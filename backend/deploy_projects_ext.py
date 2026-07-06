"""Deploy Projects — GitHub + Vercel integration for the Operator Console.

Provides the /api/operator/deploy endpoints (list, create, trigger, promote)
and the AI-agent surface /api/projects (Bearer token auth, JSON responses).

Core flows:
  • List — paginated project index with last deploy state.
  • Create — link a GitHub repo to a new Vercel project (git-linked).
  • Trigger — POST a deploy (preview or production) and poll to READY.
  • Promote — merge a preview branch to main, then production-deploy main.
  • Autopilot — review → ship → watch → healthcheck (SSE stream, extracted
    to `deploy/autopilot.py` to keep this file under 2k lines).
"""
from __future__ import annotations

import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import (
    APIRouter, Body, Depends, Header, HTTPException, Query, Request, status,
)
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db
from vercel_api_ext import (
    VERCEL_API, vercel_attach_domain, vercel_create_deployment,
    vercel_ensure_project, vercel_team_qs, vercel_token,
)

logger = logging.getLogger(__name__)

ops_router = APIRouter(prefix='/api/operator/deploy', tags=['deploy'])
projects_router = APIRouter(prefix='/api/projects', tags=['projects'])

GITHUB_API = 'https://api.github.com'
SELF_PROJECT_ID = 'platform_self'
PLATFORM_REPO = os.environ.get('PLATFORM_REPO', 'Richiie86/tbc-ai-tools')


async def get_settings_doc() -> dict:
    """Shared settings reader. Returns the singleton payment_settings doc
    (which also holds GitHub / Vercel / Porkbun tokens)."""
    return await db.settings.find_one({'_id': 'payment_settings'}) or {}


def _slugify(name: str) -> str:
    s = re.sub(r'[^a-z0-9]+', '-', (name or '').lower()).strip('-')
    return s[:40] or 'project'


async def _ensure_self_project() -> dict:
    """Lazy-create the platform self-heal project doc when it's missing.
    Returns the upserted doc."""
    now = datetime.now(timezone.utc)
    await db.deploy_projects.update_one(
        {'id': SELF_PROJECT_ID},
        {'$setOnInsert': {
            'id': SELF_PROJECT_ID,
            'projectName': 'TBC Platform (Self)',
            'repo': PLATFORM_REPO,
            'repoType': 'github',
            'gitRef': 'main',
            'created_at': now,
            'updated_at': now,
        }},
        upsert=True,
    )
    return await db.deploy_projects.find_one({'id': SELF_PROJECT_ID})


async def _record_deployment(project_id: str, deploy_res: dict) -> None:
    """Stamp the deploy state on the project doc so the list view is live."""
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {
            'last_deployment_id': deploy_res.get('id') or deploy_res.get('uid'),
            'last_deployment_url': deploy_res.get('url'),
            'last_deployment_state': deploy_res.get('readyState') or deploy_res.get('state'),
            'updated_at': datetime.now(timezone.utc),
        }},
    )


async def _vercel_get_deployment(settings: dict, deployment_id: str) -> dict:
    """Thin wrapper around Vercel's GET /v13/deployments/{id} for polling."""
    token = vercel_token(settings)
    params = dict(vercel_team_qs(settings))
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            f'{VERCEL_API}/v13/deployments/{deployment_id}',
            headers={'Authorization': f'Bearer {token}'},
            params=params,
        )
    if r.status_code >= 400:
        raise HTTPException(502, f'Vercel deployment fetch failed: {r.text[:200]}')
    return r.json()


