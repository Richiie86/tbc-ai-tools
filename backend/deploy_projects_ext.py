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
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db
from github_api_ext import GITHUB_API, stream_github_zip
from payments_ext import get_settings_doc
from vercel_api_ext import (
    TERMINAL_STATES,
    VERCEL_API,
    VERCEL_TOKEN_MISSING_DETAIL as _VERCEL_TOKEN_MISSING_DETAIL,
    vercel_attach_domain as _vercel_attach_domain,
    vercel_create_deployment,
    vercel_domain_config as _vercel_domain_config,
    vercel_find_project_id as _vercel_find_project_id,
    vercel_get_deployment as _vercel_get_deployment,
    vercel_promote_to_production as _vercel_promote_to_production,
    vercel_redeploy as _vercel_redeploy,
    vercel_team_qs as _vercel_team_qs,
    vercel_token as _vercel_token,
)

logger = logging.getLogger('tbc')

SELF_PROJECT_ID = 'tbctools-self'

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
    # When true, the watcher auto-fires Promote-to-prod the moment a preview
    # deploy reaches READY *and* the live URL returns HTTP 200. Combined with
    # the existing ship-gate (block on AI `do_not_ship`) this turns the
    # pipeline into "land preview → AI reviews → if green, auto-ship".
    auto_promote: bool = False
    # When true, autopilot defaults to `auto_fix_max_iterations=3` for this
    # project so the AI silently fixes do_not_ship verdicts and reships.
    # The operator can still override per-run. Default off — explicit opt-in
    # because auto-commits to GitHub are irreversible.
    auto_heal: bool = False
    # When true, a deployment that lands in a FAILED terminal state
    # (ERROR/CANCELED) automatically re-promotes the last known-good
    # production deployment, so a broken deploy can't silently persist.
    # Opt-in (like auto_promote/auto_heal) because it changes what production
    # serves without an operator in the loop. A manual Rollback endpoint is
    # always available regardless of this flag.
    auto_rollback: bool = False


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
    # Optional: when set, the Deploy button also connects this domain to the
    # project in the same click (deploy → auto-attach domain). Porkbun domains
    # get their DNS auto-pointed; others come back with manual DNS steps.
    domain: Optional[str] = None


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
    """Strip internal Mongo `_id`, surface only the documented fields.
    Uses .get() everywhere so a partially-seeded or half-migrated doc
    (missing `domain`, `created_at`, etc.) never 500s the whole list."""
    return {
        'id': doc.get('id'),
        'projectName': doc.get('projectName', ''),
        'repo': doc.get('repo', ''),
        'domain': doc.get('domain', ''),
        'repoType': doc.get('repoType', 'github'),
        'gitRef': doc.get('gitRef'),
        'vercel_project_id': doc.get('vercel_project_id'),
        'subdomain': doc.get('subdomain'),
        'subdomain_attached': bool(doc.get('subdomain_attached', False)),
        'auto_promote': bool(doc.get('auto_promote', False)),
        'auto_heal': bool(doc.get('auto_heal', False)),
        'auto_rollback': bool(doc.get('auto_rollback', False)),
        'last_deployment_id': doc.get('last_deployment_id'),
        'last_deployment_url': doc.get('last_deployment_url'),
        'last_deployment_state': doc.get('last_deployment_state'),
        'last_deployed_at': doc.get('last_deployed_at'),
        'last_promoted_at': doc.get('last_promoted_at'),
        'last_good_deployment_id': doc.get('last_good_deployment_id'),
        'last_rollback_at': doc.get('last_rollback_at'),
        'created_at': doc.get('created_at'),
        'updated_at': doc.get('updated_at'),
    }


def _mask_secret(v: Optional[str]) -> Optional[str]:
    """Mask everything except the last 4 characters for safe display."""
    if not v:
        return None
    if len(v) <= 4:
        return '••' + v[-1:]
    return '••••' + v[-4:]


