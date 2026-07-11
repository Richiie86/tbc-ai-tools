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




def _vercel_error_detail(action: str, response: httpx.Response) -> str:
    """Return a stable, actionable Vercel error string for common statuses.

    Keeps frontend toasts string-compatible while making 400/404/409/429/5xx
    failures clear enough for the autonomous deploy loop to decide whether to
    retry, reconcile, or ask for credentials.
    """
    try:
        err = response.json().get('error', {})
    except Exception:
        err = {'message': response.text[:300]}
    msg = err.get('message') or err.get('code') or response.text[:200] or 'Vercel error'
    code = err.get('code') or 'vercel_error'
    status = response.status_code
    if status == 400:
        hint = 'bad request — check project settings, git ref, or payload shape'
    elif status == 401:
        hint = 'unauthorized — replace the Vercel token in My Keys'
    elif status == 403:
        hint = 'forbidden — token/team does not have access to this project'
    elif status == 404:
        hint = 'not found — the app will try to recreate/relink the Vercel project when possible'
    elif status == 409:
        hint = 'conflict — the target may already exist or already be current'
    elif status == 429:
        hint = 'rate limited — retry after Vercel allows more requests'
    elif status >= 500:
        hint = 'Vercel service error — retry shortly'
    else:
        hint = 'request failed'
    return f'{action}: HTTP {status} ({code}) — {msg}. Next: {hint}.'

def vercel_team_qs(settings: dict) -> dict:
    """Resolve the Vercel team/workspace scope from (in order):
      1. The operator-managed `settings.vercel_team_id` row in Mongo.
      2. `VERCEL_TEAM_ID` env var (so deployments target the right
         workspace even before the operator pastes it via the UI).
    Returns an empty dict when neither is set (personal-scope fallback)."""
    tid = ((settings or {}).get('vercel_team_id') or '').strip()
    if not tid:
        tid = (os.environ.get('VERCEL_TEAM_ID') or '').strip()
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
        raise HTTPException(502, _vercel_error_detail('Vercel deploy', r))
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
        raise HTTPException(502, _vercel_error_detail('Vercel attach domain', r))
    body = r.json()
    return {'attached': True, 'name': name, 'verified': body.get('verified', False), 'raw': body}


async def vercel_redeploy(
    settings: dict, deployment_id: str, name_slug: str = 'project',
) -> dict:
    """Redeploy an existing deployment by replaying it.

    Vercel has NO `POST /v13/deployments/{id}/redeploy` route — calling it
    404s with "The requested API endpoint was not found." The correct way to
    redeploy is `POST /v13/deployments` with the previous deployment's id in
    the body as `deploymentId`; Vercel then rebuilds it, inheriting the
    project's settings and env. `name` is required even for an existing
    project, so callers pass the project's slug.
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    qs = dict(vercel_team_qs(settings) or {})
    qs['skipAutoDetectionConfirmation'] = '1'
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v13/deployments',
            params=qs,
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            json={'name': name_slug, 'deploymentId': deployment_id, 'target': 'production'},
        )
    if r.status_code >= 400:
        raise HTTPException(502, _vercel_error_detail('Vercel redeploy', r))
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
        raise HTTPException(502, _vercel_error_detail('Vercel get-deployment', r))
    return r.json()


async def vercel_domain_config(settings: dict, domain: str) -> dict:
    """Return whether `domain` is correctly pointed at Vercel.

    Uses `GET /v6/domains/{domain}/config` which reports `misconfigured`
    (True when the registrar's DNS records don't point at Vercel yet). This
    is the authoritative "is DNS ready?" signal — far more reliable than a
    raw resolver check because it's exactly what Vercel itself uses to decide
    whether to serve the domain.

    Returns a small dict: `{ready, misconfigured, raw}`. Never raises for a
    "not found"/"still propagating" case — those simply come back as
    `ready=False` so the caller can render a red dot instead of erroring.
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    name = (domain or '').strip().rstrip('.')
    for prefix in ('https://', 'http://'):
        if name.lower().startswith(prefix):
            name = name[len(prefix):]
    name = name.split('/', 1)[0]
    if not name:
        raise HTTPException(400, 'Empty domain')
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            f'{VERCEL_API}/v6/domains/{name}/config',
            params=vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}'},
        )
    # A 4xx here (domain not attached anywhere, still unknown to Vercel, etc.)
    # is a normal "not ready yet" state, not an operator-facing error.
    if r.status_code >= 400:
        return {'ready': False, 'misconfigured': True, 'raw': {'status': r.status_code}}
    body = r.json()
    misconfigured = bool(body.get('misconfigured', True))
    return {'ready': not misconfigured, 'misconfigured': misconfigured, 'raw': body}


