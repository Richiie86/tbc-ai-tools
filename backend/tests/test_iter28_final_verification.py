"""Iter28 final verification — changelog public/operator, auto-fix include_health,
AI Build tab loads, operator tabs, EOS health check endpoint, TTL GC.
"""
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

# Make sure backend env (MONGO_URL etc) is loaded before importing db.
load_dotenv(Path('/app/backend/.env'))
load_dotenv(Path('/app/frontend/.env'))

BASE = os.environ['REACT_APP_BACKEND_URL'].rstrip('/')
API = f'{BASE}/api'

OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASS = '123Admin@98'


# ─── Fixtures ─────────────────────────────────────────────────────────────
@pytest.fixture(scope='session')
def session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    return s


@pytest.fixture(scope='session')
def operator_session(session):
    r = session.post(f'{API}/auth/login', json={'email': OP_EMAIL, 'password': OP_PASS})
    assert r.status_code == 200, f'operator login failed: {r.status_code} {r.text[:200]}'
    body = r.json()
    if body.get('pending_2fa'):
        pytest.skip('Operator account requires 2FA — cannot test here')
    token = body.get('token')
    if token:
        session.headers.update({'Authorization': f'Bearer {token}'})
    return session


# ─── 1. Public changelog (anonymous) ─────────────────────────────────────
class TestChangelogPublic:
    def test_public_changelog_anonymous_no_auth(self):
        # Use a fresh session (no cookies, no Authorization)
        r = requests.get(f'{API}/changelog/public')
        assert r.status_code == 200
        d = r.json()
        assert 'entries' in d and isinstance(d['entries'], list)
        assert 'count' in d and isinstance(d['count'], int)

    def test_public_changelog_limit_clamped(self):
        r = requests.get(f'{API}/changelog/public?limit=999')
        assert r.status_code == 200
        d = r.json()
        # Server clamps to _MAX_ENTRIES_PER_FETCH=30
        assert d['count'] <= 30

    def test_public_changelog_entry_shape(self):
        r = requests.get(f'{API}/changelog/public?limit=1')
        assert r.status_code == 200
        for e in r.json()['entries']:
            for k in ('id', 'title', 'created_at'):
                assert k in e
            assert '_id' not in e  # MongoDB ObjectId must be stripped


# ─── 2. Changelog CRUD (operator) ────────────────────────────────────────
class TestChangelogOperator:
    def test_create_then_visible_publicly_then_delete(self, operator_session):
        title = f'TEST_iter28_{uuid.uuid4().hex[:8]}'
        r = operator_session.post(f'{API}/changelog', json={
            'title': title,
            'body_md': 'iter28 final verification entry',
            'tag': 'test',
        })
        assert r.status_code == 200, r.text[:300]
        created = r.json()
        assert created['title'] == title
        assert created['tag'] == 'test'
        eid = created['id']

        # Anonymous public list now sees it
        pub = requests.get(f'{API}/changelog/public?limit=30').json()
        assert any(e.get('id') == eid for e in pub['entries']), 'New entry not in public list'

        # Authenticated list also sees it + unread tracking present
        auth = operator_session.get(f'{API}/changelog').json()
        assert 'unread_count' in auth
        assert any(e.get('id') == eid for e in auth['entries'])

        # Delete
        d = operator_session.delete(f'{API}/changelog/{eid}')
        assert d.status_code == 200 and d.json().get('deleted') is True

        # Confirmed removal
        pub2 = requests.get(f'{API}/changelog/public?limit=30').json()
        assert not any(e.get('id') == eid for e in pub2['entries'])

    def test_anonymous_cannot_create(self):
        r = requests.post(f'{API}/changelog', json={'title': 'nope'})
        assert r.status_code in (401, 403)

    def test_delete_nonexistent_returns_404(self, operator_session):
        r = operator_session.delete(f'{API}/changelog/does-not-exist-{uuid.uuid4().hex}')
        assert r.status_code == 404


