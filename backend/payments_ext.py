"""Extended payment routes: editable plans, treasury, settings, manual payments, PDF receipts."""
import os
import io
import base64
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from fastapi.responses import StreamingResponse, Response
import segno
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

from auth_utils import get_current_operator, get_current_user
from models import (
    PlanModel, PlanUpsertRequest,
    TreasuryDestination, TreasuryUpsertRequest,
    PaymentSettings, ManualPaymentRequest,
    PaymentTransaction,
    License, LicenseUpsertRequest, EarningsReportRequest, RoyaltyRecord, RemittanceRequest,
)
import secrets

logger = logging.getLogger('tbc.payments')

router = APIRouter(prefix='/api')


DEFAULT_PLANS = [
    {'id': 'starter',    'name': 'Starter',    'price': 9.0,   'regular_price': 19.0,  'credits': 500,    'intro': True,  'features': ['500 AI messages/mo', 'GPT-5 + Claude access', 'Chat history', 'Email support'], 'enabled': True, 'order': 1},
    {'id': 'pro',        'name': 'Pro',        'price': 49.0,  'regular_price': 69.0,  'credits': 2500,   'intro': True,  'features': ['2,500 AI messages/mo', 'GPT-5, Claude Opus & Gemini', 'Priority responses', 'Code export', 'Priority support'], 'enabled': True, 'order': 2},
    {'id': 'enterprise', 'name': 'Enterprise', 'price': 139.0, 'regular_price': 139.0, 'credits': 10000,  'intro': False, 'features': ['10,000 AI messages/mo', 'All frontier models', 'API access', 'Custom integrations', '24/7 support'], 'enabled': True, 'order': 3},
]

# One-shot top-up packs surfaced from the in-chat OutOfCreditsDialog. These are
# `hidden: True` so they don't render on the public /pricing page (the modal
# drives the only entry point). Updating `price` here keeps the modal & the
# Plans tab in sync. Adding a new pack is a one-line addition + a matching
# entry in OutOfCreditsDialog.jsx → TOP_UP_PACKS.
DEFAULT_CREDIT_PACKS = [
    {'id': 'credits_100',  'name': 'Quick top-up', 'price': 9.0,  'regular_price': 9.0,  'credits': 100,   'intro': False, 'features': ['100 credits',  'No expiry', 'Applies across every model'], 'enabled': True, 'hidden': True, 'order': 100, 'kind': 'credit_pack'},
    {'id': 'credits_500',  'name': 'Best value',   'price': 39.0, 'regular_price': 45.0, 'credits': 500,   'intro': True,  'features': ['500 credits',  'No expiry', 'Most popular pack'],           'enabled': True, 'hidden': True, 'order': 101, 'kind': 'credit_pack'},
    {'id': 'credits_1000', 'name': 'Power pack',   'price': 69.0, 'regular_price': 90.0, 'credits': 1000, 'intro': True,  'features': ['1,000 credits', 'No expiry', 'Best for active builders'],     'enabled': True, 'hidden': True, 'order': 102, 'kind': 'credit_pack'},
]


def _serialize(d):
    if not d:
        return d
    d.pop('_id', None)
    for k, v in list(d.items()):
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


def _plan_activation_set(plan: dict) -> dict:
    """Build the $set dict for activating `plan` on a user.

    Always sets `plan` + `plan_started_at`. If the plan has `trial_days > 0`,
    also sets `plan_expires_at`; otherwise clears it (permanent plan).

    **Credit-pack purchases are different** — they add credits without
    changing the user's underlying subscription. For those we return an empty
    `$set` so the caller's `$inc: {credits}` does all the work.
    """
    if plan.get('kind') == 'credit_pack':
        # No plan change — just stamp the last-topped-up time for the operator's
        # audit trail. Skipping `plan` / `plan_started_at` / `plan_expires_at`
        # preserves the user's existing subscription window.
        return {'credits_last_topped_up_at': datetime.now(timezone.utc)}
    now = datetime.now(timezone.utc)
    trial_days = int(plan.get('trial_days') or 0)
    expires = now + timedelta(days=trial_days) if trial_days > 0 else None
    return {
        'plan': plan['id'],
        'plan_started_at': now,
        'plan_expires_at': expires,
    }


def _mask_key(k: Optional[str]) -> Optional[str]:
    if not k:
        return None
    if len(k) <= 8:
        return '••••' + k[-2:]
    return k[:4] + '••••' + k[-4:]


async def get_db():
    """Return shared Mongo db handle."""
    from db import db as _db
    return _db


# ---------- INIT DEFAULTS (called from server.startup) ----------
async def seed_defaults():
    db = await get_db()
    if await db.plans.count_documents({}) == 0:
        await db.plans.insert_many(DEFAULT_PLANS)
        logger.info('Seeded default plans')
    # Credit packs are seeded **idempotently** even on existing deployments so
    # the OutOfCreditsDialog works end-to-end without an operator step. We use
    # upsert-per-id rather than insert_many so re-runs don't 11000-collide and
    # so editing prices in DEFAULT_CREDIT_PACKS rolls forward automatically.
    for pack in DEFAULT_CREDIT_PACKS:
        if await db.plans.find_one({'id': pack['id']}) is None:
            await db.plans.insert_one(pack)
            logger.info('Seeded credit pack %s', pack['id'])
    if await db.settings.count_documents({'_id': 'payment_settings'}) == 0:
        defaults = PaymentSettings().model_dump()
        defaults['_id'] = 'payment_settings'
        await db.settings.insert_one(defaults)
        logger.info('Seeded payment settings')


async def get_settings_doc() -> dict:
    db = await get_db()
    doc = await db.settings.find_one({'_id': 'payment_settings'})
    if not doc:
        defaults = PaymentSettings().model_dump()
        defaults['_id'] = 'payment_settings'
        await db.settings.insert_one(defaults)
        return defaults
    return doc


async def get_plans_list(only_enabled: bool = False) -> List[dict]:
    db = await get_db()
    q = {'enabled': True} if only_enabled else {}
    cursor = db.plans.find(q).sort('order', 1)
    return [_serialize(p) async for p in cursor]


