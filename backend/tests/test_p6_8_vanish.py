"""P6.8 — Permanent-delete (vanish) tests.

The /vanish endpoint requires a typed-email confirmation; the bulk
'vanish' action skips per-row confirmation but is gated by the
operator-only auth. The operator cannot vanish themselves.
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


def _login():
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    s.headers.update({'Authorization': f'Bearer {r.json().get("token")}'})
    return s


async def _seed(uid: str, email: str | None = None, role: str = 'user'):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        await client[os.environ['DB_NAME']].users.insert_one({
            'id': uid,
            'email': email or f'vanish-{uid}@example.com',
            'name': 'Vanish QA',
            'role': role,
            'plan': 'free', 'credits': 0,
            'status': 'active',
            'created_at': datetime.now(timezone.utc),
        })
    finally:
        client.close()


async def _exists(uid: str) -> bool:
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        return (await client[os.environ['DB_NAME']].users.find_one({'id': uid})) is not None
    finally:
        client.close()


async def _cleanup(uid: str):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        await client[os.environ['DB_NAME']].users.delete_one({'id': uid})
    finally:
        client.close()


def test_vanish_with_correct_email_hard_deletes():
    uid = f'VAN_{uuid.uuid4().hex[:8]}'
    email = f'van-{uid}@example.com'
    asyncio.run(_seed(uid, email=email))
    s = _login()
    try:
        assert asyncio.run(_exists(uid)) is True
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/vanish', json={'confirm_email': email})
        assert r.status_code == 200, r.text
        assert r.json().get('success') is True
        assert r.json().get('deleted_count') == 1
        # Document must be GONE (hard delete, not just soft-flag).
        assert asyncio.run(_exists(uid)) is False
    finally:
        # Idempotent cleanup in case the vanish failed mid-test.
        asyncio.run(_cleanup(uid))


def test_vanish_without_email_confirmation_is_rejected():
    uid = f'VAN_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed(uid))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/vanish', json={})
        assert r.status_code == 400, r.text
        assert 'confirm_email' in (r.json().get('detail') or '')
        # Document still exists.
        assert asyncio.run(_exists(uid)) is True
    finally:
        asyncio.run(_cleanup(uid))


def test_vanish_with_wrong_email_is_rejected():
    uid = f'VAN_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed(uid))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/vanish',
                   json={'confirm_email': 'WRONG@example.com'})
        assert r.status_code == 400, r.text
        # Doc must survive a wrong-email attempt.
        assert asyncio.run(_exists(uid)) is True
    finally:
        asyncio.run(_cleanup(uid))


def test_vanish_email_match_is_case_insensitive():
    uid = f'VAN_{uuid.uuid4().hex[:8]}'
    email = f'CaseTest-{uuid.uuid4().hex[:6]}@Example.COM'
    asyncio.run(_seed(uid, email=email))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/vanish',
                   json={'confirm_email': email.lower()})
        assert r.status_code == 200, r.text
        assert asyncio.run(_exists(uid)) is False
    finally:
        asyncio.run(_cleanup(uid))


def test_bulk_vanish_deletes_multiple():
    uids = [f'VAN_{uuid.uuid4().hex[:8]}' for _ in range(3)]
    for u in uids:
        asyncio.run(_seed(u))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/bulk',
                   json={'user_ids': uids, 'action': 'vanish'})
        assert r.status_code == 200, r.text
        assert set(r.json().get('ok') or []) == set(uids)
        for u in uids:
            assert asyncio.run(_exists(u)) is False
    finally:
        for u in uids:
            asyncio.run(_cleanup(u))


def test_operator_cannot_vanish_themselves():
    """The operator we log in as must not be vanish-able even with
    a matching email payload. The endpoint hard-stops at the role check."""
    s = _login()
    # Look up own id.
    me = s.get(f'{BASE_URL}/api/auth/me').json()
    r = s.post(f'{BASE_URL}/api/operator/users/{me["id"]}/vanish',
               json={'confirm_email': me['email']})
    assert r.status_code == 400, r.text
    assert 'operator' in (r.json().get('detail') or '').lower()
