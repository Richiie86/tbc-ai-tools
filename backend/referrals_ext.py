"""Referrals + Projects + Brand settings routes."""
import os
import re
import secrets
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request, Query

from auth_utils import get_current_operator, get_current_user
from models import (
    ReferralCode, ReferralClick, ReferralEarning, TrackClickRequest,
    Project, ProjectUpsertRequest,
    BrandSettings,
)

router = APIRouter(prefix='/api')

DEFAULT_BRAND = BrandSettings().dict()


async def get_db():
    from db import db as _db
    return _db


def _serialize(d):
    if not d:
        return d
    d.pop('_id', None)
    for k, v in list(d.items()):
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


# Map legacy Project statuses → new 5-stage lifecycle.
_LEGACY_PROJECT_STATUS = {'active': 'dev', 'paused': 'dev', 'done': 'launched'}


def _migrate_project_status(p: dict) -> dict:
    """Normalize any legacy 'active'/'paused'/'done' status to the new lifecycle."""
    if not p:
        return p
    s = p.get('status')
    if s in _LEGACY_PROJECT_STATUS:
        p['status'] = _LEGACY_PROJECT_STATUS[s]
    return p


def _slug_from_email(email: str) -> str:
    base = email.split('@', 1)[0]
    s = re.sub(r'[^a-z0-9]+', '-', base.lower()).strip('-')
    if not s:
        s = 'user'
    return s[:24]


async def get_or_create_referral_code(user: dict) -> str:
    db = await get_db()
    if user.get('referral_code'):
        # ensure code is registered in referral_codes collection too
        await db.referral_codes.update_one(
            {'code': user['referral_code']},
            {'$setOnInsert': {'user_id': user['id'], 'code': user['referral_code'], 'created_at': datetime.now(timezone.utc)}},
            upsert=True,
        )
        return user['referral_code']
    base = _slug_from_email(user['email'])
    code = base
    n = 0
    while await db.referral_codes.find_one({'code': code}):
        n += 1
        code = f"{base}-{n}"
        if n > 50:
            code = base + '-' + secrets.token_hex(3)
            break
    await db.referral_codes.insert_one({
        'id': secrets.token_hex(8),
        'user_id': user['id'],
        'code': code,
        'created_at': datetime.now(timezone.utc),
    })
    await db.users.update_one({'id': user['id']}, {'$set': {'referral_code': code}})
    return code


async def get_brand_settings() -> dict:
    db = await get_db()
    doc = await db.settings.find_one({'_id': 'brand_settings'})
    if not doc:
        defaults = {**DEFAULT_BRAND, '_id': 'brand_settings'}
        await db.settings.insert_one(defaults)
        return defaults
    # ensure all defaults present
    merged = {**DEFAULT_BRAND, **{k: v for k, v in doc.items() if v is not None}}
    return merged


# ===================================================================
# PUBLIC: Click tracking, brand settings
# ===================================================================
@router.get('/brand/settings')
async def public_brand_settings():
    s = await get_brand_settings()
    return {
        'share_base_url': s.get('share_base_url'),
        'referral_base_url_org': s.get('referral_base_url_org'),
        'referral_base_url_com': s.get('referral_base_url_com'),
        'referral_pct': s.get('referral_pct', 10.0),
    }


@router.post('/referral/track')
async def referral_track(req: TrackClickRequest, request: Request):
    db = await get_db()
    # Only track if code exists
    if not await db.referral_codes.find_one({'code': req.code}):
        return {'ok': False, 'reason': 'unknown_code'}
    click = ReferralClick(
        code=req.code,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get('user-agent'),
        referrer=req.referrer,
    )
    await db.referral_clicks.insert_one(click.dict())
    return {'ok': True}


