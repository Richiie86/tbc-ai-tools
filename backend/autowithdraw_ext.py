"""Auto-withdraw (payout) for connected payment providers.

Provider matrix:
  • Stripe         — `POST /v1/payouts` (sends to the default bank account).
  • NOWPayments    — `POST /v1/payout` (sends crypto to a configured address).
  • PayPal         — intentionally out of scope (payouts API requires extra
                     account entitlement; we surface "not supported" to keep the
                     UI honest).

Settings live on the `payment_settings` doc:
  • autopay_stripe_enabled         : bool
  • autopay_stripe_threshold_usd   : float (min available to trigger)
  • autopay_nowpay_enabled         : bool
  • autopay_nowpay_threshold_usd   : float (USD equivalent per asset row)
  • autopay_nowpay_address         : str (destination crypto address)
  • autopay_nowpay_currency        : str (BTC, ETH, USDTTRC20, ...)

Each successful (or attempted) payout is persisted on `db.withdrawals` so the
Money tab can render history.
"""
import os
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db
from payments_ext import get_settings_doc, _paypal_token  # noqa: F401 (paypal helper reserved for future)
from audit_ext import record_audit

logger = logging.getLogger('tbc.withdraw')
router = APIRouter(prefix='/api/operator/withdraw')


# ============== SCHEMAS ==============
class AutoWithdrawSettings(BaseModel):
    autopay_stripe_enabled: bool = False
    autopay_stripe_threshold_usd: float = 100.0
    autopay_stripe_daily_cap_usd: float = 5000.0
    autopay_nowpay_enabled: bool = False
    autopay_nowpay_threshold_usd: float = 25.0
    autopay_nowpay_daily_cap: float = 1.0  # asset units (BTC/ETH/etc — set per operator)
    autopay_nowpay_address: Optional[str] = None
    autopay_nowpay_currency: Optional[str] = None


class ManualStripePayoutRequest(BaseModel):
    amount_usd: float


class ManualCryptoPayoutRequest(BaseModel):
    amount: float
    currency: str
    address: str


# ============== HELPERS ==============
async def _record(provider: str, kind: str, amount_usd: float, status: str, detail: str, raw: dict | None = None) -> str:
    """Append a withdrawal record."""
    import uuid
    wid = str(uuid.uuid4())
    await db.withdrawals.insert_one({
        'id': wid,
        'provider': provider,
        'kind': kind,  # 'manual' or 'auto'
        'amount_usd': float(amount_usd),
        'status': status,  # 'queued' | 'success' | 'failed'
        'detail': detail[:500] if detail else '',
        'raw': raw or {},
        'created_at': datetime.now(timezone.utc),
    })
    return wid


async def _stripe_balance_available_usd(settings: dict) -> float:
    key = settings.get('stripe_secret_key')
    if not key:
        raise HTTPException(400, 'Stripe secret key not configured')
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get('https://api.stripe.com/v1/balance', headers={'Authorization': f'Bearer {key}'})
    r.raise_for_status()
    avail = r.json().get('available') or []
    return sum(b.get('amount', 0) for b in avail if b.get('currency') == 'usd') / 100.0


async def _stripe_payout(settings: dict, amount_usd: float) -> dict:
    """Trigger a Stripe payout (USD only). Returns the Stripe payout object."""
    key = settings.get('stripe_secret_key')
    cents = int(round(amount_usd * 100))
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            'https://api.stripe.com/v1/payouts',
            headers={'Authorization': f'Bearer {key}'},
            data={'amount': cents, 'currency': 'usd'},
        )
    if r.status_code >= 400:
        raise HTTPException(502, f'Stripe payout failed: {r.text[:200]}')
    return r.json()


