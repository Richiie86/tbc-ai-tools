"""P6.11 — Operator "Clone all to tbc1" workspace tests.

Verifies:
  * POST /api/operator/projects/clone-all clones every operator-owned project
    with a `-tbc1` suffix and adds `tbc1` to tags.
  * crypto-forex-tax is bootstrapped if it doesn't exist yet.
  * Re-running is idempotent (already-cloned projects skipped).
  * Workspace name is validated.
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
    me = s.get(f'{BASE_URL}/api/auth/me').json()
    return s, me['id']


async def _wipe_workspace(owner_id: str, workspace: str = 'tbc1'):
    """Remove every project tagged with `workspace` for this owner. Used to
    keep tests independent from prior runs and from any production data."""
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        db = client[os.environ['DB_NAME']]
        await db.projects.delete_many({'owner_id': owner_id, 'tags': workspace})
    finally:
        client.close()


async def _count_in_workspace(owner_id: str, workspace: str = 'tbc1') -> int:
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        db = client[os.environ['DB_NAME']]
        return await db.projects.count_documents({'owner_id': owner_id, 'tags': workspace})
    finally:
        client.close()


def test_clone_all_copies_every_project_and_bootstraps_crypto_forex_tax():
    s, owner = _login()
    asyncio.run(_wipe_workspace(owner))

    # Seed two non-workspace projects.
    seed_titles = [f'seed-a-{uuid.uuid4().hex[:6]}', f'seed-b-{uuid.uuid4().hex[:6]}']
    for t in seed_titles:
        r = s.post(f'{BASE_URL}/api/operator/projects', json={
            'title': t, 'status': 'idea', 'tags': [],
        })
        assert r.status_code == 200, r.text

    r = s.post(f'{BASE_URL}/api/operator/projects/clone-all', json={'workspace': 'tbc1'})
    assert r.status_code == 200, r.text
    body = r.json()
    cloned_titles = {c['title'] for c in body['cloned']}
    boots = {b['title'] for b in body['bootstrapped']}

    # Both seeded projects must appear as `-tbc1` clones.
    for t in seed_titles:
        assert f'{t}-tbc1' in cloned_titles, f'{t}-tbc1 not in {cloned_titles}'
    # crypto-forex-tax was bootstrapped.
    assert 'crypto-forex-tax-tbc1' in boots, body

    # Workspace count went up by AT LEAST (2 clones + 1 bootstrap) = 3.
    assert asyncio.run(_count_in_workspace(owner)) >= 3


def test_clone_all_is_idempotent():
    s, owner = _login()
    asyncio.run(_wipe_workspace(owner))
    # First call
    r1 = s.post(f'{BASE_URL}/api/operator/projects/clone-all', json={'workspace': 'tbc1'})
    assert r1.status_code == 200
    first_total = asyncio.run(_count_in_workspace(owner))
    # Second call — projects already tagged tbc1 must be skipped.
    r2 = s.post(f'{BASE_URL}/api/operator/projects/clone-all', json={'workspace': 'tbc1'})
    assert r2.status_code == 200
    body = r2.json()
    # No new clones on the second pass — the previously cloned items must
    # all show up in `skipped` (we may still bootstrap missing extras, but
    # since the first pass already created them they'd be skipped too).
    assert body['cloned_count'] == 0, f'second pass cloned {body["cloned_count"]} items: {body}'
    # And the workspace headcount must NOT have doubled.
    second_total = asyncio.run(_count_in_workspace(owner))
    assert second_total <= first_total + body.get('bootstrapped_count', 0)


def test_workspace_name_validation():
    s, _ = _login()
    for bad in ['', 'Has SPACES', '!nope', '_leading', 'x' * 32]:
        r = s.post(f'{BASE_URL}/api/operator/projects/clone-all', json={'workspace': bad})
        assert r.status_code == 400, f'{bad!r} should be rejected'


def test_custom_workspace_name():
    s, owner = _login()
    asyncio.run(_wipe_workspace(owner, 'altspace'))
    s.post(f'{BASE_URL}/api/operator/projects', json={
        'title': f'multi-{uuid.uuid4().hex[:6]}', 'status': 'idea', 'tags': [],
    })
    r = s.post(f'{BASE_URL}/api/operator/projects/clone-all', json={'workspace': 'altspace'})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['workspace'] == 'altspace'
    assert any(c['title'].endswith('-altspace') for c in body['cloned'])
    # Cleanup so we don't pollute the operator's workspace list.
    asyncio.run(_wipe_workspace(owner, 'altspace'))
