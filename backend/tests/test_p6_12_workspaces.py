"""P6.12 — Workspace switcher / registry tests."""
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


def test_list_workspaces_includes_clone_targets():
    s = _login()
    # Make sure tbc1 is registered (idempotent — safe if already there).
    s.post(f'{BASE_URL}/api/operator/projects/clone-all', json={'workspace': 'tbc1'})
    r = s.get(f'{BASE_URL}/api/operator/projects/workspaces')
    assert r.status_code == 200, r.text
    names = r.json().get('workspaces') or []
    assert 'tbc1' in names, names


def test_create_workspace_persists_and_returns_list():
    s = _login()
    new_name = f'qa{uuid.uuid4().hex[:6]}'
    r = s.post(f'{BASE_URL}/api/operator/projects/workspaces', json={'name': new_name})
    assert r.status_code == 200, r.text
    names = r.json().get('workspaces') or []
    assert new_name in names

    # Survives a re-read.
    r2 = s.get(f'{BASE_URL}/api/operator/projects/workspaces')
    assert new_name in (r2.json().get('workspaces') or [])

    # Cleanup so we don't pollute the dropdown forever.
    async def _cleanup():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            await client[os.environ['DB_NAME']].settings.update_one(
                {'_id': 'project_workspaces'},
                {'$pull': {'names': new_name}},
            )
        finally:
            client.close()
    asyncio.run(_cleanup())


def test_create_workspace_validates_name():
    s = _login()
    for bad in ['', '   ', 'HAS SPACES', '_under', 'a' * 32, '!nope']:
        r = s.post(f'{BASE_URL}/api/operator/projects/workspaces', json={'name': bad})
        assert r.status_code == 400, f'{bad!r} should be rejected'


def test_workspaces_endpoint_returns_in_use_tags_too():
    """Even without using /workspaces POST, any project tagged with a
    valid workspace slug must surface in the list."""
    s = _login()
    tag = f'ws{uuid.uuid4().hex[:6]}'
    r = s.post(f'{BASE_URL}/api/operator/projects', json={
        'title': f'in-use-{uuid.uuid4().hex[:6]}',
        'status': 'idea',
        'tags': [tag],
    })
    assert r.status_code == 200
    pid = r.json()['id']
    try:
        list_r = s.get(f'{BASE_URL}/api/operator/projects/workspaces')
        names = list_r.json().get('workspaces') or []
        assert tag in names, f'{tag} not found in {names}'
    finally:
        s.delete(f'{BASE_URL}/api/operator/projects/{pid}')
