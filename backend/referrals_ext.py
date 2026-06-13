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

DEFAULT_BRAND = BrandSettings().model_dump()


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
    await db.referral_clicks.insert_one(click.model_dump())
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
        {'$group': {
            '_id': '$status',
            'sum': {'$sum': '$commission_amount'},
            'credits': {'$sum': {'$ifNull': ['$credits_awarded', 0]}},
            'count': {'$sum': 1},
        }},
    ])
    accrued = 0.0
    paid = 0.0
    accrued_n = 0
    paid_n = 0
    credits_awarded = 0
    async for row in earn_cursor:
        credits_awarded += int(row.get('credits') or 0)
        if row['_id'] == 'accrued':
            accrued = round(row['sum'], 2)
            accrued_n = row['count']
        elif row['_id'] in ('paid', 'credited'):
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
            'credits_awarded': credits_awarded,
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
    p = Project(owner_id=user['sub'], **req.model_dump())
    await db.projects.insert_one(p.model_dump())
    return _serialize(p.model_dump())


@router.put('/operator/projects/{pid}')
async def op_update_project(pid: str, req: ProjectUpsertRequest, user: dict = Depends(get_current_operator)):
    db = await get_db()
    updates = {**req.model_dump(), 'updated_at': datetime.now(timezone.utc)}
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


# Default extra titles every "Clone all" pass guarantees in the destination
# workspace, even if the operator hasn't created them yet on this DB. The
# user specifically asked for `crypto-forex-tax` to live alongside the
# cloned set so they could keep working on it from `tbc1`.
_BOOTSTRAP_TITLES: list[str] = ['crypto-forex-tax']


def _clone_project_doc(src: dict, owner_id: str, workspace: str) -> dict:
    """Build a fresh project doc that mirrors `src` into `workspace`.

    The title gets a `-{workspace}` suffix unless it already ends in one,
    `tags` gains the workspace tag, and a fresh id + timestamps are stamped.
    """
    tags = list(src.get('tags') or [])
    if workspace not in tags:
        tags.append(workspace)
    base_title = (src.get('title') or 'untitled').strip()
    suffix = f'-{workspace}'
    new_title = base_title if base_title.endswith(suffix) else f'{base_title}{suffix}'
    now = datetime.now(timezone.utc)
    return Project(
        owner_id=owner_id,
        title=new_title,
        description=src.get('description'),
        status=src.get('status') or 'idea',
        tags=tags,
        link_url=src.get('link_url'),
        chat_session_id=None,  # fresh session — operator continues work here
        is_for_sale=False,     # never auto-list a clone for sale
        price_usd=0.0,
        asset_url=src.get('asset_url'),
        summary=src.get('summary'),
        cover_emoji=src.get('cover_emoji'),
        created_at=now,
        updated_at=now,
    ).model_dump()


async def _register_workspace(db, name: str) -> None:
    """Add a workspace name to the settings registry so the UI can list it
    in the workspace switcher. Idempotent via $addToSet."""
    await db.settings.update_one(
        {'_id': 'project_workspaces'},
        {'$addToSet': {'names': name}, '$setOnInsert': {'created_at': datetime.now(timezone.utc)}},
        upsert=True,
    )


@router.get('/operator/projects/workspaces')
async def op_list_workspaces(user: dict = Depends(get_current_operator)):
    """Return the set of workspace names known to this operator.

    Two sources are merged so freshly-imported data still surfaces:
      • settings.project_workspaces.names — registered by clone-all
      • DISTINCT tags currently in use that match the workspace name
        regex (lowercase slug). This catches projects imported from a
        seed or copied in manually.

    Excludes obvious non-workspace tags like 'bootstrap'.
    """
    db = await get_db()
    settings = await db.settings.find_one({'_id': 'project_workspaces'}) or {}
    names: set[str] = set(settings.get('names') or [])

    # Also fold in any in-use tags that look like a workspace slug.
    pipeline = [
        {'$match': {'owner_id': user['sub']}},
        {'$unwind': '$tags'},
        {'$group': {'_id': '$tags'}},
    ]
    async for row in db.projects.aggregate(pipeline):
        tag = row['_id']
        if isinstance(tag, str) and re.match(r'^[a-z0-9][a-z0-9_-]{0,30}$', tag) and tag != 'bootstrap':
            names.add(tag)

    return {'workspaces': sorted(names)}