# ===================================================================
# USER: My referral
# ===================================================================
@router.get('/referral/me')
async def my_referral(user: dict = Depends(get_current_user)):
    db = await get_db()
    db_user = await db.users.find_one({'id': user['sub']})
    if not db_user:
        raise HTTPException(404, 'User not found')
    code = await get_or_create_referral_code(db_user)
    # Build share URLs based on brand settings
    brand = await get_brand_settings()
    org_url = f"{brand.get('referral_base_url_org', 'https://www.tbctools.org/referral').rstrip('/')}/{code}"
    com_url = f"{brand.get('referral_base_url_com', 'https://www.tbctools.com/referral').rstrip('/')}/{code}"

    # Stats
    click_count = await db.referral_clicks.count_documents({'code': code})
    signup_count = await db.users.count_documents({'referred_by_code': code})
    earn_cursor = db.referral_earnings.aggregate([
        {'$match': {'referrer_user_id': db_user['id']}},
        {'$group': {'_id': '$status', 'sum': {'$sum': '$commission_amount'}, 'count': {'$sum': 1}}},
    ])
    accrued = 0.0
    paid = 0.0
    accrued_n = 0
    paid_n = 0
    async for row in earn_cursor:
        if row['_id'] == 'accrued':
            accrued = round(row['sum'], 2)
            accrued_n = row['count']
        elif row['_id'] == 'paid':
            paid = round(row['sum'], 2)
            paid_n = row['count']

    return {
        'code': code,
        'share_url_org': org_url,
        'share_url_com': com_url,
        'commission_pct': brand.get('referral_pct', 10.0),
        'stats': {
            'clicks': click_count,
            'signups': signup_count,
            'accrued_usd': accrued,
            'paid_usd': paid,
            'accrued_count': accrued_n,
            'paid_count': paid_n,
        },
    }


@router.get('/referral/my-earnings')
async def my_referral_earnings(user: dict = Depends(get_current_user)):
    db = await get_db()
    cursor = db.referral_earnings.find({'referrer_user_id': user['sub']}).sort('created_at', -1).limit(200)
    return [_serialize(e) async for e in cursor]


# ===================================================================
# OPERATOR: referral management + brand settings
# ===================================================================
@router.get('/operator/referrals')
async def op_list_referrals(_: dict = Depends(get_current_operator)):
    """Operator dashboard of all referral codes — batched to avoid N+1."""
    db = await get_db()
    # 1) Page of codes (most recent first)
    codes_docs = await db.referral_codes.find(
        {}, {'code': 1, 'user_id': 1, 'created_at': 1}
    ).sort('created_at', -1).limit(500).to_list(500)
    if not codes_docs:
        return []

    user_ids = list({r['user_id'] for r in codes_docs})
    code_strs = [r['code'] for r in codes_docs]

    # 2) One $in query per dimension (instead of one per code)
    users_by_id = {
        u['id']: u
        async for u in db.users.find(
            {'id': {'$in': user_ids}}, {'id': 1, 'email': 1, 'name': 1}
        )
    }

    clicks_pipeline = [
        {'$match': {'code': {'$in': code_strs}}},
        {'$group': {'_id': '$code', 'n': {'$sum': 1}}},
    ]
    clicks_by_code = {
        d['_id']: d['n']
        async for d in db.referral_clicks.aggregate(clicks_pipeline)
    }

    signups_pipeline = [
        {'$match': {'referred_by_code': {'$in': code_strs}}},
        {'$group': {'_id': '$referred_by_code', 'n': {'$sum': 1}}},
    ]
    signups_by_code = {
        d['_id']: d['n']
        async for d in db.users.aggregate(signups_pipeline)
    }

    earnings_pipeline = [
        {'$match': {'referrer_user_id': {'$in': user_ids}}},
        {'$group': {
            '_id': {'uid': '$referrer_user_id', 'status': '$status'},
            'sum': {'$sum': '$commission_amount'},
            'count': {'$sum': 1},
        }},
    ]
    earnings_by_uid_status = {}
    async for d in db.referral_earnings.aggregate(earnings_pipeline):
        earnings_by_uid_status[(d['_id']['uid'], d['_id']['status'])] = (d['sum'] or 0, d['count'] or 0)

    # 3) Assemble response
    out = []
    for r in codes_docs:
        uid = r['user_id']
        u = users_by_id.get(uid)
        accrued_sum, accrued_n = earnings_by_uid_status.get((uid, 'accrued'), (0, 0))
        paid_sum, paid_n = earnings_by_uid_status.get((uid, 'paid'), (0, 0))
        out.append({
            'code': r['code'],
            'user_id': uid,
            'user_email': u.get('email') if u else None,
            'user_name': u.get('name') if u else None,
            'created_at': (r['created_at'].isoformat() if isinstance(r.get('created_at'), datetime) else r.get('created_at')),
            'clicks': clicks_by_code.get(r['code'], 0),
            'signups': signups_by_code.get(r['code'], 0),
            'accrued_usd': round(accrued_sum, 2),
            'accrued_count': accrued_n,
            'paid_usd': round(paid_sum, 2),
            'paid_count': paid_n,
        })
    return out