async def vercel_find_project_id(settings: dict, name: str) -> Optional[str]:
    """Best-effort resolve a Vercel project id from a project name/slug via
    `GET /v9/projects/{idOrName}`. Returns None (never raises) when the token
    is missing or Vercel doesn't know the name — callers treat that as "can't
    resolve yet" and fall back to other strategies."""
    token = vercel_token(settings)
    if not token or not (name or '').strip():
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f'{VERCEL_API}/v9/projects/{name.strip()}',
                params=vercel_team_qs(settings),
                headers={'Authorization': f'Bearer {token}'},
            )
        if r.status_code >= 400:
            return None
        return r.json().get('id')
    except Exception:
        return None


def vercel_name_slug(name: str) -> str:
    """Turn a human project name into a Vercel-legal project slug.

    Vercel project names must be lowercase, <=100 chars, and contain only
    letters, digits, '.', '_' and '-' (no spaces, no leading/trailing or
    doubled separators). We keep the pretty name in Mongo and only send this
    slug to Vercel so a rename like "My Landing Page" becomes "my-landing-page".
    """
    import re
    s = (name or '').strip().lower()
    s = re.sub(r'[^a-z0-9._-]+', '-', s)   # collapse illegal runs into a hyphen
    s = re.sub(r'-{2,}', '-', s)            # no doubled hyphens
    s = s.strip('-._')                      # no leading/trailing separators
    return s[:100] or 'project'


async def vercel_rename_project(
    settings: dict, id_or_name: str, new_name: str,
) -> dict:
    """Rename the real Vercel project via `PATCH /v9/projects/{idOrName}`.

    This is what makes an in-app rename actually show up in the Vercel
    dashboard (previously the new name only lived in our Mongo record, so
    "Vercel doesn't have the name"). We send a slugified `name` because Vercel
    rejects spaces/uppercase. Best-effort by design: returns a small status
    dict instead of throwing on a soft failure, so a rename in our UI never
    hard-fails just because the Vercel side hiccupped.
    """
    token = vercel_token(settings)
    if not token:
        return {'ok': False, 'reason': 'no_token'}
    if not (id_or_name or '').strip():
        return {'ok': False, 'reason': 'no_project'}
    slug = vercel_name_slug(new_name)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.patch(
                f'{VERCEL_API}/v9/projects/{id_or_name.strip()}',
                params=vercel_team_qs(settings),
                headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
                json={'name': slug},
            )
        if r.status_code >= 400:
            try:
                msg = r.json().get('error', {}).get('message') or r.text[:200]
            except Exception:
                msg = r.text[:200]
            return {'ok': False, 'reason': msg, 'status': r.status_code, 'slug': slug}
        return {'ok': True, 'slug': slug, 'project': r.json()}
    except Exception as e:  # network / timeout — non-fatal
        return {'ok': False, 'reason': str(e)[:200], 'slug': slug}


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
        raise HTTPException(502, _vercel_error_detail('Vercel promote', r))
    # Vercel sometimes returns 200 with empty body — wrap defensively.
    try:
        return r.json() if r.content else {}
    except Exception:
        return {}


async def vercel_ensure_project(
    settings: dict, name_slug: str, repo: str, repo_type: str = 'github',
    git_ref: Optional[str] = None,
) -> dict:
    """Create (or resolve) a Vercel project WITHOUT waiting for a deploy.

    This is what lets "Connect domain" work before the first Deploy: we
    provision the Vercel project up-front (linking the git repo so Vercel then
    auto-builds the production branch), then the caller can attach the domain
    immediately.

    Idempotent-ish: if a project with `name_slug` already exists Vercel returns
    a 409 `conflict`; we fall back to resolving the existing id via
    `vercel_find_project_id` so callers always get an id back.

    Returns `{id, name, created}`.
    """
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, VERCEL_TOKEN_MISSING_DETAIL)
    if not (repo or '').strip():
        raise HTTPException(
            400,
            'Cannot create the Vercel project without a git repo. Add the '
            'owner/name repo to the project first, then connect the domain.',
        )
    payload = {
        'name': name_slug,
        'framework': None,
        'gitRepository': {'type': repo_type or 'github', 'repo': repo},
    }
    if git_ref:
        payload['gitRepository']['sourceless'] = False
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{VERCEL_API}/v10/projects',
            params=vercel_team_qs(settings),
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            json=payload,
        )
    if r.status_code < 400:
        body = r.json()
        return {'id': body.get('id'), 'name': body.get('name'), 'created': True}
    # Already exists (or a name clash) → resolve the existing id.
    try:
        err = r.json().get('error', {})
    except Exception:
        err = {'message': r.text[:300]}
    code = err.get('code') or ''
    if code in {'conflict', 'project_name_already_exists'} or r.status_code == 409:
        existing = await vercel_find_project_id(settings, name_slug)
        if existing:
            return {'id': existing, 'name': name_slug, 'created': False}
    raise HTTPException(502, _vercel_error_detail('Vercel create project', r))


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
        raise HTTPException(502, _vercel_error_detail('Vercel list-deployments', r))
    return r.json().get('deployments', [])
