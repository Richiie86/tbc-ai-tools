"""Deploy-projects API + Vercel integration.

Two surfaces:

1. **Operator surface** (`/api/operator/deploy/*`): cookie-authenticated; powers
   the Ops-tab Deploy / Redeploy / Preview buttons. Returns deployment status
   for inline feedback.

2. **AI-agent surface** (`/api/projects/*`): Bearer-token authenticated using
   the `ai_api_key` stored in payment_settings. Lets an external AI program
   create, list, update, and delete deploy projects programmatically — the
   exact contract documented for tbctools.org/api/projects.

Plus a `ship_and_watch` background poller and outbound webhook on every
deploy state change so callers can be event-driven rather than poll-based.
A magic project id `tbctools-self` lets the operator deploy this platform
itself with a single button or a single API call.

Tokens (Vercel PAT, ai_api_key, webhook secret) live in `payment_settings`
(Mongo) and are *never* returned to the browser. The Vercel REST API is
called directly with `httpx.AsyncClient` (no Vercel SDK), following the same
pattern as our Stripe / NOWPayments integrations.
"""
import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db
from payments_ext import get_settings_doc

logger = logging.getLogger('tbc')

VERCEL_API = 'https://api.vercel.com'
SELF_PROJECT_ID = 'tbctools-self'

# Terminal Vercel readyStates — when the poller sees one of these it stops.
TERMINAL_STATES = {'READY', 'ERROR', 'CANCELED'}

# ===================================================================
# Models
# ===================================================================
class ProjectIn(BaseModel):
    """Request body for `POST /api/projects` (create or update)."""
    id: Optional[str] = None
    projectName: str
    repo: str                # e.g. "tbctools/my-cool-app"
    domain: str              # e.g. "my-cool-app.tbctools.org"
    repoType: str = 'github'
    gitRef: Optional[str] = None  # branch; None ⇒ repo default branch
    # Optional Vercel project id once Vercel knows about this project. We fill
    # it in lazily on the first successful deploy so the operator doesn't have
    # to paste it.
    vercel_project_id: Optional[str] = None


class ProjectOut(BaseModel):
    id: str
    projectName: str
    repo: str
    domain: str
    repoType: str
    gitRef: Optional[str] = None
    vercel_project_id: Optional[str] = None
    last_deployment_id: Optional[str] = None
    last_deployment_url: Optional[str] = None
    last_deployment_state: Optional[str] = None
    last_deployed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class DeployRequest(BaseModel):
    target: str = 'production'        # 'production' | 'preview'
    git_ref: Optional[str] = None     # override the project's default branch
    # Operator-only override: skip the do_not_ship review-gate even when the
    # last AI code review says the project shouldn't ship. Defaults to false
    # so an autonomous AI agent can't bypass its own safety net by accident.
    bypass_review: bool = False


# ===================================================================
# Helpers
# ===================================================================
_SLUG_RX = re.compile(r'[^a-z0-9-]+')


def _slugify(name: str) -> str:
    slug = _SLUG_RX.sub('-', name.lower()).strip('-')[:48]
    return slug or 'project'


def _gen_project_id(name: str) -> str:
    """Stable-prefix + random suffix so AI agents can re-create a project
    deterministically if they pass `id`, and otherwise get a clash-free new one.
    """
    return f'{_slugify(name)}-{secrets.token_urlsafe(4).lower().replace("_", "").replace("-", "")[:5]}'


def _project_to_out(doc: dict) -> dict:
    """Strip internal Mongo `_id`, surface only the documented fields."""
    return {
        'id': doc['id'],
        'projectName': doc['projectName'],
        'repo': doc['repo'],
        'domain': doc['domain'],
        'repoType': doc.get('repoType', 'github'),
        'gitRef': doc.get('gitRef'),
        'vercel_project_id': doc.get('vercel_project_id'),
        'last_deployment_id': doc.get('last_deployment_id'),
        'last_deployment_url': doc.get('last_deployment_url'),
        'last_deployment_state': doc.get('last_deployment_state'),
        'last_deployed_at': doc.get('last_deployed_at'),
        'created_at': doc['created_at'],
        'updated_at': doc['updated_at'],
    }


async def _require_ai_api_key(authorization: Optional[str] = Header(None)) -> dict:
    """Validate `Authorization: Bearer <AI_API_KEY>` against the stored token.

    Returns the settings doc on success so callers can grab Vercel credentials
    from it without re-reading. Raises 401 on any mismatch / missing config.
    """
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Missing Bearer token')
    presented = authorization.split(None, 1)[1].strip()
    settings = await get_settings_doc()
    stored = (settings or {}).get('ai_api_key')
    if not stored:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            'AI API key not configured on this server. The operator must generate one in the Security tab.',
        )
    # Constant-time compare to avoid timing side channels.
    if not secrets.compare_digest(stored, presented):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid Bearer token')
    return settings


# ===================================================================
# Vercel API helpers (direct httpx calls — no SDK)
# ===================================================================
def _vercel_team_qs(settings: dict) -> dict:
    tid = settings.get('vercel_team_id')
    return {'teamId': tid} if tid else {}


async def _vercel_create_deployment(
    settings: dict, project: dict, target: str, git_ref: Optional[str],
) -> dict:
    """Trigger `POST /v13/deployments`. Returns the raw Vercel response."""
    token = (settings or {}).get('vercel_token')
    if not token:
        raise HTTPException(503, 'Vercel token not configured. Operator must paste it in the Security tab.')

    ref = git_ref or project.get('gitRef') or 'main'
    repo = project['repo']
    repo_type = project.get('repoType', 'github')
    payload = {
        # `name` lets Vercel auto-create the project on first deploy when no
        # `project` id is on file yet. Once Vercel returns a `projectId` we
        # persist it onto the project doc so subsequent deploys are stable.
        'name': _slugify(project['projectName']),
        'target': target,
        'gitSource': {
            'type': repo_type,
            'repo': repo,           # "owner/name"
            'ref': ref,
        },
    }
    if project.get('vercel_project_id'):
        payload['project'] = project['vercel_project_id']

    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v13/deployments',
            params=_vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            json=payload,
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        msg = err.get('message') or err.get('code') or 'Vercel error'
        raise HTTPException(502, f'Vercel deploy: {msg}')
    return r.json()


async def _vercel_redeploy(settings: dict, deployment_id: str) -> dict:
    token = (settings or {}).get('vercel_token')
    if not token:
        raise HTTPException(503, 'Vercel token not configured.')
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v13/deployments/{deployment_id}/redeploy',
            params=_vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}'},
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        msg = err.get('message') or err.get('code') or 'Vercel error'
        raise HTTPException(502, f'Vercel redeploy: {msg}')
    return r.json()


async def _vercel_get_deployment(settings: dict, deployment_id: str) -> dict:
    """Fetch a deployment by id — used by the watcher and the per-project
    Health Check button. Raises 502 on Vercel-side error, 503 if no token."""
    token = (settings or {}).get('vercel_token')
    if not token:
        raise HTTPException(503, 'Vercel token not configured.')
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            f'{VERCEL_API}/v13/deployments/{deployment_id}',
            params=_vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}'},
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        raise HTTPException(502, f"Vercel get-deployment: {err.get('message') or err.get('code')}")
    return r.json()


