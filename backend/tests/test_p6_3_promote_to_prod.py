"""P6.3 — Promote-to-prod endpoint contract tests.

Verifies POST /api/operator/deploy/{id}/promote behaviour without
actually hitting Vercel's promote API (we don't want flaky external
calls in CI). Two paths covered:
  * 400 when the project has no recorded last_deployment_id
  * 404 when the project doesn't exist
"""
import os
import uuid
import requests

# Load backend .env so MONGO_URL/DB_NAME are available when the test runs
# outside the supervisor-managed process.
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


def test_promote_returns_400_when_no_previous_deployment():
    s = _login()
    pid = f'TEST_promote_{uuid.uuid4().hex[:8]}'
    import asyncio
    from motor.motor_asyncio import AsyncIOMotorClient
    from datetime import datetime, timezone

    async def _insert():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            await client[os.environ['DB_NAME']].deploy_projects.insert_one({
                'id': pid,
                'projectName': pid,
                'repo': 'octocat/Hello-World',
                'domain': None,
                'vercel_project_id': 'prj_dummy',  # so we hit the "no deployment" branch
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc),
            })
        finally:
            client.close()
    asyncio.run(_insert())

    try:
        r = s.post(f'{BASE_URL}/api/operator/deploy/{pid}/promote', json={})
        assert r.status_code == 400, r.text
        assert 'no preview deployment' in r.json().get('detail', '').lower()
    finally:
        async def _cleanup():
            client = AsyncIOMotorClient(os.environ['MONGO_URL'])
            try:
                await client[os.environ['DB_NAME']].deploy_projects.delete_one({'id': pid})
            finally:
                client.close()
        asyncio.run(_cleanup())


def test_promote_returns_404_when_project_missing():
    s = _login()
    r = s.post(f'{BASE_URL}/api/operator/deploy/does-not-exist-{uuid.uuid4().hex[:6]}/promote', json={})
    assert r.status_code == 404