async def _nowpayments_payout(settings: dict, amount: float, currency: str, address: str) -> dict:
    """Trigger a NOWPayments crypto payout."""
    key = settings.get('nowpayments_api_key')
    if not key:
        raise HTTPException(400, 'NOWPayments API key not configured')
    payload = {
        'withdrawals': [{
            'address': address,
            'currency': currency.lower(),
            'amount': float(amount),
        }],
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            'https://api.nowpayments.io/v1/payout',
            headers={'x-api-key': key, 'Content-Type': 'application/json'},
            json=payload,
        )
    if r.status_code >= 400:
        raise HTTPException(502, f'NOWPayments payout failed: {r.text[:200]}')
    return r.json()


async def _auto_paid_last_24h(provider: str) -> float:
    """Sum of successful AUTO payout amounts for `provider` in the last 24 hours.

    Used to enforce the operator-adjustable daily safety cap. We deliberately do
    not include manual payouts — the cap is a guard against runaway auto loops.
    """
    from datetime import timedelta as _td
    cutoff = datetime.now(timezone.utc) - _td(hours=24)
    cursor = db.withdrawals.aggregate([
        {'$match': {'provider': provider, 'kind': 'auto', 'status': 'success', 'created_at': {'$gte': cutoff}}},
        {'$group': {'_id': None, 'total': {'$sum': '$amount_usd'}}},
    ])
    out = await cursor.to_list(length=1)
    return float(out[0]['total']) if out else 0.0


# ============== SETTINGS ==============
@router.get('/settings')
async def get_autowithdraw_settings(_user: dict = Depends(get_current_operator)):
    s = await get_settings_doc()
    paid_stripe_24h = await _auto_paid_last_24h('stripe')
    paid_nowpay_24h = await _auto_paid_last_24h('nowpayments')
    return {
        'autopay_stripe_enabled': bool(s.get('autopay_stripe_enabled', False)),
        'autopay_stripe_threshold_usd': float(s.get('autopay_stripe_threshold_usd', 100.0)),
        'autopay_stripe_daily_cap_usd': float(s.get('autopay_stripe_daily_cap_usd', 5000.0)),
        'autopay_nowpay_enabled': bool(s.get('autopay_nowpay_enabled', False)),
        'autopay_nowpay_threshold_usd': float(s.get('autopay_nowpay_threshold_usd', 25.0)),
        'autopay_nowpay_daily_cap': float(s.get('autopay_nowpay_daily_cap', 1.0)),
        'autopay_nowpay_address': s.get('autopay_nowpay_address') or '',
        'autopay_nowpay_currency': s.get('autopay_nowpay_currency') or '',
        # capability flags so the UI can disable rows that aren't configured.
        'stripe_configured': bool(s.get('stripe_secret_key')),
        'nowpay_configured': bool(s.get('nowpayments_api_key')),
        # Live "used today" amounts (auto only) for the cap progress bar
        'stripe_paid_24h_usd': paid_stripe_24h,
        'nowpay_paid_24h': paid_nowpay_24h,
    }


@router.put('/settings')
async def update_autowithdraw_settings(req: AutoWithdrawSettings, request: Request, op: dict = Depends(get_current_operator)):
    updates = req.dict(exclude_unset=False)
    await db.settings.update_one({'_id': 'payment_settings'}, {'$set': updates}, upsert=True)
    await record_audit(op, 'withdraw.settings_update', details={'keys': list(updates.keys())}, request=request)
    return {'success': True, 'updated_keys': list(updates.keys())}


# ============== HISTORY ==============
@router.get('/history')
async def list_withdrawals(_user: dict = Depends(get_current_operator)):
    cursor = db.withdrawals.find({}).sort('created_at', -1).limit(50)
    out = []
    async for w in cursor:
        w.pop('_id', None)
        if isinstance(w.get('created_at'), datetime):
            w['created_at'] = w['created_at'].isoformat()
        out.append(w)
    return out


