"""Emergent-style Deploy + Iterate for chat sessions.

The user's ask: from a chat session, click **Deploy** → the chat becomes a
**live app** (auto GitHub repo + Vercel project + production deploy + optional
domain), then **keep editing in the same chat and re-deploy to overwrite** the
live app — exactly like emergent.app.

This module wires the chat surface to the origination engine that already
exists in `app_builder_ext.py` (plan → repo → commit → git-linked Vercel
project → deploy → poll READY) and the iterate loop reuses the LLM edit
envelope from `sandbox_ai_ext.py`.

Endpoints (all user-auth, per-session):

  POST /api/chat/sessions/{id}/deploy
      First call provisions: builds the app from the conversation, creates a
      private repo, a git-linked Vercel project, deploys to production, and
      links the session ↔ deploy_project. Subsequent calls redeploy the linked
      project (git-linked → a push already auto-builds, but we trigger an
      explicit production deploy so we can poll + return the live URL).
      body: { prompt?: str }   # optional one-line "what should this app be"

  POST /api/chat/sessions/{id}/apply
      Iterate: read the current app files from the repo, feed them + the user's
      instruction to the LLM, commit the changed files back to `main`, and
      redeploy. Overwrites the live app.
      body: { instruction: str }

  GET  /api/chat/sessions/{id}/deploy
      Lightweight status: linked project, repo, last deploy url/state.

Design: the GitHub repo is the per-chat source of truth. The chat session gets
`deploy_project_id`; the `deploy_projects` doc gets `session_id` + `origin:'chat'`.
Because the Vercel project is git-linked, iteration = commit → auto-redeploy.

Money-safety: provisioning fires paid LLM calls + creates real repos/projects,
so the first deploy is credit-gated (operator/enterprise/unlimited are free),
mirroring `domain_launch_ext`. The charge is refunded if provisioning fails.
Redeploy + apply are NOT charged — iterating should be frictionless.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_utils import get_current_user
from db import db

logger = logging.getLogger('tbc.chat_deploy')

router = APIRouter(prefix='/api/chat/sessions', tags=['chat-deploy'])

# Flat price to provision (first deploy) a chat into a live app, in credits.
CHAT_DEPLOY_COST = int(os.environ.get('CHAT_DEPLOY_COST', '25'))
_MAX_SPEC_CHARS = 6_000


class ChatDeployIn(BaseModel):
    # Optional override — if the conversation doesn't describe an app yet, the
    # frontend collects a one-liner and passes it here.
    prompt: Optional[str] = Field(default=None, max_length=_MAX_SPEC_CHARS)
    domain: Optional[str] = Field(default=None, max_length=253)


class ChatApplyIn(BaseModel):
    instruction: str = Field(min_length=2, max_length=8_000)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _get_session_or_404(session_id: str, user: dict) -> dict:
    s = await db.chat_sessions.find_one({'id': session_id, 'user_id': user['sub']})
    if not s:
        raise HTTPException(404, 'Session not found')
    return s


async def _build_spec_from_conversation(session: dict, override: Optional[str]) -> str:
    """Derive the build prompt from the chat. Prefer an explicit override; else
    stitch the session title + the user's own messages into a spec. Raises 422
    if there's nothing to build from, so the UI can ask for a one-liner."""
    if override and override.strip():
        return override.strip()[:_MAX_SPEC_CHARS]

    title = (session.get('title') or '').strip()
    parts: list[str] = []
    if title and title.lower() not in ('new chat', 'untitled'):
        parts.append(f'App title: {title}')
    cursor = db.chat_messages.find(
        {'session_id': session['id'], 'role': 'user'}
    ).sort('created_at', 1).limit(40)
    async for m in cursor:
        c = (m.get('content') or '').strip()
        if c:
            parts.append(c)
    spec = '\n\n'.join(parts).strip()
    if len(spec) < 8:
        raise HTTPException(
            422,
            {
                'error': 'no_build_spec',
                'message': (
                    "Tell me what this app should be first (one line is fine), "
                    "then click Deploy."
                ),
            },
        )
    return spec[:_MAX_SPEC_CHARS]


