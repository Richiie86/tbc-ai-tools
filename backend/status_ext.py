"""Public `/api/status` — uptime + health + recent incidents.

Pulled from data we already capture elsewhere:
  - `ai_model_tests`     — per-model probe pass/fail + latency
  - `runtime_errors`     — critical incidents in the last N days
  - DB ping              — Mongo connectivity

Anonymous + read-only. No auth required so the page can be linked from
status badges, email footers, etc. Cached at the edge via short Cache-
Control headers; we do not paginate (the page is small by design).
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Response

from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/status', tags=['status'])

# Overall-status thresholds — easy to tune later without changing the FE.
_OUTAGE_CRITICAL_COUNT_24H = 5
_INCIDENT_LOOKBACK_DAYS = 7
_INCIDENT_LIMIT = 10


def _isofmt(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    return dt.isoformat()


async def _latest_per_model() -> list[dict]:
    """Most recent `ai_model_tests` row per model_id. We sort newest-first
    and keep the first one we see per model — single pass."""
    out: dict[str, dict] = {}
    cursor = db.ai_model_tests.find({}).sort('created_at', -1).limit(200)
    async for d in cursor:
        m = d.get('model')
        if not m or m in out:
            continue
        out[m] = {
            'model': m,
            'provider': d.get('provider'),
            'pass': bool(d.get('pass')),
            'avg_latency_ms': int(d.get('avg_latency_ms') or 0),
            'checked_at': _isofmt(d.get('created_at')),
            'probes_failed': [p.get('name') for p in d.get('probes', []) if not p.get('pass')],
        }
    # Stable ordering for the UI (alphabetical by model id).
    return sorted(out.values(), key=lambda r: r['model'])


async def _recent_incidents() -> list[dict]:
    """Critical, non-dismissed runtime errors from the last N days,
    newest-first. Single concise payload — no stack traces, no PII."""
    since = datetime.now(timezone.utc) - timedelta(days=_INCIDENT_LOOKBACK_DAYS)
    cursor = db.runtime_errors.find(
        {
            'severity': 'critical',
            'dismissed_at': None,
            'created_at': {'$gte': since},
        },
        {'message': 1, 'source': 1, 'count': 1, 'created_at': 1, 'updated_at': 1, 'signature': 1},
    ).sort('updated_at', -1).limit(_INCIDENT_LIMIT)
    out = []
    async for d in cursor:
        out.append({
            'signature': d.get('signature'),
            'message': (d.get('message') or '')[:280],
            'source': d.get('source') or 'frontend',
            'count': int(d.get('count') or 1),
            'first_seen': _isofmt(d.get('created_at')),
            'last_seen': _isofmt(d.get('updated_at') or d.get('created_at')),
        })
    return out


async def _critical_count_24h() -> int:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    return await db.runtime_errors.count_documents({
        'severity': 'critical',
        'created_at': {'$gte': since},
    })


async def _db_ping() -> bool:
    try:
        await db.command('ping')
        return True
    except Exception as e:
        logger.warning('status ping failed: %s', e)
        return False


def _overall(model_health: list[dict], crit_24h: int, db_ok: bool) -> str:
    if not db_ok:
        return 'outage'
    if crit_24h >= _OUTAGE_CRITICAL_COUNT_24H:
        return 'outage'
    any_fail = any(not m['pass'] for m in model_health)
    if any_fail or crit_24h > 0:
        return 'degraded'
    return 'operational'


@router.get('')
async def status(response: Response):
    """One snapshot for the public status page.

    Designed to be cheap (~3 Mongo reads + 1 ping). Cache for 30 seconds
    at the edge so a status-page tab open in the corner doesn't hammer
    Mongo every 5 seconds.
    """
    db_ok = await _db_ping()
    model_health = await _latest_per_model() if db_ok else []
    crit_24h = await _critical_count_24h() if db_ok else 0
    incidents = await _recent_incidents() if db_ok else []
    response.headers['Cache-Control'] = 'public, max-age=30'
    return {
        'overall': _overall(model_health, crit_24h, db_ok),
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'components': {
            'database': 'operational' if db_ok else 'outage',
            'ai_models': 'operational' if model_health and all(m['pass'] for m in model_health)
                         else ('degraded' if model_health else 'unknown'),
        },
        'models': model_health,
        'critical_errors_24h': crit_24h,
        'incidents': incidents,
    }
