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
async def _check_mongo() -> dict:
    started = datetime.now(timezone.utc)
    try:
        await db.command('ping')
        ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        return {'key': 'mongo', 'label': 'MongoDB', 'ok': True, 'latency_ms': ms, 'detail': 'ping ok'}
    except Exception as e:
        return {'key': 'mongo', 'label': 'MongoDB', 'ok': False, 'detail': str(e)[:200]}


def _check_env_keys() -> list[dict]:
    """Required envs must be set; optional ones surface as info-only rows."""
    env_required = ['MONGO_URL', 'DB_NAME', 'JWT_SECRET']
    env_optional = ['EMERGENT_LLM_KEY', 'RESEND_API_KEY', 'STRIPE_API_KEY']
    out: list[dict] = []
    for k in env_required:
        present = bool(os.environ.get(k))
        out.append({'key': f'env.{k}', 'label': f'env · {k}', 'ok': present,
                    'detail': 'set' if present else 'missing (required)'})
    for k in env_optional:
        present = bool(os.environ.get(k))
        out.append({'key': f'env.{k}', 'label': f'env · {k}', 'ok': True,
                    'detail': 'set' if present else 'unset (operator may configure in Security tab)'})
    return out


async def _check_settings_keys() -> list[dict]:
    """DB-backed API keys (presence only)."""
    s = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    keys = [
        'emergent_llm_key', 'stripe_secret_key', 'paypal_client_id',
        'resend_api_key', 'nowpayments_api_key',
    ]
    return [
        {'key': f'settings.{k}', 'label': f'settings · {k}', 'ok': True,
         'detail': 'configured' if s.get(k) else 'not configured'}
        for k in keys
    ]


async def _check_master_payments() -> dict:
    bs = await db.settings.find_one({'_id': 'brand_settings'}) or {}
    on = bool(bs.get('master_payments_enabled', True))
    return {
        'key': 'payments.master_switch', 'label': 'Master Payments',
        'ok': on, 'detail': 'ON' if on else 'OFF (no payments will process)',
    }


async def _check_frontend() -> dict:
    frontend_url = os.environ.get('FRONTEND_URL') or 'http://localhost:3000'
    started = datetime.now(timezone.utc)
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(frontend_url)
        ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        return {'key': 'frontend', 'label': 'Frontend', 'ok': r.status_code < 500,
                'latency_ms': ms, 'detail': f'HTTP {r.status_code}'}
    except Exception as e:
        return {'key': 'frontend', 'label': 'Frontend', 'ok': False, 'detail': str(e)[:200]}


def _check_disk() -> dict:
    try:
        usage = shutil.disk_usage('/app')
        pct = round(usage.used / usage.total * 100, 1)
        return {
            'key': 'disk', 'label': 'Disk (/app)',
            'ok': pct < 90,
            'detail': f'{pct}% used · {usage.free // (1024**3)} GB free',
        }
    except Exception as e:
        return {'key': 'disk', 'label': 'Disk (/app)', 'ok': False, 'detail': str(e)[:200]}


def _check_services() -> list[dict]:
    """Only treat the trio core services as required for "healthy".

    Non-core services that aren't RUNNING surface as a `warn` row (yellow in
    the UI) instead of silently passing — operators were previously blind to
    a stopped sidecar because the row would just say "non-critical · ok".
    """
    CORE_SERVICES = {'backend', 'frontend', 'mongodb'}
    res = _run(['sudo', 'supervisorctl', 'status'], timeout=10)
    rows: list[dict] = []
    for line in (res.get('stdout') or '').splitlines():
        parts = line.split()
        if not parts:
            continue
        name = parts[0]
        state = parts[1] if len(parts) > 1 else 'UNKNOWN'
        is_core = name in CORE_SERVICES
        is_running = state == 'RUNNING'
        detail = ' '.join(parts[1:]) if len(parts) > 1 else 'unknown'

        if is_core:
            level = 'ok' if is_running else 'fail'
        else:
            level = 'ok' if is_running else 'warn'
            if not is_running:
                detail = f'{detail} · non-critical sidecar stopped'

        rows.append({
            'key': f'svc.{name}',
            'label': f'svc · {name}',
            # `ok` is preserved for back-compat — UI old enough to predate
            # the `level` field will still light up correctly.
            'ok': level != 'fail',
            'level': level,
            'detail': detail,
        })
    return rows


def _check_commit() -> str:
    git = _run(['git', '-C', '/app', 'log', '-1', '--pretty=%h · %s · %cr'], timeout=5)
    return (git.get('stdout') or '').strip() or 'unknown'


@router.get('/health')
async def ops_health(_user: dict = Depends(get_current_operator)):
    """Aggregated health snapshot. Each check returns {ok, latency_ms, detail?}."""
    checks: list[dict] = []
    checks.append(await _check_mongo())
    checks.extend(_check_env_keys())
    checks.extend(await _check_settings_keys())
    checks.append(await _check_master_payments())
    checks.append(await _check_frontend())
    checks.append(_check_disk())
    checks.extend(_check_services())

    ok_count = sum(1 for c in checks if c.get('level', 'ok' if c['ok'] else 'fail') == 'ok')
    warn_count = sum(1 for c in checks if c.get('level') == 'warn')
    fail_count = sum(1 for c in checks if c.get('level', 'ok' if c['ok'] else 'fail') == 'fail')
    return {
        'generated_at': _now_iso(),
        'summary': {
            'total': len(checks),
            'passing': ok_count,
            'warning': warn_count,
            'failing': fail_count,
        },
        'commit': _check_commit(),
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
