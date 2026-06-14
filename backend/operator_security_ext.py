"""Operator-only surfaces for two locked-down workflows:

1. **Re-registration approvals**
   - When the operator vanishes an account, we stash the email in
     `db.vanished_emails`. The next time anyone signs up with the
     same address, the register handler flips the new user doc to
     `pending_approval=true, status='pending'` and login is refused
     with 403.
   - `GET  /api/operator/security/pending-users` lists every such
     held account so the operator can review it.
   - `POST /api/operator/security/pending-users/{id}/approve` clears
     the hold and also removes the vanished_emails entry so a future
     vanish-then-resignup-then-vanish chain works correctly.
   - `POST /api/operator/security/pending-users/{id}/reject` deletes
     the held account outright (no audit trail kept beyond the
     existing `audit_log` collection).

2. **KYC-bypass allowlist**
   - The operator can drop specific emails into a small allowlist
     that skips the KYC step at signup/checkout. 2FA is still
     required — that gate lives in the auth flow and is not touched
     here.
   - Locked: every endpoint requires `get_current_operator`. The data
     lives in `db.kyc_bypass_emails` (one doc per email) and is
     read by any KYC-gating code via the public helper
     `is_kyc_bypassed(email)` exposed at the bottom of this module.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/security', tags=['operator-security'])

_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def _norm_email(e: Optional[str]) -> str:
    return (e or '').strip().lower()


# ─── 1. Pending users (re-registration approvals) ──────────────────────
@router.get('/pending-users')
async def list_pending_users(op: dict = Depends(get_current_operator)):
    """Return every user doc with `pending_approval=true`. These are the
    accounts created via the public register form for an email that was
    previously vanished — they cannot log in until approved.
    """
    cursor = db.users.find(
        {'$or': [{'pending_approval': True}, {'status': 'pending'}]},
        {'id': 1, 'email': 1, 'name': 1, 'pending_reason': 1, 'created_at': 1, 'role': 1},
    ).sort('created_at', -1).limit(200)
    out: list[dict] = []
    async for u in cursor:
        out.append({
            'id': u.get('id'),
            'email': u.get('email'),
            'name': u.get('name'),
            'reason': u.get('pending_reason') or 'reregistration_after_vanish',
            'created_at': u.get('created_at').isoformat() if u.get('created_at') else None,
            'role': u.get('role'),
        })
    return {'pending': out, 'count': len(out)}


@router.post('/pending-users/{user_id}/approve')
async def approve_pending_user(
    user_id: str, request: Request, op: dict = Depends(get_current_operator),
):
    """Clear the hold on a re-registered account. The user can log in
    immediately. We also drop the vanished_emails entry so the operator
    doesn't have to re-approve every future signup from the same email
    (one approval = welcome back)."""
    target = await db.users.find_one({'id': user_id}, {'id': 1, 'email': 1})
    if not target:
        raise HTTPException(404, 'User not found')
    await db.users.update_one(
        {'id': user_id},
        {'$set': {'status': 'active'},
         '$unset': {'pending_approval': '', 'pending_reason': ''}},
    )
    await db.vanished_emails.delete_one({'email': _norm_email(target.get('email'))})
    try:
        await db.audit_log.insert_one({
            'actor_email': op.get('email'),
            'kind': 'user.approve_reregistration',
            'target': target.get('email'),
            'created_at': datetime.now(timezone.utc),
            'ip': request.client.host if request.client else 'unknown',
        })
    except Exception:
        pass
    logger.info('Operator %s approved re-registration for %s', op.get('email'), target.get('email'))
    return {'success': True, 'email': target.get('email')}


@router.post('/pending-users/{user_id}/reject')
async def reject_pending_user(
    user_id: str, request: Request, op: dict = Depends(get_current_operator),
):
    """Permanently reject a re-registration. Deletes the held user doc.
    The email stays in vanished_emails so any future signup is still held.
    """
    target = await db.users.find_one({'id': user_id}, {'id': 1, 'email': 1})
    if not target:
        raise HTTPException(404, 'User not found')
    await db.users.delete_one({'id': user_id})
    try:
        await db.audit_log.insert_one({
            'actor_email': op.get('email'),
            'kind': 'user.reject_reregistration',
            'target': target.get('email'),
            'created_at': datetime.now(timezone.utc),
            'ip': request.client.host if request.client else 'unknown',
        })
    except Exception:
        pass
    logger.info('Operator %s rejected re-registration for %s', op.get('email'), target.get('email'))
    return {'success': True, 'email': target.get('email')}


# ─── 2. KYC bypass allowlist ──────────────────────────────────────────
class KycBypassAddRequest(BaseModel):
    email: EmailStr
    note: Optional[str] = None  # operator-only memo (e.g. "vendor account")


@router.get('/kyc-bypass')
async def list_kyc_bypass(op: dict = Depends(get_current_operator)):
    """List every email currently on the KYC-bypass allowlist."""
    cursor = db.kyc_bypass_emails.find({}).sort('created_at', -1).limit(500)
    out: list[dict] = []
    async for d in cursor:
        out.append({
            'email': d.get('email'),
            'note': d.get('note') or '',
            'added_by': d.get('added_by') or '',
            'created_at': d.get('created_at').isoformat() if d.get('created_at') else None,
        })
    return {'emails': out, 'count': len(out)}


@router.post('/kyc-bypass')
async def add_kyc_bypass(
    req: KycBypassAddRequest, request: Request,
    op: dict = Depends(get_current_operator),
):
    """Add an email to the allowlist. Idempotent — re-adding the same
    email refreshes its timestamp + note. 2FA is NOT skipped — that
    gate lives in auth and is not touched here."""
    email = _norm_email(str(req.email))
    if not _EMAIL_RE.match(email):
        raise HTTPException(400, 'Invalid email')
    await db.kyc_bypass_emails.update_one(
        {'email': email},
        {'$set': {
            'email': email,
            'note': (req.note or '')[:200],
            'added_by': op.get('email'),
            'created_at': datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    try:
        await db.audit_log.insert_one({
            'actor_email': op.get('email'),
            'kind': 'kyc_bypass.add',
            'target': email,
            'note': (req.note or '')[:200],
            'created_at': datetime.now(timezone.utc),
            'ip': request.client.host if request.client else 'unknown',
        })
    except Exception:
        pass
    return {'success': True, 'email': email}


@router.delete('/kyc-bypass/{email}')
async def remove_kyc_bypass(
    email: str, request: Request, op: dict = Depends(get_current_operator),
):
    """Remove an email from the allowlist."""
    email_n = _norm_email(email)
    res = await db.kyc_bypass_emails.delete_one({'email': email_n})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Email not on the allowlist')
    try:
        await db.audit_log.insert_one({
            'actor_email': op.get('email'),
            'kind': 'kyc_bypass.remove',
            'target': email_n,
            'created_at': datetime.now(timezone.utc),
            'ip': request.client.host if request.client else 'unknown',
        })
    except Exception:
        pass
    return {'success': True, 'email': email_n}


async def is_kyc_bypassed(email: Optional[str]) -> bool:
    """Public helper for any KYC-gating code. Returns True iff the email
    is on the operator-controlled allowlist."""
    if not email:
        return False
    doc = await db.kyc_bypass_emails.find_one({'email': _norm_email(email)}, {'_id': 1})
    return doc is not None