# ---------- Outbound webhook ------------------------------------------
async def _fire_webhook(event: str, payload: dict, settings: Optional[dict] = None) -> None:
    """POST to the operator-configured webhook URL on every deploy state change.

    Body is JSON: `{"event": "...", "ts": "...", "data": {...}}`.
    We sign it with HMAC-SHA256(secret, raw_body) and put the hex in the
    `X-TBC-Signature` header so the receiver can verify authenticity.

    Failures are logged but never raise — webhooks are best-effort and must
    not block a deploy response. Timeout is short (5s) for the same reason.
    """
    if settings is None:
        settings = await get_settings_doc()
    url = (settings or {}).get('deploy_webhook_url')
    if not url:
        return  # not configured — silent no-op
    body = json.dumps({
        'event': event,
        'ts': datetime.now(timezone.utc).isoformat(),
        'data': payload,
    }, default=str).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    secret = (settings or {}).get('deploy_webhook_secret')
    if secret:
        sig = hmac.new(secret.encode('utf-8'), body, hashlib.sha256).hexdigest()
        headers['X-TBC-Signature'] = f'sha256={sig}'
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(url, content=body, headers=headers)
        if r.status_code >= 400:
            logger.warning('Webhook %s → %s returned %s', event, url, r.status_code)
    except Exception as e:
        logger.warning('Webhook %s → %s failed: %s', event, url, str(e)[:200])


# ---------- Ship-and-watch poller -------------------------------------
async def _watch_deployment(project_id: str, deployment_id: str) -> None:
    """Poll Vercel until `deployment_id` reaches a terminal state.

    Fires a webhook on every state change and a final webhook on terminal.
    Persists the final state onto the project doc so the Ops tab refresh
    picks it up without an extra round-trip.

    Designed to run as a background `asyncio.create_task` — no exceptions
    leak. Bounded to ~10 minutes (60 polls × 10s) so a stuck deploy doesn't
    leak the task forever.
    """
    last_state: Optional[str] = None
    for _ in range(60):  # ~10 minutes
        await asyncio.sleep(10.0)
        try:
            settings = await get_settings_doc()
            res = await _vercel_get_deployment(settings, deployment_id)
        except Exception as e:
            logger.warning('Watch %s: poll failed: %s', deployment_id, str(e)[:120])
            continue
        state = res.get('readyState') or res.get('state')
        if state != last_state:
            await db.deploy_projects.update_one(
                {'id': project_id},
                {'$set': {
                    'last_deployment_state': state,
                    'last_deployment_url': res.get('url'),
                    'updated_at': datetime.now(timezone.utc),
                }},
            )
            await _fire_webhook('deployment.state_changed', {
                'project_id': project_id,
                'deployment_id': deployment_id,
                'state': state,
                'previous_state': last_state,
                'url': res.get('url'),
            }, settings)
            last_state = state
        if state in TERMINAL_STATES:
            await _fire_webhook(
                'deployment.succeeded' if state == 'READY' else 'deployment.failed',
                {
                    'project_id': project_id,
                    'deployment_id': deployment_id,
                    'state': state,
                    'url': res.get('url'),
                },
                settings,
            )
            return
    # Timed out — log and let Ops tab show the last known state.
    logger.warning('Watch %s: timed out after 10 minutes', deployment_id)


def _start_watch(project_id: str, deployment_id: Optional[str]) -> None:
    """Fire-and-forget background watcher. Never awaited."""
    if not deployment_id:
        return
    try:
        asyncio.get_event_loop().create_task(_watch_deployment(project_id, deployment_id))
    except RuntimeError:
        # No running loop — happens in some sync test contexts. Skip silently.
        pass


async def _record_deployment(project_id: str, vercel_res: dict) -> None:
    """Persist last-deployment fields onto the project doc so the Ops tab can
    render "Last deployed: 5 min ago · sha · state" without re-querying Vercel.
    Also fires a `deployment.triggered` webhook and kicks off the watcher.
    """
    proj_vercel_id = vercel_res.get('projectId') or vercel_res.get('project', {}).get('id')
    deployment_id = vercel_res.get('id') or vercel_res.get('uid')
    update = {
        '$set': {
            'last_deployment_id': deployment_id,
            'last_deployment_url': vercel_res.get('url'),
            'last_deployment_state': vercel_res.get('readyState') or vercel_res.get('state'),
            'last_deployed_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
        },
    }
    if proj_vercel_id:
        update['$set']['vercel_project_id'] = proj_vercel_id
    await db.deploy_projects.update_one({'id': project_id}, update)

    await _fire_webhook('deployment.triggered', {
        'project_id': project_id,
        'deployment_id': deployment_id,
        'url': vercel_res.get('url'),
        'target': vercel_res.get('target'),
        'state': vercel_res.get('readyState') or vercel_res.get('state'),
    })
    _start_watch(project_id, deployment_id)


# ===================================================================
# AI-agent surface: /api/projects/*   (Bearer-token auth)
# ===================================================================
projects_router = APIRouter(prefix='/api/projects', tags=['projects'])


@projects_router.post('', status_code=201)
async def create_or_update_project(
    payload: ProjectIn,
    settings: dict = Depends(_require_ai_api_key),
):
    now = datetime.now(timezone.utc)
    if payload.id:
        existing = await db.deploy_projects.find_one({'id': payload.id})
        if not existing:
            # Caller asked us to update a non-existent id — create it with that
            # id so the AI program can use deterministic IDs (their choice).
            doc = payload.dict()
            doc['created_at'] = now
            doc['updated_at'] = now
            await db.deploy_projects.insert_one(doc)
            return {'project': _project_to_out(doc)}
        update = payload.dict(exclude_none=True)
        update['updated_at'] = now
        await db.deploy_projects.update_one({'id': payload.id}, {'$set': update})
        merged = {**existing, **update}
        return {'project': _project_to_out(merged)}

    # Create with a generated id
    pid = _gen_project_id(payload.projectName)
    doc = payload.dict()
    doc['id'] = pid
    doc['created_at'] = now
    doc['updated_at'] = now
    await db.deploy_projects.insert_one(doc)
    logger.info('AI created deploy project %s (%s → %s)', pid, payload.repo, payload.domain)
    return {'project': _project_to_out(doc)}


@projects_router.get('')
async def list_projects(_settings: dict = Depends(_require_ai_api_key)):
    cursor = db.deploy_projects.find({}).sort('updated_at', -1)
    return [_project_to_out(d) async for d in cursor]


@projects_router.get('/{project_id}')
async def get_project(project_id: str, _settings: dict = Depends(_require_ai_api_key)):
    doc = await db.deploy_projects.find_one({'id': project_id})
    if not doc:
        raise HTTPException(404, 'Project not found')
    return _project_to_out(doc)