@router.post('/operator/referrals/pay')
async def op_mark_referrals_paid(body: dict, _: dict = Depends(get_current_operator)):
    """Mark all 'accrued' referral earnings for a user as 'paid'. Body: {user_id}."""
    user_id = body.get('user_id')
    if not user_id:
        raise HTTPException(400, 'user_id required')
    db = await get_db()
    res = await db.referral_earnings.update_many(
        {'referrer_user_id': user_id, 'status': 'accrued'},
        {'$set': {'status': 'paid', 'paid_at': datetime.now(timezone.utc).isoformat()}},
    )
    return {'success': True, 'modified': res.modified_count}


@router.get('/operator/brand-settings')
async def op_get_brand_settings(_: dict = Depends(get_current_operator)):
    s = await get_brand_settings()
    return {
        'share_base_url': s.get('share_base_url'),
        'referral_base_url_org': s.get('referral_base_url_org'),
        'referral_base_url_com': s.get('referral_base_url_com'),
        'referral_pct': s.get('referral_pct', 10.0),
    }


@router.put('/operator/brand-settings')
async def op_update_brand_settings(payload: dict, _: dict = Depends(get_current_operator)):
    db = await get_db()
    allowed = {'share_base_url', 'referral_base_url_org', 'referral_base_url_com', 'referral_pct'}
    updates = {}
    for k, v in payload.items():
        if k in allowed and v not in (None, ''):
            updates[k] = v
    if updates:
        await db.settings.update_one({'_id': 'brand_settings'}, {'$set': updates}, upsert=True)
    return {'success': True, 'updated_keys': list(updates.keys())}


# ===================================================================
# PROJECTS (operator)
# ===================================================================
@router.get('/operator/projects')
async def op_list_projects(user: dict = Depends(get_current_operator)):
    db = await get_db()
    cursor = db.projects.find({'owner_id': user['sub']}).sort('updated_at', -1).limit(500)
    return [_serialize(_migrate_project_status(p)) async for p in cursor]


@router.post('/operator/projects')
async def op_create_project(req: ProjectUpsertRequest, user: dict = Depends(get_current_operator)):
    db = await get_db()
    p = Project(owner_id=user['sub'], **req.dict())
    await db.projects.insert_one(p.dict())
    return _serialize(p.dict())


@router.put('/operator/projects/{pid}')
async def op_update_project(pid: str, req: ProjectUpsertRequest, user: dict = Depends(get_current_operator)):
    db = await get_db()
    updates = {**req.dict(), 'updated_at': datetime.now(timezone.utc)}
    res = await db.projects.update_one({'id': pid, 'owner_id': user['sub']}, {'$set': updates})
    if res.matched_count == 0:
        raise HTTPException(404, 'Project not found')
    doc = await db.projects.find_one({'id': pid})
    return _serialize(_migrate_project_status(doc))


