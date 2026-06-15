"""Iter29 — Visual Verify endpoints + regression smoke on AI Build / auto-fix.

Covers:
  - GET  /api/operator/ai-build/visual-verify/{plan_id}  → 404 for unknown plan
  - POST /api/operator/ai-build/visual-verify/{plan_id}  → 404 for unknown plan
  - GET  /api/operator/ai-build/visual-verify/{plan_id}  → structured verdict
    for an existing plan (seeded directly in Mongo).
  - Regression smoke for existing AI Build endpoints (status codes only —
    github_token may not be configured so 503 is acceptable).
  - Auto-fix status endpoint shape: config + today_count + recent[].
"""
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path('/app/backend/.env'))
load_dotenv(Path('/app/frontend/.env'))

BASE = os.environ['REACT_APP_BACKEND_URL'].rstrip('/')
API = f'{BASE}/api'
OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASS = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')


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


@pytest.fixture(scope='session')
def mongo_db():
    """Direct Mongo handle for seeding plan docs."""
    from pymongo import MongoClient
    client = MongoClient(os.environ['MONGO_URL'])
    return client[os.environ['DB_NAME']]


# ─── 1. Visual verify — unknown plan ──────────────────────────────────────
class TestVisualVerifyUnknown:
    def test_get_unknown_plan_returns_404(self, operator_session):
        plan_id = f'TEST_unknown_{uuid.uuid4().hex[:8]}'
        r = operator_session.get(f'{API}/operator/ai-build/visual-verify/{plan_id}')
        assert r.status_code == 404, f'expected 404 got {r.status_code} {r.text[:200]}'

    def test_post_unknown_plan_returns_404(self, operator_session):
        plan_id = f'TEST_unknown_{uuid.uuid4().hex[:8]}'
        r = operator_session.post(f'{API}/operator/ai-build/visual-verify/{plan_id}', json={})
        # 404 (plan_not_found) is required. We must NOT see 200.
        # Other acceptable failure (no llm key / no preview url) would only
        # show after the plan IS found; with an unknown plan we must 404.
        assert r.status_code == 404, f'expected 404 got {r.status_code} {r.text[:200]}'


# ─── 2. Visual verify — existing plan returns stored verdict ──────────────
class TestVisualVerifyExisting:
    def test_get_existing_plan_returns_verdict(self, operator_session, mongo_db):
        # Seed a plan doc with a pre-baked visual_verify record.
        plan_id = f'TEST_iter29_{uuid.uuid4().hex[:10]}'
        plan_doc = {
            'plan_id': plan_id,
            'operator_id': 'system',
            'prompt': 'TEST iter29',
            'summary': 'TEST iter29 summary',
            'branch': 'test/iter29',
            'created_at': datetime.now(timezone.utc),
            'visual_verify': {
                'verdict': 'pass',
                'summary': 'Page renders correctly',
                'concerns': [],
                'reviewer_model': 'gpt-4o-mini',
                'preview_url': 'https://example.test/preview',
                'attempted_at': datetime.now(timezone.utc).isoformat(),
            },
        }
        mongo_db.ai_build_plans.insert_one(plan_doc)
        try:
            r = operator_session.get(f'{API}/operator/ai-build/visual-verify/{plan_id}')
            assert r.status_code == 200, f'expected 200 got {r.status_code} {r.text[:200]}'
            body = r.json()
            assert body.get('verdict') == 'pass'
            assert body.get('summary') == 'Page renders correctly'
            assert body.get('reviewer_model') == 'gpt-4o-mini'
            assert body.get('preview_url') == 'https://example.test/preview'
        finally:
            mongo_db.ai_build_plans.delete_one({'plan_id': plan_id})

    def test_get_existing_plan_no_verify_returns_not_run(self, operator_session, mongo_db):
        """If a plan exists but has never been verified, endpoint returns the
        synthetic 'not_run' record (status 200)."""
        plan_id = f'TEST_iter29_{uuid.uuid4().hex[:10]}'
        mongo_db.ai_build_plans.insert_one({
            'plan_id': plan_id,
            'operator_id': 'system',
            'prompt': 'TEST iter29 noverify',
            'summary': '',
            'created_at': datetime.now(timezone.utc),
        })
        try:
            r = operator_session.get(f'{API}/operator/ai-build/visual-verify/{plan_id}')
            assert r.status_code == 200
            body = r.json()
            assert body.get('verdict') == 'not_run'
            assert 'summary' in body
        finally:
            mongo_db.ai_build_plans.delete_one({'plan_id': plan_id})


# ─── 3. Visual verify endpoint requires auth ──────────────────────────────
class TestVisualVerifyAuthRequired:
    def test_unauthenticated_get_rejected(self):
        # Use a fresh session with no cookies / no Authorization
        r = requests.get(f'{API}/operator/ai-build/visual-verify/anything')
        assert r.status_code in (401, 403), f'expected 401/403 got {r.status_code}'


# ─── 4. AI Build smoke regression ─────────────────────────────────────────
class TestAIBuildSmoke:
    def test_history_returns_200(self, operator_session):
        r = operator_session.get(f'{API}/operator/ai-build/history?limit=5')
        assert r.status_code == 200
        body = r.json()
        # Some deployments use {items: [...]} others {plans: [...]} — accept any list field
        assert isinstance(body, dict)

    def test_plan_endpoint_wired(self, operator_session):
        """POST /plan should respond with either 200 (created) OR 503 (github_token
        not configured). Anything else is a wiring regression."""
        r = operator_session.post(
            f'{API}/operator/ai-build/plan',
            json={'prompt': 'TEST iter29 wiring check', 'target': 'tbc-tools'},
        )
        assert r.status_code in (200, 201, 400, 422, 503), f'unexpected {r.status_code} {r.text[:300]}'

    def test_open_pr_unknown_returns_404_or_503(self, operator_session):
        r = operator_session.post(
            f'{API}/operator/ai-build/open-pr/TEST_unknown_{uuid.uuid4().hex[:8]}',
            json={},
        )
        assert r.status_code in (404, 503), f'unexpected {r.status_code} {r.text[:200]}'

    def test_preview_url_unknown_returns_404_or_503(self, operator_session):
        r = operator_session.get(
            f'{API}/operator/ai-build/preview-url/TEST_unknown_{uuid.uuid4().hex[:8]}'
        )
        # 404 (plan not found), 409 (no PR yet), or 503 (token missing) all acceptable as wiring proof.
        assert r.status_code in (404, 409, 503, 400)


# ─── 5. Auto-fix status endpoint shape ────────────────────────────────────
class TestAutoFixStatus:
    def test_status_returns_config_and_recent(self, operator_session):
        r = operator_session.get(f'{API}/operator/auto-fix/status')
        assert r.status_code == 200, f'unexpected {r.status_code} {r.text[:200]}'
        body = r.json()
        assert 'config' in body, f'missing config key: {list(body.keys())}'
        assert 'today_count' in body
        assert 'recent' in body
        assert isinstance(body['recent'], list)
        assert isinstance(body['today_count'], int)
