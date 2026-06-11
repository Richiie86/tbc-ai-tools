"""Extended payment routes: editable plans, treasury, settings, manual payments, PDF receipts."""
import os
import io
import base64
import logging
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
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
)

logger = logging.getLogger('tbc.payments')

router = APIRouter(prefix='/api')


DEFAULT_PLANS = [
    {'id': 'starter',    'name': 'Starter',    'price': 9.0,   'regular_price': 19.0,  'credits': 500,    'intro': True,  'features': ['500 AI messages/mo', 'GPT-5 + Claude access', 'Chat history', 'Email support'], 'enabled': True, 'order': 1},
    {'id': 'pro',        'name': 'Pro',        'price': 49.0,  'regular_price': 69.0,  'credits': 2500,   'intro': True,  'features': ['2,500 AI messages/mo', 'GPT-5, Claude Opus & Gemini', 'Priority responses', 'Code export', 'Priority support'], 'enabled': True, 'order': 2},
    {'id': 'enterprise', 'name': 'Enterprise', 'price': 139.0, 'regular_price': 139.0, 'credits': 10000,  'intro': False, 'features': ['10,000 AI messages/mo', 'All frontier models', 'API access', 'Custom integrations', '24/7 support'], 'enabled': True, 'order': 3},
]


def _serialize(d):
    if not d:
        return d
    d.pop('_id', None)
    for k, v in list(d.items()):
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


def _mask_key(k: Optional[str]) -> Optional[str]:
    if not k:
        return None
    if len(k) <= 8:
        return '••••' + k[-2:]
    return k[:4] + '••••' + k[-4:]


async def get_db():
    """Imported lazily to avoid circular import with server."""
    from server import db as _db
    return _db


# ---------- INIT DEFAULTS (called from server.startup) ----------
async def seed_defaults():
    db = await get_db()
    if await db.plans.count_documents({}) == 0:
        await db.plans.insert_many(DEFAULT_PLANS)
        logger.info('Seeded default plans')
    if await db.settings.count_documents({'_id': 'payment_settings'}) == 0:
        defaults = PaymentSettings().dict()
        defaults['_id'] = 'payment_settings'
        await db.settings.insert_one(defaults)
        logger.info('Seeded payment settings')


async def get_settings_doc() -> dict:
    db = await get_db()
    doc = await db.settings.find_one({'_id': 'payment_settings'})
    if not doc:
        defaults = PaymentSettings().dict()
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
    await db.payment_transactions.insert_one(tx.dict())
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
            {'$set': {'plan': plan['id']}, '$inc': {'credits': int(plan['credits'])}},
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
    dest = TreasuryDestination(**req.dict())
    await db.treasury.insert_one(dest.dict())
    return _serialize(dest.dict())


@router.put('/operator/treasury/{dest_id}')
async def op_update_treasury(dest_id: str, req: TreasuryUpsertRequest, _: dict = Depends(get_current_operator)):
    db = await get_db()
    updates = {k: v for k, v in req.dict().items() if v is not None}
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
    }
    updates = {}
    for k, v in payload.items():
        if k not in allowed:
            continue
        if isinstance(v, str) and v.strip() == '':
            continue
        updates[k] = v
    if updates:
        await db.settings.update_one({'_id': 'payment_settings'}, {'$set': updates}, upsert=True)
    return {'success': True, 'updated_keys': list(updates.keys())}


@router.post('/operator/settings/clear')
async def op_clear_secret(key: str = Query(...), _: dict = Depends(get_current_operator)):
    db = await get_db()
    if key not in {'stripe_secret_key', 'nowpayments_api_key', 'nowpayments_ipn_secret', 'paypal_client_id', 'paypal_client_secret'}:
        raise HTTPException(400, 'Cannot clear this key')
    await db.settings.update_one({'_id': 'payment_settings'}, {'$set': {key: None}})
    return {'success': True}


# ===================================================================
# PDF RECEIPTS
# ===================================================================
def _build_receipt_pdf(tx: dict, user: Optional[dict] = None, plan: Optional[dict] = None) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=15*mm)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle('h1', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=22, textColor=colors.HexColor('#c89c2a'), spaceAfter=4)
    h2 = ParagraphStyle('h2', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=11, textColor=colors.HexColor('#3a2c08'), spaceAfter=6)
    body = ParagraphStyle('body', parent=styles['BodyText'], fontName='Helvetica', fontSize=10, textColor=colors.HexColor('#1f2937'), leading=14)
    muted = ParagraphStyle('m', parent=styles['BodyText'], fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#6b7280'))

    story = []
    story.append(Paragraph('TBC AI Control', h1))
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
    story.append(Paragraph('This is an automated receipt generated by TBC AI Control. If you have questions, contact support@tbctools.org.', muted))

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


@router.get('/operator/transactions/export')
async def op_tx_export(
    from_date: Optional[str] = Query(None, alias='from'),
    to_date: Optional[str] = Query(None, alias='to'),
    only_paid: bool = Query(True),
    _: dict = Depends(get_current_operator),
):
    """Export receipts for date range as a single combined PDF."""
    db = await get_db()
    q = {}
    if only_paid:
        q['payment_status'] = 'paid'
    if from_date or to_date:
        q['created_at'] = {}
        try:
            if from_date:
                q['created_at']['$gte'] = datetime.fromisoformat(from_date.replace('Z', '+00:00'))
            if to_date:
                q['created_at']['$lte'] = datetime.fromisoformat(to_date.replace('Z', '+00:00'))
        except Exception:
            raise HTTPException(400, 'Invalid date format. Use YYYY-MM-DD.')
        if not q['created_at']:
            del q['created_at']

    cursor = db.payment_transactions.find(q).sort('created_at', 1)
    txs = [t async for t in cursor]

    if not txs:
        raise HTTPException(404, 'No transactions in selected range')

    # Combined PDF
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=15*mm)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle('h1', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=20, textColor=colors.HexColor('#c89c2a'), spaceAfter=4)
    h2 = ParagraphStyle('h2', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=12, textColor=colors.HexColor('#3a2c08'), spaceAfter=6)
    body = ParagraphStyle('body', parent=styles['BodyText'], fontName='Helvetica', fontSize=10, textColor=colors.HexColor('#1f2937'))
    muted = ParagraphStyle('m', parent=styles['BodyText'], fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#6b7280'))

    story = []
    story.append(Paragraph('TBC AI Control — Transactions Report', h1))
    rng = []
    if from_date:
        rng.append(f"from {from_date}")
    if to_date:
        rng.append(f"to {to_date}")
    story.append(Paragraph('Range: ' + (' '.join(rng) if rng else 'all time'), muted))
    story.append(Paragraph(f"Total transactions: {len(txs)}", muted))
    total = sum(float(t.get('amount', 0)) for t in txs)
    story.append(Paragraph(f"Total amount (paid): ${total:.2f}", body))
    story.append(Spacer(1, 14))

    # Summary table
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

    pdf = buf.getvalue()
    fname = f"tbc_transactions_{(from_date or 'all')}_{(to_date or 'all')}.pdf"
    return Response(content=pdf, media_type='application/pdf', headers={'Content-Disposition': f'attachment; filename={fname}'})
