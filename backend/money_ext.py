"""Operator → Money tab.

Aggregates live balances from connected payment providers (Stripe, PayPal,
NOWPayments) and merges them with internal revenue stats so the operator has
a single screen for "where the money is" and "where it came from".

We never persist provider balances — every request hits the live API. If a
provider isn't configured or errors, that provider card simply shows
`connected: false` so the rest of the dashboard still renders.
"""
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends
import httpx

from auth_utils import get_current_operator
from db import db
from payments_ext import get_settings_doc, _paypal_token  # type: ignore

logger = logging.getLogger('tbc.money')
router = APIRouter(prefix='/api/operator/money')


# ---------- PROVIDER PROBES ----------
async def _stripe_balance(settings: dict) -> dict:
    """GET /v1/balance → returns {available, pending, currency} per balance bucket."""
    key = settings.get('stripe_secret_key')
    if not key:
        return {'connected': False, 'reason': 'No Stripe key configured'}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get('https://api.stripe.com/v1/balance', headers={'Authorization': f'Bearer {key}'})
        if r.status_code != 200:
            return {'connected': False, 'reason': f'HTTP {r.status_code}: {r.text[:120]}'}
        data = r.json()
        # Aggregate USD across buckets; expose raw arrays too.
        def _sum(arr, currency='usd'):
            return sum(b.get('amount', 0) for b in (arr or []) if b.get('currency') == currency) / 100.0
        return {
            'connected': True,
            'available_usd': _sum(data.get('available')),
            'pending_usd': _sum(data.get('pending')),
            'instant_available_usd': _sum(data.get('instant_available') or []),
            'livemode': data.get('livemode', False),
        }
    except Exception as e:
        return {'connected': False, 'reason': str(e)[:200]}


async def _paypal_balance(settings: dict) -> dict:
    """GET /v1/reporting/balances → may require account-level entitlement."""
    cid = settings.get('paypal_client_id')
    if not cid or not settings.get('paypal_client_secret'):
        return {'connected': False, 'reason': 'No PayPal credentials configured'}
    try:
        token, base = await _paypal_token(settings)
    except Exception as e:
        return {'connected': False, 'reason': f'auth failed: {str(e)[:120]}'}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f'{base}/v1/reporting/balances',
                headers={'Authorization': f'Bearer {token}'},
                params={'currency_code': 'USD'},
            )
        if r.status_code != 200:
            return {
                'connected': True,
                'balance_unavailable': True,
                'reason': f'HTTP {r.status_code} (the Reporting/Balances API requires entitlement)',
                'mode': settings.get('paypal_mode', 'sandbox'),
            }
        data = r.json()
        usd_total = 0.0
        for b in data.get('balances', []) or []:
            if b.get('currency') == 'USD':
                usd_total = float(b.get('total_balance', {}).get('value', 0))
                break
        return {
            'connected': True,
            'available_usd': usd_total,
            'mode': settings.get('paypal_mode', 'sandbox'),
            'as_of': data.get('as_of_time'),
        }
    except Exception as e:
        return {'connected': True, 'balance_unavailable': True, 'reason': str(e)[:200]}


async def _nowpayments_balance(settings: dict) -> dict:
    """GET /v1/balance → returns dict of currency → amount."""
    key = settings.get('nowpayments_api_key')
    if not key:
        return {'connected': False, 'reason': 'No NOWPayments key configured'}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get('https://api.nowpayments.io/v1/balance', headers={'x-api-key': key})
        if r.status_code != 200:
            return {'connected': False, 'reason': f'HTTP {r.status_code}: {r.text[:120]}'}
        data = r.json() or {}
        balances = data.get('balances') or data  # API returns {balances:{btc:..}} or sometimes flat
        # Flatten to display rows + best-effort USD estimate via amount * 1 (no FX).
        rows = []
        for k, v in (balances or {}).items():
            if isinstance(v, dict):
                rows.append({'asset': k.upper(), 'amount': float(v.get('amount', 0)), 'pending': float(v.get('pendingAmount', 0))})
            else:
                rows.append({'asset': k.upper(), 'amount': float(v), 'pending': 0.0})
        return {'connected': True, 'assets': rows}
    except Exception as e:
        return {'connected': False, 'reason': str(e)[:200]}


