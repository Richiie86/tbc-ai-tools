"""Operator audit log.

Append-only event stream of operator actions (user moderation, plan/settings
changes, withdrawals, etc.). Each row is small and self-describing so the
Audit tab can render it without joining other collections.

Schema (db.audit_log):
  id          : uuid
  actor_id    : operator user id (or None for system jobs)
  actor_email : operator email (or 'system')
  action      : str (e.g. 'user.pause', 'plan.create', 'settings.update')
  target      : str | None (the email/id being acted on)
  details     : dict (small JSON — extra context)
  ip          : str | None (operator IP if available)
  created_at  : datetime
"""
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc.audit')
router = APIRouter(prefix='/api/operator/audit')


async def record_audit(
    actor: dict | None,
    action: str,
    target: str | None = None,
    details: dict | None = None,
    request: Request | None = None,
) -> None:
    """Persist one audit row. Safe to call from anywhere — failures are logged
    and swallowed so a logging hiccup never breaks the underlying operation."""
    try:
        ip = None
        if request is not None:
            # Honour proxy headers when present.
            ip = request.headers.get('x-forwarded-for', '').split(',')[0].strip() or (request.client.host if request.client else None)
        doc = {
            'id': str(uuid.uuid4()),
            'actor_id': (actor or {}).get('sub'),
            'actor_email': (actor or {}).get('email') or 'system',
            'action': action,
            'target': target,
            'details': details or {},
            'ip': ip,
            'created_at': datetime.now(timezone.utc),
        }
        await db.audit_log.insert_one(doc)
    except Exception as e:
        logger.exception('audit write failed: %s', e)


@router.get('')
async def list_audit(
    _user: dict = Depends(get_current_operator),
    limit: int = Query(100, ge=1, le=500),
    skip: int = Query(0, ge=0),
    action: str | None = Query(None, description='Exact action filter (e.g. user.pause)'),
    actor: str | None = Query(None, description='Filter by actor email substring'),
):
    """Paginated newest-first audit list with optional action + actor filters."""
    q: dict = {}
    if action:
        q['action'] = action
    if actor:
        q['actor_email'] = {'$regex': actor, '$options': 'i'}

    total = await db.audit_log.count_documents(q)
    cursor = db.audit_log.find(q).sort('created_at', -1).skip(skip).limit(limit)
    rows: list[dict] = []
    async for r in cursor:
        r.pop('_id', None)
        if isinstance(r.get('created_at'), datetime):
            r['created_at'] = r['created_at'].isoformat()
        rows.append(r)
    # Build a small distinct-action list so the UI can populate a filter dropdown.
    actions = await db.audit_log.distinct('action')
    return {'total': total, 'rows': rows, 'distinct_actions': sorted(actions)}