# ============== MANUAL PAYOUTS ==============
@router.post('/stripe/now')
async def withdraw_stripe_now(req: ManualStripePayoutRequest, request: Request, op: dict = Depends(get_current_operator)):
    settings = await get_settings_doc()
    try:
        result = await _stripe_payout(settings, req.amount_usd)
        wid = await _record('stripe', 'manual', req.amount_usd, 'success', f"Stripe payout {result.get('id')}", result)
        await record_audit(op, 'withdraw.stripe_manual', details={'amount_usd': req.amount_usd, 'stripe_id': result.get('id')}, request=request)
        return {'success': True, 'withdrawal_id': wid, 'stripe_id': result.get('id'), 'arrival_date': result.get('arrival_date')}
    except HTTPException as e:
        await _record('stripe', 'manual', req.amount_usd, 'failed', e.detail)
        await record_audit(op, 'withdraw.stripe_manual.failed', details={'amount_usd': req.amount_usd, 'error': e.detail}, request=request)
        raise


@router.post('/nowpayments/now')
async def withdraw_nowpayments_now(req: ManualCryptoPayoutRequest, request: Request, op: dict = Depends(get_current_operator)):
    settings = await get_settings_doc()
    try:
        result = await _nowpayments_payout(settings, req.amount, req.currency, req.address)
        wid = await _record('nowpayments', 'manual', float(req.amount), 'success', f"{req.amount} {req.currency} → {req.address[:10]}…", result)
        await record_audit(op, 'withdraw.crypto_manual', details={'amount': float(req.amount), 'currency': req.currency, 'address': req.address[:10] + '…'}, request=request)
        return {'success': True, 'withdrawal_id': wid, 'response': result}
    except HTTPException as e:
        await _record('nowpayments', 'manual', float(req.amount), 'failed', e.detail)
        await record_audit(op, 'withdraw.crypto_manual.failed', details={'currency': req.currency, 'error': e.detail}, request=request)
        raise


# ============== AUTO CRON ==============
async def _sweep_stripe(settings: dict) -> dict:
    """One Stripe auto-payout pass. Returns an attempt summary row.

    Pulled out of `run_auto_withdraw_once` so the orchestrator stays linear and
    each provider can be unit-tested / patched in isolation.
    """
    if not settings.get('autopay_stripe_enabled'):
        return {'provider': 'stripe', 'status': 'disabled'}
    if not settings.get('stripe_secret_key'):
        return {'provider': 'stripe', 'status': 'skipped', 'reason': 'Stripe key not configured'}
    try:
        avail = await _stripe_balance_available_usd(settings)
        threshold = float(settings.get('autopay_stripe_threshold_usd', 100.0))
        if avail < threshold:
            return {'provider': 'stripe', 'status': 'skipped',
                    'reason': f'available ${avail:.2f} < threshold ${threshold:.2f}'}
        # Apply daily safety cap (auto payouts only).
        cap = float(settings.get('autopay_stripe_daily_cap_usd', 5000.0))
        paid = await _auto_paid_last_24h('stripe')
        headroom = max(0.0, cap - paid)
        if headroom <= 0.0:
            return {'provider': 'stripe', 'status': 'skipped',
                    'reason': f'daily cap reached (${paid:.2f}/${cap:.2f})'}
        payout_amt = min(avail, headroom)
        result = await _stripe_payout(settings, payout_amt)
        await _record('stripe', 'auto', payout_amt, 'success',
                      f"Auto payout {result.get('id')} · cap {paid + payout_amt:.2f}/{cap:.2f}", result)
        return {
            'provider': 'stripe', 'status': 'success',
            'amount_usd': payout_amt, 'capped': payout_amt < avail,
            'cap_remaining_after': max(0.0, cap - paid - payout_amt),
        }
    except Exception as e:
        await _record('stripe', 'auto', 0, 'failed', str(e)[:300])
        return {'provider': 'stripe', 'status': 'failed', 'error': str(e)[:200]}