async def _project_health(project: dict, settings: dict) -> dict:
    """Probe the deployed app's /healthcheck (or root if no health endpoint).
    Returns {ok, status, detail, url, checked_at}.
    
    Enhanced error handling to provide specific diagnostics instead of
    generic 'unknown error'.
    """
    url = project.get('domain') or project.get('last_deployment_url') or ''
    if not url:
        return {'ok': False, 'status': None, 'detail': 'No deployment URL configured', 'url': None}
    
    # Ensure URL has scheme
    if not url.startswith(('http://', 'https://')):
        url = f'https://{url}'
    
    # Try /healthcheck first, fall back to root if 404
    health_url = f'{url}/healthcheck'
    
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            try:
                r = await client.get(health_url)
                endpoint_used = '/healthcheck'
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    # Health endpoint doesn't exist, try root
                    r = await client.get(url)
                    endpoint_used = '/'
                else:
                    raise
            
            ok = 200 <= r.status_code < 400
            
            # Try to parse response body for additional context
            detail = f'HTTP {r.status_code} from {endpoint_used}'
            try:
                body = r.json()
                if isinstance(body, dict):
                    # Extract useful fields from health response
                    if 'status' in body:
                        detail += f", status: {body['status']}"
                    if 'error' in body:
                        detail += f", error: {body['error']}"
                    if 'message' in body:
                        detail += f", message: {body['message'][:100]}"
            except Exception:
                # Not JSON, include first 200 chars of text
                try:
                    text = r.text[:200]
                    if text and not ok:
                        detail += f", body: {text}"
                except Exception:
                    pass
            
            return {
                'ok': ok,
                'status': r.status_code,
                'detail': detail,
                'url': health_url if endpoint_used == '/healthcheck' else url,
                'checked_at': datetime.now(timezone.utc).isoformat(),
            }
    
    except httpx.TimeoutException as e:
        return {
            'ok': False,
            'status': None,
            'detail': f'Request timeout after 15s: {str(e)}',
            'url': health_url,
            'checked_at': datetime.now(timezone.utc).isoformat(),
        }
    except httpx.ConnectError as e:
        return {
            'ok': False,
            'status': None,
            'detail': f'Connection failed (DNS or network error): {str(e)}',
            'url': health_url,
            'checked_at': datetime.now(timezone.utc).isoformat(),
        }
    except httpx.HTTPError as e:
        return {
            'ok': False,
            'status': None,
            'detail': f'HTTP error: {type(e).__name__}: {str(e)[:200]}',
            'url': health_url,
            'checked_at': datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        # Catch-all for any other unexpected errors with full type info
        return {
            'ok': False,
            'status': None,
            'detail': f'Unexpected error ({type(e).__name__}): {str(e)[:200]}',
            'url': health_url,
            'checked_at': datetime.now(timezone.utc).isoformat(),
        }


async def _create_fix_review_chat(project: dict, review: dict, user_id: Optional[str]) -> Optional[str]:
    """Spawn a fix-review chat session pre-seeded with the review findings.
    Returns session_id or None."""
    import uuid
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    findings_blob = '\n'.join(
        f"- [{f.get('severity', 'low').upper()}] {f.get('file', '?')}: {f.get('title', '')}\n"
        f"    {f.get('explanation', '')}\n"
        f"    Suggested fix: {f.get('suggested_fix', '')}"
        for f in (review.get('findings') or [])
    )
    system = (
        f"You are a senior engineer helping fix code-review findings on "
        f"{project.get('projectName')} ({project['repo']}).\n\n"
        f"Review verdict: {review.get('verdict')}\n"
        f"Summary: {review.get('summary', '(none)')}\n\n"
        f"Findings:\n{findings_blob}\n\n"
        "Ask the operator what they'd like to fix first, then guide them through the change."
    )
    await db.chat_sessions.insert_one({
        'id': session_id,
        'user_id': user_id or 'system',
        'title': f"Fix review: {project.get('projectName', 'project')}",
        'model': 'claude-sonnet-4-6',
        'system_message': system,
        'created_at': now,
        'updated_at': now,
    })
    return session_id


async def _require_ai_api_key(authorization: Optional[str] = Header(None)) -> dict:
    """Bearer token gate for the /api/projects surface. Validates against the
    stored ai_api_key (Operator → Security → AI API Key)."""
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Missing Bearer token')
    presented = authorization.split(None, 1)[1].strip()
    settings = await get_settings_doc()
    stored = (settings or {}).get('ai_api_key')
    if not stored or presented != stored:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid API key')
    return settings


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    repo: str = Field(min_length=1, max_length=200)
    git_ref: str = Field(default='main', max_length=100)
    domain: Optional[str] = Field(default=None, max_length=253)


class ProjectPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    domain: Optional[str] = Field(default=None, max_length=253)
    git_ref: Optional[str] = Field(default=None, max_length=100)
    auto_heal: Optional[bool] = None


class TriggerDeploy(BaseModel):
    target: str = Field(default='preview')
    git_ref: Optional[str] = None


class PromoteRequest(BaseModel):
    preview_ref: str


@ops_router.get('')
async def list_projects(
    user: dict = Depends(get_current_operator),
    limit: int = Query(50, ge=1, le=200),
):
    """List all deploy projects (newest first). Each row includes the last
    deploy state so the operator knows which ones are live / errored."""
    cursor = db.deploy_projects.find({}).sort('created_at', -1).limit(limit)
    out = []
    async for p in cursor:
        p.pop('_id', None)
        for k in ('created_at', 'updated_at'):
            if isinstance(p.get(k), datetime):
                p[k] = p[k].isoformat()
        out.append(p)
    return out


@ops_router.post('')
async def create_project(
    body: ProjectCreate,
    request: Request,
    user: dict = Depends(get_current_operator),
):
    """Create a new deploy project. Vercel project is created on first deploy."""
    import uuid
    project_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    doc = {
        'id': project_id,
        'projectName': body.name.strip(),
        'repo': body.repo.strip(),
        'repoType': 'github',
        'gitRef': body.git_ref.strip(),
        'domain': (body.domain or '').strip() or None,
        'created_at': now,
        'updated_at': now,
    }
    await db.deploy_projects.insert_one(doc)
    from audit_ext import record_audit
    await record_audit(
        user, 'deploy.project_create',
        target=project_id,
        details={'name': body.name, 'repo': body.repo},
        request=request,
    )
    doc.pop('_id', None)
    doc['created_at'] = now.isoformat()
    doc['updated_at'] = now.isoformat()
    return doc


@ops_router.patch('/{project_id}')
async def patch_project(
    project_id: str,
    body: ProjectPatch,
    request: Request,
    user: dict = Depends(get_current_operator),
):
    """Partial update a project. Useful for inline domain editor in the list."""
    updates = {}
    if body.name is not None:
        updates['projectName'] = body.name.strip()
    if body.domain is not None:
        d = body.domain.strip()
        updates['domain'] = d if d else None
        # Invalidate CORS cache so the new domain is trusted immediately.
        from cors_dynamic_ext import invalidate_cors_cache
        invalidate_cors_cache()
    if body.git_ref is not None:
        updates['gitRef'] = body.git_ref.strip()
    if body.auto_heal is not None:
        updates['auto_heal'] = bool(body.auto_heal)
    if not updates:
        raise HTTPException(400, 'No fields to update')
    updates['updated_at'] = datetime.now(timezone.utc)
    res = await db.deploy_projects.update_one({'id': project_id}, {'$set': updates})
    if res.matched_count == 0:
        raise HTTPException(404, 'Project not found')
    from audit_ext import record_audit
    await record_audit(
        user, 'deploy.project_patch',
        target=project_id,
        details={'updates': list(updates.keys())},
        request=request,
    )
    fresh = await db.deploy_projects.find_one({'id': project_id})
    fresh.pop('_id', None)
    for k in ('created_at', 'updated_at'):
        if isinstance(fresh.get(k), datetime):
            fresh[k] = fresh[k].isoformat()
    return fresh


@ops_router.delete('/{project_id}')
async def delete_project(
    project_id: str,
    request: Request,
    user: dict = Depends(get_current_operator),
):
    """Hard-delete a project. The linked Vercel project is NOT destroyed."""
    res = await db.deploy_projects.delete_one({'id': project_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Project not found')
    from audit_ext import record_audit
    await record_audit(
        user, 'deploy.project_delete',
        target=project_id,
        request=request,
    )
    return {'deleted': True}


async def _trigger_deploy(
    project_id: str,
    settings: dict,
    target: str,
    git_ref: Optional[str],
    *,
    bypass_review: bool = False,
    user_id: Optional[str] = None,
) -> dict:
    """Core deploy trigger (shared by operator + AI surfaces). Returns the
    Vercel deployment JSON + our stamped metadata."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')

    if target == 'production' and not bypass_review:
        last_review = project.get('last_code_review') or {}
        verdict = last_review.get('verdict')
        if verdict == 'do_not_ship':
            fix_session_id = await _create_fix_review_chat(project, last_review, user_id)
            raise HTTPException(
                403,
                {
                    'error': 'review_gate',
                    'verdict': verdict,
                    'summary': last_review.get('summary'),
                    'fix_chat_session_id': fix_session_id,
                    'message': (
                        'The last code review blocked production deploys. '
                        'Open the fix chat or run autopilot with bypass_review=true.'
                    ),
                },
            )

    ref = git_ref or project.get('gitRef') or 'main'
    slug = _slugify(project['projectName'])

    vercel_pid = project.get('vercel_project_id')
    if not vercel_pid:
        vercel_proj = await vercel_ensure_project(
            settings, slug, project['repo'], project.get('repoType', 'github'), ref,
        )
        vercel_pid = vercel_proj['id']
        await db.deploy_projects.update_one(
            {'id': project_id},
            {'$set': {'vercel_project_id': vercel_pid}},
        )
        project['vercel_project_id'] = vercel_pid

    if project.get('domain'):
        try:
            await vercel_attach_domain(settings, vercel_pid, project['domain'])
        except Exception as e:
            logger.warning('Domain attach failed for %s: %s', project['domain'], e)

    deploy_res = await vercel_create_deployment(settings, project, target, ref, slug)
    await _record_deployment(project_id, deploy_res)
    return deploy_res


@ops_router.post('/{project_id}/trigger')
async def trigger_deploy_op(
    project_id: str,
    body: TriggerDeploy,
    user: dict = Depends(get_current_operator),
):
    """Operator-initiated deploy trigger. Returns the Vercel deployment JSON."""
    settings = await get_settings_doc()
    return await _trigger_deploy(
        project_id, settings, body.target, body.git_ref,
        user_id=user.get('sub'),
    )


@projects_router.post('/{project_id}/trigger')
async def trigger_deploy_ai(
    project_id: str,
    body: TriggerDeploy,
    settings: dict = Depends(_require_ai_api_key),
):
    """AI-agent surface. Bearer token auth, same deploy logic."""
    return await _trigger_deploy(
        project_id, settings, body.target, body.git_ref,
        user_id=None,
    )


@ops_router.post('/{project_id}/promote')
async def promote_preview(
    project_id: str,
    body: PromoteRequest,
    user: dict = Depends(get_current_operator),
):
    """Merge a preview branch to main, then production-deploy main."""
    settings = await get_settings_doc()
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')

    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        raise HTTPException(503, 'GitHub token not configured')

    repo = project['repo']
    base = project.get('gitRef') or 'main'

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f'{GITHUB_API}/repos/{repo}/merges',
            headers={
                'Authorization': f'Bearer {gh_token}',
                'Accept': 'application/vnd.github+json',
            },
            json={'base': base, 'head': body.preview_ref, 'commit_message': f'Promote {body.preview_ref} to {base}'},
        )
    if r.status_code >= 400:
        raise HTTPException(502, f'GitHub merge failed: {r.text[:300]}')

    merge_sha = (r.json() or {}).get('sha')
    deploy_res = await _trigger_deploy(
        project_id, settings, 'production', base,
        user_id=user.get('sub'),
    )
    return {'merged': True, 'merge_sha': merge_sha, 'deployment': deploy_res}


@ops_router.get('/{project_id}/healthcheck')
async def healthcheck_op(
    project_id: str,
    user: dict = Depends(get_current_operator),
):
    """On-demand health probe. Returns {ok, status, detail, checked_at}."""
    settings = await get_settings_doc()
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    return await _project_health(project, settings)


@projects_router.get('/{project_id}/healthcheck')
async def healthcheck_ai(
    project_id: str,
    settings: dict = Depends(_require_ai_api_key),
):
    """AI-agent surface."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    return await _project_health(project, settings)


def setup_routers(app):
    """Called from server.py to mount both routers + the split-out autopilot /
    code_review modules."""
    app.include_router(ops_router)
    app.include_router(projects_router)
    from deploy import autopilot, code_review
    autopilot  # imported for side-effects (registers routes)
    code_review  # ditto
