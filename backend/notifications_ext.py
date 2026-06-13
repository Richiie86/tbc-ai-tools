"""User-facing notifications & operator direct-messaging.

Two surfaces:
  * Operator → user(s): DM a single user, broadcast to filtered audience,
    one-click "remind users without 2FA" campaign.
  * User: list / mark-read / delete their own notifications.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorDatabase

from auth_utils import get_current_operator, get_current_user

logger = logging.getLogger('tbc.notifications')

router = APIRouter(prefix='/api')


# ===================================================================
# Models
# ===================================================================
def _uid() -> str:
    import secrets
    return secrets.token_urlsafe(12)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Notification(BaseModel):
    id: str = Field(default_factory=_uid)
    user_id: str                          # recipient
    from_operator_id: Optional[str] = None
    kind: Literal['dm', '2fa_reminder', 'broadcast'] = 'dm'
    subject: str
    body: str
    read_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=_now)


class OperatorDMRequest(BaseModel):
    subject: str
    body: str
    kind: Literal['dm', '2fa_reminder', 'broadcast'] = 'dm'


class BroadcastRequest(BaseModel):
    subject: str
    body: str
    kind: Literal['broadcast', '2fa_reminder'] = 'broadcast'
    # Audience filters (any combination — all must be true to receive).
    only_no_2fa: bool = False
    only_paid: bool = False
    user_ids: Optional[List[str]] = None  # explicit list overrides filters


def _serialize(doc: dict) -> dict:
    out = dict(doc or {})
    out.pop('_id', None)
    for k in ('created_at', 'read_at'):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


# ===================================================================
# DB helper — server.py wires the live db handle in via setup().
# ===================================================================
_db_holder: dict = {}


def setup(db: AsyncIOMotorDatabase) -> APIRouter:
    """Attach the Motor db handle and return the router for inclusion."""
    _db_holder['db'] = db
    return router


def _db() -> AsyncIOMotorDatabase:
    db = _db_holder.get('db')
    if db is None:
        raise RuntimeError('notifications_ext.setup(db) was not called')
    return db


# ===================================================================
# User endpoints
# ===================================================================
@router.get('/notifications')
async def list_my_notifications(user: dict = Depends(get_current_user)):
    """Newest first. Unread come first so the bell badge maps cleanly."""
    db = _db()
    uid = user.get('id') or user.get('sub')
    cursor = db.user_notifications.find({'user_id': uid}).sort('created_at', -1).limit(50)
    docs = [_serialize(d) async for d in cursor]
    unread = sum(1 for d in docs if not d.get('read_at'))
    return {'items': docs, 'unread_count': unread}


@router.post('/notifications/{notif_id}/read')
async def mark_notification_read(notif_id: str, user: dict = Depends(get_current_user)):
    db = _db()
    uid = user.get('id') or user.get('sub')
    res = await db.user_notifications.update_one(
        {'id': notif_id, 'user_id': uid, 'read_at': None},
        {'$set': {'read_at': _now()}},
    )
    return {'ok': True, 'updated': res.modified_count}


@router.post('/notifications/read-all')
async def mark_all_read(user: dict = Depends(get_current_user)):
    db = _db()
    uid = user.get('id') or user.get('sub')
    res = await db.user_notifications.update_many(
        {'user_id': uid, 'read_at': None},
        {'$set': {'read_at': _now()}},
    )
    return {'ok': True, 'updated': res.modified_count}


@router.delete('/notifications/{notif_id}')
async def delete_notification(notif_id: str, user: dict = Depends(get_current_user)):
    db = _db()
    uid = user.get('id') or user.get('sub')
    res = await db.user_notifications.delete_one({'id': notif_id, 'user_id': uid})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Notification not found')
    return {'ok': True}


# ===================================================================
# Operator endpoints
# ===================================================================
@router.post('/operator/users/{user_id}/notify')
async def op_dm_user(
    user_id: str,
    payload: OperatorDMRequest,
    op: dict = Depends(get_current_operator),
):
    """Send a direct message to a single user. The user will see it in
    their notifications bell on the next page load / poll."""
    db = _db()
    target = await db.users.find_one({'id': user_id})
    if not target:
        raise HTTPException(404, 'User not found')
    notif = Notification(
        user_id=user_id,
        from_operator_id=op.get('id'),
        kind=payload.kind,
        subject=payload.subject.strip(),
        body=payload.body.strip(),
    )
    await db.user_notifications.insert_one(notif.model_dump())
    logger.info('DM sent to %s (%s) by operator %s', user_id, target.get('email'), op.get('email'))
    return {'ok': True, 'id': notif.id}


@router.post('/operator/notify/broadcast')
async def op_broadcast(
    payload: BroadcastRequest,
    op: dict = Depends(get_current_operator),
):
    """Send the same notification to many users in one shot.

    Filter precedence (all AND-ed together):
      * `user_ids` list (when provided, explicit list wins entirely)
      * `only_no_2fa` — users with totp_enabled != True
      * `only_paid`   — users on any non-free plan
    """
    db = _db()
    if payload.user_ids:
        query = {'id': {'$in': list(payload.user_ids)}}
    else:
        query: dict = {}
        if payload.only_no_2fa:
            query['totp_enabled'] = {'$ne': True}
        if payload.only_paid:
            query['plan'] = {'$in': ['starter', 'pro', 'enterprise']}
    targets: List[str] = []
    async for u in db.users.find(query, {'id': 1}):
        targets.append(u['id'])
    if not targets:
        return {'ok': True, 'sent': 0}
    now = _now()
    docs = [
        {
            'id': _uid(),
            'user_id': uid,
            'from_operator_id': op.get('id'),
            'kind': payload.kind,
            'subject': payload.subject.strip(),
            'body': payload.body.strip(),
            'read_at': None,
            'created_at': now,
        }
        for uid in targets
    ]
    await db.user_notifications.insert_many(docs)
    logger.info('Broadcast (%s) sent to %d users by operator %s', payload.kind, len(docs), op.get('email'))
    return {'ok': True, 'sent': len(docs)}


@router.post('/operator/notify/2fa-reminder')
async def op_send_2fa_reminder(
    payload: dict = Body(default=None),
    op: dict = Depends(get_current_operator),
):
    """Convenience: blast a standard 2FA-setup reminder to every user that
    has not enabled TOTP yet. Operator can override subject/body via
    optional `subject` / `body` keys."""
    db = _db()
    subject = ((payload or {}).get('subject') or 'Secure your account — turn on 2FA').strip()
    body = ((payload or {}).get('body') or (
        'Hey! We noticed you haven\'t set up two-factor authentication yet. '
        'It takes 30 seconds and dramatically improves the security of your account. '
        'Open Settings → Set up 2FA to scan the QR code with your authenticator app.'
    )).strip()
    targets: List[str] = []
    async for u in db.users.find({'totp_enabled': {'$ne': True}, 'role': 'user'}, {'id': 1}):
        targets.append(u['id'])
    if not targets:
        return {'ok': True, 'sent': 0, 'matched': 0}
    now = _now()
    docs = [
        {
            'id': _uid(),
            'user_id': uid,
            'from_operator_id': op.get('id'),
            'kind': '2fa_reminder',
            'subject': subject,
            'body': body,
            'read_at': None,
            'created_at': now,
        }
        for uid in targets
    ]
    await db.user_notifications.insert_many(docs)
    logger.info('2FA reminder sent to %d users by operator %s', len(docs), op.get('email'))
    return {'ok': True, 'sent': len(docs), 'matched': len(targets)}


@router.get('/operator/notify/audiences')
async def op_audiences(_: dict = Depends(get_current_operator)):
    """Lightweight counts so the Messaging UI can show "Send to 47 users
    without 2FA" before the operator clicks."""
    db = _db()
    total = await db.users.count_documents({'role': 'user'})
    no_2fa = await db.users.count_documents({'role': 'user', 'totp_enabled': {'$ne': True}})
    paid = await db.users.count_documents({'plan': {'$in': ['starter', 'pro', 'enterprise']}})
    return {'total_users': total, 'no_2fa': no_2fa, 'paid': paid}
