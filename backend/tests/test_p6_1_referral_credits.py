"""P6.1 — Auto-credit referral flow.

Verifies that when a referred user pays a transaction, the referrer is
*instantly* credited `referral_pct%` of the credits the buyer received,
and an in-app notification is dropped on their bell.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'http://localhost:8000').rstrip('/')
API = f"{BASE_URL}/api"

OPERATOR_EMAIL = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OPERATOR_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')


def _login(session, email, password):
    return session.post(f"{API}/auth/login", json={'email': email, 'password': password}, timeout=15)


@pytest.fixture(scope='module')
def op():
    s = requests.Session()
    r = _login(s, OPERATOR_EMAIL, OPERATOR_PASSWORD)
    if r.status_code != 200 or r.json().get('pending_2fa'):
        pytest.skip('Operator login unavailable (creds or TOTP)')
    return s


def test_referral_includes_credits_awarded(op):
    """The /referral/me overview must surface a `credits_awarded` stat
    and a `commission_pct` so the UI can render the new copy."""
    r = op.get(f"{API}/referral/me", timeout=10)
    assert r.status_code == 200, r.text
    body = r.json()
    assert 'commission_pct' in body
    assert 'stats' in body
    assert 'credits_awarded' in body['stats'], 'stats.credits_awarded missing'
    assert isinstance(body['stats']['credits_awarded'], int)


def test_record_referral_earning_credits_referrer():
    """End-to-end: seed a referral relationship, call record_referral_earning
    twice with the same tx to also verify idempotency, then assert that the
    referrer's credits incremented by exactly `referral_pct%` of credits
    purchased and a notification was created."""
    import asyncio
    import sys
    sys.path.insert(0, '/app/backend')
    from motor.motor_asyncio import AsyncIOMotorClient
    from referrals_ext import record_referral_earning
    import db as _db_mod

    async def _run():
        # Fresh Motor client bound to *this* test's event loop. We swap the
        # shared `db.db` so the referral helper writes to the same DB
        # without hitting a "different loop" runtime error.
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        fresh_db = client[os.environ['DB_NAME']]
        original_db = _db_mod.db
        _db_mod.db = fresh_db

        ref_id = f"test-referrer-{uuid.uuid4().hex[:6]}"
        buyer_id = f"test-buyer-{uuid.uuid4().hex[:6]}"
        code = f"refcode-{uuid.uuid4().hex[:6]}"
        tx_id = f"tx-{uuid.uuid4().hex[:10]}"

        try:
            await fresh_db.users.insert_one({
                'id': ref_id, 'email': f'{ref_id}@test.local',
                'role': 'user', 'credits': 100, 'plan': 'free',
            })
            await fresh_db.users.insert_one({
                'id': buyer_id, 'email': f'{buyer_id}@test.local',
                'role': 'user', 'credits': 0, 'plan': 'free',
                'referred_by_code': code,
            })
            await fresh_db.referral_codes.insert_one({'user_id': ref_id, 'code': code})

            await record_referral_earning(
                transaction_id=tx_id,
                paid_user_id=buyer_id,
                paid_user_email=f'{buyer_id}@test.local',
                plan_id='pro',
                amount=49.0,
                currency='usd',
                credits_purchased=2500,
            )

            updated = await fresh_db.users.find_one({'id': ref_id})
            assert updated['credits'] == 350, f"Expected 350, got {updated['credits']}"

            earn = await fresh_db.referral_earnings.find_one({'transaction_id': tx_id})
            assert earn is not None
            assert earn['status'] == 'credited'
            assert earn['credits_awarded'] == 250
            assert earn['credits_purchased'] == 2500
            assert earn.get('credited_at') is not None

            notif = await fresh_db.user_notifications.find_one(
                {'user_id': ref_id, 'kind': 'broadcast'},
                sort=[('created_at', -1)],
            )
            assert notif is not None
            assert '250' in notif['subject'] or '250' in notif['body']

            # Idempotency check
            await record_referral_earning(
                transaction_id=tx_id,
                paid_user_id=buyer_id,
                paid_user_email=f'{buyer_id}@test.local',
                plan_id='pro',
                amount=49.0,
                currency='usd',
                credits_purchased=2500,
            )
            again = await fresh_db.users.find_one({'id': ref_id})
            assert again['credits'] == 350, f"Double-credited: {again['credits']}"
        finally:
            await fresh_db.users.delete_many({'id': {'$in': [ref_id, buyer_id]}})
            await fresh_db.referral_codes.delete_many({'code': code})
            await fresh_db.referral_earnings.delete_many({'transaction_id': tx_id})
            await fresh_db.user_notifications.delete_many({'user_id': ref_id})
            _db_mod.db = original_db
            client.close()

    asyncio.run(_run())
