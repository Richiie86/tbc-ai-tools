"""P6.5 — Operator revenue/growth analytics endpoint tests.

Verifies GET /api/operator/analytics/30d returns the expected
shape and that aggregations actually pick up seeded data.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone, timedelta

import requests
from motor.motor_asyncio import AsyncIOMotorClient

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv('/app/backend/.env')
except Exception:
    pass

BASE_URL = (
    os.environ.get('REACT_APP_BACKEND_URL')
    or open('/app/frontend/.env').read().split('REACT_APP_BACKEND_URL=')[1].split('\n')[0].strip()
).rstrip('/')

from tests._creds import OP_EMAIL, OP_PASSWORD  # centralised — see /app/backend/tests/_creds.py


def _login():
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    s.headers.update({'Authorization': f'Bearer {r.json().get("token")}'})
    return s


def test_analytics_requires_operator():
    """Unauthenticated calls must be rejected with 401."""
    r = requests.get(f'{BASE_URL}/api/operator/analytics/30d')
    assert r.status_code in (401, 403), r.text


def test_analytics_shape_is_correct():
    s = _login()
    r = s.get(f'{BASE_URL}/api/operator/analytics/30d')
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body.get('days'), list) and len(body['days']) == 30
    assert body.get('currency') == 'usd'
    series = body.get('series') or {}
    for key in ('revenue', 'signups', 'referrals', 'royalty', 'birthday'):
        assert key in series, f'missing series: {key}'
        assert len(series[key]) == 30, f'series {key} should be 30 wide'
    totals = body.get('totals') or {}
    for key in ('revenue_30d', 'signups_30d', 'referrals_30d', 'royalty_30d',
                'birthday_30d', 'mrr_estimate'):
        assert key in totals, f'missing total: {key}'


def test_analytics_picks_up_seeded_payment():
    """Insert one paid txn and one referral_earnings doc inside the window;
    confirm the totals & series counts increment accordingly."""
    s = _login()
    before = s.get(f'{BASE_URL}/api/operator/analytics/30d').json()
    seed_tx = f'WHTEST_TX_{uuid.uuid4().hex[:10]}'
    seed_ref = f'WHTEST_REF_{uuid.uuid4().hex[:10]}'

    async def _seed():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            db = client[os.environ['DB_NAME']]
            now = datetime.now(timezone.utc)
            await db.payment_transactions.insert_one({
                'id': seed_tx,
                'payment_status': 'paid',
                'amount': 42.0,
                'currency': 'usd',
                'created_at': now,
            })
            await db.referral_earnings.insert_one({
                'id': seed_ref,
                'transaction_id': seed_tx,
                'commission_amount': 4.2,
                'created_at': now,
            })
        finally:
            client.close()

    async def _cleanup():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            db = client[os.environ['DB_NAME']]
            await db.payment_transactions.delete_one({'id': seed_tx})
            await db.referral_earnings.delete_one({'id': seed_ref})
        finally:
            client.close()

    asyncio.run(_seed())
    try:
        after = s.get(f'{BASE_URL}/api/operator/analytics/30d').json()
        # Revenue and referral totals must each have moved by the expected delta.
        rev_delta = round(after['totals']['revenue_30d'] - before['totals']['revenue_30d'], 2)
        ref_delta = after['totals']['referrals_30d'] - before['totals']['referrals_30d']
        assert rev_delta >= 42.0 - 0.01, f'revenue delta {rev_delta} should be ≥ 42'
        assert ref_delta >= 1, f'referrals delta {ref_delta} should be ≥ 1'
        # Today's slot specifically should have bumped.
        assert after['series']['revenue'][-1] >= 42.0 - 0.01
        assert after['series']['referrals'][-1] >= 1
    finally:
        asyncio.run(_cleanup())