@projects_router.delete('/{project_id}')
async def delete_project(project_id: str, _settings: dict = Depends(_require_ai_api_key)):
    res = await db.deploy_projects.delete_one({'id': project_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Project not found')
    return {'ok': True, 'deleted_id': project_id}


# ===================================================================
# Operator surface: /api/operator/deploy/* (cookie auth)
# ===================================================================
ops_router = APIRouter(prefix='/api/operator/deploy', tags=['deploy'])


@ops_router.get('/projects')
async def op_list_projects(_user: dict = Depends(get_current_operator)):
    # Lazily upsert the self project so the Ops tab always shows it after the
    # operator pastes self_repo in Settings — no second click needed.
    await _ensure_self_project()
    cursor = db.deploy_projects.find({}).sort('updated_at', -1)
    return [_project_to_out(d) async for d in cursor]


@ops_router.get('/key')
async def op_get_key_status(_user: dict = Depends(get_current_operator)):
    """Returns presence flags only — never echoes the token values."""
    settings = await get_settings_doc()
    return {
        'has_vercel_token': bool((settings or {}).get('vercel_token')),
        'has_vercel_team_id': bool((settings or {}).get('vercel_team_id')),
        'has_ai_api_key': bool((settings or {}).get('ai_api_key')),
        'vercel_team_id': (settings or {}).get('vercel_team_id'),
    }


class KeyUpdate(BaseModel):
    vercel_token: Optional[str] = None
    vercel_team_id: Optional[str] = None
    # When `regenerate_ai_api_key` is true the server mints a fresh token and
    # returns it once (the only time it's ever sent to the client).
    regenerate_ai_api_key: bool = False
    # An explicit value lets the operator set a token of their choosing
    # (useful for restoring from backup).
    ai_api_key: Optional[str] = None


@ops_router.post('/key')
async def op_update_keys(
    payload: KeyUpdate,
    _user: dict = Depends(get_current_operator),
):
    update: dict = {}
    if payload.vercel_token is not None:
        update['vercel_token'] = payload.vercel_token.strip() or None
    if payload.vercel_team_id is not None:
        update['vercel_team_id'] = payload.vercel_team_id.strip() or None

    new_key: Optional[str] = None
    if payload.regenerate_ai_api_key:
        new_key = 'tbc_' + secrets.token_urlsafe(32)
        update['ai_api_key'] = new_key
    elif payload.ai_api_key is not None:
        update['ai_api_key'] = payload.ai_api_key.strip() or None
        new_key = payload.ai_api_key.strip() or None

    if update:
        await db.settings.update_one(
            {'_id': 'payment_settings'},
            {'$set': update},
            upsert=True,
        )
    # `revealed_ai_api_key` is the *only* path the plain-text token ever
    # leaves the server. The UI must display it once and tell the operator
    # to copy it into their AI program's env var.
    return {
        'ok': True,
        'revealed_ai_api_key': new_key,
    }


async def _create_fix_review_chat(project: dict, review: dict, user_id: Optional[str]) -> Optional[str]:
    """Seed a chat session pre-loaded with the failing review findings so the
    operator can ask the AI to fix them in one click. Returns the new
    session_id (or None if we can't create one — e.g. AI surface caller).

    Imported lazily to avoid a top-level cycle (server.py imports this module
    via setup_routers).
    """
    if not user_id:
        return None  # AI-surface (no associated user) — nothing to seed
    try:
        from models import ChatSession, ChatMessage  # direct import — no cycle
    except Exception:
        return None
    DEFAULT_MODEL = 'claude-opus-4-7'  # mirror server.py; safe constant copy

    findings = review.get('findings') or []
    missing = review.get('missing_files') or []
    findings_block = '\n\n'.join(
        f"- [{f.get('severity', 'low').upper()}] {f.get('file', '?')}: "
        f"**{f.get('title', '(untitled)')}**\n  {f.get('explanation', '')}\n"
        f"  Suggested fix: {f.get('suggested_fix', 'n/a')}"
        for f in findings
    ) or '(no structured findings — see raw review)'
    missing_block = ('\n\nMissing files: ' + ', '.join(missing)) if missing else ''
    prompt = (
        f"My deploy of **{project.get('projectName')}** "
        f"(repo `{project.get('repo')}`, branch `{review.get('ref') or project.get('gitRef') or 'main'}`) "
        f"was blocked by an AI code review with verdict **{review.get('verdict')}**.\n\n"
        f"Summary: {review.get('summary', '(no summary)')}\n\n"
        f"Findings ({len(findings)}):\n{findings_block}{missing_block}\n\n"
        "Please propose concrete patches (file paths + diffs) that resolve every HIGH/MEDIUM "
        "finding so I can re-run the review and ship. If a finding is invalid, say so and explain "
        "why before we proceed."
    )

    s = ChatSession(
        user_id=user_id,
        title=f"Fix review: {project.get('projectName', 'project')[:48]}",
        model=DEFAULT_MODEL,
        variant='tbc1',
    )
    await db.chat_sessions.insert_one(s.dict())
    msg = ChatMessage(session_id=s.id, user_id=user_id, role='user', content=prompt)
    await db.chat_messages.insert_one(msg.dict())
    logger.info('Seeded fix-review chat %s for project %s (user %s)', s.id, project.get('id'), user_id)
    return s.id


async def _trigger_deploy(
    project_id: str,
    settings: dict,
    target: str,
    git_ref: Optional[str],
    *,
    bypass_review: bool = False,
    user_id: Optional[str] = None,
) -> dict:
    """Shared deploy implementation. Used by both the operator (cookie auth)
    and AI-agent (Bearer auth) surfaces so the contract stays identical.
    Raises 404 if the project isn't known, 400 if `target` is invalid.

    Ship-gate: when `target == "production"` and the project's most recent
    code review verdict is `do_not_ship`, we refuse with 412 (Precondition
    Failed) UNLESS `bypass_review` is true. The 412 body carries the failing
    review + a freshly-seeded chat `session_id` so the UI can open a "fix
    these findings" conversation in one click.

    Special case: `tbctools-self` is lazy-upserted from settings so a freshly
    configured operator can "Deploy this app" in one click without manually
    creating a project row first.
    """
    if target not in ('production', 'preview'):
        raise HTTPException(400, 'target must be "production" or "preview"')
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')

    # Ship-gate (production deploys only — previews always go through so the
    # operator can sanity-check fixes before re-running the review).
    if target == 'production' and not bypass_review:
        last_review = project.get('last_code_review') or {}
        if last_review.get('verdict') == 'do_not_ship':
            fix_session_id = await _create_fix_review_chat(project, last_review, user_id)
            raise HTTPException(
                412,
                {
                    'error': 'review_blocked',
                    'message': (
                        f"Production deploy blocked by AI code review verdict "
                        f"'{last_review.get('verdict')}'. Resolve the findings or "
                        f"pass bypass_review=true to override."
                    ),
                    'review': last_review,
                    'fix_chat_session_id': fix_session_id,
                },
            )

    res = await _vercel_create_deployment(settings, project, target, git_ref)
    await _record_deployment(project_id, res)
    return {
        'deployment_id': res.get('id') or res.get('uid'),
        'url': res.get('url'),
        'state': res.get('readyState') or res.get('state'),
        'target': res.get('target') or target,
        'project_id': project_id,
    }


async def _trigger_redeploy(project_id: str, settings: dict) -> dict:
    """Shared redeploy implementation — replays the last deployment of the
    project. Raises 400 if no prior deploy exists, 404 if the project doesn't.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    last_id = project.get('last_deployment_id')
    if not last_id:
        raise HTTPException(
            400,
            'No prior deployment to redeploy. Run a regular Deploy first.',
        )
    res = await _vercel_redeploy(settings, last_id)
    await _record_deployment(project_id, res)
    return {
        'deployment_id': res.get('id') or res.get('uid'),
        'url': res.get('url'),
        'state': res.get('readyState') or res.get('state'),
        'project_id': project_id,
    }


@ops_router.post('/{project_id}/deploy')
async def op_deploy_project(
    project_id: str,
    req: DeployRequest,
    user: dict = Depends(get_current_operator),
):
    settings = await get_settings_doc()
    return await _trigger_deploy(
        project_id, settings, req.target, req.git_ref,
        bypass_review=req.bypass_review,
        user_id=user.get('sub'),
    )


@ops_router.post('/{project_id}/redeploy')
async def op_redeploy_project(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    settings = await get_settings_doc()
    return await _trigger_redeploy(project_id, settings)


# ----- AI-agent deploy actions (Bearer-token auth) ---------------------
@projects_router.post('/{project_id}/deploy')
async def ai_deploy_project(
    project_id: str,
    req: DeployRequest,
    settings: dict = Depends(_require_ai_api_key),
):
    """Kick off a deployment for a project the agent owns.

    Combined with the create-or-update `POST /api/projects` endpoint, this
    closes the AI→ship loop: the agent can register a brand-new project and
    immediately ship it without anyone clicking in the operator console.

    Body matches the operator endpoint:
      {"target": "production" | "preview", "git_ref": "main", "bypass_review": false}

    NB: AI-surface callers can also `bypass_review=true`, but the default is
    false so an autonomous agent has to make an explicit decision to override
    its own safety net (the `do_not_ship` ship-gate).
    """
    return await _trigger_deploy(
        project_id, settings, req.target, req.git_ref,
        bypass_review=req.bypass_review,
    )


@projects_router.post('/{project_id}/redeploy')
async def ai_redeploy_project(
    project_id: str,
    settings: dict = Depends(_require_ai_api_key),
):
    """Replay the project's last deployment. Useful for "ship the same code
    again after a config change" without recomputing the source bundle."""
    return await _trigger_redeploy(project_id, settings)


async def _ensure_self_project() -> Optional[dict]:
    """The `tbctools-self` magic project represents the platform itself.

    Operator sets `self_repo`/`self_git_ref`/`self_vercel_project_id` in
    Settings, and this function lazily upserts a corresponding project row so
    every existing endpoint (Deploy/Redeploy/Health/AI surface) works on it
    without any special-casing in the handlers.
    """
    settings = await get_settings_doc()
    repo = (settings or {}).get('self_repo')
    if not repo:
        return None
    git_ref = (settings or {}).get('self_git_ref') or 'main'
    now = datetime.now(timezone.utc)
    doc = {
        'id': SELF_PROJECT_ID,
        'projectName': 'TBC AI Tools (this app)',
        'repo': repo,
        'domain': 'tbctools.org',
        'repoType': 'github',
        'gitRef': git_ref,
        'updated_at': now,
    }
    if (settings or {}).get('self_vercel_project_id'):
        doc['vercel_project_id'] = settings['self_vercel_project_id']
    # Upsert without clobbering deployment history fields.
    await db.deploy_projects.update_one(
        {'id': SELF_PROJECT_ID},
        {'$set': doc, '$setOnInsert': {'created_at': now}},
        upsert=True,
    )
    return await db.deploy_projects.find_one({'id': SELF_PROJECT_ID})


# ---------- Health check helpers --------------------------------------
async def _project_health(project: dict, settings: dict) -> dict:
    """Health snapshot for a single project: HTTP-ping the public domain +
    overlay the last known Vercel deployment state. Used by both the operator
    Health buttons and the AI surface so an autonomous agent can decide
    whether to re-deploy after a failure.
    """
    domain = project.get('domain') or ''
    url = domain if domain.startswith('http') else f'https://{domain}'
    started = datetime.now(timezone.utc)
    http_status: Optional[int] = None
    error: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            r = await client.get(url)
        http_status = r.status_code
    except Exception as e:
        error = str(e)[:200]
    latency_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

    # Best-effort overlay the latest deployment state from Vercel — silent on
    # error so the HTTP ping result still surfaces.
    vercel_state: Optional[str] = project.get('last_deployment_state')
    last_id = project.get('last_deployment_id')
    if last_id and (settings or {}).get('vercel_token'):
        try:
            res = await _vercel_get_deployment(settings, last_id)
            vercel_state = res.get('readyState') or res.get('state') or vercel_state
            await db.deploy_projects.update_one(
                {'id': project['id']},
                {'$set': {'last_deployment_state': vercel_state}},
            )
        except Exception as e:
            logger.info('health: vercel state refresh failed for %s: %s', project['id'], str(e)[:120])

    ok = (
        http_status is not None and 200 <= http_status < 400
        and (vercel_state in (None, 'READY'))
    )
    return {
        'project_id': project['id'],
        'domain': project.get('domain'),
        'ok': ok,
        'http_status': http_status,
        'latency_ms': latency_ms,
        'vercel_state': vercel_state,
        'error': error,
        'checked_at': datetime.now(timezone.utc).isoformat(),
    }


@ops_router.post('/{project_id}/healthcheck')
async def op_project_health(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    """Operator-visible health check for a single deploy project.

    Returns: ok, http_status, latency_ms, vercel_state, error. Updates the
    persisted `last_deployment_state` as a side-effect so the Ops tab stays
    in sync with Vercel without a separate refresh.
    """
    settings = await get_settings_doc()
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        # The self project is lazy — make sure it exists before bailing.
        if project_id == SELF_PROJECT_ID:
            project = await _ensure_self_project()
        if not project:
            raise HTTPException(404, 'Project not found')
    return await _project_health(project, settings)


@projects_router.post('/{project_id}/healthcheck')
async def ai_project_health(
    project_id: str,
    settings: dict = Depends(_require_ai_api_key),
):
    """Same as the operator health check but on the Bearer-auth surface so an
    AI agent can decide whether to redeploy after a failure (ship-and-watch
    + react-and-fix loop)."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    return await _project_health(project, settings)


# ---------- "Deploy this app" shortcut --------------------------------
# These literal routes must register *before* the parameterized
# `/{project_id}/deploy` routes so FastAPI doesn't treat `self` as a project
# id. We re-declare the routers here in a self-contained block so registration
# order is explicit, then re-attach below.
self_ops_router = APIRouter(prefix='/api/operator/deploy', tags=['deploy'])
self_ai_router = APIRouter(prefix='/api/projects', tags=['projects'])


@self_ops_router.post('/self/deploy')
async def op_self_deploy(
    req: DeployRequest,
    user: dict = Depends(get_current_operator),
):
    """One-tap "Deploy this app" — operator button in the Ops tab.

    Lazily creates the self project from `self_repo` in Settings if it doesn't
    yet exist, then triggers a Vercel deploy. Failure modes:
      - 503 "Vercel token not configured"
      - 503 "self_repo not configured" (operator must paste it in Security)
    """
    project = await _ensure_self_project()
    if not project:
        raise HTTPException(
            503,
            'self_repo not configured. Set it in Operator → Security (e.g. "tbctools/platform").',
        )
    settings = await get_settings_doc()
    return await _trigger_deploy(
        SELF_PROJECT_ID, settings, req.target, req.git_ref,
        bypass_review=req.bypass_review,
        user_id=user.get('sub'),
    )


@self_ai_router.post('/self/deploy')
async def ai_self_deploy(
    req: DeployRequest,
    settings: dict = Depends(_require_ai_api_key),
):
    """Same as op_self_deploy but on the AI surface — lets the agent push its
    own improvements end-to-end ("self-grow")."""
    project = await _ensure_self_project()
    if not project:
        raise HTTPException(503, 'self_repo not configured.')
    return await _trigger_deploy(
        SELF_PROJECT_ID, settings, req.target, req.git_ref,
        bypass_review=req.bypass_review,
    )


# ---------- Clone an existing project ("make a copy") ------------------
async def _clone_project(source_id: str, new_name: Optional[str] = None) -> dict:
    """Create a fresh project that mirrors `source_id` (same repo/branch/
    repoType) under a new id. Domain is intentionally blanked so the operator
    sets a new one — two projects can't share the same Vercel domain.

    Special case: cloning `tbctools-self` is allowed and produces a freestanding
    copy of the platform project (operator-owned, not linked to settings)."""
    src = await db.deploy_projects.find_one({'id': source_id})
    if not src and source_id == SELF_PROJECT_ID:
        src = await _ensure_self_project()
    if not src:
        raise HTTPException(404, 'Source project not found')
    now = datetime.now(timezone.utc)
    pid = _gen_project_id(new_name or src['projectName'] + ' Copy')
    doc = {
        'id': pid,
        'projectName': new_name or f"{src['projectName']} (copy)",
        'repo': src['repo'],
        'repoType': src.get('repoType', 'github'),
        'gitRef': src.get('gitRef'),
        # Domain is left blank — Vercel won't accept two projects on one host.
        'domain': '',
        # Fresh deployment history. We *don't* copy vercel_project_id so the
        # first deploy creates a brand-new Vercel project linked to this row.
        'created_at': now,
        'updated_at': now,
    }
    await db.deploy_projects.insert_one(doc)
    logger.info('Cloned project %s → %s', source_id, pid)
    return _project_to_out(doc)


class CloneRequest(BaseModel):
    new_name: Optional[str] = None


@ops_router.post('/{project_id}/clone')
async def op_clone_project(
    project_id: str,
    req: CloneRequest,
    _user: dict = Depends(get_current_operator),
):
    """Make a copy of an existing project (or `tbctools-self`) under a new id.
    The new project has the same repo/branch but a blank domain — the operator
    sets the new domain in the inline editor before the first deploy.
    """
    return {'project': await _clone_project(project_id, req.new_name)}


@projects_router.post('/{project_id}/clone')
async def ai_clone_project(
    project_id: str,
    req: CloneRequest,
    _settings: dict = Depends(_require_ai_api_key),
):
    """Same as op_clone_project, on the AI surface. Useful for "fork this and
    ship a variant" agent flows."""
    return {'project': await _clone_project(project_id, req.new_name)}


# ---------- Inline domain edit (Copy URL UX) ---------------------------
class DomainUpdate(BaseModel):
    domain: str


@ops_router.patch('/{project_id}/domain')
async def op_update_domain(
    project_id: str,
    payload: DomainUpdate,
    _user: dict = Depends(get_current_operator),
):
    """Quick inline domain update — lets the operator paste a new URL into
    a freshly cloned project without leaving the Ops tab.
    """
    domain = payload.domain.strip()
    if not domain:
        raise HTTPException(400, 'Domain is required')
    res = await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'domain': domain, 'updated_at': datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, 'Project not found')
    doc = await db.deploy_projects.find_one({'id': project_id})
    return _project_to_out(doc)


# ===================================================================
# Run Code Review (AI on a project's repo)
# ===================================================================
GITHUB_API = 'https://api.github.com'
# Keep prompt bounded so a huge repo doesn't blow our token budget; we sample
# the highest-signal files (config + entry points + top-level source).
_REVIEW_PER_FILE_CHARS = 6_000
_REVIEW_TOTAL_CHARS = 40_000
# File patterns we ALWAYS try to include if present (high signal).
_REVIEW_PRIORITY_FILES = (
    'README.md', 'readme.md', 'package.json', 'pyproject.toml',
    'requirements.txt', 'tsconfig.json', 'next.config.js', 'next.config.mjs',
    'vercel.json', 'Dockerfile', '.env.example',
)
# Extensions we consider "code" for the secondary sweep.
_REVIEW_CODE_EXTS = ('.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.rb', '.java', '.json', '.md', '.yml', '.yaml')


async def _gh_get_json(client: httpx.AsyncClient, url: str, token: Optional[str], params: Optional[dict] = None):
    headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    r = await client.get(url, headers=headers, params=params)
    if r.status_code == 404:
        return None
    if r.status_code == 403:
        # Rate-limited or auth-required — bubble up a clear message.
        msg = r.json().get('message', 'GitHub rate limit')
        raise HTTPException(502, f'GitHub: {msg}. Configure a github_token in Operator → Security for private repos / higher limits.')
    if r.status_code >= 400:
        raise HTTPException(502, f'GitHub: HTTP {r.status_code} on {url}')
    return r.json()


async def _gh_get_text(client: httpx.AsyncClient, url: str, token: Optional[str]) -> Optional[str]:
    headers = {'Accept': 'application/vnd.github.raw'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    r = await client.get(url, headers=headers)
    if r.status_code >= 400:
        return None
    return r.text


async def _fetch_repo_snapshot(repo: str, git_ref: Optional[str], gh_token: Optional[str]) -> dict:
    """Snapshot the repo's high-signal files for code review.

    Returns a dict with `files: [{path, content, truncated}], file_count, total_chars`.
    Public repos work without a token (rate-limited); private repos require one.
    """
    ref = git_ref or 'main'
    files: list[dict] = []
    total = 0
    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1) Repo metadata so we can resolve the default branch if `ref` is wrong.
        meta = await _gh_get_json(client, f'{GITHUB_API}/repos/{repo}', gh_token)
        if not meta:
            raise HTTPException(404, f'Repo {repo!r} not found on GitHub')
        default_branch = meta.get('default_branch', 'main')
        ref = ref or default_branch

        # 2) Tree of the ref — recursive so we can pick paths without N round-trips.
        # GitHub's tree endpoint may truncate; that's fine for review purposes.
        tree_resp = await _gh_get_json(
            client, f'{GITHUB_API}/repos/{repo}/git/trees/{ref}', gh_token,
            params={'recursive': '1'},
        )
        if not tree_resp:
            # Branch resolution failed — fall back to the repo default.
            tree_resp = await _gh_get_json(
                client, f'{GITHUB_API}/repos/{repo}/git/trees/{default_branch}', gh_token,
                params={'recursive': '1'},
            )
            ref = default_branch
        if not tree_resp:
            raise HTTPException(502, f'GitHub: could not fetch tree for {repo}@{ref}')

        tree = [t for t in (tree_resp.get('tree') or []) if t.get('type') == 'blob']

        # Bucketed selection: priority files first, then small top-level code files.
        chosen_paths: list[str] = []
        # Priority (exact filename match anywhere in repo, prefer root-level).
        for name in _REVIEW_PRIORITY_FILES:
            for t in tree:
                p = t['path']
                if p == name or p.endswith(f'/{name}'):
                    chosen_paths.append(p)
                    break
        # Top-level code files (no slash in path, has a known code ext).
        for t in tree:
            p = t['path']
            if '/' not in p and p.endswith(_REVIEW_CODE_EXTS) and p not in chosen_paths:
                chosen_paths.append(p)
                if len(chosen_paths) >= 20:
                    break
        # Add a few src/* entry points if we still have budget.
        if len(chosen_paths) < 20:
            for t in tree:
                p = t['path']
                if p.startswith(('src/', 'backend/', 'frontend/src/', 'app/')) and p.endswith(_REVIEW_CODE_EXTS):
                    if p not in chosen_paths:
                        chosen_paths.append(p)
                        if len(chosen_paths) >= 30:
                            break

        # 3) Fetch each file's content (cap per-file + cap total).
        for path in chosen_paths:
            if total >= _REVIEW_TOTAL_CHARS:
                break
            content = await _gh_get_text(
                client, f'{GITHUB_API}/repos/{repo}/contents/{path}', gh_token,
            )
            if content is None:
                continue
            truncated = False
            if len(content) > _REVIEW_PER_FILE_CHARS:
                content = content[:_REVIEW_PER_FILE_CHARS]
                truncated = True
            # Trim if adding would exceed total cap.
            if total + len(content) > _REVIEW_TOTAL_CHARS:
                content = content[: max(0, _REVIEW_TOTAL_CHARS - total)]
                truncated = True
            files.append({'path': path, 'content': content, 'truncated': truncated})
            total += len(content)

    return {
        'repo': repo,
        'ref': ref,
        'default_branch': default_branch,
        'files': files,
        'file_count': len(files),
        'total_chars': total,
    }


_CODE_REVIEW_SYSTEM = (
    "You are an expert senior code reviewer. Review the provided files from a "
    "real production repo and return STRICT JSON with the schema:\n"
    "{\n"
    '  "summary": "<one paragraph plain English>",\n'
    '  "verdict": "ship" | "ship_with_fixes" | "do_not_ship",\n'
    '  "findings": [\n'
    "     {\n"
    '       "severity": "high" | "medium" | "low",\n'
    '       "file": "<repo path>",\n'
    '       "line_hint": "<optional snippet or N/A>",\n'
    '       "title": "<short>",\n'
    '       "explanation": "<plain language>",\n'
    '       "suggested_fix": "<concrete code/config change>"\n'
    "     }\n"
    "  ],\n"
    '  "missing_files": ["<file the repo should have but lacks>"]\n'
    "}\n"
    "Focus on: correctness bugs, security holes (secrets, auth, injection), "
    "performance footguns, deployment-readiness, and missing essentials (env "
    "examples, README, build config). Be specific — name files, lines, and the "
    "exact change. Do NOT output anything except the JSON object."
)


async def _run_code_review(project: dict, settings: dict) -> dict:
    """Fetch the repo snapshot, hand it to the LLM, parse JSON. Always returns
    a dict — even on parse failure we surface the raw text so the operator can
    still act on it."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage  # local import to avoid top-level cost

    gh_token = (settings or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
    snapshot = await _fetch_repo_snapshot(project['repo'], project.get('gitRef'), gh_token)
    if not snapshot['files']:
        raise HTTPException(502, f"Could not fetch any source files from {project['repo']}@{snapshot['ref']}")

    # Build the prompt: file listing + each file's content with header.
    file_blocks = []
    for f in snapshot['files']:
        marker = '  [TRUNCATED]' if f['truncated'] else ''
        file_blocks.append(f"--- FILE: {f['path']}{marker} ---\n{f['content']}")
    prompt = (
        f"Repo: {project['repo']}\n"
        f"Branch: {snapshot['ref']}\n"
        f"Project name: {project.get('projectName', '(unnamed)')}\n"
        f"Domain: {project.get('domain', '(unset)')}\n"
        f"Files sampled: {snapshot['file_count']} ({snapshot['total_chars']} chars)\n\n"
        + '\n\n'.join(file_blocks)
        + '\n\nReturn the strict JSON review object now.'
    )

    llm_key = (settings or {}).get('emergent_llm_key') or os.environ.get('EMERGENT_LLM_KEY')
    if not llm_key:
        raise HTTPException(503, 'Emergent LLM key not configured. Set EMERGENT_LLM_KEY in backend env or operator settings.')

    chat = LlmChat(
        api_key=llm_key,
        session_id=f'code-review-{project["id"]}',
        system_message=_CODE_REVIEW_SYSTEM,
    ).with_model('openai', 'gpt-4o')

    try:
        raw = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        raise HTTPException(502, f'LLM error: {str(e)[:300]}')

    # Robust JSON parse: strip ```json fences if the model added them.
    text = (raw or '').strip()
    if text.startswith('```'):
        # remove opening fence (with optional language) and closing fence
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)
    parsed: Optional[dict] = None
    try:
        parsed = json.loads(text)
    except Exception:
        # Best-effort: try to grab the first {...} block.
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None

    review = parsed or {
        'summary': 'LLM returned non-JSON output (shown below in raw_text).',
        'verdict': 'ship_with_fixes',
        'findings': [],
        'missing_files': [],
        'raw_text': text[:6000],
    }
    review['project_id'] = project['id']
    review['repo'] = project['repo']
    review['ref'] = snapshot['ref']
    review['files_sampled'] = [f['path'] for f in snapshot['files']]
    review['reviewed_at'] = datetime.now(timezone.utc).isoformat()

    # Persist last review snapshot on the project so the UI can re-show it
    # after navigation without re-running the AI.
    await db.deploy_projects.update_one(
        {'id': project['id']},
        {'$set': {
            'last_code_review': review,
            'last_code_review_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
        }},
    )
    return review


@ops_router.post('/{project_id}/code-review')
async def op_code_review(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    """Run an AI code review on this project's repo.

    Fetches a snapshot of the repo from GitHub, sends it to the LLM with a
    strict JSON schema prompt, returns findings + suggested fixes. Result is
    cached on the project doc so it survives a refresh.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    settings = await get_settings_doc()
    return await _run_code_review(project, settings)


@projects_router.post('/{project_id}/code-review')
async def ai_code_review(
    project_id: str,
    settings: dict = Depends(_require_ai_api_key),
):
    """Same as op_code_review but on the Bearer-token AI surface — lets an
    autonomous agent gate its ship-and-watch loop on the review verdict."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    return await _run_code_review(project, settings)


# ===================================================================
# Code download (per-project repo zip + self source zip)
# ===================================================================
async def _stream_github_zip(repo: str, ref: Optional[str], gh_token: Optional[str]):
    """Yield bytes from GitHub's zipball endpoint. Public repos work tokenless
    (rate-limited); private repos need `github_token` in operator settings.

    Implemented as a generator so we can `StreamingResponse` directly without
    buffering a 100MB+ repo in memory.
    """
    url = f'{GITHUB_API}/repos/{repo}/zipball'
    if ref:
        url = f'{url}/{ref}'
    headers = {'Accept': 'application/vnd.github+json'}
    if gh_token:
        headers['Authorization'] = f'Bearer {gh_token}'
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        async with client.stream('GET', url, headers=headers) as r:
            if r.status_code == 404:
                raise HTTPException(404, f'Repo {repo!r} or ref {ref!r} not found on GitHub')
            if r.status_code == 403:
                raise HTTPException(
                    502,
                    'GitHub rate limit / auth required. Set github_token in operator settings for private repos.',
                )
            if r.status_code >= 400:
                raise HTTPException(502, f'GitHub: HTTP {r.status_code} fetching zip')
            async for chunk in r.aiter_bytes(64 * 1024):
                yield chunk


@ops_router.get('/{project_id}/download')
async def op_download_project(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    """Download this project's repo as a zip — proxies GitHub's zipball.

    Streams the response so we never buffer the whole archive. For private
    repos the operator must have set `github_token` in settings; otherwise
    GitHub will 404/403 and we surface a friendly error.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    settings = await get_settings_doc()
    gh_token = (settings or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
    ref = project.get('gitRef')
    fname = f"{_slugify(project['projectName'])}-{ref or 'main'}.zip"
    return StreamingResponse(
        _stream_github_zip(project['repo'], ref, gh_token),
        media_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{fname}"'},
    )


@projects_router.get('/{project_id}/download')
async def ai_download_project(
    project_id: str,
    settings: dict = Depends(_require_ai_api_key),
):
    """Same as op_download_project on the Bearer-auth AI surface."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    gh_token = (settings or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
    ref = project.get('gitRef')
    fname = f"{_slugify(project['projectName'])}-{ref or 'main'}.zip"
    return StreamingResponse(
        _stream_github_zip(project['repo'], ref, gh_token),
        media_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{fname}"'},
    )


# ---------- Self-source zip (download THIS app's exact live code) -----
_SELF_SOURCE_ROOT = Path(os.environ.get('SELF_SOURCE_ROOT', '/app'))
# Skip heavy / regenerable / private dirs. These would balloon the zip from
# ~5MB → 1GB+ and aren't useful for forking the platform anyway.
_SELF_EXCLUDE_DIRS = {
    'node_modules', '.git', '.next', '.cache', '.yarn', '.pnpm-store',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.venv', 'venv', 'env',
    'dist', 'build', '.parcel-cache', 'coverage',
    '.emergent',  # platform-internal
}
_SELF_EXCLUDE_FILES = {
    '.DS_Store',
}
# Strip secrets — we *replace* .env files with a template marker so the zip
# never carries live keys but the recipient knows what variables to set.
_SELF_ENV_FILE_NAMES = {'.env', '.env.local', '.env.production'}
_SELF_MAX_FILE_BYTES = 5 * 1024 * 1024  # skip individual files >5MB (e.g. accidental binaries)


def _build_self_zip() -> bytes:
    """Walk /app, zip every code file, strip .env contents and big binaries.
    Returns the zip bytes. Synchronous on purpose — we run it in a thread via
    `asyncio.to_thread` from the handler.
    """
    buf = io.BytesIO()
    root = _SELF_SOURCE_ROOT
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            # Prune excluded dirs IN-PLACE so os.walk doesn't descend into them.
            dirnames[:] = [d for d in dirnames if d not in _SELF_EXCLUDE_DIRS and not d.startswith('.')]
            for fname in filenames:
                if fname in _SELF_EXCLUDE_FILES:
                    continue
                full = Path(dirpath) / fname
                try:
                    size = full.stat().st_size
                except OSError:
                    continue
                if size > _SELF_MAX_FILE_BYTES:
                    continue
                rel = full.relative_to(root)
                # Sanitize .env files: keep the path so the structure is intact,
                # but replace the content with a placeholder.
                if fname in _SELF_ENV_FILE_NAMES:
                    zf.writestr(
                        str(Path('tbctools-self') / rel),
                        '# Live secrets were stripped before download.\n'
                        '# Copy keys from your own deployment / Emergent dashboard.\n',
                    )
                    continue
                try:
                    zf.write(full, arcname=str(Path('tbctools-self') / rel))
                except (OSError, PermissionError):
                    continue
        # Stamp a README so the receiver knows what they got.
        zf.writestr(
            'tbctools-self/DOWNLOAD_README.txt',
            f"TBC AI Tools — live source snapshot\n"
            f"Generated: {datetime.now(timezone.utc).isoformat()}\n"
            f"This is a sanitized copy of /app at the moment of download.\n"
            f"node_modules, .git, .env contents, and other regenerable artifacts were stripped.\n"
            f"To run locally:\n"
            f"  cd backend && pip install -r requirements.txt && uvicorn server:app --reload\n"
            f"  cd frontend && yarn install && yarn start\n"
            f"Configure backend/.env and frontend/.env with your own keys.\n",
        )
    return buf.getvalue()


@ops_router.get('/self/download-app')
async def op_download_self_source(_user: dict = Depends(get_current_operator)):
    """Download THIS app's exact live source as a zip.

    Includes every code/config file under /app except `node_modules`, `.git`,
    `__pycache__`, build dirs, and similar regenerable / private content.
    `.env` files are kept (so the structure is preserved) but their contents
    are replaced with a "set your own keys" placeholder.

    Streams entirely in-memory — for our ~5MB-ish codebase this is fine; for a
    much bigger app we'd switch to a tempfile-backed stream.
    """
    data = await asyncio.to_thread(_build_self_zip)
    fname = f'tbctools-self-{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")}.zip'
    return StreamingResponse(
        iter([data]),
        media_type='application/zip',
        headers={
            'Content-Disposition': f'attachment; filename="{fname}"',
            'Content-Length': str(len(data)),
        },
    )


@projects_router.get('/self/download-app')
async def ai_download_self_source(_settings: dict = Depends(_require_ai_api_key)):
    """AI-surface twin of op_download_self_source — same zip, Bearer auth."""
    data = await asyncio.to_thread(_build_self_zip)
    fname = f'tbctools-self-{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")}.zip'
    return StreamingResponse(
        iter([data]),
        media_type='application/zip',
        headers={
            'Content-Disposition': f'attachment; filename="{fname}"',
            'Content-Length': str(len(data)),
        },
    )


# ===================================================================
# Autopilot — propose → review → ship → watch → react (SSE)
# ===================================================================
class AutopilotRequest(BaseModel):
    target: str = 'preview'           # 'preview' default for safety
    git_ref: Optional[str] = None
    # When True, autopilot continues past a do_not_ship verdict — useful for
    # demos. Default False keeps the safety net.
    bypass_review: bool = False
    # How long to poll Vercel before giving up (seconds). 0 disables watch.
    watch_timeout_s: int = 90


def _sse(event: str, data: dict) -> str:
    """Format an SSE frame. `event:` lines let the EventSource client switch
    on type instead of parsing a `kind` field."""
    payload = json.dumps(data, default=str)
    return f'event: {event}\ndata: {payload}\n\n'


async def _autopilot_stream(project_id: str, settings: dict, req: AutopilotRequest, user_id: Optional[str]):
    """Drive the AI ship-and-watch loop end-to-end. Streams structured
    Server-Sent Events so the operator console can render a live timeline:

        loop_start    → loop has begun, includes project info
        review_start  → fetching repo + running LLM review
        review_done   → review payload (verdict, findings, ...)
        gate_blocked  → do_not_ship + seeded fix chat id; loop ends here
        deploy_start  → calling Vercel
        deploy_state  → polled `readyState` from Vercel (one per poll)
        deploy_ready  → readyState == READY (or ERROR — see `error` field)
        health_check  → final HTTP probe of the deployed URL
        loop_complete → terminal success
        loop_error    → terminal failure (caught exception, etc)

    The stream is run synchronously so the connection stays open until the
    loop terminates — the front-end EventSource closes naturally when we stop
    yielding.
    """
    try:
        project = await db.deploy_projects.find_one({'id': project_id})
        if not project and project_id == SELF_PROJECT_ID:
            project = await _ensure_self_project()
        if not project:
            yield _sse('loop_error', {'message': 'Project not found', 'project_id': project_id})
            return

        yield _sse('loop_start', {
            'project_id': project_id,
            'project_name': project.get('projectName'),
            'repo': project.get('repo'),
            'ref': req.git_ref or project.get('gitRef'),
            'target': req.target,
            'bypass_review': req.bypass_review,
        })

        # ---- Step 1: review ----------------------------------------------
        yield _sse('review_start', {'project_id': project_id})
        try:
            review = await _run_code_review(project, settings)
        except HTTPException as he:
            yield _sse('loop_error', {'stage': 'review', 'status': he.status_code, 'message': str(he.detail)})
            return
        yield _sse('review_done', {
            'verdict': review.get('verdict'),
            'summary': (review.get('summary') or '')[:600],
            'findings_count': len(review.get('findings') or []),
            'findings': (review.get('findings') or [])[:10],
        })

        # ---- Step 2: gate ------------------------------------------------
        if review.get('verdict') == 'do_not_ship' and not req.bypass_review:
            fix_session_id = await _create_fix_review_chat(project, review, user_id)
            yield _sse('gate_blocked', {
                'verdict': review.get('verdict'),
                'fix_chat_session_id': fix_session_id,
                'next_action': 'Open the fix chat or rerun autopilot with bypass_review=true',
            })
            return

        # ---- Step 3: deploy ----------------------------------------------
        yield _sse('deploy_start', {'target': req.target, 'ref': req.git_ref or project.get('gitRef')})
        try:
            deploy_res = await _vercel_create_deployment(settings, project, req.target, req.git_ref)
        except HTTPException as he:
            yield _sse('loop_error', {'stage': 'deploy', 'status': he.status_code, 'message': str(he.detail)})
            return
        await _record_deployment(project_id, deploy_res)
        deployment_id = deploy_res.get('id') or deploy_res.get('uid')
        deployment_url = deploy_res.get('url')
        yield _sse('deploy_started', {
            'deployment_id': deployment_id,
            'url': deployment_url,
            'state': deploy_res.get('readyState') or deploy_res.get('state'),
        })

        # ---- Step 4: watch (poll Vercel) ---------------------------------
        terminal_state = None
        deadline = datetime.now(timezone.utc).timestamp() + max(0, req.watch_timeout_s)
        if deployment_id and req.watch_timeout_s > 0:
            while datetime.now(timezone.utc).timestamp() < deadline:
                await asyncio.sleep(4)
                try:
                    state_res = await _vercel_get_deployment(settings, deployment_id)
                except Exception as e:
                    yield _sse('deploy_state', {'state': 'POLL_ERROR', 'detail': str(e)[:200]})
                    continue
                state = state_res.get('readyState') or state_res.get('state')
                yield _sse('deploy_state', {'state': state, 'deployment_id': deployment_id})
                if state in ('READY', 'ERROR', 'CANCELED'):
                    terminal_state = state
                    break
        yield _sse('deploy_ready', {
            'state': terminal_state or 'WATCH_TIMEOUT',
            'deployment_id': deployment_id,
            'url': deployment_url,
        })

        # ---- Step 5: react (healthcheck) — only on READY -----------------
        if terminal_state == 'READY':
            # Persist the latest state so a subsequent Ops tab refresh is
            # consistent with what we just observed.
            await db.deploy_projects.update_one(
                {'id': project_id},
                {'$set': {'last_deployment_state': 'READY'}},
            )
            fresh = await db.deploy_projects.find_one({'id': project_id}) or project
            health = await _project_health(fresh, settings)
            yield _sse('health_check', health)
            yield _sse('loop_complete', {
                'ok': health.get('ok'),
                'state': terminal_state,
                'url': deployment_url,
            })
        else:
            yield _sse('loop_complete', {
                'ok': False,
                'state': terminal_state or 'WATCH_TIMEOUT',
                'url': deployment_url,
                'message': 'Deploy did not reach READY within the watch window.',
            })

    except Exception as e:  # absolute last-resort safety net
        logger.exception('autopilot crashed for project %s', project_id)
        yield _sse('loop_error', {'stage': 'unexpected', 'message': str(e)[:300]})


def _autopilot_response(project_id: str, settings: dict, req: AutopilotRequest, user_id: Optional[str]):
    """Wrap the async generator in a StreamingResponse with SSE headers."""
    return StreamingResponse(
        _autopilot_stream(project_id, settings, req, user_id),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',  # disable nginx/CF buffering
            'Connection': 'keep-alive',
        },
    )


@ops_router.post('/{project_id}/autopilot')
async def op_autopilot(
    project_id: str,
    req: AutopilotRequest,
    user: dict = Depends(get_current_operator),
):
    """Run the full propose → review → ship → watch → react loop on this
    project and stream progress as Server-Sent Events. Frontend opens an
    `EventSource` on this endpoint (cookie auth) and renders the timeline
    live in the AutopilotDialog.
    """
    settings = await get_settings_doc()
    return _autopilot_response(project_id, settings, req, user.get('sub'))


@projects_router.post('/{project_id}/autopilot')
async def ai_autopilot(
    project_id: str,
    req: AutopilotRequest,
    settings: dict = Depends(_require_ai_api_key),
):
    """AI-surface twin of op_autopilot (Bearer token auth). Same SSE stream."""
    return _autopilot_response(project_id, settings, req, None)


def setup_routers(app):
    """Attach all routers. Literal-path routers are added *first* so they take
    precedence over the parameterized `/{project_id}/...` matches."""
    app.include_router(self_ai_router)
    app.include_router(self_ops_router)
    app.include_router(projects_router)
    app.include_router(ops_router)
