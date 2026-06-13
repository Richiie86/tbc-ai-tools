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
import json
import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
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


async def _trigger_deploy(project_id: str, settings: dict, target: str, git_ref: Optional[str]) -> dict:
    """Shared deploy implementation. Used by both the operator (cookie auth)
    and AI-agent (Bearer auth) surfaces so the contract stays identical.
    Raises 404 if the project isn't known, 400 if `target` is invalid.

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
    _user: dict = Depends(get_current_operator),
):
    settings = await get_settings_doc()
    return await _trigger_deploy(project_id, settings, req.target, req.git_ref)


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
      {"target": "production" | "preview", "git_ref": "main"}
    """
    return await _trigger_deploy(project_id, settings, req.target, req.git_ref)


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
    _user: dict = Depends(get_current_operator),
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
    return await _trigger_deploy(SELF_PROJECT_ID, settings, req.target, req.git_ref)


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
    return await _trigger_deploy(SELF_PROJECT_ID, settings, req.target, req.git_ref)


def setup_routers(app):
    """Attach all routers. Literal-path routers are added *first* so they take
    precedence over the parameterized `/{project_id}/...` matches."""
    app.include_router(self_ai_router)
    app.include_router(self_ops_router)
    app.include_router(projects_router)
    app.include_router(ops_router)
