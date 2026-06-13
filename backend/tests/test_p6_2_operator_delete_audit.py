# Validates new endpoint DELETE /api/operator/deploy/{project_id} writes
# an audit row with action='deploy_project.delete' and via='operator_ui'.
import os
import uuid
import time
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL') or open('/app/frontend/.env').read().split('REACT_APP_BACKEND_URL=')[1].split('\n')[0].strip()
BASE_URL = BASE_URL.rstrip('/')

from tests._creds import OP_EMAIL, OP_PASSWORD  # centralised — see /app/backend/tests/_creds.py


def _login_operator():
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    token = r.json().get('token')
    s.headers.update({'Authorization': f'Bearer {token}'})
    return s


def test_operator_delete_writes_audit_row_with_operator_ui_via():
    s = _login_operator()

    # Insert a deploy project directly into Mongo using the same helpers the app uses
    pid = f'TEST_del_{uuid.uuid4().hex[:8]}'
    import asyncio
    import sys
    sys.path.insert(0, '/app/backend')
    from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
    from datetime import datetime, timezone

    async def _insert():
        # Fresh Motor client bound to *this* event loop. Avoids the
        # "Future attached to a different loop" failure when this test
        # runs after other async tests in the same pytest session.
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            await client[os.environ['DB_NAME']].deploy_projects.insert_one({
                'id': pid,
                'projectName': f'TEST_del_{pid}',
                'repo': 'octocat/Hello-World',
                'domain': None,
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc),
            })
        finally:
            client.close()
    asyncio.run(_insert())

    # Now DELETE
    r = s.delete(f'{BASE_URL}/api/operator/deploy/{pid}')
    assert r.status_code == 200, r.text
    assert r.json().get('ok') is True
    assert r.json().get('deleted_id') == pid

    # Verify audit row appears with the right action + via
    time.sleep(0.5)
    r = s.get(f'{BASE_URL}/api/operator/audit', params={'limit': 50, 'action': 'deploy_project.delete'})
    assert r.status_code == 200, r.text
    rows = r.json() if isinstance(r.json(), list) else r.json().get('rows', [])
    matching = [row for row in rows if row.get('action') == 'deploy_project.delete' and (row.get('details') or {}).get('project_id') == pid]
    assert matching, f"no audit row found for pid {pid}; rows sample: {rows[:3]}"
    row = matching[0]
    assert (row.get('details') or {}).get('via') == 'operator_ui'


def test_operator_delete_unknown_returns_404():
    s = _login_operator()
    r = s.delete(f'{BASE_URL}/api/operator/deploy/does_not_exist_xyz')
    assert r.status_code == 404
