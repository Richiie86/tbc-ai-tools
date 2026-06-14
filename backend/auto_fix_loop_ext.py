"""Autonomous Auto-Fix Loop — operator-opt-in self-healing.

Wires the existing runtime-error pipeline directly into AI Build so that
critical errors with no existing fix PR get planned + reviewed +
PR'd automatically — and (optionally) auto-merged once GH checks pass.

Schedule: every 5 minutes via APScheduler (registered in server.py
alongside the nightly drift cron). Each tick:
  1. Read `app_settings.auto_fix.*` config (default OFF).
  2. Count plans created today; bail if >= per_day_cap.
  3. Find critical `runtime_errors` from the last 24h with no
     `auto_fix_plan_id` and dismissed_at=None.
  4. For each (up to 3 per tick): call `_plan_one` → `_open_pr_one`,
     stamp the error doc so we never retry it.
  5. If `auto_merge` is on, sweep planned PRs whose `review.verdict==ship`
     AND whose GitHub `mergeable_state` is `clean`, and merge them.

All steps are best-effort with logging — a single failure never halts
the loop, but the failing error gets `auto_fix_attempted_at` set so we
don't retry it forever.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/auto-fix', tags=['auto-fix'])

_DEFAULT_PER_TICK = 3
_DEFAULT_PER_DAY = 5
_DEFAULT_LOOKBACK_HOURS = 24
_GITHUB_API = 'https://api.github.com'


# ─── Settings helpers ─────────────────────────────────────────────────────
async def _config() -> dict:
    s = await db.app_settings.find_one({}) or {}
    cfg = s.get('auto_fix') or {}
    return {
        'enabled': bool(cfg.get('enabled', False)),
        'auto_merge': bool(cfg.get('auto_merge', False)),
        'include_health': bool(cfg.get('include_health', False)),
        'per_day_cap': int(cfg.get('per_day_cap') or _DEFAULT_PER_DAY),
        'per_tick_cap': int(cfg.get('per_tick_cap') or _DEFAULT_PER_TICK),
        'project_id': cfg.get('project_id'),
    }


async def _today_attempt_count() -> int:
    since = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return await db.ai_build_plans.count_documents({
        'created_at': {'$gte': since},
        'source': {'$in': ['auto_fix', 'auto_fix_drift']},
    })


# ─── Reusable building blocks (small wrappers around ai_build_ext logic) ──
async def _plan_one(err: dict, project_id: str, operator_id: str) -> Optional[str]:
    """Generate a plan for the given error and return the plan_id (or None
    on failure). Reuses the same /plan code path via direct call."""
    from ai_build_ext import PlanRequest, plan

    rca = err.get('rca') or {}
    file_hint = rca.get('suggested_file') or ''
    if not file_hint and err.get('stack'):
        import re
        m = re.search(r'(frontend/src/[^\s):]+|backend/[^\s):]+\.py)(:\d+)?', err['stack'])
        if m:
            file_hint = m.group(1) + (m.group(2) or '')

    prompt_lines = [
        'Auto-fix request for a production runtime error:',
        '',
        f'Error: {(err.get("message") or "")[:400]}',
        f'Source: {err.get("source") or "frontend"}',
        f'URL: {err.get("url") or ""}',
        f'Likely file: {file_hint}' if file_hint else '',
        f'Root cause (RCA): {rca.get("root_cause") or ""}' if rca.get('root_cause') else '',
        f'Suggested change: {rca.get("suggested_change") or ""}' if rca.get('suggested_change') else '',
        '',
        'Keep the fix minimal, behaviour-preserving, and well-tested.',
    ]
    req = PlanRequest(project_id=project_id, prompt='\n'.join(line for line in prompt_lines if line))
    fake_user = {'id': operator_id, 'sub': operator_id, 'role': 'operator'}
    try:
        resp = await plan(req, user=fake_user)
    except Exception as e:
        logger.warning('auto-fix plan failed for err=%s: %s', err.get('id'), e)
        return None
    # Stamp `source=auto_fix` on the plan so the daily cap counter finds it.
    await db.ai_build_plans.update_one(
        {'plan_id': resp.plan_id},
        {'$set': {'source': 'auto_fix', 'runtime_error_id': err.get('id')}},
    )
    return resp.plan_id


async def _open_pr_one(plan_id: str, operator_id: str) -> Optional[str]:
    """Best-effort PR open. Returns pr_url or None."""
    from ai_build_ext import OpenPRRequest, open_pr
    fake_user = {'id': operator_id, 'sub': operator_id, 'role': 'operator'}
    try:
        resp = await open_pr(OpenPRRequest(plan_id=plan_id), user=fake_user)
        return resp.get('pr_url')
    except Exception as e:
        logger.warning('auto-fix open_pr failed for plan=%s: %s', plan_id, e)
        return None


async def _operator_id() -> Optional[str]:
    """The 'agent' that auto-fix actions are attributed to. Falls back to
    any operator account if none is explicitly configured."""
    settings = await db.app_settings.find_one({}) or {}
    explicit = (settings.get('auto_fix') or {}).get('agent_operator_id')
    if explicit:
        return explicit
    op = await db.users.find_one({'role': 'operator'}, {'id': 1})
    return (op or {}).get('id')


async def _plan_one_from_drift(test_doc: dict, project_id: str, operator_id: str) -> Optional[str]:
    """Same shape as _plan_one but the prompt is shaped for a failing AI
    Test Bench probe (model drift) rather than a runtime error."""
    from ai_build_ext import PlanRequest, plan

    model_id = test_doc.get('model') or 'unknown'
    failed_probes = [p for p in (test_doc.get('probes') or []) if not p.get('pass')]
    failure_lines = []
    for p in failed_probes[:5]:
        failure_lines.append(
            f"  • probe `{p.get('name')}`: {p.get('error') or 'failed pass-check'} "
            f"(latency {p.get('latency_ms', 0)}ms)"
        )

    prompt_lines = [
        'Auto-fix request for a failing AI Test Bench probe (model drift):',
        '',
        f'Model: {model_id}',
        f'Avg latency: {test_doc.get("avg_latency_ms", 0)}ms',
        f'Failed probes ({len(failed_probes)}):',
        *failure_lines,
        '',
        'Likely fix areas (check first):',
        '  - `backend/ai_test_bench_ext.py` — probe definitions / pass-checks',
        '  - `backend/server.py` chat fallback chain — provider may have moved',
        '  - System-prompt drift in `backend/ai_learnings_*` injection',
        '',
        'Keep the fix minimal and provider-agnostic. Do not loosen the probe '
        'just to make it pass — only fix real regressions.',
    ]
    req = PlanRequest(project_id=project_id, prompt='\n'.join(line for line in prompt_lines if line))
    fake_user = {'id': operator_id, 'sub': operator_id, 'role': 'operator'}
    try:
        resp = await plan(req, user=fake_user)
    except Exception as e:
        logger.warning('auto-fix drift plan failed for test=%s: %s', test_doc.get('id'), e)
        return None
    await db.ai_build_plans.update_one(
        {'plan_id': resp.plan_id},
        {'$set': {'source': 'auto_fix_drift', 'model_test_id': test_doc.get('id')}},
    )
    return resp.plan_id


async def _auto_fix_drift_sweep(cfg: dict, operator_id: str, budget: int) -> dict:
    """Find recent failing `ai_model_tests` rows that haven't been auto-fixed
    yet and run them through plan → review → PR (same gate as the runtime-
    error path). Returns `{processed, opened, errors[]}`. `budget` is the
    remaining daily cap shared with the runtime-error sweep."""
    out = {'processed': 0, 'opened': 0, 'errors': []}
    if budget <= 0:
        return out
    since = datetime.now(timezone.utc) - timedelta(hours=_DEFAULT_LOOKBACK_HOURS)
    cursor = db.ai_model_tests.find({
        'pass': False,
        'created_at': {'$gte': since},
        'auto_fix_attempted_at': None,
    }).sort('created_at', -1).limit(min(cfg['per_tick_cap'], budget))
    async for t in cursor:
        out['processed'] += 1
        stamp = datetime.now(timezone.utc)
        plan_id = await _plan_one_from_drift(t, cfg['project_id'], operator_id)
        if not plan_id:
            await db.ai_model_tests.update_one(
                {'id': t.get('id')},
                {'$set': {'auto_fix_attempted_at': stamp, 'auto_fix_outcome': 'plan_failed'}},
            )
            out['errors'].append(f"drift_plan_failed: {t.get('id')}")
            continue
        plan_doc = await db.ai_build_plans.find_one({'plan_id': plan_id})
        review = (plan_doc or {}).get('review') or {}
        if review.get('verdict') != 'ship':
            await db.ai_model_tests.update_one(
                {'id': t.get('id')},
                {'$set': {
                    'auto_fix_attempted_at': stamp,
                    'auto_fix_outcome': f'review_{review.get("verdict") or "missing"}',
                    'auto_fix_plan_id': plan_id,
                }},
            )
            continue
        pr_url = await _open_pr_one(plan_id, operator_id)
        await db.ai_model_tests.update_one(
            {'id': t.get('id')},
            {'$set': {
                'auto_fix_attempted_at': stamp,
                'auto_fix_outcome': 'pr_opened' if pr_url else 'pr_failed',
                'auto_fix_plan_id': plan_id,
                'auto_fix_pr_url': pr_url,
            }},
        )
        if pr_url:
            out['opened'] += 1
    return out


async def _auto_fix_health_sweep(cfg: dict, operator_id: str, budget: int) -> dict:
    """Third corner of the self-healing triangle: run the deploy
    `/healthcheck` for each tracked project; for any that fail (or
    error), queue a fix PR with the failure payload pre-loaded.

    Throttled so we don't hammer the project — last attempt timestamp is
    stored on `deploy_projects.last_auto_health_attempt_at` and we skip
    projects probed in the last 60 minutes."""
    from ai_build_ext import PlanRequest, plan as ai_plan
    out = {'processed': 0, 'opened': 0, 'errors': []}
    if budget <= 0:
        return out
    cooldown = datetime.now(timezone.utc) - timedelta(minutes=60)
    cursor = db.deploy_projects.find({
        '$or': [
            {'last_auto_health_attempt_at': None},
            {'last_auto_health_attempt_at': {'$lt': cooldown}},
        ],
    }).limit(min(cfg['per_tick_cap'], budget))
    fake_user = {'id': operator_id, 'sub': operator_id, 'role': 'operator'}

    async for project in cursor:
        pid = project.get('id')
        url = project.get('url') or project.get('domain')
        if not url:
            continue
        # Probe via raw httpx — never trip the deploy router (which would
        # need the operator's JWT for the /healthcheck endpoint).
        target = url if url.startswith('http') else f'https://{url}'
        ok = False
        detail = ''
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                r = await client.get(target)
            ok = 200 <= r.status_code < 400
            detail = f'HTTP {r.status_code}'
        except Exception as e:
            detail = f'connect failed: {str(e)[:200]}'
        await db.deploy_projects.update_one(
            {'id': pid},
            {'$set': {
                'last_auto_health_attempt_at': datetime.now(timezone.utc),
                'last_auto_health_ok': ok,
                'last_auto_health_detail': detail,
            }},
        )
        if ok:
            continue

        out['processed'] += 1
        prompt = (
            f'Auto-fix request for a failing health-check on `{project.get("projectName") or pid}`.\n\n'
            f'Probe target: {target}\n'
            f'Outcome: {detail}\n\n'
            'Investigate likely culprits in this priority order:\n'
            '  - backend/server.py — startup / scheduler errors\n'
            '  - backend/runtime_errors_ext.py — recent critical entries\n'
            '  - frontend bundle errors blocking the public landing\n\n'
            'Keep the fix minimal — restore the failing endpoint without '
            'touching auth, payments, or schemas.'
        )
        req = PlanRequest(project_id=pid, prompt=prompt)
        try:
            resp = await ai_plan(req, user=fake_user)
        except Exception as e:
            out['errors'].append(f'health_plan_failed:{pid}:{e}')
            continue
        await db.ai_build_plans.update_one(
            {'plan_id': resp.plan_id},
            {'$set': {'source': 'auto_fix_health', 'project_id': pid}},
        )
        plan_doc = await db.ai_build_plans.find_one({'plan_id': resp.plan_id})
        review = (plan_doc or {}).get('review') or {}
        if review.get('verdict') == 'ship':
            pr_url = await _open_pr_one(resp.plan_id, operator_id)
            if pr_url:
                out['opened'] += 1
    return out


# ─── Core tick ────────────────────────────────────────────────────────────
async def run_auto_fix_tick() -> dict:
    """One pass of the loop. Returns `{processed, opened, skipped, errors}`."""
    cfg = await _config()
    out = {'enabled': cfg['enabled'], 'processed': 0, 'opened': 0, 'merged': 0,
           'skipped_capped': False, 'errors': []}
    if not cfg['enabled']:
        return out
    if not cfg['project_id']:
        out['errors'].append('auto_fix.project_id not configured')
        return out

    today_count = await _today_attempt_count()
    remaining_today = max(0, cfg['per_day_cap'] - today_count)
    if remaining_today == 0:
        out['skipped_capped'] = True
        return out

    operator_id = await _operator_id()
    if not operator_id:
        out['errors'].append('No operator account found to attribute auto-fix actions')
        return out

    since = datetime.now(timezone.utc) - timedelta(hours=_DEFAULT_LOOKBACK_HOURS)
    cursor = db.runtime_errors.find({
        'severity': 'critical',
        'dismissed_at': None,
        'created_at': {'$gte': since},
        'auto_fix_attempted_at': None,
    }).sort('updated_at', -1).limit(min(cfg['per_tick_cap'], remaining_today))

    async for err in cursor:
        out['processed'] += 1
        stamp = datetime.now(timezone.utc)
        plan_id = await _plan_one(err, cfg['project_id'], operator_id)
        if not plan_id:
            await db.runtime_errors.update_one(
                {'id': err.get('id')},
                {'$set': {'auto_fix_attempted_at': stamp, 'auto_fix_outcome': 'plan_failed'}},
            )
            out['errors'].append(f"plan_failed: {err.get('id')}")
            continue

        # Inspect plan's review verdict before opening a PR — autonomous
        # mode should only PR when the cross-AI says `ship` (we ignore
        # ship_with_concerns for autonomy to avoid noisy PRs).
        plan_doc = await db.ai_build_plans.find_one({'plan_id': plan_id})
        review = (plan_doc or {}).get('review') or {}
        if review.get('verdict') != 'ship':
            await db.runtime_errors.update_one(
                {'id': err.get('id')},
                {'$set': {
                    'auto_fix_attempted_at': stamp,
                    'auto_fix_outcome': f'review_{review.get("verdict") or "missing"}',
                    'auto_fix_plan_id': plan_id,
                }},
            )
            continue

        pr_url = await _open_pr_one(plan_id, operator_id)
        await db.runtime_errors.update_one(
            {'id': err.get('id')},
            {'$set': {
                'auto_fix_attempted_at': stamp,
                'auto_fix_outcome': 'pr_opened' if pr_url else 'pr_failed',
                'auto_fix_plan_id': plan_id,
                'auto_fix_pr_url': pr_url,
            }},
        )
        if pr_url:
            out['opened'] += 1

    # ─── Drift sweep ─────────────────────────────────────────────────
    # Same plan→review→PR pipeline, but seeded from failing
    # `ai_model_tests` rows (nightly drift alerts). Shares the remaining
    # daily cap with the runtime-error sweep so we never exceed it.
    remaining = max(0, cfg['per_day_cap'] - (await _today_attempt_count()))
    drift = await _auto_fix_drift_sweep(cfg, operator_id, remaining)
    out['drift_processed'] = drift['processed']
    out['drift_opened'] = drift['opened']
    if drift['errors']:
        out['errors'].extend(drift['errors'])
    out['opened'] += drift['opened']
    out['processed'] += drift['processed']

    # Health-check sweep — also bound by remaining daily cap. Only runs
    # when explicitly opted in via `auto_fix.include_health`.
    if cfg.get('include_health'):
        remaining = max(0, cfg['per_day_cap'] - (await _today_attempt_count()))
        health = await _auto_fix_health_sweep(cfg, operator_id, remaining)
        out['health_processed'] = health['processed']
        out['health_opened'] = health['opened']
        if health['errors']:
            out['errors'].extend(health['errors'])
        out['opened'] += health['opened']
        out['processed'] += health['processed']

    # Optional second sweep: auto-merge clean PRs.
    if cfg['auto_merge']:
        out['merged'] = await _auto_merge_sweep()
    return out


async def _auto_merge_sweep() -> int:
    """Merge any auto-fix PRs whose GitHub `mergeable_state == clean`.
    Returns count merged. Best-effort — never raises."""
    settings = await db.payment_settings.find_one({}) or {}
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        return 0
    cursor = db.ai_build_plans.find({
        'source': {'$in': ['auto_fix', 'auto_fix_drift']},
        'status': 'opened',
        'merged_at': None,
    }).limit(5)
    merged = 0
    async with httpx.AsyncClient(timeout=20.0) as client:
        async for plan_doc in cursor:
            repo = plan_doc.get('repo')
            number = plan_doc.get('pr_number')
            if not (repo and number):
                continue
            try:
                r = await client.get(
                    f'{_GITHUB_API}/repos/{repo}/pulls/{number}',
                    headers={'Authorization': f'Bearer {gh_token}',
                             'Accept': 'application/vnd.github+json'},
                )
                if r.status_code != 200:
                    continue
                pr = r.json()
                if pr.get('mergeable_state') != 'clean' or pr.get('merged'):
                    continue
                m = await client.put(
                    f'{_GITHUB_API}/repos/{repo}/pulls/{number}/merge',
                    headers={'Authorization': f'Bearer {gh_token}',
                             'Accept': 'application/vnd.github+json'},
                    json={'merge_method': 'squash'},
                )
                if m.status_code in (200, 201):
                    await db.ai_build_plans.update_one(
                        {'plan_id': plan_doc['plan_id']},
                        {'$set': {'merged_at': datetime.now(timezone.utc), 'auto_merged': True}},
                    )
                    merged += 1
            except Exception as e:
                logger.warning('auto-merge PR #%s failed: %s', number, e)
    return merged


# ─── HTTP endpoints (operator-only) ───────────────────────────────────────
class AutoFixConfig(BaseModel):
    enabled: bool = False
    auto_merge: bool = False
    include_health: bool = False
    per_day_cap: int = Field(_DEFAULT_PER_DAY, ge=0, le=50)
    per_tick_cap: int = Field(_DEFAULT_PER_TICK, ge=1, le=10)
    project_id: Optional[str] = None


@router.get('/config')
async def get_config(op: dict = Depends(get_current_operator)):
    return await _config()


@router.put('/config')
async def put_config(req: AutoFixConfig, op: dict = Depends(get_current_operator)):
    if req.enabled and not req.project_id:
        raise HTTPException(400, 'Choose a default project_id before enabling auto-fix.')
    await db.app_settings.update_one(
        {},
        {'$set': {'auto_fix': req.model_dump()}},
        upsert=True,
    )
    return await _config()


@router.post('/run-now')
async def run_now(op: dict = Depends(get_current_operator)):
    """Manual one-shot tick — useful for testing or to drain the queue."""
    return await run_auto_fix_tick()


@router.get('/status')
async def status(op: dict = Depends(get_current_operator)):
    """Snapshot: today's attempt count, last 5 outcomes (runtime + drift)."""
    cfg = await _config()
    today = await _today_attempt_count()

    cursor = db.runtime_errors.find(
        {'auto_fix_attempted_at': {'$ne': None}},
        {'id': 1, 'message': 1, 'auto_fix_attempted_at': 1, 'auto_fix_outcome': 1, 'auto_fix_pr_url': 1},
    ).sort('auto_fix_attempted_at', -1).limit(5)
    recent = []
    async for d in cursor:
        d.pop('_id', None)
        ts = d.get('auto_fix_attempted_at')
        if ts and not isinstance(ts, str):
            d['auto_fix_attempted_at'] = ts.isoformat()
        d['kind'] = 'error'
        recent.append(d)

    drift_cursor = db.ai_model_tests.find(
        {'auto_fix_attempted_at': {'$ne': None}},
        {'id': 1, 'model': 1, 'auto_fix_attempted_at': 1, 'auto_fix_outcome': 1, 'auto_fix_pr_url': 1},
    ).sort('auto_fix_attempted_at', -1).limit(5)
    async for d in drift_cursor:
        d.pop('_id', None)
        ts = d.get('auto_fix_attempted_at')
        if ts and not isinstance(ts, str):
            d['auto_fix_attempted_at'] = ts.isoformat()
        recent.append({
            'id': d.get('id'),
            'message': f'Drift: {d.get("model")}',
            'auto_fix_attempted_at': d.get('auto_fix_attempted_at'),
            'auto_fix_outcome': d.get('auto_fix_outcome'),
            'auto_fix_pr_url': d.get('auto_fix_pr_url'),
            'kind': 'drift',
        })

    # Merge both lists newest-first.
    recent.sort(key=lambda r: r.get('auto_fix_attempted_at') or '', reverse=True)
    return {'config': cfg, 'today_count': today, 'recent': recent[:10]}