def _project_settings_to_out(doc: dict) -> dict:
    """Operator-only view that exposes presence + masked previews of secrets."""
    raw_env = doc.get('env_vars') or {}
    return {
        'id': doc['id'],
        'projectName': doc['projectName'],
        'admin_email': doc.get('admin_email') or '',
        'admin_password_set': bool(doc.get('admin_password_hash')),
        'env_vars': [
            {'key': k, 'masked': _mask_secret(v), 'present': bool(v)}
            for k, v in raw_env.items()
        ],
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
async def _maybe_auto_promote(
    project_id: str,
    deployment_id: str,
    deploy_url: Optional[str],
    settings: dict,
) -> None:
    """If the project has `auto_promote=true`, poll the preview URL for up
    to 30 s and — when it returns HTTP < 400 — call the promote helper.

    Mirrors the ship-gate philosophy: a successful build alone is not
    enough, the preview must actually respond before we put it in front
    of users. Last AI review (if present) acts as the second gate.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project or not project.get('auto_promote'):
        return

    # Honour the ship-gate: a recent `do_not_ship` review blocks promote
    # just like it would block a manual production deploy. The review is
    # persisted onto the project doc itself as `last_code_review`.
    last_review = (project or {}).get('last_code_review') or {}
    if last_review.get('verdict') == 'do_not_ship':
        logger.info(
            'Auto-promote blocked for %s: latest code review verdict=do_not_ship',
            project_id,
        )
        await _fire_webhook('deploy.auto_promote_blocked', {
            'project_id': project_id,
            'deployment_id': deployment_id,
            'reason': 'do_not_ship',
        }, settings)
        return

    # Probe the preview URL for up to 30 s, 5 s apart. Without this we'd
    # frequently catch the build before Vercel's edge cache warmed up.
    if not deploy_url:
        deploy_url = project.get('last_deployment_url')
    probe_url = (
        deploy_url if (deploy_url and deploy_url.startswith('http'))
        else (f'https://{deploy_url}' if deploy_url else None)
    )
    if not probe_url:
        logger.info('Auto-promote skipped: no preview URL to probe')
        return

    async with httpx.AsyncClient(timeout=5.0) as client:
        for attempt in range(6):  # 6 * 5 s = 30 s
            try:
                r = await client.get(probe_url, follow_redirects=True)
                if r.status_code < 400:
                    break
            except httpx.HTTPError:
                pass
            if attempt < 5:
                await asyncio.sleep(5.0)
        else:
            logger.info('Auto-promote skipped: %s did not return <400 within 30 s', probe_url)
            await _fire_webhook('deploy.auto_promote_blocked', {
                'project_id': project_id,
                'deployment_id': deployment_id,
                'reason': 'preview_health_failed',
                'url': probe_url,
            }, settings)
            return

    # All gates passed → promote.
    try:
        await _trigger_promote(project_id, settings, deployment_id)
        logger.info('Auto-promoted %s → production (deployment %s)', project_id, deployment_id)
    except HTTPException as e:
        logger.warning('Auto-promote final step failed for %s: %s', project_id, e.detail)
        await _fire_webhook('deploy.auto_promote_failed', {
            'project_id': project_id,
            'deployment_id': deployment_id,
            'error': str(e.detail),
        }, settings)


async def _maybe_auto_rollback(
    project_id: str,
    failed_deployment_id: str,
    settings: dict,
) -> None:
    """When a deployment lands in a FAILED terminal state, re-promote the
    project's last known-good deployment so a broken build can't silently
    persist as (or block) production.

    Opt-in via the project's `auto_rollback` flag. Safe + idempotent: if the
    known-good deployment is already the one serving production this simply
    re-asserts it and alerts the operator. If there is no recorded known-good
    deployment we skip (nothing safe to roll back to) and fire a webhook so
    the operator knows manual intervention is needed.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project or not project.get('auto_rollback'):
        return

    good_id = project.get('last_good_deployment_id')
    if not good_id or good_id == failed_deployment_id:
        logger.warning(
            'Auto-rollback for %s: no distinct known-good deployment to roll back to '
            '(failed=%s, known_good=%s)', project_id, failed_deployment_id, good_id,
        )
        await _fire_webhook('deploy.rollback_skipped', {
            'project_id': project_id,
            'failed_deployment_id': failed_deployment_id,
            'reason': 'no_known_good_deployment',
        }, settings)
        return

    try:
        await _trigger_promote(project_id, settings, good_id)
        now = datetime.now(timezone.utc)
        await db.deploy_projects.update_one(
            {'id': project_id},
            {'$set': {'last_rollback_at': now, 'updated_at': now}},
        )
        logger.warning(
            'Auto-rolled back %s to last known-good deployment %s after %s failed',
            project_id, good_id, failed_deployment_id,
        )
        await _fire_webhook('deploy.rolled_back', {
            'project_id': project_id,
            'failed_deployment_id': failed_deployment_id,
            'restored_deployment_id': good_id,
        }, settings)
        # Best-effort operator ping — never blocks the rollback.
        try:
            from webhook_ext import send_event
            await send_event(
                f'Auto-rollback · {project.get("projectName") or project_id} · '
                f'restored {good_id} after {failed_deployment_id} failed',
                kind='rollback',
            )
        except Exception as e:
            logger.warning('rollback send_event failed: %s', e)
    except HTTPException as e:
        logger.error('Auto-rollback FAILED for %s: %s', project_id, e.detail)
        await _fire_webhook('deploy.rollback_failed', {
            'project_id': project_id,
            'failed_deployment_id': failed_deployment_id,
            'restored_deployment_id': good_id,
            'error': str(e.detail),
        }, settings)


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
            # ── auto-promote gate ───────────────────────────────────────
            # Fire only on a clean READY *and* when the project opted in.
            # We also re-check the ship-gate's last review verdict so a
            # `do_not_ship` blocks the auto-promote even though the build
            # itself succeeded.
            if state == 'READY':
                try:
                    await _maybe_auto_promote(project_id, deployment_id, res.get('url'), settings)
                except Exception as e:
                    logger.warning('Auto-promote failed for %s: %s', deployment_id, str(e)[:200])
            else:
                # Failed terminal state (ERROR/CANCELED) → attempt auto-rollback
                # to the last known-good deployment if the project opted in.
                try:
                    await _maybe_auto_rollback(project_id, deployment_id, settings)
                except Exception as e:
                    logger.warning('Auto-rollback failed for %s: %s', deployment_id, str(e)[:200])
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
            doc = payload.model_dump()
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
    doc = payload.model_dump()
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
    """API-key delete path (used by external automation).

    We capture the project's name/repo in the audit row so we can still
    trace what was removed even after the document is gone.
    """
    doc = await db.deploy_projects.find_one({'id': project_id})
    if not doc:
        raise HTTPException(404, 'Project not found')
    res = await db.deploy_projects.delete_one({'id': project_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Project not found')
    try:
        from audit_ext import record_audit
        await record_audit(
            actor={'id': 'system', 'email': 'ai-api-key', 'role': 'system'},
            action='deploy_project.delete',
            target=doc.get('projectName') or project_id,
            details={
                'project_id': project_id,
                'repo': doc.get('repo'),
                'domain': doc.get('domain'),
                'via': 'api_key',
            },
        )
    except Exception:
        # Audit failure must never block the actual deletion.
        pass
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


class OperatorProjectIn(BaseModel):
    """Request body for `POST /api/operator/deploy/projects` (operator create).

    Mirrors the AI-agent `ProjectIn` but lets the operator create a deploy
    project straight from the Ops tab UI — name it up-front, optionally paste
    a custom domain (any registrar, not just tbctools.org) and a repo. The
    domain is stored bare; it attaches to Vercel + auto-configures Porkbun DNS
    on the first Deploy / domain-save so the project goes live on THAT domain.
    """
    projectName: str
    repo: str = ''
    domain: str = ''
    repoType: str = 'github'
    gitRef: Optional[str] = None


@ops_router.post('/projects', status_code=201)
async def op_create_project(
    payload: OperatorProjectIn,
    request: Request,
    op: dict = Depends(get_current_operator),
):
    """Operator-driven create so a human can start a deploy project (with a
    name they choose) without needing the AI API key. Domain is optional at
    create time — it can be pasted/edited inline on the row afterwards."""
    name = (payload.projectName or '').strip()
    if not name:
        raise HTTPException(400, 'Project name is required')
    # Normalize a pasted domain/URL to a bare host (same rule as domain PATCH).
    domain = (payload.domain or '').strip()
    for prefix in ('https://', 'http://'):
        if domain.lower().startswith(prefix):
            domain = domain[len(prefix):]
    domain = domain.split('/', 1)[0].rstrip('.')

    now = datetime.now(timezone.utc)
    pid = _gen_project_id(name)
    doc = {
        'id': pid,
        'projectName': name,
        'repo': (payload.repo or '').strip(),
        'domain': domain,
        'repoType': payload.repoType or 'github',
        'gitRef': payload.gitRef,
        'auto_promote': False,
        'auto_heal': False,
        'auto_rollback': False,
        'created_at': now,
        'updated_at': now,
    }
    await db.deploy_projects.insert_one(doc)
    try:
        from audit_ext import record_audit
        await record_audit(
            op, 'deploy_project.create', target=name,
            details={'project_id': pid, 'repo': doc['repo'], 'domain': domain, 'via': 'operator_ui'},
            request=request,
        )
    except Exception:
        pass
    # NEW (additive, best-effort): give every project an instant
    # `<slug>.tbctools.org` subdomain. Never blocks or alters creation — if
    # anything fails the project is created exactly as before and the
    # subdomain can be assigned later from the Ops tab.
    try:
        from wildcard_bootstrap_ext import assign_subdomain
        sub_res = await assign_subdomain(doc, attach=True)
        doc['subdomain'] = sub_res.get('subdomain')
    except Exception as e:  # pragma: no cover - best-effort
        logger.warning('auto-subdomain assign skipped for %s: %s', pid, e)
    logger.info('Operator created deploy project %s (%s → %s)', pid, doc['repo'], domain or '—')
    return _project_to_out(doc)


@ops_router.get('/key')
async def op_get_key_status(_user: dict = Depends(get_current_operator)):
    """Returns presence flags only — never echoes the token values."""
    settings = await get_settings_doc()
    return {
        # Token presence reports whether EITHER the operator-set value
        # or the VERCEL_TOKEN env-var fallback would resolve.
        'has_vercel_token': bool(_vercel_token(settings)),
        'has_vercel_team_id': bool((settings or {}).get('vercel_team_id')),
        'has_ai_api_key': bool((settings or {}).get('ai_api_key')),
        'has_github_token': bool((settings or {}).get('github_token')),
        'vercel_team_id': (settings or {}).get('vercel_team_id'),
    }


@ops_router.delete('/{project_id}')
async def op_delete_project(
    project_id: str,
    request: Request,
    op: dict = Depends(get_current_operator),
):
    """Operator-driven delete with full audit trail.

    Captures the deleted project's name/repo/domain in the audit row so we
    can answer "where did project X go?" months later. The audit happens
    *after* a successful Mongo delete to keep the rows trustworthy.
    """
    doc = await db.deploy_projects.find_one({'id': project_id})
    if not doc:
        raise HTTPException(404, 'Project not found')
    res = await db.deploy_projects.delete_one({'id': project_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Project not found')
    try:
        from audit_ext import record_audit
        await record_audit(
            op,
            'deploy_project.delete',
            target=doc.get('projectName') or project_id,
            details={
                'project_id': project_id,
                'repo': doc.get('repo'),
                'domain': doc.get('domain'),
                'last_deployment_url': doc.get('last_deployment_url'),
                'via': 'operator_ui',
            },
            request=request,
        )
    except Exception:
        pass
    return {'ok': True, 'deleted_id': project_id}


class KeyUpdate(BaseModel):
    vercel_token: Optional[str] = None
    vercel_team_id: Optional[str] = None
    # GitHub PAT used for private-repo downloads + higher API rate limits on
    # code reviews. Fine-grained tokens with `Contents: Read` on the target
    # repo are enough.
    github_token: Optional[str] = None
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
    if payload.github_token is not None:
        update['github_token'] = payload.github_token.strip() or None

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


# -------------------------------------------------------------------
# Per-project settings (admin email / password / env-var secrets)
# -------------------------------------------------------------------
class ProjectSettingsUpdate(BaseModel):
    """Partial update for the project-level settings page.

    Empty strings on string fields are ignored so the operator can save
    one field at a time without wiping the others. Pass `env_vars` as a
    {key: value} dict — keys present here replace existing values; pass
    an empty string for any value to mark it for deletion.
    """
    admin_email: Optional[str] = None
    admin_password: Optional[str] = None
    env_vars: Optional[dict] = None


@ops_router.get('/{project_id}/settings')
async def op_get_project_settings(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    doc = await db.deploy_projects.find_one({'id': project_id})
    if not doc:
        raise HTTPException(404, 'Project not found')
    return _project_settings_to_out(doc)


@ops_router.put('/{project_id}/settings')
async def op_update_project_settings(
    project_id: str,
    payload: ProjectSettingsUpdate,
    _user: dict = Depends(get_current_operator),
):
    doc = await db.deploy_projects.find_one({'id': project_id})
    if not doc:
        raise HTTPException(404, 'Project not found')

    update: dict = {'updated_at': datetime.now(timezone.utc)}
    if payload.admin_email and payload.admin_email.strip():
        update['admin_email'] = payload.admin_email.strip()
    if payload.admin_password and payload.admin_password.strip():
        # Use bcrypt via passlib so we never store the plaintext password.
        try:
            from passlib.hash import bcrypt
            update['admin_password_hash'] = bcrypt.hash(payload.admin_password)
        except Exception as e:
            raise HTTPException(500, f'Password hashing failed: {e}')
    if payload.env_vars is not None:
        # Merge — empty string deletes, present values replace.
        existing_env = dict(doc.get('env_vars') or {})
        for k, v in payload.env_vars.items():
            key = (k or '').strip()
            if not key:
                continue
            if v is None or (isinstance(v, str) and v.strip() == ''):
                existing_env.pop(key, None)
            else:
                existing_env[key] = str(v)
        update['env_vars'] = existing_env

    await db.deploy_projects.update_one({'id': project_id}, {'$set': update})
    fresh = await db.deploy_projects.find_one({'id': project_id})
    return _project_settings_to_out(fresh)


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
    # Tag the doc so the user-facing sidebar can exclude these auto-seeded
    # "Fix review:" chats — operator explicitly asked for the sidebar to
    # only show conversations they started themselves. The session still
    # exists at its direct URL (returned via the 412 deploy body) so the
    # operator can jump to it when they want — it just won't clutter the
    # "New session" list.
    session_doc = s.model_dump()
    session_doc['kind'] = 'fix_review'
    await db.chat_sessions.insert_one(session_doc)
    msg = ChatMessage(session_id=s.id, user_id=user_id, role='user', content=prompt)
    await db.chat_messages.insert_one(msg.model_dump())
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

    # Repo is the linchpin of every downstream call (Vercel pulls from git,
    # Code Review reads from GitHub, ZIP download streams from GitHub).
    # Surface the precondition with a clear CTA so the operator knows
    # EXACTLY where to go — the legacy behaviour was a confusing
    # "Repo 'foo/bar' not found on GitHub" toast from a downstream 404.
    if not (project.get('repo') or '').strip():
        raise HTTPException(
            412,
            {
                'error': 'repo_not_configured',
                'message': (
                    'No GitHub repo configured for this project. '
                    'Open Operator Console → Settings → "This app source" and '
                    'paste your repo in the form `owner/name` (e.g. `myorg/tbc-tools`). '
                    'Then click Deploy again.'
                ),
                'configure_url': '/operator?tab=settings#self-source',
            },
        )

    # Ship-gate (production deploys only — previews always go through so the
    # operator can sanity-check fixes before re-running the review).
    if target == 'production' and not bypass_review:
        last_review = project.get('last_code_review') or {}
        if last_review.get('verdict') == 'repo_empty':
            # A `repo_empty` verdict is cheap to be WRONG about and expensive
            # for the operator: it hard-blocks the deploy. It's also easy to
            # go stale — the verdict is cached, so once code is pushed the
            # stored `repo_empty` lingers until someone manually re-runs
            # Review. Before blocking, re-check the LIVE repo tree (a single
            # cheap GitHub call, no LLM spend) so a stale verdict can self-heal.
            try:
                from deploy.code_review import fetch_repo_snapshot
                settings_doc = await get_settings_doc()
                gh_token = (settings_doc or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
                snap = await fetch_repo_snapshot(
                    project['repo'], project.get('gitRef'), gh_token,
                )
                live_code_count = snap.get('code_blob_count', 0)
            except Exception:
                # If the re-check fails (rate limit, transient GitHub error),
                # fall back to the cached verdict rather than guessing.
                live_code_count = 0
            if live_code_count > 0:
                # Stale verdict — repo now has real source. Clear the cached
                # `repo_empty` so the gate stops blocking, and let the deploy
                # proceed. The operator can run a full Review post-deploy.
                await db.deploy_projects.update_one(
                    {'id': project_id},
                    {'$unset': {'last_code_review': '', 'last_code_review_at': ''},
                     '$set': {'updated_at': datetime.now(timezone.utc)}},
                )
                last_review = {}
        if last_review.get('verdict') == 'repo_empty':
            # Confirmed empty: nothing to fix because there's no code yet.
            # Operator needs the one-click initial push, not the AI fix
            # chat. Surface a dedicated error so the frontend can render
            # the correct dialog (and stop charging the user to talk to
            # an LLM that can't help here).
            raise HTTPException(
                412,
                {
                    'error': 'repo_empty',
                    'message': (
                        f"The GitHub repo {project.get('repo')!r} has no source code yet. "
                        "Use the one-click 'Push initial code' button to upload this app's "
                        "source, then click Deploy again."
                    ),
                    'review': last_review,
                    'initial_push_url': f'/api/operator/deploy/{project_id}/initial-push',
                    'can_auto_push': True,
                },
            )
        # Operator ship-gate. DEFAULTS TO ADVISORY (False): the AI code review
        # still runs and its do_not_ship verdict is recorded and shown to the
        # operator, but it does NOT hard-block a manual production deploy. The
        # human operator is the final authority over their own deploys. Set
        # `enforce_ship_gate: true` in Operator Settings to restore a hard
        # block (e.g. for fully autonomous, unattended deploys).
        gate_enforced = bool((settings or {}).get('enforce_ship_gate', False))
        if last_review.get('verdict') == 'do_not_ship' and gate_enforced:
            fix_session_id = await _create_fix_review_chat(project, last_review, user_id)
            raise HTTPException(
                412,
                {
                    'error': 'review_blocked',
                    'message': (
                        f"Production deploy blocked by AI code review verdict "
                        f"'{last_review.get('verdict')}'. Resolve the findings, "
                        f"pass bypass_review=true, or turn off 'Enforce AI ship-gate' "
                        f"in Operator Settings to override."
                    ),
                    'review': last_review,
                    'fix_chat_session_id': fix_session_id,
                },
            )

    res = await vercel_create_deployment(
        settings, project, target, git_ref, name_slug=_slugify(project['projectName']),
    )
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
    res = await _vercel_redeploy(
        settings, last_id, name_slug=_slugify(project.get('projectName') or 'project'),
    )
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
    """Trigger a Vercel deploy. Wrapped in defensive error handling so the
    response is ALWAYS a proper JSON body — never a half-written stream
    that Cloudflare surfaces as the dreaded 520 (origin returned invalid
    or incomplete response).

    Production specifically: when Vercel needs to create a new project on
    the first deploy, its `/v13/deployments` call can take 30-60s. Our
    httpx client has a 20s timeout for that exact reason — anything
    longer surfaces as a 502 with a user-actionable message.
    """
    settings = await get_settings_doc()
    try:
        result = await _trigger_deploy(
            project_id, settings, req.target, req.git_ref,
            bypass_review=req.bypass_review,
            user_id=user.get('sub'),
        )
        # One-click "deploy AND connect the domain": when the operator has a
        # domain set for this chat, attach it in the same action so there's no
        # separate Launch step. Best-effort — a domain hiccup never fails the
        # deploy itself; the outcome (incl. any manual DNS steps) rides back on
        # the response under `domain_launch`.
        wanted = (req.domain or '').strip()
        if wanted:
            try:
                from domain_launch_ext import perform_domain_launch
                project = await db.deploy_projects.find_one({'id': project_id}) or {}
                launch = await perform_domain_launch(
                    user, wanted,
                    project_id=project_id,
                    project_name=project.get('projectName'),
                )
                if isinstance(result, dict):
                    result['domain_launch'] = launch
            except HTTPException as de:
                if isinstance(result, dict):
                    result['domain_launch'] = {
                        'ok': False,
                        'domain': wanted,
                        'message': de.detail if isinstance(de.detail, str) else str(de.detail),
                    }
            except Exception as de:  # pragma: no cover - network
                logger.warning('deploy domain auto-connect failed for %s: %s', project_id, de)
                if isinstance(result, dict):
                    result['domain_launch'] = {
                        'ok': False, 'domain': wanted,
                        'message': f'Domain connect skipped: {de}',
                    }
        return result
    except HTTPException:
        # Re-raise FastAPI-level errors verbatim — already JSON-encodable.
        raise
    except (httpx.TimeoutException, asyncio.TimeoutError) as e:
        logger.warning('Vercel deploy timed out for %s: %s', project_id, e)
        raise HTTPException(
            504,
            'Vercel deploy timed out. The build may still be running — '
            'check the Vercel dashboard or click Health in a few seconds.',
        ) from e
    except Exception as e:
        logger.exception('Unexpected deploy error for %s', project_id)
        raise HTTPException(
            502,
            f'Deploy failed: {type(e).__name__}: {str(e)[:200]}',
        ) from e


class PromoteRequest(BaseModel):
    """Optional override — usually we promote `last_deployment_id` but the
    operator may want to ship a specific older preview."""
    deployment_id: Optional[str] = None
    # Closes the loop between Sandbox → preview → production → audit trail.
    # When `auto_tag=true` we create an annotated GitHub tag
    # `prod-YYYY-MM-DD-N` pointing at the promoted commit. When
    # `auto_changelog=true` we prepend an entry to CHANGELOG.md. Both
    # default off — opt-in per promote to avoid surprising the operator.
    auto_tag: bool = False
    auto_changelog: bool = False


@ops_router.post('/{project_id}/redeploy')
async def op_redeploy_project(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    settings = await get_settings_doc()
    return await _trigger_redeploy(project_id, settings)


@ops_router.post('/{project_id}/promote')
async def op_promote_project(
    project_id: str,
    request: Request,
    payload: PromoteRequest = Body(default=None),
    op: dict = Depends(get_current_operator),
):
    """Operator-driven one-click "ship the preview I just looked at" button.
    Promotes the project's last preview deployment to production via
    Vercel's promote API and audit-logs the action with the actor email."""
    settings = await get_settings_doc()
    result = await _trigger_promote(
        project_id, settings, payload.deployment_id if payload else None,
    )
    # ---- optional release-tag + CHANGELOG append --------------------
    # Best-effort: failures are reported alongside the promote result but
    # never roll back the underlying Vercel promote.
    if payload and (payload.auto_tag or payload.auto_changelog):
        try:
            from deploy_release_tag_ext import (
                create_release_tag, prepend_changelog_entry,
            )
            project = await db.deploy_projects.find_one({'id': project_id}) or {}
            repo = project.get('repo')
            # Pull the commit sha that the promoted deployment came from.
            # `_trigger_promote` returns it in `meta.githubCommitSha` when
            # available; otherwise we leave a placeholder.
            commit_sha = (
                (result.get('meta') or {}).get('githubCommitSha')
                or result.get('commit_sha')
                or ''
            )
            branch = (
                (result.get('meta') or {}).get('githubCommitRef')
                or project.get('gitRef')
                or 'main'
            )
            tag_info = None
            if payload.auto_tag and repo and commit_sha:
                tag_info = await create_release_tag(
                    settings, repo, commit_sha,
                    message=f"Promoted {project.get('name') or project_id} via TBC autopilot",
                )
                result['release_tag'] = tag_info or {'error': 'tag_creation_failed'}
            if payload.auto_changelog and repo and tag_info and tag_info.get('tag'):
                changelog = await prepend_changelog_entry(
                    settings, repo, branch,
                    tag_info['tag'], commit_sha,
                    project.get('name') or project_id,
                    op.get('email') or 'unknown',
                )
                result['changelog'] = (
                    {'sha': changelog.get('sha'), 'message': changelog.get('message')}
                    if changelog else {'error': 'changelog_write_failed'}
                )
                # Also write an in-app changelog entry so the "What's new"
                # popover surfaces this promote to end users without
                # needing to read GitHub. Best-effort — never blocks.
                try:
                    from changelog_ext import _insert_entry
                    await _insert_entry(
                        title=f"{tag_info['tag']} — {project.get('name') or project_id}",
                        body_md=(
                            f"Promoted to production from `{branch}` "
                            f"({commit_sha[:8] if commit_sha else ''}).\n\n"
                            f"By {op.get('email') or 'unknown'}."
                        ),
                        tag=tag_info['tag'],
                        project=project.get('name') or project_id,
                        source='promote',
                        author_email=op.get('email'),
                    )
                except Exception:
                    logger.exception('in-app changelog entry failed')
        except Exception:
            # Never block the operator's promote on the audit-trail layer.
            logger.exception('release-tag / changelog post-promote failed')
    try:
        from audit_ext import record_audit
        await record_audit(
            op,
            'deploy_project.promote',
            target=project_id,
            details={
                'deployment_id': result.get('promoted_deployment_id'),
                'url': result.get('url'),
                'production_url': result.get('production_url'),
            },
            request=request,
        )
    except Exception:
        # Audit failures must never block the operator action.
        pass
    return result


class ProjectFlagsUpdate(BaseModel):
    """Partial flag update for the per-project Settings page.

    Currently only carries `auto_promote` but kept as a model so we can
    add more toggles (auto_redeploy_on_push, slack_notify_on_fail, ...)
    without churning the endpoint signature.
    """
    auto_promote: Optional[bool] = None
    auto_heal: Optional[bool] = None
    auto_rollback: Optional[bool] = None
    # Editable identity fields so the operator can rename a project (or fix
    # its repo / branch) after creation, right from the Ops row.
    projectName: Optional[str] = None
    repo: Optional[str] = None
    gitRef: Optional[str] = None


@ops_router.patch('/{project_id}')
async def op_patch_project_flags(
    project_id: str,
    payload: ProjectFlagsUpdate,
    op: dict = Depends(get_current_operator),
):
    """Toggle per-project automation flags AND edit identity fields
    (projectName / repo / gitRef) so a project can be renamed after creation."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    update: dict = {'updated_at': datetime.now(timezone.utc)}
    if payload.auto_promote is not None:
        update['auto_promote'] = bool(payload.auto_promote)
    if payload.auto_heal is not None:
        update['auto_heal'] = bool(payload.auto_heal)
    if payload.auto_rollback is not None:
        update['auto_rollback'] = bool(payload.auto_rollback)
    if payload.projectName is not None:
        new_name = payload.projectName.strip()
        if not new_name:
            raise HTTPException(400, 'Project name cannot be empty')
        update['projectName'] = new_name
    if payload.repo is not None:
        update['repo'] = payload.repo.strip()
    if payload.gitRef is not None:
        update['gitRef'] = payload.gitRef.strip() or None
    await db.deploy_projects.update_one({'id': project_id}, {'$set': update})
    fresh = await db.deploy_projects.find_one({'id': project_id})
    return _project_to_out(fresh)


@ops_router.post('/{project_id}/rollback')
async def op_rollback_project(
    project_id: str,
    op: dict = Depends(get_current_operator),
):
    """Manually roll production back to the last known-good deployment.

    Always available to the operator (independent of the `auto_rollback`
    flag) so a broken production deploy can be recovered with one click.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    good_id = project.get('last_good_deployment_id')
    if not good_id:
        raise HTTPException(
            400,
            'No known-good deployment recorded yet. Promote a working deploy '
            'first, then rollback becomes available.',
        )
    settings = await get_settings_doc()
    result = await _trigger_promote(project_id, settings, good_id)
    now = datetime.now(timezone.utc)
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'last_rollback_at': now, 'updated_at': now}},
    )
    await _fire_webhook('deploy.rolled_back', {
        'project_id': project_id,
        'restored_deployment_id': good_id,
        'manual': True,
    }, settings)
    return {'ok': True, 'restored_deployment_id': good_id, **result}


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


async def _trigger_promote(project_id: str, settings: dict, deployment_id: Optional[str] = None) -> dict:
    """Shared promote-to-prod path used by both the AI API and the operator
    endpoints. Promotes the project's last preview (or the supplied
    `deployment_id`) to production via Vercel's promote API, writes an
    audit-flavoured note onto the project doc, and fires the standard
    outbound webhook so external watchers stay in sync.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    target_id = deployment_id or project.get('last_deployment_id')
    if not target_id:
        raise HTTPException(
            400,
            'No preview deployment recorded yet. Run Deploy first, then promote.',
        )
    result = await _vercel_promote_to_production(
        settings, project.get('vercel_project_id'), target_id,
    )
    now = datetime.now(timezone.utc)
    promoted_url = (
        result.get('url')
        or result.get('alias', [None])[0] if isinstance(result.get('alias'), list)
        else result.get('url')
    ) or project.get('last_deployment_url')
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {
            'last_promoted_at': now,
            'last_promoted_deployment_id': target_id,
            # A successfully promoted deployment is our best "known-good"
            # production artifact, and becomes the target for auto-rollback
            # if a later deploy fails.
            'last_good_deployment_id': target_id,
            'last_deployment_state': 'PROMOTED',
            'updated_at': now,
        }},
    )
    await _fire_webhook(
        'deploy.promoted',
        {
            'project_id': project_id,
            'deployment_id': target_id,
            'promoted_url': promoted_url,
            'project_name': project.get('projectName'),
            'domain': project.get('domain'),
        },
        settings=settings,
    )
    # Best-effort Slack/Discord notification — never blocks promote success.
    try:
        from webhook_ext import send_event
        await send_event(
            f'Promoted to production · {project.get("projectName") or project_id} · {promoted_url or ""}',
            kind='promote',
        )
    except Exception as e:
        logger.warning('promote send_event failed: %s', e)
    return {
        'ok': True,
        'project_id': project_id,
        'promoted_deployment_id': target_id,
        'url': promoted_url,
        'production_url': f"https://{project['domain']}" if project.get('domain') else promoted_url,
        'promoted_at': now.isoformat(),
    }


class PromoteRequest_AI_Compat(BaseModel):
    """[deprecated duplicate — kept as no-op placeholder]"""
    deployment_id: Optional[str] = None


@projects_router.post('/{project_id}/promote')
async def ai_promote_project(
    project_id: str,
    req: PromoteRequest = Body(default=None),
    settings: dict = Depends(_require_ai_api_key),
):
    """Promote the last (or specified) preview deployment to production.
    Reuses the built artifact — no rebuild, no git fetch. Standard
    "ship what I just eyeballed" flow."""
    return await _trigger_promote(project_id, settings, (req.deployment_id if req else None))


async def _ensure_self_project() -> Optional[dict]:
    """The `tbctools-self` magic project represents the platform itself.

    Always upserts a project row so the Operator Console + Dashboard "No
    projects" dropdown always has at least ONE entry. Fields are split:

      - `$setOnInsert` for fields the operator may curate (`repo`,
        `domain`, `vercel_project_id`) — set on first insert only,
        never clobbered on subsequent list calls.
      - `$set` for `updated_at` only.

    `repo` defaults to an EMPTY string when no `self_repo` setting is
    saved. The operator's first Deploy/Review click then surfaces a
    friendly 412 with a "Configure repo in Settings" CTA, instead of
    silently failing with a "Repo not found on GitHub" toast (which
    is what happened when we used a placeholder like
    `rac-investments/tbc-self-copy`).
    """
    settings = await get_settings_doc()
    # Fallback chain for the repo:
    #   1. `payment_settings.self_repo` (operator-set via Settings UI)
    #   2. `OPERATOR_DEFAULT_REPO` env var (per-deployment default)
    #   3. '' (empty → first Deploy click surfaces a "Configure now" 412)
    # The env-var hook lets a fresh production deploy auto-fill the
    # operator's real GitHub repo without them ever opening Settings.
    repo = (
        (settings or {}).get('self_repo')
        or os.environ.get('OPERATOR_DEFAULT_REPO', '')
    ).strip()
    git_ref = (settings or {}).get('self_git_ref') or 'main'
    domain = (settings or {}).get('self_domain') or 'tbctools.org'
    now = datetime.now(timezone.utc)
    insert_doc = {
        'id': SELF_PROJECT_ID,
        'projectName': 'TBC AI Tools (this app)',
        'repo': repo,
        'domain': domain,
        'repoType': 'github',
        'gitRef': git_ref,
        'created_at': now,
        # NOTE: `updated_at` is intentionally NOT here — `$set` already
        # writes it on every call. Mongo rejects the operation if both
        # `$set` and `$setOnInsert` touch the same field.
    }
    if (settings or {}).get('self_vercel_project_id'):
        insert_doc['vercel_project_id'] = settings['self_vercel_project_id']
    await db.deploy_projects.update_one(
        {'id': SELF_PROJECT_ID},
        {
            '$set': {'updated_at': now},
            '$setOnInsert': insert_doc,
        },
        upsert=True,
    )
    # ONE-SHOT REPAIR: an earlier version of this function seeded the
    # placeholder `rac-investments/tbc-self-copy` via `$set`, which
    # clobbered the operator's real repo on production. Detect that
    # exact dead value and clear it back to '' so the operator's next
    # click surfaces the "Configure repo" CTA instead of "Repo not
    # found on GitHub". Safe to keep long-term — only matches the
    # exact known-bad string we wrote ourselves.
    bad_repo = 'rac-investments/tbc-self-copy'
    await db.deploy_projects.update_one(
        {'id': SELF_PROJECT_ID, 'repo': bad_repo},
        {'$set': {'repo': '', 'updated_at': now}},
    )
    # ---- Auto-detect repo from clone history -------------------------
    # If `repo` is still empty, look at any other deploy_projects row
    # the operator has created (clones, manual rows, prior deploys).
    # Most operators have already typed their real repo somewhere, so
    # we can save them the trip to Settings entirely by re-using it.
    # We pick the most-recently-updated non-self row to favour the
    # operator's current active project.
    self_doc = await db.deploy_projects.find_one({'id': SELF_PROJECT_ID})
    if not (self_doc or {}).get('repo'):
        recent = await db.deploy_projects.find_one(
            {
                'id': {'$ne': SELF_PROJECT_ID},
                'repo': {'$nin': [None, '', 'rac-investments/tbc-self-copy']},
            },
            sort=[('updated_at', -1)],
        )
        detected = (recent or {}).get('repo')
        # Second fallback: env-var default. Lets a fresh production deploy
        # auto-fill the operator's repo even when their DB has no clone
        # history yet (the common case right after a brand-new deploy).
        if not detected:
            detected = os.environ.get('OPERATOR_DEFAULT_REPO', '').strip()
        if detected:
            await db.deploy_projects.update_one(
                {'id': SELF_PROJECT_ID},
                {'$set': {
                    'repo': detected,
                    'gitRef': (recent or {}).get('gitRef') or 'main',
                    'updated_at': now,
                }},
            )
            logger.info('Auto-filled self repo: %s (source=%s)',
                        detected, 'clone-history' if recent else 'env-var')
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
async def _resolve_vercel_project_id(doc: dict, settings: dict) -> Optional[str]:
    """Resolve (and persist) the Vercel project id for a deploy-project doc.

    The domain-attach flow used to silently no-op whenever `vercel_project_id`
    was missing — which is the norm for the "This app" self-project and for
    any freshly-created project that has only ever been deployed by name. That
    made the Launch button appear to "do nothing". This resolver fills the gap
    with three best-effort strategies, in order:

      1. The id already stored on the doc.
      2. The `projectId` reported by the project's last deployment (most
         reliable right after a Deploy — which is exactly when operators try
         to launch a domain).
      3. A name lookup on Vercel (`GET /v9/projects/{slug}`).

    Whatever it finds is written back onto the doc so future launches are
    instant. Returns None only when every strategy comes up empty.
    """
    existing = (doc or {}).get('vercel_project_id')
    if existing:
        return existing

    resolved: Optional[str] = None
    # Strategy 2 — ask the last deployment who its project is.
    dep_id = (doc or {}).get('last_deployment_id')
    if dep_id:
        try:
            dep = await _vercel_get_deployment(settings, dep_id)
            resolved = dep.get('projectId') or (dep.get('project') or {}).get('id')
        except Exception as e:
            logger.info('Resolve project id via deployment failed: %s', str(e)[:120])

    # Strategy 3 — look the project up by its slug/name.
    if not resolved:
        name = _slugify((doc or {}).get('projectName') or '')
        resolved = await _vercel_find_project_id(settings, name)

    # Strategy 4 (NEW) — nothing exists on Vercel yet, so CREATE the project
    # from the doc's repo. This is what lets "Connect domain" work on a
    # never-deployed project: we provision the Vercel project up-front (linked
    # to the repo so Vercel auto-builds production) instead of forcing a manual
    # Deploy first. Only attempted when a repo is set.
    if not resolved and (doc or {}).get('repo'):
        try:
            from vercel_api_ext import vercel_ensure_project
            ensured = await vercel_ensure_project(
                settings,
                _slugify((doc or {}).get('projectName') or 'project'),
                doc['repo'],
                (doc or {}).get('repoType', 'github'),
                (doc or {}).get('gitRef'),
            )
            resolved = ensured.get('id')
        except Exception as e:
            logger.info('Auto-create Vercel project failed: %s', str(e)[:160])

    if resolved:
        await db.deploy_projects.update_one(
            {'id': (doc or {}).get('id')},
            {'$set': {'vercel_project_id': resolved, 'updated_at': datetime.now(timezone.utc)}},
        )
    return resolved


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

    Also best-effort attaches the domain on Vercel (`POST /v10/projects/{id}/domains`)
    so subsequent Deploy buttons can route traffic immediately. Attach failures
    do NOT block the Mongo save — operators can still Deploy and let Vercel
    auto-attach on first push — but the response includes `vercel_attached: bool`
    + `vercel_error: str|null` so the UI can show a friendly secondary toast.
    """
    domain = payload.domain.strip()
    if not domain:
        raise HTTPException(400, 'Domain is required')
    # Strip protocol/path so a pasted URL becomes a bare host.
    for prefix in ('https://', 'http://'):
        if domain.lower().startswith(prefix):
            domain = domain[len(prefix):]
    domain = domain.split('/', 1)[0].rstrip('.')
    if not domain:
        raise HTTPException(400, 'Empty domain after normalization')

    res = await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'domain': domain, 'updated_at': datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, 'Project not found')
    doc = await db.deploy_projects.find_one({'id': project_id})
    # Auto-allowlist this domain for CORS so the browser can hit /api
    # from `https://{domain}` on the next page load. Lazy import keeps
    # cors_dynamic_ext optional in test contexts that don't load it.
    try:
        from cors_dynamic_ext import invalidate_cors_cache
        invalidate_cors_cache()
    except Exception:
        pass

    # Best-effort Vercel attach. We now auto-resolve the Vercel project id
    # when it's missing (self-project / freshly-deployed projects), so the
    # Launch button actually attaches instead of silently no-opping.
    settings = await get_settings_doc()
    vercel_attached = False
    vercel_error: Optional[str] = None
    vercel_project_id = await _resolve_vercel_project_id(doc, settings)
    if vercel_project_id:
        try:
            await _vercel_attach_domain(settings, vercel_project_id, domain)
            vercel_attached = True
        except HTTPException as e:
            vercel_error = e.detail if isinstance(e.detail, str) else str(e.detail)
            logger.info(
                'Vercel attach skipped for project %s (%s): %s',
                project_id, domain, vercel_error,
            )
        except Exception as e:  # network / unexpected — non-fatal
            vercel_error = f'Vercel attach failed: {e}'
            logger.warning('Vercel attach unexpected error: %s', e)
    else:
        # We now self-provision the Vercel project from the repo, so the only
        # way to land here is a project with NO repo set. Tell the operator
        # exactly what unblocks it instead of silently no-opping.
        vercel_error = (
            'This project has no git repo set, so a Vercel project can\'t be '
            'created automatically. Add the owner/name repo to the project, '
            'then Launch the domain — it will attach automatically.'
        )

    # Auto-point the domain's DNS at Vercel via the connected Porkbun account
    # so it goes live on THIS domain directly (any registrar the operator uses
    # through Porkbun). Fully best-effort: a missing Porkbun connection or a
    # domain hosted elsewhere just skips silently with a friendly note.
    dns_configured = False
    dns_error: Optional[str] = None
    try:
        from porkbun_ext import configure_vercel_dns
        dns_res = await configure_vercel_dns(domain)
        dns_configured = bool(dns_res.get('ok'))
    except HTTPException as e:
        dns_error = e.detail if isinstance(e.detail, str) else str(e.detail)
    except Exception as e:  # network / unexpected — non-fatal
        dns_error = f'Porkbun DNS setup skipped: {e}'
        logger.warning('Porkbun DNS auto-config error for %s: %s', domain, e)

    out = _project_to_out(doc)
    out['vercel_attached'] = vercel_attached
    out['vercel_error'] = vercel_error
    out['dns_configured'] = dns_configured
    out['dns_error'] = dns_error
    return out


@ops_router.get('/dns-status')
async def op_dns_status(_user: dict = Depends(get_current_operator)):
    """Live DNS readiness for every project that has a custom domain.

    Powers the dashboard's DNS sidebar: each domain gets a red/green dot
    (`ready` bool) sourced from Vercel's authoritative
    `GET /v6/domains/{domain}/config` (`misconfigured=false` ⇒ ready). The
    tbctools.org self-domain is skipped — it's the platform's own host, not a
    launched customer domain, so it never needs a readiness dot.

    Shape:
      { ready: bool,                 # true only when ALL domains are ready
        total: int, ready_count: int,
        domains: [{project_id, projectName, domain, ready, checked}] }

    Fully best-effort: a missing Vercel token or a per-domain lookup error
    just yields `ready=False, checked=False` for that row instead of 500ing
    the whole sidebar.
    """
    settings = await get_settings_doc()
    await _ensure_self_project()
    self_domain = ((settings or {}).get('self_domain') or 'tbctools.org').strip().lower()

    rows: list[dict] = []
    cursor = db.deploy_projects.find({}).sort('updated_at', -1)
    async for d in cursor:
        domain = (d.get('domain') or '').strip().lower()
        # Skip empty domains and the platform's own host.
        if not domain or domain == self_domain:
            continue
        rows.append({
            'project_id': d.get('id'),
            'projectName': d.get('projectName') or d.get('id'),
            'domain': domain,
        })

    async def _check(row: dict) -> dict:
        try:
            cfg = await _vercel_domain_config(settings, row['domain'])
            return {**row, 'ready': bool(cfg.get('ready')), 'checked': True}
        except HTTPException as e:
            # 503 (no token) or 4xx — surface as "unknown" rather than error.
            return {**row, 'ready': False, 'checked': False,
                    'note': e.detail if isinstance(e.detail, str) else 'unavailable'}
        except Exception:
            return {**row, 'ready': False, 'checked': False}

    checked = await asyncio.gather(*[_check(r) for r in rows]) if rows else []
    ready_count = sum(1 for r in checked if r.get('ready'))
    return {
        'ready': bool(checked) and ready_count == len(checked),
        'total': len(checked),
        'ready_count': ready_count,
        'domains': list(checked),
    }



# ===================================================================
# Code download (per-project repo zip + self source zip)
# ===================================================================
# `GITHUB_API` + `stream_github_zip` come from `github_api_ext`. The
# `_stream_github_zip` alias keeps the existing call sites untouched.
_stream_github_zip = stream_github_zip


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
                        '# Copy keys from your own deployment dashboard.\n',
                    )
                    continue
                try:
                    zf.write(full, arcname=str(Path('tbctools-self') / rel))
                except (OSError, PermissionError):
                    continue
        # Stamp a README so the receiver knows what they got. The wording
        # is deliberately explicit: this is the SKELETON only — no users,
        # payments, API tokens, deploy targets, audit log, or any other
        # operator data lives in this zip. The recipient must register
        # for every third-party service from scratch.
        zf.writestr(
            'tbctools-self/DOWNLOAD_README.txt',
            (
                'TBC AI Tools — live source snapshot (skeleton only)\n'
                f'Generated: {datetime.now(timezone.utc).isoformat()}\n'
                '\n'
                'WHAT THIS ZIP CONTAINS\n'
                '  • Frontend (React) and backend (FastAPI) source code only.\n'
                '  • Empty database — no users, payments, deploy targets,\n'
                '    chat history, audit log, referrals, or operator account.\n'
                '  • Empty .env files (placeholders) — every API key MUST be\n'
                '    obtained by the recipient from the original vendor.\n'
                '\n'
                'WHAT THIS ZIP DOES NOT CONTAIN (and never will)\n'
                '  • Vercel access tokens, project IDs, or deploy history.\n'
                '  • GitHub personal-access tokens or webhook secrets.\n'
                '  • Stripe / PayPal / NOWPayments API keys or webhook secrets.\n'
                '  • Resend / SendGrid / OpenAI / Anthropic / Gemini API keys.\n'
                '  • Any customer data, payment history, or audit trail.\n'
                '  • The operator account email/password — you set one up\n'
                '    on first boot via the seed script.\n'
                '\n'
                'TO RUN THIS LOCALLY\n'
                '  1. cd backend && pip install -r requirements.txt\n'
                '  2. cd frontend && yarn install\n'
                '  3. Set MONGO_URL + DB_NAME in backend/.env\n'
                '  4. Set REACT_APP_BACKEND_URL in frontend/.env\n'
                '  5. Start: uvicorn server:app --reload   |   yarn start\n'
                '  6. Register your own integrations and paste keys via the\n'
                '     Operator Console → Security tab.\n'
                '\n'
                'In other words: this is a clean foundation. Every account,\n'
                'every cent of revenue, every customer relationship, and\n'
                'every third-party integration must be built up by you from\n'
                'zero — the original operator\'s data stays with the original\n'
                'operator.\n'
            ),
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


def setup_routers(app):
    """Attach all routers. Literal-path routers are added *first* so they take
    precedence over the parameterized `/{project_id}/...` matches.

    Importing the `deploy` submodules here (rather than at top of file)
    avoids a circular import — those modules import shared helpers from
    THIS module, and their @router.post decorators register their endpoints
    onto the shared routers as a side-effect. Once registered we then call
    `app.include_router` and the new routes ship.
    """
    # noqa: F401 — imported for the decorator side-effects (route registration).
    from deploy import code_review as _code_review  # noqa: F401
    from deploy import autopilot as _autopilot  # noqa: F401

    app.include_router(self_ai_router)
    app.include_router(self_ops_router)
    app.include_router(projects_router)
    app.include_router(ops_router)