@router.post('/operator/projects/workspaces')
async def op_create_workspace(
    payload: dict,
    user: dict = Depends(get_current_operator),
):
    """Register a fresh workspace name. The UI uses this when the operator
    types a name in "+ New workspace…" without immediately cloning into it.

    Returns the updated workspace list so the dropdown can rehydrate.
    """
    name = (payload.get('name') or '').strip().lower()
    if not name or not re.match(r'^[a-z0-9][a-z0-9_-]{0,30}$', name):
        raise HTTPException(400, 'name must be lowercase alphanumeric (1-31 chars)')
    db = await get_db()
    await _register_workspace(db, name)
    # Re-read so we return the live list.
    return await op_list_workspaces(user=user)


@router.post('/operator/projects/clone-all')
async def op_clone_all_projects(
    payload: dict | None = None,
    user: dict = Depends(get_current_operator),
):
    """Duplicate every project owned by this operator into a target
    workspace (default `tbc1`). Each clone gets a `-{workspace}` suffix,
    the workspace name added to its `tags`, and a fresh chat session.

    Also bootstraps any `_BOOTSTRAP_TITLES` that don't exist yet — the
    operator asked for `crypto-forex-tax` to always live alongside the
    cloned set so they can keep building on it from tbc1.

    Idempotent: projects that already have the target workspace tag are
    skipped (their fresh copies stay; we don't keep doubling).
    """
    db = await get_db()
    payload = payload or {}
    # Validate the workspace argument explicitly so an empty string or
    # whitespace can't sneak through `or 'tbc1'`.
    if 'workspace' in payload:
        ws = payload.get('workspace')
        if not isinstance(ws, str) or not ws.strip():
            raise HTTPException(400, 'workspace cannot be empty')
        workspace = ws.strip().lower()
    else:
        workspace = 'tbc1'
    if not re.match(r'^[a-z0-9][a-z0-9_-]{0,30}$', workspace):
        raise HTTPException(400, 'workspace must be lowercase alphanumeric (1-31 chars)')
    extras = list(payload.get('include_titles') or _BOOTSTRAP_TITLES)

    cloned: list[dict] = []
    skipped: list[dict] = []
    bootstrapped: list[dict] = []

    # Pre-load every title already living in the target workspace so we
    # can skip sources whose clone exists. This guards idempotency even
    # when the source project hasn't itself been tagged.
    existing_clone_titles: set[str] = set()
    async for d in db.projects.find(
        {'owner_id': user['sub'], 'tags': workspace},
        {'title': 1},
    ):
        existing_clone_titles.add(d.get('title') or '')

    suffix = f'-{workspace}'
    # Pull EVERY project this operator owns. We skip ones already tagged
    # with the target workspace AND ones whose `{title}-{workspace}` already
    # exists as a clone (the case where the source itself isn't tagged).
    cursor = db.projects.find({'owner_id': user['sub']}).limit(1000)
    async for src in cursor:
        src_title = (src.get('title') or '').strip()
        if workspace in (src.get('tags') or []):
            skipped.append({'id': src.get('id'), 'title': src_title,
                            'reason': f'already in {workspace}'})
            continue
        # Already cloned in a previous pass? Don't re-clone.
        dest_title = src_title if src_title.endswith(suffix) else f'{src_title}{suffix}'
        if dest_title in existing_clone_titles:
            skipped.append({'id': src.get('id'), 'title': src_title,
                            'reason': f'{dest_title} already exists in {workspace}'})
            continue
        doc = _clone_project_doc(src, user['sub'], workspace)
        await db.projects.insert_one(doc)
        existing_clone_titles.add(doc['title'])
        cloned.append({'id': doc['id'], 'title': doc['title'], 'from': src.get('id')})

    # Bootstrap titles that the operator wanted available in this
    # workspace even if they've never been created on this DB.
    existing_titles_q = {
        'owner_id': user['sub'],
        'tags': workspace,
        'title': {'$in': [f'{t}-{workspace}' for t in extras] + extras},
    }
    existing_titles = {d['title'] async for d in db.projects.find(existing_titles_q, {'title': 1})}
    for raw in extras:
        target = raw if raw.endswith(f'-{workspace}') else f'{raw}-{workspace}'
        if target in existing_titles:
            continue
        now = datetime.now(timezone.utc)
        doc = Project(
            owner_id=user['sub'],
            title=target,
            status='idea',
            tags=[workspace, 'bootstrap'],
            description=f'Bootstrapped into {workspace} by clone-all so the operator can continue work.',
            created_at=now,
            updated_at=now,
        ).model_dump()
        await db.projects.insert_one(doc)
        bootstrapped.append({'id': doc['id'], 'title': doc['title']})

    # Always register the workspace so the dropdown shows it even when
    # the operator skipped the bootstrap defaults.
    await _register_workspace(db, workspace)

    return {
        'workspace': workspace,
        'cloned': cloned,
        'skipped': skipped,
        'bootstrapped': bootstrapped,
        'cloned_count': len(cloned),
        'bootstrapped_count': len(bootstrapped),
        'skipped_count': len(skipped),
    }


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
    sd = s.model_dump()
    sd['project_id'] = p['id']
    await db.chat_sessions.insert_one(sd)

    msg = ChatMessage(session_id=s.id, user_id=user['sub'], role='user', content=primer)
    await db.chat_messages.insert_one(msg.model_dump())

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


