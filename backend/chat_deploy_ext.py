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