@router.delete('/operator/projects/{pid}')
async def op_delete_project(pid: str, user: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.projects.delete_one({'id': pid, 'owner_id': user['sub']})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Project not found')
    return {'success': True}


@router.post('/operator/projects/{pid}/launch-chat')
async def op_launch_project_chat(pid: str, user: dict = Depends(get_current_operator)):
    """One-click 'Open in TBC chat' — creates a new chat session pre-seeded with
    the project context (title, status, description, tags, link) so the LLM
    treats the next prompt as a continuation of building this project.

    Returns `{ session_id }` — the frontend then navigates to `/dashboard/{session_id}`.
    """
    db = await get_db()
    p = await db.projects.find_one({'id': pid, 'owner_id': user['sub']})
    if not p:
        raise HTTPException(404, 'Project not found')

    stage_label = {
        'expand': 'Code to expand (reusable boilerplate)',
        'idea': 'Start new project (scoping & planning)',
        'dev': 'Under development (actively building)',
        'launched': 'Launched (shipped)',
        'running': 'Running (live & maintained)',
    }.get(p.get('status') or 'idea', 'Idea')

    tag_line = ', '.join(p.get('tags') or []) or 'none'
    link_line = p.get('link_url') or 'n/a'
    description = (p.get('description') or '').strip() or 'No description yet.'

    primer = (
        f"PROJECT BRIEF — {p.get('title')}\n"
        f"Stage: {stage_label}\n"
        f"Tags: {tag_line}\n"
        f"External link: {link_line}\n\n"
        f"Description:\n{description}\n\n"
        f"You are continuing work on this project as the TBC AI builder. "
        f"Acknowledge the brief in one short sentence, then ask the single most "
        f"useful next-step question to move the project forward."
    )

    # Create session + seed first user message (so history primes the LLM).
    from models import ChatSession, ChatMessage  # local import to avoid circular at module load
    s = ChatSession(
        user_id=user['sub'],
        title=f"📁 {p.get('title')[:48]}",
        model='gpt-4o-mini',
        variant='tbc1',
    )
    sd = s.dict()
    sd['project_id'] = p['id']
    await db.chat_sessions.insert_one(sd)

    msg = ChatMessage(session_id=s.id, user_id=user['sub'], role='user', content=primer)
    await db.chat_messages.insert_one(msg.dict())

    # Cross-link: store session_id back on the project for quick reopen later.
    await db.projects.update_one(
        {'id': pid},
        {'$set': {'chat_session_id': s.id, 'updated_at': datetime.now(timezone.utc)}},
    )

    return {'session_id': s.id, 'project_id': p['id']}


# ===================================================================
# Helpers used by server.py
# ===================================================================
async def record_referral_signup(new_user_id: str, new_user_email: str, code: Optional[str]):
    if not code:
        return
    db = await get_db()
    rc = await db.referral_codes.find_one({'code': code})
    if not rc:
        return
    if rc['user_id'] == new_user_id:
        return  # cannot refer self
    await db.users.update_one({'id': new_user_id}, {'$set': {'referred_by_code': code}})


async def record_referral_earning(transaction_id: str, paid_user_id: str, paid_user_email: str, plan_id: str, amount: float, currency: str = 'usd'):
    """Called when a paid transaction is confirmed. If user was referred, accrue commission for referrer."""
    db = await get_db()
    paid_user = await db.users.find_one({'id': paid_user_id})
    if not paid_user or not paid_user.get('referred_by_code'):
        return
    code = paid_user['referred_by_code']
    rc = await db.referral_codes.find_one({'code': code})
    if not rc:
        return
    brand = await get_brand_settings()
    pct = float(brand.get('referral_pct', 10.0))
    commission = round(float(amount) * pct / 100.0, 2)
    # Idempotency on transaction_id
    if await db.referral_earnings.find_one({'transaction_id': transaction_id}):
        return
    earn = ReferralEarning(
        referrer_user_id=rc['user_id'],
        referred_user_id=paid_user_id,
        referred_user_email=paid_user_email,
        transaction_id=transaction_id,
        plan_id=plan_id,
        gross_amount=float(amount),
        commission_pct=pct,
        commission_amount=commission,
        currency=currency,
    )
    await db.referral_earnings.insert_one(earn.dict())