async def record_referral_earning(transaction_id: str, paid_user_id: str, paid_user_email: str, plan_id: str, amount: float, currency: str = 'usd', credits_purchased: int = 0):
    """Called when a paid transaction is confirmed.

    If the buyer was referred, we accrue a USD commission record for audit and
    *also* auto-credit the referrer's account with `referral_pct`% of the
    credits the buyer just received. This makes the referral programme
    instant — referrers never have to wait for a payout.

    A `user_notifications` entry is created so the referrer sees a bell
    notification immediately.
    """
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
    # Auto-credit: referrer earns `pct%` of the credits the buyer received.
    # We round half-up so the referrer never silently loses a credit.
    credits_award = int(round(int(credits_purchased or 0) * pct / 100.0))

    # Idempotency on transaction_id — never double-pay.
    if await db.referral_earnings.find_one({'transaction_id': transaction_id}):
        return

    referrer_id = rc['user_id']
    earn = ReferralEarning(
        referrer_user_id=referrer_id,
        referred_user_id=paid_user_id,
        referred_user_email=paid_user_email,
        transaction_id=transaction_id,
        plan_id=plan_id,
        gross_amount=float(amount),
        commission_pct=pct,
        commission_amount=commission,
        currency=currency,
    )
    earn_doc = earn.model_dump()
    # Stash the credits awarded + auto-credited flag on the same record so
    # we keep one source of truth per transaction.
    earn_doc['credits_purchased'] = int(credits_purchased or 0)
    earn_doc['credits_awarded'] = credits_award
    earn_doc['status'] = 'credited' if credits_award > 0 else 'accrued'
    earn_doc['credited_at'] = datetime.now(timezone.utc) if credits_award > 0 else None
    await db.referral_earnings.insert_one(earn_doc)

    if credits_award > 0:
        await db.users.update_one(
            {'id': referrer_id},
            {'$inc': {'credits': credits_award}},
        )
        # Drop an in-app notification so the referrer sees the win instantly.
        try:
            from notifications_ext import _uid as _notif_uid
            await db.user_notifications.insert_one({
                'id': _notif_uid(),
                'user_id': referrer_id,
                'from_operator_id': None,
                'kind': 'broadcast',
                'subject': f'+{credits_award} credits — referral payout',
                'body': (
                    f'Your referral {paid_user_email} just purchased the {plan_id} plan. '
                    f'You earned {credits_award} credits ({int(pct)}% of {int(credits_purchased or 0)}). '
                    f'Thanks for spreading the word!'
                ),
                'read_at': None,
                'created_at': datetime.now(timezone.utc),
            })
        except Exception:
            # Notification failure must never block the credit grant.
            pass
