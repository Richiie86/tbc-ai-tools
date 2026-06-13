"""P6.10 — Auto-purge of test/preview-user chat data on operator login.

Verifies:
  * Seeding chat sessions/messages for the preview-user, logging in as
    the operator, and confirming the data is gone afterwards.
  * The manual /api/operator/purge-test-data endpoint returns the
    deleted counts + refreshed stats.
  * Real customer data is NOT touched.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone

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

OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASSWORD = '123Admin@98'
TEST_EMAIL = 'preview-user@tbctools.dev'


def _login():
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    s.headers.update({'Authorization': f'Bearer {r.json().get("token")}'})
    return s


async def _seed_test_chat(n_sessions: int = 2, msgs_per_session: int = 3) -> tuple[list[str], list[str]]:
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        db = client[os.environ['DB_NAME']]
        tu = await db.users.find_one({'email': TEST_EMAIL}, {'id': 1})
        assert tu is not None, 'preview-user not seeded'
        sids, mids = [], []
        for _ in range(n_sessions):
            sid = f'TST_SESS_{uuid.uuid4().hex[:8]}'
            await db.chat_sessions.insert_one({
                'id': sid, 'user_id': tu['id'], 'title': 'qa',
                'model': 'gpt-4o-mini',
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc),
            })
            sids.append(sid)
            for _ in range(msgs_per_session):
                mid = f'TST_MSG_{uuid.uuid4().hex[:8]}'
                await db.chat_messages.insert_one({
                    'id': mid, 'session_id': sid, 'role': 'user',
                    'content': 'hi', 'created_at': datetime.now(timezone.utc),
                })
                mids.append(mid)
        return sids, mids
    finally:
        client.close()


async def _count_test_chat() -> tuple[int, int]:
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        db = client[os.environ['DB_NAME']]
        tu = await db.users.find_one({'email': TEST_EMAIL}, {'id': 1})
        if not tu:
            return 0, 0
        sids = [s['id'] async for s in db.chat_sessions.find({'user_id': tu['id']}, {'id': 1})]
        msgs = await db.chat_messages.count_documents({'session_id': {'$in': sids}}) if sids else 0
        return len(sids), msgs
    finally:
        client.close()


def test_operator_login_purges_test_chat_data():
    asyncio.run(_seed_test_chat(2, 3))
    before_s, before_m = asyncio.run(_count_test_chat())
    assert before_s >= 2 and before_m >= 6

    # Fresh login as operator triggers the purge (no 2FA configured).
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text

    after_s, after_m = asyncio.run(_count_test_chat())
    assert after_s == 0, f'sessions remained: {after_s}'
    assert after_m == 0, f'messages remained: {after_m}'


def test_manual_purge_endpoint_returns_counts_and_stats():
    asyncio.run(_seed_test_chat(3, 2))
    s = _login()
    # The login above already purged — re-seed AFTER auth so we can exercise
    # the manual endpoint on data we know exists.
    asyncio.run(_seed_test_chat(3, 2))
    r = s.post(f'{BASE_URL}/api/operator/purge-test-data')
    assert r.status_code == 200, r.text
    body = r.json()
    assert 'purged' in body and 'stats' in body
    assert body['purged']['sessions'] >= 3
    assert body['purged']['messages'] >= 6
    # Stats payload must be the canonical shape.
    for key in ('total_users', 'paid_users', 'total_messages', 'revenue_usd'):
        assert key in body['stats'], f'missing stat: {key}'

    after_s, _ = asyncio.run(_count_test_chat())
    assert after_s == 0


def test_purge_does_not_touch_other_users():
    """Insert a chat session for a NON-test user — purge must leave it alone."""
    s = _login()
    other_uid = f'REAL_{uuid.uuid4().hex[:8]}'
    other_sid = f'REAL_SESS_{uuid.uuid4().hex[:8]}'

    async def _seed_real():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            db = client[os.environ['DB_NAME']]
            await db.users.insert_one({
                'id': other_uid, 'email': f'real-{other_uid}@example.com',
                'role': 'user', 'plan': 'free', 'credits': 0, 'status': 'active',
                'created_at': datetime.now(timezone.utc),
            })
            await db.chat_sessions.insert_one({
                'id': other_sid, 'user_id': other_uid, 'title': 'real',
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc),
            })
        finally:
            client.close()

    async def _cleanup_real():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            db = client[os.environ['DB_NAME']]
            await db.users.delete_one({'id': other_uid})
            await db.chat_sessions.delete_one({'id': other_sid})
        finally:
            client.close()

    async def _real_exists() -> bool:
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            return (await client[os.environ['DB_NAME']].chat_sessions.find_one({'id': other_sid})) is not None
        finally:
            client.close()

    asyncio.run(_seed_real())
    try:
        r = s.post(f'{BASE_URL}/api/operator/purge-test-data')
        assert r.status_code == 200
        # Non-test session survives.
        assert asyncio.run(_real_exists()) is True
    finally:
        asyncio.run(_cleanup_real())
