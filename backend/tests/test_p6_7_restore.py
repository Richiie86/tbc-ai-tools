"""P6.7 — User restore (undo soft-delete) tests.

Verifies the new POST /api/operator/users/{id}/restore endpoint and the
'restore' bulk action, plus that GET /operator/users still includes
deleted accounts so the UI can offer the restore CTA.
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

from tests._creds import OP_EMAIL, OP_PASSWORD  # centralised — see /app/backend/tests/_creds.py


def _login():
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    s.headers.update({'Authorization': f'Bearer {r.json().get("token")}'})
    return s


async def _seed_user(uid: str, deleted: bool = False):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        doc = {
            'id': uid,
            'email': f'restore-{uid}@example.com',
            'name': 'Restore QA',
            'role': 'user',
            'plan': 'free',
            'credits': 0,
            'status': 'deleted' if deleted else 'active',
            'created_at': datetime.now(timezone.utc),
        }
        if deleted:
            doc['deleted_at'] = datetime.now(timezone.utc)
        await client[os.environ['DB_NAME']].users.insert_one(doc)
    finally:
        client.close()


async def _cleanup(uid: str):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        await client[os.environ['DB_NAME']].users.delete_one({'id': uid})
    finally:
        client.close()


def test_restore_endpoint_reactivates_user():
    uid = f'RES_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed_user(uid, deleted=True))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/restore')
        assert r.status_code == 200, r.text
        assert r.json().get('success') is True

        # User must come back as active with no deleted_at.
        all_users = s.get(f'{BASE_URL}/api/operator/users').json()
        user = next((u for u in all_users if u['id'] == uid), None)
        assert user is not None, 'restored user disappeared from /operator/users'
        assert not user.get('deleted_at'), f'deleted_at still present: {user.get("deleted_at")}'
        assert user.get('status') == 'active', f'status = {user.get("status")}'
    finally:
        asyncio.run(_cleanup(uid))


def test_restore_on_active_user_is_idempotent():
    uid = f'RES_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed_user(uid, deleted=False))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/{uid}/restore')
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get('success') is True
        assert body.get('already_active') is True
    finally:
        asyncio.run(_cleanup(uid))


def test_restore_nonexistent_returns_404():
    s = _login()
    r = s.post(f'{BASE_URL}/api/operator/users/__nope__{uuid.uuid4().hex[:6]}/restore')
    assert r.status_code == 404, r.text


def test_bulk_restore_reactivates_multiple():
    uids = [f'RES_{uuid.uuid4().hex[:8]}' for _ in range(3)]
    for u in uids:
        asyncio.run(_seed_user(u, deleted=True))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/bulk', json={
            'user_ids': uids, 'action': 'restore',
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body.get('ok') or []) == set(uids), body

        all_users = s.get(f'{BASE_URL}/api/operator/users').json()
        index = {u['id']: u for u in all_users}
        for u in uids:
            assert u in index, f'{u} missing'
            assert not index[u].get('deleted_at')
            assert index[u].get('status') == 'active'
    finally:
        for u in uids:
            asyncio.run(_cleanup(u))


def test_bulk_resume_does_not_undelete():
    """resume should ONLY un-pause — it must NOT clear deleted_at, per the
    fix that adds a dedicated 'restore' action."""
    uid = f'RES_{uuid.uuid4().hex[:8]}'
    asyncio.run(_seed_user(uid, deleted=True))
    s = _login()
    try:
        r = s.post(f'{BASE_URL}/api/operator/users/bulk', json={
            'user_ids': [uid], 'action': 'resume',
        })
        assert r.status_code == 200
        all_users = s.get(f'{BASE_URL}/api/operator/users').json()
        user = next((u for u in all_users if u['id'] == uid), None)
        assert user is not None
        # deleted_at must STILL be set; status must STILL be deleted.
        assert user.get('deleted_at'), 'resume incorrectly cleared deleted_at'
        assert user.get('status') == 'deleted'
    finally:
        asyncio.run(_cleanup(uid))
