"""Per-user analytics drill-down for the Operator console.

Provides a single endpoint:
  GET /api/operator/users/{user_id}/analytics

Pulls usage signals from collections we already maintain — no schema
migrations, no token-counting plumbing required. Backed by aggregation
pipelines (cheap; ~3 small queries per call).

Returned shape:
{
  user:           {id, email, name, plan, role, status, credits, last_seen_at, created_at, banned}
  messages:       {total, last_30d, last_7d}
  active_days:    {total_distinct, last_30d, recent: [{date, msg_count}, ...]}   # 30-day sparkline
  sessions:       {total, last_30d}
  payments:       {total_usd, completed_count, last_payment_at}
}

Operator-only. Read-only. Counts are bounded by sane limits so an
abusive caller can't pin Mongo.
"""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/users', tags=['user-analytics'])


def _iso(dt) -> str | None:
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    try:
        return dt.isoformat()
    except Exception:
        return None


def _serialize_user(u: dict) -> dict:
    """Strip secrets + coerce timestamps; matches `_serialize` in server.py
    closely so the FE doesn't have to special-case the analytics row."""
    out = {k: v for k, v in u.items() if k not in ('_id', 'password_hash', 'totp_secret')}
    for k in ('created_at', 'updated_at', 'last_seen_at', 'banned_at', 'last_login_at'):
        if k in out:
            out[k] = _iso(out[k])
    out['banned'] = bool(u.get('status') == 'paused' or u.get('deleted_at'))
    return out


@router.get('/{user_id}/analytics')
async def user_analytics(user_id: str, op: dict = Depends(get_current_operator)):
    user = await db.users.find_one({'id': user_id})
    if not user:
        raise HTTPException(404, 'User not found')

    now = datetime.now(timezone.utc)
    since_30d = now - timedelta(days=30)
    since_7d = now - timedelta(days=7)

    # ─── Messages ────────────────────────────────────────────────────
    total_msgs = await db.chat_messages.count_documents({'user_id': user_id})
    msgs_30d = await db.chat_messages.count_documents(
        {'user_id': user_id, 'created_at': {'$gte': since_30d}})
    msgs_7d = await db.chat_messages.count_documents(
        {'user_id': user_id, 'created_at': {'$gte': since_7d}})

    # ─── Active days (last 30) + per-day sparkline ───────────────────
    pipeline = [
        {'$match': {'user_id': user_id, 'created_at': {'$gte': since_30d}}},
        {'$group': {
            '_id': {'$dateToString': {'format': '%Y-%m-%d', 'date': '$created_at'}},
            'count': {'$sum': 1},
        }},
        {'$sort': {'_id': 1}},
        {'$limit': 60},
    ]
    spark = []
    async for d in db.chat_messages.aggregate(pipeline):
        spark.append({'date': d['_id'], 'msg_count': int(d.get('count') or 0)})

    # Total distinct days ever — single aggregation, capped lookback to keep cheap.
    distinct_pipeline = [
        {'$match': {'user_id': user_id}},
        {'$group': {'_id': {'$dateToString': {'format': '%Y-%m-%d', 'date': '$created_at'}}}},
        {'$count': 'distinct_days'},
        {'$limit': 1},
    ]
    distinct_days = 0
    async for d in db.chat_messages.aggregate(distinct_pipeline):
        distinct_days = int(d.get('distinct_days') or 0)

    # ─── Sessions ────────────────────────────────────────────────────
    total_sessions = await db.chat_sessions.count_documents({'user_id': user_id})
    sessions_30d = await db.chat_sessions.count_documents(
        {'user_id': user_id, 'created_at': {'$gte': since_30d}})

    # ─── Payments (best-effort; matches by user_id OR email) ─────────
    pay_match = {'$or': [{'user_id': user_id}, {'user_email': user.get('email')}]}
    pay_pipeline = [
        {'$match': {**pay_match, 'status': {'$in': ['completed', 'paid', 'success']}}},
        {'$group': {
            '_id': None,
            'total_usd': {'$sum': {'$ifNull': ['$amount_usd', '$amount']}},
            'count': {'$sum': 1},
            'last_at': {'$max': '$created_at'},
        }},
    ]
    payments = {'total_usd': 0.0, 'completed_count': 0, 'last_payment_at': None}
    async for d in db.payment_transactions.aggregate(pay_pipeline):
        payments = {
            'total_usd': round(float(d.get('total_usd') or 0), 2),
            'completed_count': int(d.get('count') or 0),
            'last_payment_at': _iso(d.get('last_at')),
        }

    return {
        'user': _serialize_user(user),
        'messages': {
            'total': total_msgs,
            'last_30d': msgs_30d,
            'last_7d': msgs_7d,
        },
        'active_days': {
            'total_distinct': distinct_days,
            'last_30d': len(spark),
            'recent': spark,
        },
        'sessions': {
            'total': total_sessions,
            'last_30d': sessions_30d,
        },
        'payments': payments,
    }