# ===================================================================
# PUBLIC: payment methods + plans
# ===================================================================
@router.get('/payments/methods')
async def list_payment_methods():
    settings = await get_settings_doc()
    methods = []
    if settings.get('enable_card', True):
        methods.append({'id': 'card', 'label': 'Card / Apple Pay / Google Pay', 'description': 'Visa, Mastercard, Amex • Apple Pay & Google Pay on supported devices', 'instant': True})
    if settings.get('enable_paypal') and settings.get('paypal_client_id'):
        methods.append({'id': 'paypal', 'label': 'PayPal', 'description': 'Pay with your PayPal balance or linked card', 'instant': True})
    if settings.get('enable_crypto_auto') and settings.get('nowpayments_api_key'):
        methods.append({'id': 'crypto_auto', 'label': 'Crypto (auto)', 'description': 'BTC, ETH, USDT and more via NOWPayments', 'instant': True})
    if settings.get('enable_crypto_manual', True):
        methods.append({'id': 'crypto_manual', 'label': 'Crypto (manual)', 'description': 'Send to our wallet — confirm with tx hash', 'instant': False})
    if settings.get('enable_bank', True):
        methods.append({'id': 'bank', 'label': 'Bank transfer', 'description': 'SEPA / Wire — confirm with reference', 'instant': False})
    return methods


@router.get('/payments/treasury/active')
async def public_active_treasury(method: str = Query(...)):
    """Return the active treasury destination for a given manual method."""
    db = await get_db()
    type_ = 'crypto' if method == 'crypto_manual' else 'bank'
    doc = await db.treasury.find_one({'type': type_, 'is_active': True})
    if not doc:
        raise HTTPException(404, f'No active {type_} destination set. Operator must configure one.')
    # Strip sensitive fields if any (we already keep all fields public for manual flow)
    out = _serialize(doc)
    # Generate QR for crypto wallet
    if type_ == 'crypto' and out.get('wallet_address'):
        qr = segno.make(out['wallet_address'], micro=False, error='m')
        buf = io.BytesIO()
        qr.save(buf, kind='png', scale=6, border=2, dark='#d4af37', light='#0a0a0a')
        out['qr_data_url'] = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    return out


# ===================================================================
# PAYPAL (Orders v2 — redirect flow, pure REST)
# ===================================================================
PAYPAL_BASES = {'sandbox': 'https://api-m.sandbox.paypal.com', 'live': 'https://api-m.paypal.com'}


async def _paypal_token(settings: dict) -> tuple[str, str]:
    """Return (access_token, base_url). Raises HTTPException if credentials missing."""
    cid = settings.get('paypal_client_id')
    secret = settings.get('paypal_client_secret')
    mode = settings.get('paypal_mode', 'sandbox')
    if not cid or not secret:
        raise HTTPException(400, 'PayPal credentials not configured by operator')
    base = PAYPAL_BASES.get(mode, PAYPAL_BASES['sandbox'])
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{base}/v1/oauth2/token',
            auth=(cid, secret),
            data={'grant_type': 'client_credentials'},
            headers={'Accept': 'application/json'},
        )
    if r.status_code != 200:
        logger.error('PayPal token error: %s %s', r.status_code, r.text)
        raise HTTPException(502, 'PayPal authentication failed')
    return r.json()['access_token'], base


class PayPalCreateRequest:  # pragma: no cover (replaced below with pydantic)
    pass


from pydantic import BaseModel


class PayPalCreateReq(BaseModel):
    plan_id: str
    origin_url: str


@router.post('/payments/paypal/create')
async def paypal_create_order(req: PayPalCreateReq, user: dict = Depends(get_current_user)):
    settings = await get_settings_doc()
    if not settings.get('enable_paypal'):
        raise HTTPException(400, 'PayPal is disabled')
    plans = await get_plans_list()
    plan = next((p for p in plans if p['id'] == req.plan_id), None)
    if not plan:
        raise HTTPException(404, 'Plan not found')

    token, base = await _paypal_token(settings)
    return_url = f'{req.origin_url.rstrip("/")}/pay/paypal/return'
    cancel_url = f'{req.origin_url.rstrip("/")}/pay/paypal/cancel'

    body = {
        'intent': 'CAPTURE',
        'purchase_units': [{
            'reference_id': req.plan_id,
            'description': f"TBC AI Tools — {plan['name']} plan",
            'amount': {'currency_code': 'USD', 'value': f"{float(plan['price']):.2f}"},
        }],
        'application_context': {
            'brand_name': 'TBC AI Tools',
            'user_action': 'PAY_NOW',
            'return_url': return_url,
            'cancel_url': cancel_url,
        },
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{base}/v2/checkout/orders',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            json=body,
        )
    if r.status_code not in (200, 201):
        logger.error('PayPal create order error: %s %s', r.status_code, r.text)
        raise HTTPException(502, 'Could not create PayPal order')
    data = r.json()
    approval = next((link['href'] for link in data.get('links', []) if link.get('rel') == 'approve'), None)
    if not approval:
        raise HTTPException(502, 'PayPal did not return approval URL')

    # Persist a pending transaction so we can confirm on capture
    db = await get_db()
    tx = PaymentTransaction(
        session_id=data['id'],
        user_id=user['sub'],
        user_email=user['email'],
        plan_id=req.plan_id,
        amount=float(plan['price']),
        currency='usd',
        status='initiated',
        payment_status='pending',
        metadata={'method': 'paypal', 'paypal_mode': settings.get('paypal_mode', 'sandbox')},
    )
    await db.payment_transactions.insert_one(tx.model_dump())
    return {'order_id': data['id'], 'approval_url': approval}


@router.post('/payments/paypal/capture/{order_id}')
async def paypal_capture_order(order_id: str, user: dict = Depends(get_current_user)):
    settings = await get_settings_doc()
    token, base = await _paypal_token(settings)
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f'{base}/v2/checkout/orders/{order_id}/capture',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        )
    if r.status_code not in (200, 201):
        logger.error('PayPal capture error: %s %s', r.status_code, r.text)
        raise HTTPException(502, 'PayPal capture failed')
    data = r.json()
    if data.get('status') != 'COMPLETED':
        raise HTTPException(400, f"PayPal status is {data.get('status')}")

    db = await get_db()
    tx = await db.payment_transactions.find_one({'session_id': order_id})
    if not tx:
        raise HTTPException(404, 'Transaction not found')
    if tx.get('payment_status') == 'paid':
        return {'already_paid': True, 'plan_id': tx['plan_id']}

    plans = await get_plans_list()
    plan = next((p for p in plans if p['id'] == tx['plan_id']), None)
    await db.payment_transactions.update_one(
        {'session_id': order_id},
        {'$set': {'payment_status': 'paid', 'status': 'paid', 'updated_at': datetime.now(timezone.utc)}},
    )
    if plan:
        await db.users.update_one(
            {'id': tx['user_id']},
            {'$set': _plan_activation_set(plan), '$inc': {'credits': int(plan['credits'])}},
        )
    return {'success': True, 'plan_id': tx['plan_id']}


