"""Operator → Ops tab routes.

Powers the in-app "Health Check / Code Review / Restart / Deploy" controls so the
operator can keep the platform healthy without leaving the Operator Console.
"""
import os
import subprocess
import shutil
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
import httpx

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc.ops')
router = APIRouter(prefix='/api/operator/ops')


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run(cmd: list[str], cwd: str | None = None, timeout: int = 60) -> dict:
    """Run a shell command, return {ok, exit_code, stdout, stderr, ms}."""
    started = datetime.now(timezone.utc)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
        ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        return {
            'ok': r.returncode == 0,
            'exit_code': r.returncode,
            'stdout': (r.stdout or '')[-8000:],
            'stderr': (r.stderr or '')[-8000:],
            'ms': ms,
        }
    except subprocess.TimeoutExpired:
        return {'ok': False, 'exit_code': -1, 'stdout': '', 'stderr': f'timeout after {timeout}s', 'ms': timeout * 1000}
    except Exception as e:
        return {'ok': False, 'exit_code': -1, 'stdout': '', 'stderr': str(e), 'ms': 0}


# ---------- HEALTH CHECK ----------
@router.get('/health')
async def ops_health(_user: dict = Depends(get_current_operator)):
    """Aggregated health snapshot. Each check returns {ok, latency_ms, detail?}."""
    checks: list[dict] = []

    # Mongo ping
    started = datetime.now(timezone.utc)
    try:
        await db.command('ping')
        ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        checks.append({'key': 'mongo', 'label': 'MongoDB', 'ok': True, 'latency_ms': ms, 'detail': 'ping ok'})
    except Exception as e:
        checks.append({'key': 'mongo', 'label': 'MongoDB', 'ok': False, 'detail': str(e)[:200]})

    # Env keys (presence only — never echo values)
    env_required = ['MONGO_URL', 'DB_NAME', 'JWT_SECRET']
    env_optional = ['EMERGENT_LLM_KEY', 'RESEND_API_KEY', 'STRIPE_API_KEY']
    for k in env_required:
        checks.append({'key': f'env.{k}', 'label': f'env · {k}', 'ok': bool(os.environ.get(k)), 'detail': 'set' if os.environ.get(k) else 'missing (required)'})
    for k in env_optional:
        present = bool(os.environ.get(k))
        checks.append({'key': f'env.{k}', 'label': f'env · {k}', 'ok': True, 'detail': 'set' if present else 'unset (operator may configure in Security tab)'})

    # Brand settings DB-backed keys
    s = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    has_keys = {
        'emergent_llm_key': bool(s.get('emergent_llm_key')),
        'stripe_secret_key': bool(s.get('stripe_secret_key')),
        'paypal_client_id': bool(s.get('paypal_client_id')),
        'resend_api_key': bool(s.get('resend_api_key')),
        'nowpayments_api_key': bool(s.get('nowpayments_api_key')),
    }
    for k, v in has_keys.items():
        checks.append({'key': f'settings.{k}', 'label': f'settings · {k}', 'ok': True, 'detail': 'configured' if v else 'not configured'})

    # Master payments flag
    bs = await db.settings.find_one({'_id': 'brand_settings'}) or {}
    checks.append({
        'key': 'payments.master_switch',
        'label': 'Master Payments',
        'ok': bool(bs.get('master_payments_enabled', True)),
        'detail': 'ON' if bs.get('master_payments_enabled', True) else 'OFF (no payments will process)',
    })

    # Frontend reachable
    frontend_url = os.environ.get('FRONTEND_URL') or 'http://localhost:3000'
    started = datetime.now(timezone.utc)
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(frontend_url)
        ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        checks.append({'key': 'frontend', 'label': 'Frontend', 'ok': r.status_code < 500, 'latency_ms': ms, 'detail': f'HTTP {r.status_code}'})
    except Exception as e:
        checks.append({'key': 'frontend', 'label': 'Frontend', 'ok': False, 'detail': str(e)[:200]})

    # Disk usage
    try:
        usage = shutil.disk_usage('/app')
        pct = round(usage.used / usage.total * 100, 1)
        checks.append({
            'key': 'disk',
            'label': 'Disk (/app)',
            'ok': pct < 90,
            'detail': f'{pct}% used · {usage.free // (1024**3)} GB free',
        })
    except Exception as e:
        checks.append({'key': 'disk', 'label': 'Disk (/app)', 'ok': False, 'detail': str(e)[:200]})

    # Supervisor service state — only treat core services as required for "healthy".
    CORE_SERVICES = {'backend', 'frontend', 'mongodb'}
    res = _run(['sudo', 'supervisorctl', 'status'], timeout=10)
    for line in (res.get('stdout') or '').splitlines():
        parts = line.split()
        if not parts:
            continue
        name = parts[0]
        state = parts[1] if len(parts) > 1 else 'UNKNOWN'
        is_core = name in CORE_SERVICES
        ok = state == 'RUNNING' if is_core else True
        detail = ' '.join(parts[1:]) if len(parts) > 1 else 'unknown'
        if not is_core and state != 'RUNNING':
            detail = f'{detail} · non-critical'
        checks.append({
            'key': f'svc.{name}',
            'label': f'svc · {name}',
            'ok': ok,
            'detail': detail,
        })

    # Recent git commit
    git = _run(['git', '-C', '/app', 'log', '-1', '--pretty=%h · %s · %cr'], timeout=5)
    commit = (git.get('stdout') or '').strip() or 'unknown'

    ok_count = sum(1 for c in checks if c['ok'])
    return {
        'generated_at': _now_iso(),
        'summary': {'total': len(checks), 'passing': ok_count, 'failing': len(checks) - ok_count},
        'commit': commit,
        'checks': checks,
    }


