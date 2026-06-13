"""Vercel REST API client helpers.

Extracted from `deploy_projects_ext.py` (Feb 2026) so the routing layer stays
focused on FastAPI handlers and orchestration, while every raw HTTP call to
Vercel lives here. Each helper:

  - Resolves the operator's Vercel PAT via `_vercel_token` (Mongo settings or
    `VERCEL_TOKEN` env var) — raises 503 with a uniform user-facing message
    when missing.
  - Issues a single `httpx.AsyncClient` call.
  - Maps non-2xx into a 502 `HTTPException` carrying a friendly Vercel
    message so the frontend can toast it as-is.

No FastAPI router, no DB writes — pure side-effect functions on the Vercel
REST surface. Callers in `deploy_projects_ext.py` wrap these in their own
DB updates + webhook fires.
"""
import os
from typing import Optional

import httpx
from fastapi import HTTPException

VERCEL_API = 'https://api.vercel.com'

# Terminal Vercel readyStates — when the poller sees one of these it stops.
TERMINAL_STATES = {'READY', 'ERROR', 'CANCELED'}

# Single source of truth for the "Vercel token missing" error so every
# entry-point (deploy / redeploy / promote / health) speaks the same
# language and the frontend can pattern-match on a stable string.
VERCEL_TOKEN_MISSING_DETAIL = (
    'Vercel token not configured. Open the Operator Console → Ops tab '
    '→ Vercel keys card and paste your Personal Access Token. You can '
    'also set the VERCEL_TOKEN env var.'
)


def vercel_team_qs(settings: dict) -> dict:
    tid = (settings or {}).get('vercel_team_id')
    return {'teamId': tid} if tid else {}


def vercel_token(settings: dict) -> str:
    """Resolve the Vercel PAT from (in order):
      1. The operator-managed `settings.vercel_token` row in Mongo.
      2. `VERCEL_TOKEN` env var (handy in CI / containerised deploys
         where the operator hasn't pasted via the UI yet).
    Returns '' if neither is set — callers raise the user-facing 503."""
    token = ((settings or {}).get('vercel_token') or '').strip()
    if token:
        return token
    return (os.environ.get('VERCEL_TOKEN') or '').strip()


async def vercel_create_deployment(
    settings: dict, project: dict, target: str, git_ref: Optional[str],
    name_slug: str,
) -> dict:
    """Trigger `POST /v13/deployments`. Returns the raw Vercel response.

    `name_slug` is supplied by the caller so this module stays free of the
    deploy-projects slug utility (avoids a circular import).
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)

    ref = git_ref or project.get('gitRef') or 'main'
    repo = project['repo']
    repo_type = project.get('repoType', 'github')
    # Vercel's deployments API expects `gitSource.org` + `gitSource.repo`
    # as separate strings (not "owner/name"). Split the stored
    # "owner/name" string so the payload validates.
    if '/' in repo:
        org_part, repo_part = repo.split('/', 1)
    else:
        org_part, repo_part = '', repo
    payload = {
        # Vercel requires `name` even when targeting an existing project.
        'name': name_slug,
        'gitSource': {
            'type': repo_type,
            'org': org_part,
            'repo': repo_part,
            'ref': ref,
        },
    }
    # Vercel's API accepts only 'production', 'staging' or a custom env id
    # for `target`. To request a *preview* deployment, omit the field —
    # Vercel then creates one on a preview alias automatically.
    if target == 'production':
        payload['target'] = 'production'
    if project.get('vercel_project_id'):
        # Existing project — Vercel uses its own stored settings for the
        # build, so we don't need to supply `projectSettings` here.
        payload['project'] = project['vercel_project_id']
    else:
        # New project path — pair with framework override so Vercel
        # doesn't refuse with "projectSettings required".
        payload['projectSettings'] = {'framework': None}

    # `?skipAutoDetectionConfirmation=1` is the Vercel-recommended way to
    # avoid the "projectSettings required" 400 when we hand off framework
    # detection to Vercel itself (the project's existing settings on file
    # take precedence anyway when `payload['project']` is set).
    qs = dict(vercel_team_qs(settings) or {})
    qs['skipAutoDetectionConfirmation'] = '1'
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v13/deployments',
            params=qs,
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


async def vercel_attach_domain(
    settings: dict, vercel_project_id: str, domain: str,
) -> dict:
    """Bind `domain` to the given Vercel project via
    `POST /v10/projects/{id}/domains`. Idempotent — re-adding a domain
    that's already attached returns `{already_attached: True}` instead
    of a hard error so the operator can hit "Save & deploy" repeatedly
    without seeing scary toasts.
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    if not vercel_project_id:
        raise HTTPException(
            400,
            'Project has no vercel_project_id yet — run Deploy once to create '
            'the Vercel project, then save the domain to attach it.',
        )
    # Strip protocol/path so callers can paste a full URL.
    name = domain.strip()
    for prefix in ('https://', 'http://'):
        if name.lower().startswith(prefix):
            name = name[len(prefix):]
    name = name.split('/', 1)[0].rstrip('.')
    if not name:
        raise HTTPException(400, 'Empty domain after normalization')

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v10/projects/{vercel_project_id}/domains',
            params=vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}'},
            json={'name': name},
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        code = err.get('code') or ''
        msg = err.get('message') or 'failed'
        # Vercel returns `domain_already_in_use` when the domain is bound
        # to the SAME project (and a different code when it's on another).
        # We treat "same project" as success.
        if code in {'domain_already_exists', 'domain_already_in_use'} and \
                'this project' in msg.lower():
            return {'already_attached': True, 'name': name, 'message': msg}
        raise HTTPException(502, f'Vercel attach domain: {msg}')
    body = r.json()
    return {'attached': True, 'name': name, 'verified': body.get('verified', False), 'raw': body}


