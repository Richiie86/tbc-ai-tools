"""Deploy-projects API + Vercel integration.

Two surfaces:

1. **Operator surface** (`/api/operator/deploy/*`): cookie-authenticated; powers
   the Ops-tab Deploy / Redeploy / Preview buttons. Returns deployment status
   for inline feedback.

2. **AI-agent surface** (`/api/projects/*`): Bearer-token authenticated using
   the `ai_api_key` stored in payment_settings. Lets an external AI program
   create, list, update, and delete deploy projects programmatically — the
   exact contract documented for tbctools.org/api/projects.

Tokens (Vercel PAT, ai_api_key) live in `payment_settings` (Mongo) and are
*never* returned to the browser. The Vercel REST API is called directly with
`httpx.AsyncClient` (no Vercel SDK), following the same pattern as our Stripe
/ NOWPayments integrations.
"""
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


async def _record_deployment(project_id: str, vercel_res: dict) -> None:
    """Persist last-deployment fields onto the project doc so the Ops tab can
    render "Last deployed: 5 min ago · sha · state" without re-querying Vercel.
    """
    proj_vercel_id = vercel_res.get('projectId') or vercel_res.get('project', {}).get('id')
    update = {
        '$set': {
            'last_deployment_id': vercel_res.get('id') or vercel_res.get('uid'),
            'last_deployment_url': vercel_res.get('url'),
            'last_deployment_state': vercel_res.get('readyState') or vercel_res.get('state'),
            'last_deployed_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
        },
    }
    if proj_vercel_id:
        update['$set']['vercel_project_id'] = proj_vercel_id
    await db.deploy_projects.update_one({'id': project_id}, update)


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
    """
    if target not in ('production', 'preview'):
        raise HTTPException(400, 'target must be "production" or "preview"')
    project = await db.deploy_projects.find_one({'id': project_id})
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


def setup_routers(app):
    """Attach both routers to the FastAPI app."""
    app.include_router(projects_router)
    app.include_router(ops_router)