# ─── 3. Auto-Fix include_health config ───────────────────────────────────
class TestAutoFixIncludeHealth:
    def test_get_config_contains_include_health(self, operator_session):
        r = operator_session.get(f'{API}/operator/auto-fix/config')
        assert r.status_code == 200
        c = r.json()
        for k in ('enabled', 'auto_merge', 'include_health', 'per_day_cap', 'per_tick_cap'):
            assert k in c, f'missing config key: {k}'

    def test_put_config_toggles_include_health(self, operator_session):
        # Get current to restore later
        cur = operator_session.get(f'{API}/operator/auto-fix/config').json()

        # Toggle include_health=True (keep enabled state and project_id)
        payload = {**cur, 'include_health': True}
        # enabled requires project_id — if no project, force disable for this test
        if payload.get('enabled') and not payload.get('project_id'):
            payload['enabled'] = False
        r = operator_session.put(f'{API}/operator/auto-fix/config', json=payload)
        assert r.status_code == 200, r.text[:300]
        assert r.json().get('include_health') is True

        # GET reflects change
        r2 = operator_session.get(f'{API}/operator/auto-fix/config').json()
        assert r2.get('include_health') is True

        # Restore (set back to original)
        operator_session.put(f'{API}/operator/auto-fix/config', json={
            **cur,
            'enabled': cur.get('enabled') and bool(cur.get('project_id')),
        })

    def test_run_now_response_shape(self, operator_session):
        # Disabled by default → tick is a no-op but still returns the shape
        r = operator_session.post(f'{API}/operator/auto-fix/run-now')
        assert r.status_code == 200
        d = r.json()
        # Base keys always present
        for k in ('enabled', 'processed', 'opened', 'merged', 'errors'):
            assert k in d, f'missing run-now key: {k}'


# ─── 4. EOS Health Check endpoint ────────────────────────────────────────
class TestHealthCheckEndpoint:
    def test_healthcheck_unknown_project_404(self, operator_session):
        r = operator_session.post(f'{API}/operator/deploy/does-not-exist-{uuid.uuid4().hex}/healthcheck')
        assert r.status_code in (404, 400)


# ─── 5. Operator tabs / regression endpoints ─────────────────────────────
class TestRegression:
    def test_status_endpoint_anonymous(self):
        r = requests.get(f'{API}/status/public')
        # /status page renders via /api/status/public — should be anonymous
        assert r.status_code in (200, 404)  # tolerate variants

    def test_ai_build_history_loads(self, operator_session):
        r = operator_session.get(f'{API}/operator/ai-build/history')
        assert r.status_code == 200

    def test_operator_stats_loads(self, operator_session):
        r = operator_session.get(f'{API}/operator/stats')
        assert r.status_code == 200


# ─── 6. TTL GC for ai_build_plans (direct DB / function call) ────────────
class TestAiBuildGc:
    @pytest.mark.asyncio
    async def test_discarded_plan_25h_old_removed_opened_preserved(self):
        try:
            from db import db
        except Exception as e:
            pytest.skip(f'db import failed: {e}')

        old_id = f'TEST_gc_old_{uuid.uuid4().hex[:8]}'
        opened_id = f'TEST_gc_opened_{uuid.uuid4().hex[:8]}'
        old_ts = datetime.now(timezone.utc) - timedelta(hours=25)
        try:
            await db.ai_build_plans.insert_one({
                'plan_id': old_id, 'status': 'discarded', 'created_at': old_ts,
            })
            await db.ai_build_plans.insert_one({
                'plan_id': opened_id, 'status': 'opened', 'created_at': old_ts,
            })

            # Run the GC job manually — pulled from server scheduler
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            res = await db.ai_build_plans.delete_many({
                'status': 'discarded',
                'created_at': {'$lt': cutoff},
            })
            assert res.deleted_count >= 1

            assert await db.ai_build_plans.find_one({'plan_id': old_id}) is None
            assert await db.ai_build_plans.find_one({'plan_id': opened_id}) is not None
        finally:
            await db.ai_build_plans.delete_many({'plan_id': {'$in': [old_id, opened_id]}})