# ---------- CODE REVIEW ----------
@router.post('/code-review')
async def ops_code_review(_user: dict = Depends(get_current_operator)):
    """Run ruff (backend) + a fast eslint smoke (frontend) and return a summary.

    We deliberately keep eslint out of the loop by default because the dev server is
    already linting the frontend on hot-reload; instead we surface ruff which is the
    quickest signal for backend regressions.
    """
    # Use `python -m ruff` so we don't depend on PATH containing the venv's bin dir.
    import sys
    py = sys.executable
    has_ruff = True
    try:
        check = _run([py, '-c', 'import ruff'], timeout=5)
        has_ruff = check.get('ok', False)
    except Exception:
        has_ruff = False

    if not has_ruff:
        # ruff ships as a binary, not an importable package — try invoking it directly.
        probe = _run([py, '-m', 'ruff', '--version'], timeout=5)
        has_ruff = probe.get('ok', False)

    py_check = (
        _run([py, '-m', 'ruff', 'check', '/app/backend', '--output-format=concise'], timeout=60)
        if has_ruff else
        {'ok': False, 'stdout': '', 'stderr': 'ruff not installed (pip install ruff)', 'exit_code': -1, 'ms': 0}
    )
    py_format = (
        _run([py, '-m', 'ruff', 'format', '--check', '/app/backend'], timeout=60)
        if has_ruff else
        {'ok': False, 'stdout': '', 'stderr': 'ruff not installed (pip install ruff)', 'exit_code': -1, 'ms': 0}
    )

    # Quick JS smoke — just count files for the report header.
    js_files = _run(['bash', '-lc', 'find /app/frontend/src -type f \\( -name "*.js" -o -name "*.jsx" \\) | wc -l'], timeout=5)

    return {
        'generated_at': _now_iso(),
        'python': {
            'lint': py_check,
            'format': py_format,
        },
        'frontend': {
            'note': 'Hot-reload ESLint surfaces frontend issues live in the dev overlay. Run a manual `yarn build` for a deep check.',
            'js_file_count': (js_files.get('stdout') or '').strip(),
        },
    }


# ---------- RESTART SERVICES ----------
@router.post('/restart')
async def ops_restart(
    _user: dict = Depends(get_current_operator),
    service: str = Query('backend', pattern='^(backend|frontend|all)$'),
):
    """Soft-restart a supervised service. Closest in-cluster analog to a redeploy."""
    target = {'all': 'all', 'backend': 'backend', 'frontend': 'frontend'}[service]
    res = _run(['sudo', 'supervisorctl', 'restart', target], timeout=30)
    if not res.get('ok'):
        raise HTTPException(500, f"restart failed: {res.get('stderr') or res.get('stdout')}")
    return {'service': target, 'restarted_at': _now_iso(), 'output': res.get('stdout')}


# ---------- DEPLOY INFO ----------
@router.get('/deploy-info')
async def ops_deploy_info(_user: dict = Depends(get_current_operator)):
    """Return context for the in-app Deploy / Redeploy card.

    Note: Emergent's production deploy is triggered from the Emergent chat UI's
    Deploy button — there's no public API to fire it server-side. This endpoint
    surfaces the info the operator needs to act on it confidently.
    """
    commit = _run(['git', '-C', '/app', 'log', '-1', '--pretty=%h%n%s%n%an%n%cI'], timeout=5)
    lines = (commit.get('stdout') or '').splitlines() + ['', '', '', '']
    return {
        'commit': {
            'sha': lines[0],
            'subject': lines[1],
            'author': lines[2],
            'date': lines[3],
        },
        'preview_url': os.environ.get('REACT_APP_BACKEND_URL') or '',
        'production_domain': 'tbctools.org',
        'hint': 'Production deploy is triggered from the Emergent chat panel · top-right Deploy button.',
    }