async def _nowpay_currency_balance(settings: dict, currency: str) -> float:
    """Best-effort lookup of the auto-pay currency balance on NOWPayments.

    NOWPayments' /balance response shape has varied historically — sometimes
    `{balances: {btc: {...}}}`, sometimes `{btc: 0.1}`. We accept both shapes.
    """
    cur = (currency or '').lower()
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            'https://api.nowpayments.io/v1/balance',
            headers={'x-api-key': settings['nowpayments_api_key']},
        )
    body = r.json() or {}
    balances = body.get('balances') or body
    row = balances.get(cur) or balances.get(cur.upper())
    if isinstance(row, dict):
        return float(row.get('amount', 0))
    return float(row or 0)


async def _sweep_nowpayments(settings: dict) -> dict:
    """One NOWPayments auto-payout pass. Returns an attempt summary row."""
    if not settings.get('autopay_nowpay_enabled'):
        return {'provider': 'nowpayments', 'status': 'disabled'}
    if (not settings.get('nowpayments_api_key')
            or not settings.get('autopay_nowpay_address')
            or not settings.get('autopay_nowpay_currency')):
        return {'provider': 'nowpayments', 'status': 'skipped',
                'reason': 'key/address/currency missing'}
    try:
        cur = (settings.get('autopay_nowpay_currency') or '').lower()
        addr = settings.get('autopay_nowpay_address')
        threshold = float(settings.get('autopay_nowpay_threshold_usd', 25.0))
        amt = await _nowpay_currency_balance(settings, cur)
        if amt < threshold:
            return {'provider': 'nowpayments', 'status': 'skipped',
                    'reason': f'balance {amt} < threshold {threshold}'}
        # Apply daily safety cap (asset units, auto only).
        cap = float(settings.get('autopay_nowpay_daily_cap', 1.0))
        paid = await _auto_paid_last_24h('nowpayments')
        headroom = max(0.0, cap - paid)
        if headroom <= 0.0:
            return {'provider': 'nowpayments', 'status': 'skipped',
                    'reason': f'daily cap reached ({paid}/{cap} {cur})'}
        payout_amt = min(amt, headroom)
        result = await _nowpayments_payout(settings, payout_amt, cur, addr)
        await _record('nowpayments', 'auto', payout_amt, 'success',
                      f"Auto {payout_amt} {cur} → {addr[:10]}… · cap {paid + payout_amt:.4f}/{cap:.4f}",
                      result)
        return {
            'provider': 'nowpayments', 'status': 'success',
            'amount': payout_amt, 'currency': cur, 'capped': payout_amt < amt,
            'cap_remaining_after': max(0.0, cap - paid - payout_amt),
        }
    except Exception as e:
        await _record('nowpayments', 'auto', 0, 'failed', str(e)[:300])
        return {'provider': 'nowpayments', 'status': 'failed', 'error': str(e)[:200]}


async def run_auto_withdraw_once() -> dict:
    """Single auto-withdraw sweep — Stripe + NOWPayments. Idempotency relies on
    the operator setting a sensible threshold so we don't spin payouts every hour.

    Both provider sweeps are independent IO calls, so we run them concurrently
    via `asyncio.gather` — shaves ~2-3s off each hourly tick when both providers
    are enabled and round-tripping to their APIs.

    Skipped (disabled) providers are omitted from the response to keep the
    summary tight; explicitly-skipped ones (missing config, cap reached, etc.)
    stay so the operator can see why nothing happened.
    """
    settings = await get_settings_doc()
    rows = await asyncio.gather(
        _sweep_stripe(settings),
        _sweep_nowpayments(settings),
    )
    attempts = [row for row in rows if row.get('status') != 'disabled']
    return {
        'ran_at': datetime.now(timezone.utc).isoformat(),
        'attempts': attempts,
    }


@router.post('/cron')
async def cron_auto_withdraw(_user: dict = Depends(get_current_operator)):
    """Manual trigger for the auto-withdraw sweep (also runs hourly via APScheduler)."""
    return await run_auto_withdraw_once()