async def _charge_provision(user: dict) -> int:
    """Atomic, race-safe credit deduction for the first provision. Operator /
    enterprise / unlimited users are free (they own the infra). Returns the
    number of credits actually charged (0 when free)."""
    uid = user['sub']
    u = await db.users.find_one({'id': uid})
    if not u:
        raise HTTPException(404, 'User not found')
    unlimited = (
        u.get('role') == 'operator'
        or str(u.get('credits')) in ('inf', '-1')
        or u.get('plan') == 'enterprise'
    )
    if unlimited:
        return 0
    res = await db.users.update_one(
        {'id': uid, 'credits': {'$gte': CHAT_DEPLOY_COST}},
        {'$inc': {'credits': -CHAT_DEPLOY_COST}},
    )
    if res.modified_count == 0:
        raise HTTPException(
            402,
            f'You need at least {CHAT_DEPLOY_COST} credits to deploy this app. '
            'Top up your credits and try again.',
        )
    return CHAT_DEPLOY_COST


async def _refund(user: dict, amount: int) -> None:
    if amount > 0:
        try:
            await db.users.update_one({'id': user['sub']}, {'$inc': {'credits': amount}})
        except Exception as e:  # pragma: no cover - refund best-effort
            logger.error('Chat-deploy refund failed for %s: %s', user['sub'], e)


async def _link_session_project(session_id: str, project_id: str) -> None:
    await db.chat_sessions.update_one(
        {'id': session_id},
        {'$set': {'deploy_project_id': project_id, 'updated_at': _now()}},
    )
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'session_id': session_id, 'origin': 'chat', 'updated_at': _now()}},
    )


async def _provision(session: dict, user: dict, body: ChatDeployIn) -> dict:
    """Run the origination pipeline seeded from the conversation, then link the
    resulting deploy_project to the session. Credit-gated + refund on failure."""
    from app_builder_ext import _run_pipeline

    spec = await _build_spec_from_conversation(session, body.prompt)
    app_name = (session.get('title') or '').strip() or None
    charged = await _charge_provision(user)

    result: Optional[dict] = None
    error: Optional[str] = None
    try:
        async for ev in _run_pipeline(
            prompt=spec,
            app_name=app_name,
            domain=(body.domain or '').strip() or None,
            stack_choice='auto',
            actor=f'chat:{user["sub"]}:{session["id"]}',
        ):
            if ev.get('step') == 'error':
                error = ev.get('message')
            if ev.get('done'):
                result = ev.get('result')
    except Exception as e:  # pragma: no cover - defensive
        logger.exception('chat provision pipeline crashed')
        error = f'Unexpected error: {str(e)[:200]}'

    if not result:
        await _refund(user, charged)
        raise HTTPException(502, error or 'Deploy failed — no app was produced.')

    project_id = result.get('project_id')
    if project_id:
        await _link_session_project(session['id'], project_id)

    return {
        'ok': True,
        'provisioned': True,
        'project_id': project_id,
        'repo': result.get('repo'),
        'repo_url': result.get('repo_url'),
        'deploy_url': result.get('deploy_url'),
        'domain': result.get('domain') or '',
        'state': result.get('deployment_state'),
        'credits_charged': charged,
        'message': 'Your app is live. Keep chatting to change it, then Deploy again to update it.',
    }


async def _redeploy_linked(project: dict) -> dict:
    """Trigger an explicit production deploy of the already-linked project and
    poll to READY so we can return the live URL. Reuses the deploy trigger's
    self-heal for stale Vercel project ids."""
    from payments_ext import get_settings_doc
    from deploy_projects_ext import _trigger_deploy
    from app_builder_ext import _poll_deployment_ready

    settings = await get_settings_doc()
    git_ref = project.get('gitRef') or 'main'
    # bypass_review: this is the user's own app, not the platform repo — the
    # operator ship-gate doesn't apply here.
    res = await _trigger_deploy(
        project['id'], settings, 'production', git_ref,
        bypass_review=True, user_id=None,
    )
    deployment_id = res.get('deployment_id')
    deploy_url = res.get('url')
    if deploy_url and not deploy_url.startswith('http'):
        deploy_url = f'https://{deploy_url}'
    state = (res.get('state') or 'QUEUED')
    if deployment_id:
        ready = await _poll_deployment_ready(settings, deployment_id)
        rstate = (ready.get('readyState') or ready.get('status') or state).upper()
        if ready.get('url'):
            u = ready['url']
            deploy_url = f'https://{u}' if not u.startswith('http') else u
        state = rstate
        await db.deploy_projects.update_one(
            {'id': project['id']},
            {'$set': {'last_deployment_state': state,
                      'last_deployment_url': deploy_url, 'updated_at': _now()}},
        )
    return {
        'ok': True,
        'provisioned': False,
        'project_id': project['id'],
        'repo': project.get('repo'),
        'deploy_url': deploy_url,
        'domain': project.get('domain') or '',
        'state': state,
        'credits_charged': 0,
        'message': 'Redeploy triggered — your live app will update in a moment.',
    }