# ===================================================================
# MANUAL PAYMENT FLOW
# ===================================================================
@router.post('/payments/manual')
async def submit_manual_payment(req: ManualPaymentRequest, user: dict = Depends(get_current_user)):
    db = await get_db()
    plans = await get_plans_list()
    plan = next((p for p in plans if p['id'] == req.plan_id), None)
    if not plan:
        raise HTTPException(404, 'Plan not found')
    treas = await db.treasury.find_one({'id': req.treasury_id})
    if not treas:
        raise HTTPException(404, 'Treasury destination not found')

    tx = PaymentTransaction(
        session_id=f"manual_{datetime.now(timezone.utc).timestamp():.0f}_{user['sub'][:6]}",
        user_id=user['sub'],
        user_email=user['email'],
        plan_id=req.plan_id,
        amount=float(plan['price']),
        currency='usd',
        status='pending_review',
        payment_status='pending',
        metadata={
            'method': req.method,
            'treasury_id': req.treasury_id,
            'treasury_label': treas.get('label'),
            'proof': req.proof,
            'note': req.note or '',
        },
    )
    await db.payment_transactions.insert_one(tx.model_dump())
    return {'success': True, 'transaction_id': tx.id, 'status': 'pending_review'}


@router.post('/operator/transactions/{tx_id}/confirm')
async def op_confirm_transaction(tx_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    tx = await db.payment_transactions.find_one({'id': tx_id})
    if not tx:
        raise HTTPException(404, 'Transaction not found')
    if tx.get('payment_status') == 'paid':
        return {'already_paid': True}
    plans = await get_plans_list()
    plan = next((p for p in plans if p['id'] == tx['plan_id']), None)
    await db.payment_transactions.update_one(
        {'id': tx_id},
        {'$set': {'payment_status': 'paid', 'status': 'paid', 'updated_at': datetime.now(timezone.utc)}},
    )
    if plan:
        await db.users.update_one(
            {'id': tx['user_id']},
            {'$set': _plan_activation_set(plan), '$inc': {'credits': int(plan['credits'])}},
        )
    return {'success': True}


@router.post('/operator/transactions/{tx_id}/reject')
async def op_reject_transaction(tx_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.payment_transactions.update_one(
        {'id': tx_id},
        {'$set': {'payment_status': 'failed', 'status': 'rejected', 'updated_at': datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, 'Transaction not found')
    return {'success': True}


# ===================================================================
# OPERATOR: PLANS CRUD
# ===================================================================
@router.get('/operator/plans')
async def op_list_plans(_: dict = Depends(get_current_operator)):
    return await get_plans_list(only_enabled=False)


@router.post('/operator/plans')
async def op_create_plan(req: PlanUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    plan_id = req.id or req.name.lower().replace(' ', '_')
    if await db.plans.find_one({'id': plan_id}):
        raise HTTPException(400, 'Plan id already exists')
    p = {'id': plan_id, **req.dict(exclude={'id'})}
    await db.plans.insert_one(p)
    return _serialize(p)


@router.put('/operator/plans/{plan_id}')
async def op_update_plan(plan_id: str, req: PlanUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    updates = req.dict(exclude={'id'})
    res = await db.plans.update_one({'id': plan_id}, {'$set': updates})
    if res.matched_count == 0:
        raise HTTPException(404, 'Plan not found')
    doc = await db.plans.find_one({'id': plan_id})
    return _serialize(doc)


@router.delete('/operator/plans/{plan_id}')
async def op_delete_plan(plan_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.plans.delete_one({'id': plan_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Plan not found')
    return {'success': True}


@router.post('/operator/plans/discount-campaign')
async def op_discount_campaign(
    payload: dict = Body(...),
    _: dict = Depends(get_current_operator),
):
    """Apply a global % discount across selected (or all) plans.

    Body: {
      "percent": 20,
      "plan_ids": ["starter", "pro"] | null,
      "clear": false,
      "announce_on_banner": true,
      "starts_at": "2026-02-01T00:00:00Z" | null,
      "ends_at":   "2026-02-08T00:00:00Z" | null,
      "banner_text": "20% off PRO this week!" | null
    }
    - When clear=true, restores price = regular_price and intro=false for the selected scope.
    - Otherwise, sets price = round(regular_price * (1 - percent/100), 2) and intro=true.
    - When announce_on_banner=true, *also* writes a corresponding entry into
      the scrolling marketing banner (with optional start/end window). Pair
      with `clear=true` to retract both the prices and the banner in one call.
    """
    db = await get_db()
    clear = bool(payload.get('clear'))
    plan_ids = payload.get('plan_ids') or None
    query = {}
    if plan_ids:
        query['id'] = {'$in': list(plan_ids)}
    updated = 0
    async for doc in db.plans.find(query):
        regular = float(doc.get('regular_price') or doc.get('price') or 0)
        if regular <= 0:
            continue
        if clear:
            new_price = regular
            intro = False
        else:
            pct = max(0.0, min(100.0, float(payload.get('percent') or 0)))
            new_price = round(regular * (1 - pct / 100.0), 2)
            intro = pct > 0
        await db.plans.update_one(
            {'id': doc['id']},
            {'$set': {'price': new_price, 'regular_price': regular, 'intro': intro}},
        )
        updated += 1

    # Optional: keep the scrolling banner(s) in sync with the campaign.
    # Operator can target one or more banner scopes (defaults to landing).
    announce = bool(payload.get('announce_on_banner'))
    scopes = payload.get('banner_scopes') or ['landing']
    scopes = [s for s in scopes if s in BANNER_SCOPES] or ['landing']
    banner_updated = False
    if announce or clear:
        for scope in scopes:
            doc_id = _banner_doc_id(scope)
            existing = await db.settings.find_one({'_id': doc_id}) or {}
            if clear:
                # Pull out any auto-generated campaign messages but keep the
                # operator's hand-written ones.
                kept = [
                    m for m in (existing.get('messages') or [])
                    if not (isinstance(m, dict) and m.get('source') == 'campaign')
                ]
                banner_doc = {
                    **existing,
                    '_id': doc_id,
                    'messages': kept,
                    'enabled': bool(existing.get('enabled', False)) and len(kept) > 0,
                }
                await db.settings.update_one({'_id': doc_id}, {'$set': banner_doc}, upsert=True)
                banner_updated = True
            else:
                pct = max(0.0, min(100.0, float(payload.get('percent') or 0)))
                default_text = f'Limited offer — {int(pct)}% off all plans!'
                text = (payload.get('banner_text') or default_text).strip()
                new_msg = {
                    'text': text,
                    'href': '/pricing',
                    'source': 'campaign',
                }
                kept_user_msgs = [
                    m for m in (existing.get('messages') or [])
                    if not (isinstance(m, dict) and m.get('source') == 'campaign')
                ]
                banner_doc = {
                    '_id': doc_id,
                    'enabled': True,
                    'messages': kept_user_msgs + [new_msg],
                    'speed_seconds': float(existing.get('speed_seconds') or 30),
                    'starts_at': payload.get('starts_at') or existing.get('starts_at'),
                    'ends_at': payload.get('ends_at') or existing.get('ends_at'),
                }
                await db.settings.update_one({'_id': doc_id}, {'$set': banner_doc}, upsert=True)
                banner_updated = True

    return {
        'success': True,
        'updated': updated,
        'clear': clear,
        'banner_updated': banner_updated,
        'banner_scopes': scopes if (announce or clear) else [],
    }


# ===================================================================
# MARKETING BANNER (scrolling ticker) — multiple named scopes
# ===================================================================
BANNER_SCOPES = {'landing', 'dashboard_new', 'dashboard_subscription'}


def _banner_doc_id(scope: str) -> str:
    """Backwards-compatible doc id: the original single banner lives at
    `marketing_banner`; the new named ones at `marketing_banner:{scope}`."""
    if scope == 'landing':
        return 'marketing_banner'
    return f'marketing_banner:{scope}'


@router.get('/marketing/banner')
async def get_marketing_banner(scope: str = Query('landing')):
    """Public — fetch the current scrolling marketing banner config for a
    given scope. Defaults to `landing` so older clients keep working.

    Valid scopes: `landing`, `dashboard_new`, `dashboard_subscription`.
    Each scope is an independent banner the operator can run on its own
    schedule and audience.
    """
    if scope not in BANNER_SCOPES:
        raise HTTPException(400, f'Unknown scope. Use one of {sorted(BANNER_SCOPES)}')
    db = await get_db()
    doc = await db.settings.find_one({'_id': _banner_doc_id(scope)}) or {}
    return {
        'scope': scope,
        'enabled': bool(doc.get('enabled', False)),
        'messages': doc.get('messages') or [],
        'speed_seconds': float(doc.get('speed_seconds') or 30),
        'starts_at': doc.get('starts_at'),
        'ends_at': doc.get('ends_at'),
    }


@router.put('/operator/marketing/banner')
async def update_marketing_banner(
    payload: dict = Body(...),
    scope: str = Query('landing'),
    _: dict = Depends(get_current_operator),
):
    """Operator — replace the marketing banner config for a scope.

    Query param: `scope=landing|dashboard_new|dashboard_subscription`.
    """
    if scope not in BANNER_SCOPES:
        raise HTTPException(400, f'Unknown scope. Use one of {sorted(BANNER_SCOPES)}')
    db = await get_db()
    # Defensive normalisation — accept str messages too.
    raw_msgs = payload.get('messages') or []
    clean_msgs = []
    for m in raw_msgs:
        if isinstance(m, str):
            t = m.strip()
            if t:
                clean_msgs.append({'text': t})
        elif isinstance(m, dict):
            t = (m.get('text') or '').strip()
            if not t:
                continue
            item = {'text': t}
            href = (m.get('href') or '').strip()
            if href:
                item['href'] = href
            clean_msgs.append(item)
    doc_id = _banner_doc_id(scope)
    doc = {
        '_id': doc_id,
        'enabled': bool(payload.get('enabled', False)),
        'messages': clean_msgs,
        'speed_seconds': max(5.0, min(300.0, float(payload.get('speed_seconds') or 30))),
        'starts_at': payload.get('starts_at') or None,
        'ends_at': payload.get('ends_at') or None,
    }
    await db.settings.update_one({'_id': doc_id}, {'$set': doc}, upsert=True)
    return {'success': True, 'scope': scope, 'messages_count': len(clean_msgs)}


# ===================================================================
# OPERATOR: TREASURY CRUD
# ===================================================================
@router.get('/operator/treasury')
async def op_list_treasury(_: dict = Depends(get_current_operator)):
    db = await get_db()
    cursor = db.treasury.find({}).sort('created_at', -1)
    return [_serialize(d) async for d in cursor]


@router.post('/operator/treasury')
async def op_create_treasury(req: TreasuryUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    dest = TreasuryDestination(**req.dict(exclude_none=True))
    await db.treasury.insert_one(dest.model_dump())
    return _serialize(dest.model_dump())


@router.put('/operator/treasury/{dest_id}')
async def op_update_treasury(dest_id: str, req: TreasuryUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    res = await db.treasury.update_one({'id': dest_id}, {'$set': updates})
    if res.matched_count == 0:
        raise HTTPException(404, 'Destination not found')
    doc = await db.treasury.find_one({'id': dest_id})
    return _serialize(doc)


@router.delete('/operator/treasury/{dest_id}')
async def op_delete_treasury(dest_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.treasury.delete_one({'id': dest_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Destination not found')
    return {'success': True}


@router.post('/operator/treasury/{dest_id}/activate')
async def op_activate_treasury(dest_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    dest = await db.treasury.find_one({'id': dest_id})
    if not dest:
        raise HTTPException(404, 'Destination not found')
    # Deactivate others of same type, activate this one
    await db.treasury.update_many({'type': dest['type']}, {'$set': {'is_active': False}})
    await db.treasury.update_one({'id': dest_id}, {'$set': {'is_active': True}})
    return {'success': True}


# ===================================================================
# OPERATOR: SETTINGS
# ===================================================================
@router.get('/operator/settings')
async def op_get_settings(_: dict = Depends(get_current_operator)):
    doc = await get_settings_doc()
    return {
        'stripe_mode': doc.get('stripe_mode', 'test'),
        'stripe_secret_key_set': bool(doc.get('stripe_secret_key')),
        'stripe_secret_key_masked': _mask_key(doc.get('stripe_secret_key')),
        'nowpayments_api_key_set': bool(doc.get('nowpayments_api_key')),
        'nowpayments_api_key_masked': _mask_key(doc.get('nowpayments_api_key')),
        'nowpayments_ipn_secret_set': bool(doc.get('nowpayments_ipn_secret')),
        'paypal_mode': doc.get('paypal_mode', 'sandbox'),
        'paypal_client_id_set': bool(doc.get('paypal_client_id')),
        'paypal_client_id_masked': _mask_key(doc.get('paypal_client_id')),
        'paypal_client_secret_set': bool(doc.get('paypal_client_secret')),
        'enable_card': doc.get('enable_card', True),
        'enable_paypal': doc.get('enable_paypal', False),
        'enable_crypto_auto': doc.get('enable_crypto_auto', False),
        'enable_crypto_manual': doc.get('enable_crypto_manual', True),
        'enable_bank': doc.get('enable_bank', True),
        'emergent_llm_key_set': bool(doc.get('emergent_llm_key')),
        'emergent_llm_key_masked': _mask_key(doc.get('emergent_llm_key')),
        'resend_api_key_set': bool(doc.get('resend_api_key')),
        'resend_api_key_masked': _mask_key(doc.get('resend_api_key')),
        'sender_email': doc.get('sender_email') or os.environ.get('SENDER_EMAIL', ''),
        'default_plan_id': doc.get('default_plan_id') or 'starter',
        # Deploy & AI surface (presence + masking only, never echo plaintext).
        'vercel_token_set': bool(doc.get('vercel_token')),
        'vercel_token_masked': _mask_key(doc.get('vercel_token')),
        'vercel_team_id': doc.get('vercel_team_id') or '',
        'ai_api_key_set': bool(doc.get('ai_api_key')),
        'ai_api_key_masked': _mask_key(doc.get('ai_api_key')),
        # Outbound webhook for ship-and-watch events.
        'deploy_webhook_url': doc.get('deploy_webhook_url') or '',
        'deploy_webhook_secret_set': bool(doc.get('deploy_webhook_secret')),
        'deploy_webhook_secret_masked': _mask_key(doc.get('deploy_webhook_secret')),
        # Self-update: the project the operator wants to deploy when they hit
        # "Update this app". Two fields = repo (owner/name) + optional Vercel
        # project id once the first deploy succeeds.
        'self_repo': doc.get('self_repo') or '',
        'self_git_ref': doc.get('self_git_ref') or 'main',
        'self_vercel_project_id': doc.get('self_vercel_project_id') or '',
        # GitHub Contents API token used by code-review (private repos) and
        # auto-fix (committing patches back).
        'github_token_set': bool(doc.get('github_token')),
        'github_token_masked': _mask_key(doc.get('github_token')),
        # Rotation timestamps so the Secrets UI can show "rotated N days ago"
        # and proactively nag the operator before tokens expire.
        'vercel_token_rotated_at': doc.get('vercel_token_rotated_at'),
        'github_token_rotated_at': doc.get('github_token_rotated_at'),
    }


@router.put('/operator/settings')
async def op_update_settings(payload: dict, _: dict = Depends(get_current_operator)):
    """Accept partial updates. Keys with empty string are ignored to avoid wiping accidentally."""
    db = await get_db()
    allowed = {
        'stripe_secret_key', 'stripe_mode',
        'nowpayments_api_key', 'nowpayments_ipn_secret',
        'paypal_client_id', 'paypal_client_secret', 'paypal_mode',
        'enable_card', 'enable_paypal', 'enable_crypto_auto', 'enable_crypto_manual', 'enable_bank',
        'emergent_llm_key', 'resend_api_key', 'sender_email',
        'default_plan_id',
        # Deploy & AI surface — same gate as the rest of the settings doc.
        'vercel_token', 'vercel_team_id', 'ai_api_key',
        'deploy_webhook_url', 'deploy_webhook_secret',
        'self_repo', 'self_git_ref', 'self_vercel_project_id',
        'github_token',
    }
    updates = {}
    now = datetime.now(timezone.utc).isoformat()
    rotation_tracked = {'vercel_token', 'github_token'}
    for k, v in payload.items():
        if k not in allowed:
            continue
        if isinstance(v, str) and v.strip() == '':
            continue
        updates[k] = v
        # Track rotation so the Secrets UI can warn the operator when a
        # token has been in use for a long time.
        if k in rotation_tracked:
            updates[f'{k}_rotated_at'] = now
    if updates:
        await db.settings.update_one({'_id': 'payment_settings'}, {'$set': updates}, upsert=True)
    return {'success': True, 'updated_keys': list(updates.keys())}


@router.post('/operator/settings/clear')
async def op_clear_secret(key: str = Query(...), _: dict = Depends(get_current_operator)):
    db = await get_db()
    if key not in {'stripe_secret_key', 'nowpayments_api_key', 'nowpayments_ipn_secret', 'paypal_client_id', 'paypal_client_secret', 'emergent_llm_key', 'resend_api_key', 'vercel_token', 'ai_api_key', 'github_token'}:
        raise HTTPException(400, 'Cannot clear this key')
    unset_extra = {}
    if key in {'vercel_token', 'github_token'}:
        unset_extra[f'{key}_rotated_at'] = None
    await db.settings.update_one(
        {'_id': 'payment_settings'},
        {'$set': {key: None, **unset_extra}},
    )
    return {'success': True}


@router.post('/operator/keys/test')
async def op_test_key(
    payload: dict = Body(...),
    _: dict = Depends(get_current_operator),
):
    """Live-validate a Vercel or GitHub PAT *before* saving it.

    Lets the Secrets UI fail fast if the operator pastes an expired or
    wrong-scope token. Body shape: {"kind": "vercel"|"github", "value": "<token>"}
    The token is *never* logged.
    """
    kind = (payload.get('kind') or '').strip().lower()
    value = (payload.get('value') or '').strip()
    if kind not in {'vercel', 'github'}:
        raise HTTPException(400, 'Unsupported key kind')
    if not value:
        raise HTTPException(400, 'Empty token')

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            if kind == 'vercel':
                r = await client.get(
                    'https://api.vercel.com/v2/user',
                    headers={'Authorization': f'Bearer {value}'},
                )
                if r.status_code == 200:
                    u = (r.json().get('user') or r.json())
                    return {
                        'ok': True,
                        'identity': u.get('username') or u.get('email') or 'OK',
                        'message': 'Vercel token valid',
                    }
                return {
                    'ok': False,
                    'message': f'Vercel rejected the token ({r.status_code}). Check expiry & scopes.',
                }
            # github
            r = await client.get(
                'https://api.github.com/user',
                headers={
                    'Authorization': f'Bearer {value}',
                    'Accept': 'application/vnd.github+json',
                },
            )
            if r.status_code == 200:
                u = r.json()
                return {
                    'ok': True,
                    'identity': u.get('login') or 'OK',
                    'message': 'GitHub token valid',
                }
            return {
                'ok': False,
                'message': f'GitHub rejected the token ({r.status_code}). Check expiry & scopes (needs Contents: Write).',
            }
        except httpx.HTTPError as e:
            return {'ok': False, 'message': f'Network error: {e}'}


# ===================================================================
# Operator: Test integration connections
# ===================================================================
async def _test_paypal(settings: dict) -> dict:
    if not (settings.get('paypal_client_id') and settings.get('paypal_client_secret')):
        return {'ok': False, 'message': 'PayPal credentials not configured.'}
    mode = settings.get('paypal_mode', 'sandbox')
    base = PAYPAL_BASES.get(mode, PAYPAL_BASES['sandbox'])
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.post(
                f'{base}/v1/oauth2/token',
                auth=(settings['paypal_client_id'], settings['paypal_client_secret']),
                data={'grant_type': 'client_credentials'},
                headers={'Accept': 'application/json'},
            )
        except httpx.HTTPError as e:
            return {'ok': False, 'message': f'Network error reaching PayPal: {e}'}
    if r.status_code == 200:
        data = r.json()
        return {'ok': True,
                'message': f"Connected to PayPal {mode.upper()} · app_id={data.get('app_id') or 'n/a'} · scope OK"}
    try:
        err = r.json()
    except Exception:
        err = {'error_description': r.text[:200]}
    return {'ok': False,
            'message': f"PayPal {r.status_code}: {err.get('error_description') or err.get('error') or 'unknown error'}"}


async def _test_stripe(settings: dict) -> dict:
    key = settings.get('stripe_secret_key') or os.environ.get('STRIPE_API_KEY', '')
    if not key:
        return {'ok': False, 'message': 'Stripe secret key not configured.'}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.get('https://api.stripe.com/v1/account',
                                 headers={'Authorization': f'Bearer {key}'})
        except httpx.HTTPError as e:
            return {'ok': False, 'message': f'Network error reaching Stripe: {e}'}
    if r.status_code == 200:
        data = r.json()
        label = data.get('business_profile', {}).get('name') or data.get('email') or data.get('id', 'account')
        mode = 'LIVE' if not key.startswith('sk_test_') else 'TEST'
        return {'ok': True, 'message': f'Connected to Stripe {mode} · {label}'}
    try:
        err = r.json().get('error', {})
    except Exception:
        err = {'message': r.text[:200]}
    return {'ok': False,
            'message': f"Stripe {r.status_code}: {err.get('message') or err.get('code') or 'unknown error'}"}


async def _test_resend(_settings: dict) -> dict:
    api_key = os.environ.get('RESEND_API_KEY', '')
    if not api_key:
        return {'ok': False, 'message': 'RESEND_API_KEY not configured in backend .env'}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.get('https://api.resend.com/domains',
                                 headers={'Authorization': f'Bearer {api_key}'})
        except httpx.HTTPError as e:
            return {'ok': False, 'message': f'Network error reaching Resend: {e}'}
    if r.status_code != 200:
        return {'ok': False, 'message': f"Resend {r.status_code}: {r.text[:200]}"}
    try:
        data = r.json().get('data', [])
    except Exception:
        data = []
    verified = [d for d in data if d.get('status') == 'verified']
    sender = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')
    sender_domain = sender.split('@')[-1] if '@' in sender else sender
    sender_ok = sender_domain == 'resend.dev' or any(
        d.get('name') == sender_domain and d.get('status') == 'verified' for d in data
    )
    msg = f"Connected to Resend · {len(verified)}/{len(data)} domain(s) verified · sender '{sender}'"
    msg += ' ✅' if sender_ok else ' ⚠️  (sender domain not verified — emails will be rejected)'
    return {'ok': sender_ok, 'message': msg}


# Provider → test-handler dispatch table. Adding a new provider here is the
# only edit needed to surface a new "Test connection" button on the UI.
_CONNECTION_TESTERS = {
    'paypal': _test_paypal,
    'stripe': _test_stripe,
    'resend': _test_resend,
}


@router.post('/operator/test-connection/{provider}')
async def op_test_connection(provider: str, _: dict = Depends(get_current_operator)):
    """Ping a third-party API with the operator's saved keys and report success/failure.

    Supported providers: paypal | stripe | resend
    """
    tester = _CONNECTION_TESTERS.get(provider)
    if not tester:
        raise HTTPException(400, f'Unknown provider: {provider}')
    settings = await get_settings_doc()
    return await tester(settings)


# ===================================================================
# PDF RECEIPTS
# ===================================================================
def _build_receipt_pdf(tx: dict, user: Optional[dict] = None, plan: Optional[dict] = None) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=15*mm)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle('h1', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=22, textColor=colors.HexColor('#c89c2a'), spaceAfter=4)
    h2 = ParagraphStyle('h2', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=11, textColor=colors.HexColor('#3a2c08'), spaceAfter=6)  # noqa: F841
    body = ParagraphStyle('body', parent=styles['BodyText'], fontName='Helvetica', fontSize=10, textColor=colors.HexColor('#1f2937'), leading=14)
    muted = ParagraphStyle('m', parent=styles['BodyText'], fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#6b7280'))

    story = []
    story.append(Paragraph('TBC AI Tools', h1))
    story.append(Paragraph('TradeBridge Club &mdash; Payment Receipt', muted))
    story.append(Spacer(1, 14))

    created = tx.get('created_at')
    if isinstance(created, datetime):
        created_str = created.strftime('%Y-%m-%d %H:%M UTC')
    elif isinstance(created, str):
        created_str = created[:19].replace('T', ' ') + ' UTC'
    else:
        created_str = ''

    method = (tx.get('metadata') or {}).get('method') or 'card'
    treas_label = (tx.get('metadata') or {}).get('treasury_label') or '—'
    proof = (tx.get('metadata') or {}).get('proof') or '—'

    data = [
        ['Receipt #',         tx.get('id', '')],
        ['Date',              created_str],
        ['Customer',          tx.get('user_email', '')],
        ['Plan',              (plan or {}).get('name') or tx.get('plan_id', '')],
        ['Amount',            f"${float(tx.get('amount', 0)):.2f} {str(tx.get('currency', 'usd')).upper()}"],
        ['Payment method',    method],
        ['Treasury',          treas_label],
        ['Proof / reference', proof],
        ['Status',            f"{tx.get('payment_status', '')} / {tx.get('status', '')}"],
        ['Session id',        tx.get('session_id', '')],
    ]
    t = Table(data, colWidths=[55*mm, 110*mm])
    t.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#6b7280')),
        ('TEXTCOLOR', (1, 0), (1, -1), colors.HexColor('#111827')),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica-Bold'),
        ('ROWBACKGROUNDS', (0, 0), (-1, -1), [colors.HexColor('#fbf5e6'), colors.white]),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('LINEBELOW', (0, 0), (-1, -1), 0.25, colors.HexColor('#e5e7eb')),
    ]))
    story.append(t)
    story.append(Spacer(1, 22))
    story.append(Paragraph('Thank you for your purchase.', body))
    story.append(Paragraph('This is an automated receipt generated by TBC AI Tools. If you have questions, contact support@tbctools.org.', muted))

    doc.build(story)
    return buf.getvalue()


@router.get('/operator/transactions/{tx_id}/receipt')
async def op_tx_receipt(tx_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    tx = await db.payment_transactions.find_one({'id': tx_id})
    if not tx:
        raise HTTPException(404, 'Transaction not found')
    plan = await db.plans.find_one({'id': tx.get('plan_id')})
    user = await db.users.find_one({'id': tx.get('user_id')})
    pdf = _build_receipt_pdf(tx, user, plan)
    fname = f"receipt_{tx_id[:8]}.pdf"
    return Response(content=pdf, media_type='application/pdf', headers={'Content-Disposition': f'attachment; filename={fname}'})


def _parse_export_date_range(from_date: Optional[str], to_date: Optional[str]) -> dict:
    """Translate the optional from/to query params into a Mongo `$gte/$lte` filter.

    Raises 400 with the offending value embedded in the message so the operator
    can spot a typo at a glance. Returns an empty dict when both inputs are None
    so the caller can omit `created_at` from the query.
    """
    if not (from_date or to_date):
        return {}
    rng: dict = {}
    if from_date:
        try:
            rng['$gte'] = datetime.fromisoformat(from_date.replace('Z', '+00:00'))
        except Exception:
            raise HTTPException(400, f'Invalid `from` date "{from_date}". Use YYYY-MM-DD.')
    if to_date:
        try:
            rng['$lte'] = datetime.fromisoformat(to_date.replace('Z', '+00:00'))
        except Exception:
            raise HTTPException(400, f'Invalid `to` date "{to_date}". Use YYYY-MM-DD.')
    return rng


def _build_tx_export_pdf(txs: list[dict], from_date: Optional[str], to_date: Optional[str]) -> bytes:
    """Render the combined transactions report as a single PDF byte string."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=20*mm, rightMargin=20*mm,
                            topMargin=18*mm, bottomMargin=15*mm)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle('h1', parent=styles['Heading1'], fontName='Helvetica-Bold',
                        fontSize=20, textColor=colors.HexColor('#c89c2a'), spaceAfter=4)
    body = ParagraphStyle('body', parent=styles['BodyText'], fontName='Helvetica',
                          fontSize=10, textColor=colors.HexColor('#1f2937'))
    muted = ParagraphStyle('m', parent=styles['BodyText'], fontName='Helvetica',
                           fontSize=9, textColor=colors.HexColor('#6b7280'))

    rng_parts = []
    if from_date:
        rng_parts.append(f'from {from_date}')
    if to_date:
        rng_parts.append(f'to {to_date}')
    total = sum(float(t.get('amount', 0)) for t in txs)

    story = [
        Paragraph('TBC AI Tools — Transactions Report', h1),
        Paragraph('Range: ' + (' '.join(rng_parts) if rng_parts else 'all time'), muted),
        Paragraph(f'Total transactions: {len(txs)}', muted),
        Paragraph(f'Total amount (paid): ${total:.2f}', body),
        Spacer(1, 14),
    ]

    head = [['Date', 'Customer', 'Plan', 'Amount', 'Method', 'Status']]
    rows = []
    for t in txs:
        created = t.get('created_at')
        if isinstance(created, datetime):
            ds = created.strftime('%Y-%m-%d')
        else:
            ds = str(created)[:10]
        method = (t.get('metadata') or {}).get('method') or 'card'
        rows.append([
            ds,
            t.get('user_email', ''),
            t.get('plan_id', ''),
            f"${float(t.get('amount', 0)):.2f}",
            method,
            t.get('payment_status', ''),
        ])
    tbl = Table(head + rows, colWidths=[22*mm, 55*mm, 25*mm, 22*mm, 28*mm, 18*mm], repeatRows=1)
    tbl.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a1305')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.HexColor('#d4af37')),
        ('TEXTCOLOR', (0, 1), (-1, -1), colors.HexColor('#111827')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.HexColor('#fbf5e6'), colors.white]),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -1), 0.25, colors.HexColor('#e5e7eb')),
    ]))
    story.append(tbl)
    doc.build(story)
    return buf.getvalue()


@router.get('/operator/transactions/export')
async def op_tx_export(
    from_date: Optional[str] = Query(None, alias='from'),
    to_date: Optional[str] = Query(None, alias='to'),
    only_paid: bool = Query(True),
    _: dict = Depends(get_current_operator),
):
    """Export receipts for date range as a single combined PDF."""
    db = await get_db()
    q: dict = {}
    if only_paid:
        q['payment_status'] = 'paid'
    rng = _parse_export_date_range(from_date, to_date)
    if rng:
        q['created_at'] = rng

    cursor = db.payment_transactions.find(q).sort('created_at', 1)
    txs = [t async for t in cursor]
    if not txs:
        raise HTTPException(404, 'No transactions in selected range')

    pdf = _build_tx_export_pdf(txs, from_date, to_date)
    fname = f"tbc_transactions_{(from_date or 'all')}_{(to_date or 'all')}.pdf"
    return Response(content=pdf, media_type='application/pdf',
                    headers={'Content-Disposition': f'attachment; filename={fname}'})


# ===================================================================
# LICENSING & ROYALTIES
# ===================================================================
def _gen_license_key() -> str:
    return 'TBC-' + secrets.token_hex(16).upper()


@router.get('/operator/licenses')
async def op_list_licenses(_: dict = Depends(get_current_operator)):
    db = await get_db()
    cursor = db.licenses.find({}).sort('created_at', -1).limit(500)
    items = []
    async for d in cursor:
        d = _serialize(d)
        # attach summary: total owed
        owed_cursor = db.royalties.aggregate([
            {'$match': {'license_id': d['id'], 'status': 'owed'}},
            {'$group': {'_id': None, 'sum': {'$sum': '$royalty_amount'}, 'count': {'$sum': 1}}},
        ])
        owed_doc = await owed_cursor.to_list(1)
        rem_cursor = db.royalties.aggregate([
            {'$match': {'license_id': d['id'], 'status': 'remitted'}},
            {'$group': {'_id': None, 'sum': {'$sum': '$royalty_amount'}}},
        ])
        rem_doc = await rem_cursor.to_list(1)
        d['owed_amount'] = (owed_doc[0]['sum'] if owed_doc else 0) or 0
        d['owed_count'] = (owed_doc[0]['count'] if owed_doc else 0) or 0
        d['remitted_amount'] = (rem_doc[0]['sum'] if rem_doc else 0) or 0
        items.append(d)
    return items


@router.post('/operator/licenses')
async def op_create_license(req: LicenseUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    lic = License(key=_gen_license_key(), **req.model_dump())
    await db.licenses.insert_one(lic.model_dump())
    return _serialize(lic.model_dump())


@router.put('/operator/licenses/{lic_id}')
async def op_update_license(lic_id: str, req: LicenseUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.licenses.update_one({'id': lic_id}, {'$set': req.model_dump()})
    if res.matched_count == 0:
        raise HTTPException(404, 'License not found')
    doc = await db.licenses.find_one({'id': lic_id})
    return _serialize(doc)


@router.post('/operator/licenses/{lic_id}/revoke')
async def op_revoke_license(lic_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.licenses.update_one({'id': lic_id}, {'$set': {'status': 'revoked'}})
    if res.matched_count == 0:
        raise HTTPException(404, 'License not found')
    return {'success': True}


@router.post('/operator/licenses/{lic_id}/activate')
async def op_reactivate_license(lic_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.licenses.update_one({'id': lic_id}, {'$set': {'status': 'active'}})
    if res.matched_count == 0:
        raise HTTPException(404, 'License not found')
    return {'success': True}


@router.delete('/operator/licenses/{lic_id}')
async def op_delete_license(lic_id: str, _: dict = Depends(get_current_operator)):
    db = await get_db()
    res = await db.licenses.delete_one({'id': lic_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'License not found')
    return {'success': True}


# Public endpoint: child app reports a paid transaction
@router.post('/license/report-earnings')
async def license_report_earnings(req: EarningsReportRequest):
    db = await get_db()
    lic = await db.licenses.find_one({'key': req.license_key, 'status': 'active'})
    if not lic:
        raise HTTPException(401, 'Invalid or revoked license key')

    # Idempotency: skip if already reported by same child_transaction_id for this license
    existing = await db.royalties.find_one({'license_id': lic['id'], 'child_transaction_id': req.child_transaction_id})
    if existing:
        return {'duplicate': True, 'royalty_id': existing['id']}

    pct = float(lic.get('royalty_pct', 10.0))
    royalty_amount = round(float(req.amount) * pct / 100.0, 2)

    occurred_at = datetime.now(timezone.utc)
    if req.occurred_at:
        try:
            occurred_at = datetime.fromisoformat(req.occurred_at.replace('Z', '+00:00'))
        except Exception:
            pass

    rec = RoyaltyRecord(
        license_id=lic['id'],
        license_key=lic['key'],
        child_transaction_id=req.child_transaction_id,
        child_user_email=req.child_user_email,
        plan_id=req.plan_id,
        gross_amount=float(req.amount),
        royalty_amount=royalty_amount,
        currency=req.currency,
        payment_method=req.payment_method,
        status='owed',
        occurred_at=occurred_at,
    )
    await db.royalties.insert_one(rec.model_dump())
    await db.licenses.update_one({'id': lic['id']}, {'$set': {'last_report_at': datetime.now(timezone.utc)}})
    return {'royalty_id': rec.id, 'royalty_amount': royalty_amount, 'pct': pct}


@router.get('/operator/royalties')
async def op_list_royalties(
    license_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    _: dict = Depends(get_current_operator),
):
    db = await get_db()
    q = {}
    if license_id:
        q['license_id'] = license_id
    if status in ('owed', 'remitted', 'disputed'):
        q['status'] = status
    cursor = db.royalties.find(q).sort('occurred_at', -1).limit(500)
    return [_serialize(r) async for r in cursor]


@router.get('/operator/royalties/summary')
async def op_royalty_summary(_: dict = Depends(get_current_operator)):
    db = await get_db()
    summary = {'owed_total': 0, 'owed_count': 0, 'remitted_total': 0, 'remitted_count': 0, 'licenses_active': 0, 'licenses_total': 0}
    summary['licenses_total'] = await db.licenses.count_documents({})
    summary['licenses_active'] = await db.licenses.count_documents({'status': 'active'})
    for state, total_key, count_key in [('owed', 'owed_total', 'owed_count'), ('remitted', 'remitted_total', 'remitted_count')]:
        cursor = db.royalties.aggregate([
            {'$match': {'status': state}},
            {'$group': {'_id': None, 'sum': {'$sum': '$royalty_amount'}, 'count': {'$sum': 1}}},
        ])
        doc = await cursor.to_list(1)
        summary[total_key] = round((doc[0]['sum'] if doc else 0) or 0, 2)
        summary[count_key] = (doc[0]['count'] if doc else 0) or 0
    return summary


@router.post('/operator/royalties/remit')
async def op_record_remittance(req: RemittanceRequest, _: dict = Depends(get_current_operator)):
    """Mark a batch of royalty records as remitted (paid by licensee)."""
    db = await get_db()
    lic = await db.licenses.find_one({'id': req.license_id})
    if not lic:
        raise HTTPException(404, 'License not found')
    remittance_id = secrets.token_hex(8)
    update = {
        'status': 'remitted',
        'remittance_id': remittance_id,
        'remitted_at': datetime.now(timezone.utc).isoformat(),
        'remit_method': req.method,
        'remit_reference': req.reference,
        'remit_note': req.note,
    }
    q = {'license_id': req.license_id, 'status': 'owed'}
    if req.royalty_ids:
        q['id'] = {'$in': req.royalty_ids}
    res = await db.royalties.update_many(q, {'$set': update})
    return {'success': True, 'matched': res.matched_count, 'modified': res.modified_count, 'remittance_id': remittance_id}


@router.get('/license/agreement')
async def license_agreement_text():
    """Public text of the licensing agreement (10% royalty)."""
    return {
        'version': '1.0',
        'title': 'TBC AI Tools — Source License Agreement',
        'effective_date': '2026-01-01',
        'royalty_pct': 10.0,
        'text': (
            "By using a copy of TBC AI Tools under this license, the licensee agrees to remit "
            "ten percent (10%) of all gross revenue generated by the licensed instance to the "
            "original operator. Earnings must be reported automatically via the official "
            "/license/report-earnings endpoint or manually via the operator console at least "
            "once per calendar month. Royalties are owed in the same currency as the original "
            "payment. The licensee remains the controller of customer data on their instance, "
            "but is responsible for all customer support, regulatory compliance, taxes, and "
            "refunds related to their instance. The original operator may revoke this license "
            "for non-payment, misuse, or breach of these terms. Sub-licensing this copy is "
            "permitted, but every sub-licensed instance also owes 10% directly to the original "
            "operator (not the intermediate licensee)."
        ),
    }