# ---------- INTERNAL STATS ----------
async def _internal_stats() -> dict:
    """Aggregate everything we know about money from our own payment_transactions
    + a 30-day time series for the chart."""
    now = datetime.now(timezone.utc)
    since_30 = now - timedelta(days=30)

    paid_filter = {'payment_status': 'paid'}
    total_paid_cursor = db.payment_transactions.aggregate([
        {'$match': paid_filter},
        {'$group': {'_id': None, 'total': {'$sum': '$amount'}, 'count': {'$sum': 1}}},
    ])
    total_doc = await total_paid_cursor.to_list(length=1)
    total = total_doc[0] if total_doc else {'total': 0, 'count': 0}

    last_30_cursor = db.payment_transactions.aggregate([
        {'$match': {**paid_filter, 'updated_at': {'$gte': since_30}}},
        {'$group': {'_id': None, 'total': {'$sum': '$amount'}, 'count': {'$sum': 1}}},
    ])
    last30 = (await last_30_cursor.to_list(length=1)) or [{'total': 0, 'count': 0}]

    pending_count = await db.payment_transactions.count_documents({'payment_status': 'pending'})

    # Daily revenue series for the past 30 days (UTC days).
    daily_cursor = db.payment_transactions.aggregate([
        {'$match': {**paid_filter, 'updated_at': {'$gte': since_30}}},
        {'$group': {
            '_id': {'$dateToString': {'format': '%Y-%m-%d', 'date': '$updated_at'}},
            'total': {'$sum': '$amount'},
        }},
        {'$sort': {'_id': 1}},
    ])
    daily_map = {d['_id']: float(d['total']) async for d in daily_cursor}
    series = []
    for i in range(30, -1, -1):
        d = (now - timedelta(days=i)).strftime('%Y-%m-%d')
        series.append({'date': d, 'revenue': round(daily_map.get(d, 0.0), 2)})

    # Recent paid transactions
    recent_cursor = db.payment_transactions.find(paid_filter).sort('updated_at', -1).limit(10)
    recent = []
    async for t in recent_cursor:
        recent.append({
            'id': t.get('id'),
            'user_email': t.get('user_email'),
            'plan_id': t.get('plan_id'),
            'amount': float(t.get('amount', 0)),
            'currency': t.get('currency', 'usd'),
            'method': (t.get('metadata') or {}).get('method') or 'stripe',
            'paid_at': t.get('updated_at').isoformat() if isinstance(t.get('updated_at'), datetime) else t.get('updated_at'),
        })

    # Method breakdown (last 30 days)
    method_cursor = db.payment_transactions.aggregate([
        {'$match': {**paid_filter, 'updated_at': {'$gte': since_30}}},
        {'$group': {
            '_id': {'$ifNull': ['$metadata.method', 'stripe']},
            'total': {'$sum': '$amount'},
            'count': {'$sum': 1},
        }},
        {'$sort': {'total': -1}},
    ])
    by_method = [{'method': m['_id'], 'total': float(m['total']), 'count': m['count']} async for m in method_cursor]

    return {
        'total_revenue_usd': float(total.get('total', 0)),
        'total_paid_count': int(total.get('count', 0)),
        'last_30d_revenue_usd': float(last30[0].get('total', 0)),
        'last_30d_count': int(last30[0].get('count', 0)),
        'pending_manual_count': pending_count,
        'series_30d': series,
        'recent_transactions': recent,
        'by_method_30d': by_method,
    }


# ---------- ENDPOINT ----------
@router.get('/dashboard')
async def money_dashboard(_user: dict = Depends(get_current_operator)):
    settings = await get_settings_doc()
    stripe = await _stripe_balance(settings)
    paypal = await _paypal_balance(settings)
    crypto = await _nowpayments_balance(settings)
    internal = await _internal_stats()
    return {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'providers': {
            'stripe': stripe,
            'paypal': paypal,
            'nowpayments': crypto,
        },
        'internal': internal,
    }
