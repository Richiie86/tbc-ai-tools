"""P6.9 — Operator/admin protection tests for delete/vanish.

Even with the right typed-email confirmation, the API must REJECT any
attempt to soft-delete or vanish an operator or admin account. Demotion
through Mongo is the only path to remove a privileged user.
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


async def _seed(uid: str, role: str = 'user', email: str | None = None):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        await client[os.environ['DB_NAME']].users.insert_one({
            'id': uid,
            'email': email or f'protect-{uid}@example.com',
            'name': 'Protect QA',
            'role': role, 'plan': 'free', 'credits': 0, 'status': 'active',
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


def test_cannot_vanish_any_operator_even_with_right_email():
    uid = f'PRO_{uuid.uuid4().hex[:8]}'
    email = f'other-op-{uid}@example.com'
    asyncio.run(_seed(uid, role='operator', email=email))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/vanish',
                   json={'confirm_email': email})
        assert r.status_code == 400, r.text
        assert 'operator' in (r.json().get('detail') or '').lower()
        assert asyncio.run(_exists(uid)) is True
    finally:
        asyncio.run(_cleanup(uid))


def test_cannot_vanish_admin_account():
    uid = f'PRO_{uuid.uuid4().hex[:8]}'
    email = f'admin-{uid}@example.com'
    asyncio.run(_seed(uid, role='admin', email=email))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/vanish',
                   json={'confirm_email': email})
        assert r.status_code == 400, r.text
        assert asyncio.run(_exists(uid)) is True
    finally:
        asyncio.run(_cleanup(uid))


def test_cannot_soft_delete_admin_account():
    uid = f'PRO_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed(uid, role='admin'))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/delete')
        assert r.status_code == 400, r.text
    finally:
        asyncio.run(_cleanup(uid))


def test_bulk_vanish_skips_protected_roles():
    """Mix of normal + protected accounts — the protected ones must end up
    in `skipped`, the normal ones in `ok`, and the protected accounts
    must STILL exist after the call."""
    normal = f'NORM_{uuid.uuid4().hex[:8]}'
    op2 = f'OP2_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed(normal, role='user'))
    asyncio.run(_seed(op2, role='operator'))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/bulk', json={
            'user_ids': [normal, op2], 'action': 'vanish',
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert normal in (body.get('ok') or [])
        skipped_ids = {x.get('id') for x in (body.get('skipped') or [])}
        assert op2 in skipped_ids, body
        assert asyncio.run(_exists(normal)) is False
        assert asyncio.run(_exists(op2)) is True
    finally:
        asyncio.run(_cleanup(normal))
        asyncio.run(_cleanup(op2))