@router.post('/{session_id}/deploy')
async def chat_deploy(
    session_id: str,
    body: ChatDeployIn,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """First call provisions the app; later calls redeploy the linked project."""
    session = await _get_session_or_404(session_id, user)
    existing_id = session.get('deploy_project_id')
    if existing_id:
        project = await db.deploy_projects.find_one({'id': existing_id})
        if project and (project.get('repo') or '').strip():
            return await _redeploy_linked(project)
        # Link is dangling (project deleted / never got a repo) — re-provision.
    return await _provision(session, user, body)


@router.post('/{session_id}/apply')
async def chat_apply(
    session_id: str,
    body: ChatApplyIn,
    user: dict = Depends(get_current_user),
):
    """Iterate on the live app: read repo → LLM edits → commit → redeploy."""
    session = await _get_session_or_404(session_id, user)
    project_id = session.get('deploy_project_id')
    if not project_id:
        raise HTTPException(
            409,
            {
                'error': 'not_deployed',
                'message': 'Deploy this chat first, then you can edit the live app.',
            },
        )
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project or not (project.get('repo') or '').strip():
        raise HTTPException(409, 'Linked app has no repo — deploy again to re-provision.')

    from payments_ext import get_settings_doc
    from app_builder_ext import _read_repo_files, _commit_files
    from sandbox_ai_ext import SYSTEM_PROMPT, _strip_json_envelope
    from llm_router import LlmChat, UserMessage, resolve_text_model
    import json

    settings = await get_settings_doc()
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        raise HTTPException(503, 'GitHub token not configured.')
    resolved = await resolve_text_model()
    if not resolved:
        raise HTTPException(503, 'No AI provider key configured.')
    provider, model = resolved

    repo = project['repo']
    branch = project.get('gitRef') or 'main'
    async with httpx.AsyncClient(timeout=45.0) as client:
        files = await _read_repo_files(client, gh_token, repo, branch)
        if not files:
            raise HTTPException(502, 'Could not read the current app files from the repo.')

        parts = [
            f'INSTRUCTION:\n{body.instruction.strip()}\n',
            f'EDIT MODE: multi — you may modify ANY of the {len(files)} files below. '
            'Return the COMPLETE new content for every file you change.',
        ]
        for path, content in files.items():
            parts.append(f'\n--- FILE: {path} ---\n{content}')
        user_text = '\n'.join(parts)

        chat = LlmChat(
            api_key='',
            session_id=f'chat-apply:{session_id}',
            system_message=SYSTEM_PROMPT,
        ).with_model(provider, model)
        try:
            raw = await chat.send_message(UserMessage(text=user_text))
        except Exception as e:
            raise HTTPException(502, f'LLM error: {str(e)[:200]}') from e

        raw_text = raw if isinstance(raw, str) else getattr(raw, 'text', '') or str(raw)
        try:
            parsed = json.loads(_strip_json_envelope(raw_text))
        except Exception as e:
            raise HTTPException(502, 'The model did not return valid JSON. Try again.') from e

        changed: dict[str, str] = {}
        for entry in parsed.get('files', []) or []:
            p = (entry.get('path') or '').strip().lstrip('./')
            nc = entry.get('new_content')
            if p and isinstance(nc, str):
                changed[p] = nc
        if not changed:
            return {
                'ok': True,
                'changed': [],
                'notes': (parsed.get('notes') or 'No changes were needed.')[:500],
                'redeployed': False,
            }
        committed = await _commit_files(client, gh_token, repo, branch, changed)

    redeploy = await _redeploy_linked(project)
    return {
        'ok': True,
        'changed': list(changed.keys()),
        'committed': committed,
        'notes': (parsed.get('notes') or '')[:500],
        'redeployed': True,
        'deploy_url': redeploy.get('deploy_url'),
        'state': redeploy.get('state'),
        'message': f'Updated {committed} file(s) and redeployed your live app.',
    }


# ─── Agentic chat: make a plain chat turn ACT (read → edit → commit → deploy) ──
#
# The chat model itself (LlmChat) is text-only — it cannot touch the repo. So a
# message like "fix the health error" used to only produce words. These helpers
# let the /chat/stream turn detect an edit/fix intent and run the SAME real
# pipeline the Apply/Fix buttons use, streaming progress back as normal deltas.

# Imperative verbs that signal "change my app" rather than "answer a question".
_EDIT_VERBS = (
    'fix', 'add', 'change', 'update', 'make', 'remove', 'delete', 'create',
    'build', 'implement', 'replace', 'rename', 'redesign', 'refactor', 'edit',
    'set ', 'move', 'wire', 'connect', 'hook up', 'style', 'restyle', 'adjust',
    'increase', 'decrease', 'enable', 'disable', 'rework', 'redo', 'correct',
    'repair', 'patch', 'apply', 'insert', 'append', 'integrate', 'convert',
)


def looks_like_edit_request(message: str) -> bool:
    """True when the message reads like an instruction to modify the app (vs. a
    question). Deterministic, dependency-free — pairs with classify_message so a
    plain 'how does X work?' never triggers an edit."""
    if not message or not message.strip():
        return False
    text = message.strip().lower()
    # Obvious questions are never edits.
    if text.endswith('?') and not any(v in text for v in ('fix', 'add', 'change', 'make')):
        return False
    if text.split()[0] in ('what', 'why', 'how', 'when', 'who', 'where', 'is', 'are', 'does', 'can', 'could', 'should', 'explain'):
        return False
    return any(v in text for v in _EDIT_VERBS)


async def stream_agentic_edit(session: dict, instruction: str, *, is_operator: bool,
                              provider: str | None = None, model: str | None = None):
    """Async generator that ACTS on the user's app for a chat turn.

    Yields human-readable markdown chunks (streamed to the UI as deltas) while
    it: reads the linked repo → has the AI edit the real code → commits → and
    (operator only) redeploys. Write policy:

      * Platform repo (this app) → open a PR (operator-only, never push to the
        live platform's main).
      * Operator's own deployed app → commit to main + auto-redeploy.
      * Regular user's app → commit to main; redeploy stays on the button press.

    On any hard failure it yields a short explanation instead of raising, so the
    chat turn always completes cleanly.
    """
    project_id = session.get('deploy_project_id')
    if not project_id:
        yield ("I don't have a live app linked to this chat yet, so there's no "
               "code for me to edit. Tap **Deploy this app** first — then just "
               "tell me what to change and I'll edit the code and ship it.")
        return
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project or not (project.get('repo') or '').strip():
        yield ("This chat's app link is missing its repo. Tap **Deploy this app** "
               "again to re-provision it, then I can edit the code directly.")
        return

    from payments_ext import get_settings_doc
    from app_builder_ext import generate_ai_code_fix
    from llm_router import (
        ordered_text_models, record_provider_ok, record_provider_error,
    )
    from deploy_projects_ext import SELF_PROJECT_ID, PLATFORM_REPO

    settings = await get_settings_doc()
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        yield 'I can\'t reach GitHub — no token is configured in Operator → My Keys.'
        return
    # Build a preference-ordered provider chain for AUTO-FAILOVER. The model the
    # user picked (passed in by server.py, validated against configured keys) is
    # tried first; if it's out of credits / unauthorized we transparently fall
    # over to the next available AI so a single dead provider never blocks an
    # edit. Providers already known-down are pushed to the back of the chain.
    primary = (provider, model) if (provider and model) else None
    chain = await ordered_text_models(primary)
    if not chain:
        yield 'No AI provider key is configured, so I can\'t generate the fix. Add a key in Operator → My Keys.'
        return

    repo = project['repo']
    branch = project.get('gitRef') or 'main'
    is_platform = (project_id == SELF_PROJECT_ID) or (repo.lower() == PLATFORM_REPO.lower())

    # Hard gate: only the operator may edit the platform itself.
    if is_platform and not is_operator:
        yield 'Editing the TBC platform is restricted to the operator account.'
        return

    yield f'Reading your app\'s code (`{repo}`)…\n\n'
    fix = None
    last_err = None
    for idx, (prov_i, model_i) in enumerate(chain):
        try:
            fix = await generate_ai_code_fix(
                repo, branch, instruction, gh_token, provider=prov_i, model=model_i,
            )
            record_provider_ok(prov_i)
            if idx > 0:
                # We recovered on a fallback provider — tell the user plainly.
                yield (f'_(The previous AI was unavailable, so I switched to '
                       f'**{prov_i}** to finish this.)_\n\n')
            break
        except HTTPException as e:
            last_err = getattr(e, 'detail', str(e))
            record_provider_error(prov_i, e)
            # Only fail over on provider-fault errors (credits/auth/rate). For
            # anything else, stop and report it — retrying won't help.
            from llm_router import _classify_provider_error
            if _classify_provider_error(e) is None or idx == len(chain) - 1:
                yield f'I couldn\'t complete the edit: {last_err}'
                return
            yield (f'_({prov_i} is unavailable — {str(last_err)[:80]}. Trying '
                   f'another AI…)_\n\n')
            continue
        except Exception as e:  # noqa: BLE001
            last_err = str(e)[:200]
            record_provider_error(prov_i, e)
            logger.warning('agentic edit failed for %s on %s: %s', project_id, prov_i, last_err)
            from llm_router import _classify_provider_error
            if _classify_provider_error(e) is None or idx == len(chain) - 1:
                yield f'Something went wrong while editing: {last_err}'
                return
            yield (f'_({prov_i} is unavailable — trying another AI…)_\n\n')
            continue
    if fix is None:
        yield f'All available AIs failed to generate the edit. Last error: {last_err or "unknown"}'
        return

    changed = fix['changed']
    if not changed:
        yield fix['notes'] or 'I looked at the code and no change was needed for that.'
        return

    # ── Approval gate ─────────────────────────────────────────────────────
    # We DELIBERATELY do not commit or deploy here. Every code change is first
    # presented as a proposal (changed files + summary) and nothing touches the
    # repo or the live app until the user presses Allow/Build. This is the
    # code-review gate the operator asked for, and it applies to EVERYONE.
    import uuid
    proposal_id = uuid.uuid4().hex
    will_deploy = bool(is_operator and not is_platform)
    will_pr = bool(is_platform)
    summary = (fix.get('notes') or '').strip()
    try:
        await db.chat_proposals.insert_one({
            'id': proposal_id,
            'session_id': session.get('id'),
            'project_id': project_id,
            'repo': repo,
            'branch': branch,
            'is_platform': is_platform,
            'is_operator': bool(is_operator),
            'will_deploy': will_deploy,
            'will_pr': will_pr,
            'changed': changed,            # {path: new_content}
            'created': list(fix.get('created') or []),  # subset of changed that are new files
            'notes': summary[:2000],
            'instruction': instruction[:4000],
            'status': 'pending',
            'created_at': _now(),
        })
    except Exception as e:  # noqa: BLE001
        logger.warning('could not store proposal for %s: %s', project_id, str(e)[:200])
        yield f'I generated the change but could not stage it for approval: {str(e)[:160]}'
        return

    # Distinguish brand-new files from edits so the user can see features being
    # ADDED, not just tweaked (the in-app editor can now create new files).
    created = set(fix.get('created') or [])
    file_list = '\n'.join(
        (f'- `{p}` _(new)_' if p in created else f'- `{p}`') for p in changed
    )
    n_new = len(created)
    n_edit = len(changed) - n_new
    if n_new and n_edit:
        headline = f'**{n_new} new file(s)** and edits to **{n_edit} file(s)**'
    elif n_new:
        headline = f'**{n_new} new file(s)**'
    else:
        headline = f'changes to **{n_edit} file(s)**'
    yield (f'I\'ve prepared {headline} — nothing has been '
           f'committed or deployed yet:\n{file_list}\n\n')
    if summary:
        yield f'**What this does:** {summary}\n\n'
    # Structured event → the UI renders the Allow/Build + Reject gate.
    yield {
        '__event__': 'proposal',
        'proposal_id': proposal_id,
        'files': list(changed.keys()),
        'created': list(created),
        'summary': summary[:1000],
        'is_platform': is_platform,
        'will_deploy': will_deploy,
        'will_pr': will_pr,
    }
    if will_pr:
        yield ('Review the changes above, then press **Allow & Open PR** to commit '
               'them to a review branch and open a pull request. The live platform '
               'is never pushed directly.')
    elif will_deploy:
        yield ('Review the changes above, then press **Allow & Build** to commit and '
               'deploy your live app — I\'ll wait for the build and tell you the '
               'moment it\'s live.')
    else:
        yield ('Review the changes above, then press **Allow & Save** to commit them '
               'to your app. Tap **Deploy** when you\'re ready to push it live.')


@router.get('/{session_id}/deploy')
async def chat_deploy_status(
    session_id: str,
    user: dict = Depends(get_current_user),
):
    """Lightweight status for the in-chat Deploy UI."""
    session = await _get_session_or_404(session_id, user)
    project_id = session.get('deploy_project_id')
    if not project_id:
        return {'linked': False}
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        return {'linked': False}
    return {
        'linked': True,
        'project_id': project_id,
        'repo': project.get('repo'),
        'repo_url': (f'https://github.com/{project["repo"]}' if project.get('repo') else None),
        'domain': project.get('domain') or '',
        'deploy_url': project.get('last_deployment_url'),
        'state': project.get('last_deployment_state'),
    }


# ─── Approval gate: apply / reject / list staged proposals ─────────────────
#
# stream_agentic_edit stages every code change as a `chat_proposals` doc and
# hands the UI an Allow/Build gate. Nothing is committed or deployed until the
# user approves here. On approval the operator flow commits + deploys and WAITS
# for the build (streaming progress), then continues; regular users commit only
# and deploy with the manual button, exactly as required.

def _sse_frame(chunk) -> str:
    """Serialise an agentic chunk to an SSE `data:` frame. Dicts carrying an
    `__event__` key become their own typed event (proposal / deploy_progress /
    deploy_done); plain strings become `delta` text."""
    import json as _json
    if isinstance(chunk, dict):
        ev = dict(chunk)
        if '__event__' in ev:
            ev['type'] = ev.pop('__event__')
        return 'data: ' + _json.dumps(ev) + '\n\n'
    return 'data: ' + _json.dumps({'type': 'delta', 'content': chunk}) + '\n\n'


async def _redeploy_linked_streaming(project: dict):
    """Trigger a production deploy and WAIT for it, yielding progress events so
    the chat can show 'still building…' and then continue when it's live.

    Reuses the blocking `_poll_deployment_ready` for the actual Vercel polling
    (so we don't duplicate its self-heal / API details) and emits a heartbeat
    `deploy_progress` event every few seconds while it runs. Ends with a single
    `deploy_done` event carrying the terminal state + live URL."""
    from payments_ext import get_settings_doc
    from deploy_projects_ext import _trigger_deploy
    from app_builder_ext import _poll_deployment_ready
    import asyncio
    import time as _time

    settings = await get_settings_doc()
    git_ref = project.get('gitRef') or 'main'
    res = await _trigger_deploy(
        project['id'], settings, 'production', git_ref,
        bypass_review=True, user_id=None,
    )
    deployment_id = res.get('deployment_id')
    deploy_url = res.get('url')
    if deploy_url and not deploy_url.startswith('http'):
        deploy_url = f'https://{deploy_url}'
    state = (res.get('state') or 'QUEUED')
    yield {'__event__': 'deploy_progress', 'state': state, 'elapsed': 0, 'url': deploy_url}

    if not deployment_id:
        await db.deploy_projects.update_one(
            {'id': project['id']},
            {'$set': {'last_deployment_state': state,
                      'last_deployment_url': deploy_url, 'updated_at': _now()}},
        )
        yield {'__event__': 'deploy_done', 'state': state, 'url': deploy_url}
        return

    poll_task = asyncio.create_task(_poll_deployment_ready(settings, deployment_id))
    start = _time.monotonic()
    # Heartbeat while the build runs so the UI shows it's not done yet.
    while not poll_task.done():
        try:
            await asyncio.wait_for(asyncio.shield(poll_task), timeout=4)
        except asyncio.TimeoutError:
            elapsed = int(_time.monotonic() - start)
            yield {'__event__': 'deploy_progress', 'state': 'BUILDING',
                   'elapsed': elapsed, 'url': deploy_url}
        except Exception:  # noqa: BLE001 — real result handled below
            break
    ready = await poll_task
    rstate = (ready.get('readyState') or ready.get('status') or state).upper()
    u = ready.get('url')
    if u:
        deploy_url = f'https://{u}' if not u.startswith('http') else u
    await db.deploy_projects.update_one(
        {'id': project['id']},
        {'$set': {'last_deployment_state': rstate,
                  'last_deployment_url': deploy_url, 'updated_at': _now()}},
    )
    yield {'__event__': 'deploy_done', 'state': rstate, 'url': deploy_url}


async def _apply_proposal_stream(proposal: dict, *, is_operator: bool):
    """Commit an approved proposal (platform → PR; otherwise → main) and, for the
    operator on their own app, deploy + wait. Yields text + structured events."""
    from payments_ext import get_settings_doc
    from app_builder_ext import GITHUB_API as _GH_API, _commit_files, _gh_get, _gh_post

    settings = await get_settings_doc()
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        yield "I can't reach GitHub — no token is configured in Operator → My Keys."
        return

    repo = proposal['repo']
    branch = proposal.get('branch') or 'main'
    changed = proposal.get('changed') or {}
    is_platform = bool(proposal.get('is_platform'))
    if is_platform and not is_operator:
        yield 'Editing the TBC platform is restricted to the operator account.'
        return
    if not changed:
        await db.chat_proposals.update_one({'id': proposal['id']}, {'$set': {'status': 'empty'}})
        yield 'There are no changes left to apply.'
        return

    project = await db.deploy_projects.find_one({'id': proposal['project_id']})
    file_list = '\n'.join(f'- `{p}`' for p in changed)
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            if is_platform:
                ref = await _gh_get(client, f'{_GH_API}/repos/{repo}/git/ref/heads/{branch}', gh_token)
                base_sha = (ref.json().get('object') or {}).get('sha') if ref.status_code == 200 else None
                if not base_sha:
                    yield f'Could not read the base branch `{branch}` to open a PR.'
                    return
                new_branch = f'ai-fix/{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")}'
                mk = await _gh_post(client, f'{_GH_API}/repos/{repo}/git/refs', gh_token,
                                    {'ref': f'refs/heads/{new_branch}', 'sha': base_sha})
                if mk.status_code not in (200, 201):
                    yield f'Could not create the fix branch: {mk.text[:160]}'
                    return
                committed = await _commit_files(client, gh_token, repo, new_branch, changed)
                pr_body = (f'**Approved change from chat**\n\n> {proposal.get("instruction", "")[:1500]}\n\n'
                           f'**AI summary:** {proposal.get("notes", "")}\n\n'
                           f'**Files changed ({committed}):**\n{file_list}\n\n'
                           '_Review before merging — direct pushes to the live platform are blocked._')
                pr = await _gh_post(client, f'{_GH_API}/repos/{repo}/pulls', gh_token, {
                    'title': f'AI fix · {(proposal.get("notes") or "code fix")[:64]}',
                    'head': new_branch, 'base': branch, 'body': pr_body[:60_000],
                })
                await db.chat_proposals.update_one({'id': proposal['id']}, {'$set': {'status': 'applied'}})
                if pr.status_code not in (200, 201):
                    yield f'Committed to `{new_branch}` but couldn\'t open the PR: {pr.text[:160]}'
                    return
                pj = pr.json()
                await db.chat_proposals.update_one(
                    {'id': proposal['id']}, {'$set': {'pr_url': pj.get('html_url')}})
                yield (f'Approved. I opened **PR #{pj.get("number")}** with the change '
                       f'({committed} file(s)). Review and merge it to ship — I never '
                       f'push straight to the live platform.\n\n{pj.get("html_url")}')
                return

            committed = await _commit_files(client, gh_token, repo, branch, changed)
    except Exception as e:  # noqa: BLE001
        logger.warning('proposal apply commit failed for %s: %s', proposal.get('id'), str(e)[:200])
        yield f'I tried to apply the change but committing failed: {str(e)[:200]}'
        return

    await db.chat_proposals.update_one({'id': proposal['id']}, {'$set': {'status': 'applied'}})

    if is_operator and project:
        yield (f'Approved — committed {committed} file(s). Deploying your live app now; '
               f'I\'ll wait for the build…\n\n')
        try:
            async for prog in _redeploy_linked_streaming(project):
                yield prog
        except Exception as e:  # noqa: BLE001
            yield (f'Committed {committed} file(s), but the deploy hit a snag: '
                   f'{str(e)[:160]}. Tap **Redeploy now** to retry.')
            return
        yield '\nYour app is live with the change.'
    else:
        yield (f'Approved — I committed {committed} file(s) to your app. '
               f'Tap **Deploy** to push it live when you\'re ready.')


@router.post('/{session_id}/proposals/{proposal_id}/apply')
async def chat_apply_proposal(
    session_id: str,
    proposal_id: str,
    user: dict = Depends(get_current_user),
):
    """Approve a staged proposal: commit (+ deploy & wait for operator). SSE."""
    session = await _get_session_or_404(session_id, user)
    proposal = await db.chat_proposals.find_one({'id': proposal_id, 'session_id': session_id})
    if not proposal:
        raise HTTPException(404, 'That change was not found — it may have expired.')
    if proposal.get('status') != 'pending':
        raise HTTPException(409, f'This change was already {proposal.get("status")}.')
    db_user = await db.users.find_one({'id': user['sub']})
    is_operator = bool(db_user and db_user.get('role') == 'operator')

    async def gen():
        try:
            async for chunk in _apply_proposal_stream(proposal, is_operator=is_operator):
                yield _sse_frame(chunk)
        except Exception as e:  # noqa: BLE001
            logger.exception('apply proposal stream failed')
            yield _sse_frame(f'\n\nSomething went wrong applying that: {str(e)[:200]}')
        yield 'data: ' + __import__('json').dumps({'type': 'done'}) + '\n\n'

    return StreamingResponse(gen(), media_type='text/event-stream')


@router.post('/{session_id}/proposals/{proposal_id}/reject')
async def chat_reject_proposal(
    session_id: str,
    proposal_id: str,
    user: dict = Depends(get_current_user),
):
    """Discard a staged proposal without touching the repo or the live app."""
    session = await _get_session_or_404(session_id, user)  # noqa: F841 — authz
    r = await db.chat_proposals.update_one(
        {'id': proposal_id, 'session_id': session_id, 'status': 'pending'},
        {'$set': {'status': 'rejected', 'updated_at': _now()}},
    )
    if not r.matched_count:
        raise HTTPException(404, 'That change was not found or was already handled.')
    return {'ok': True, 'status': 'rejected'}


@router.get('/{session_id}/proposals')
async def chat_list_proposals(
    session_id: str,
    user: dict = Depends(get_current_user),
):
    """Pending proposals for this chat so the Allow/Build gate survives reload."""
    session = await _get_session_or_404(session_id, user)  # noqa: F841 — authz
    out = []
    cur = db.chat_proposals.find(
        {'session_id': session_id, 'status': 'pending'}
    ).sort('created_at', -1)
    async for p in cur:
        created = p.get('created_at')
        out.append({
            'proposal_id': p['id'],
            'files': list((p.get('changed') or {}).keys()),
            'summary': (p.get('notes') or '')[:1000],
            'is_platform': bool(p.get('is_platform')),
            'will_deploy': bool(p.get('will_deploy')),
            'will_pr': bool(p.get('will_pr')),
            'created_at': created.isoformat() if hasattr(created, 'isoformat') else None,
        })
    return {'proposals': out}