async def vercel_redeploy(settings: dict, deployment_id: str) -> dict:
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v13/deployments/{deployment_id}/redeploy',
            params=vercel_team_qs(settings),
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


async def vercel_get_deployment(settings: dict, deployment_id: str) -> dict:
    """Fetch a deployment by id — used by the watcher and the per-project
    Health Check button. Raises 502 on Vercel-side error, 503 if no token."""
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            f'{VERCEL_API}/v13/deployments/{deployment_id}',
            params=vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}'},
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        raise HTTPException(502, f"Vercel get-deployment: {err.get('message') or err.get('code')}")
    return r.json()


async def vercel_promote_to_production(
    settings: dict, project_vercel_id: str, deployment_id: str,
) -> dict:
    """Promote an already-built preview deployment to production via Vercel's
    project-level promote endpoint.

    Endpoint: `POST /v10/projects/{projectId}/promote/{deploymentId}`
    This reuses the existing build artifact (zero rebuild) — way faster
    than re-deploying from git and the standard pattern for "ship the
    preview I just eyeballed".

    Returns the raw Vercel response (usually a deployment object with
    target='production' once accepted).
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    if not project_vercel_id:
        raise HTTPException(400, 'Project has no vercel_project_id yet — deploy at least once before promoting.')
    if not deployment_id:
        raise HTTPException(400, 'No preview deployment to promote — run Deploy first.')
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v10/projects/{project_vercel_id}/promote/{deployment_id}',
            params=vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}'},
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        msg = err.get('message') or err.get('code') or 'failed'
        # Soft-success: deploy was already promoted (e.g. it landed on the
        # production branch). The operator's intent is satisfied — surface
        # a 200 with an `already_production` flag instead of a hard error.
        if 'already the current production' in msg.lower() or 'already production' in msg.lower():
            return {'already_production': True, 'message': msg}
        raise HTTPException(
            502,
            f"Vercel promote: {msg}",
        )
    # Vercel sometimes returns 200 with empty body — wrap defensively.
    try:
        return r.json() if r.content else {}
    except Exception:
        return {}


async def vercel_list_deployments(
    settings: dict,
    project_vercel_id: str,
    limit: int = 30,
) -> list[dict]:
    """List recent deployments for a project, newest first.

    Used by the dashboard's "Preview Ready" widget to surface every active
    preview branch with a one-click "Promote to prod" button.

    Returns the raw `deployments` array (each entry has uid, url, state,
    target, meta.githubCommitRef, created…). The caller groups by branch
    and dedupes.
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    if not project_vercel_id:
        return []
    params = {'projectId': project_vercel_id, 'limit': str(limit), **vercel_team_qs(settings)}
    async with httpx.AsyncClient(timeout=12.0) as client:
        r = await client.get(
            f'{VERCEL_API}/v6/deployments',
            params=params,
            headers={'Authorization': f'Bearer {token}'},
        )
    if r.status_code >= 400:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:300]}
        raise HTTPException(502, f"Vercel list-deployments: {err.get('message') or err.get('code')}")
    return r.json().get('deployments', [])
