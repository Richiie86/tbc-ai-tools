"""
P3 tests for the ship-gate (do_not_ship verdict blocks production deploys):
  (a) production deploy → 412 when last_code_review.verdict == 'do_not_ship'
  (b) 412 detail dict shape (error, message, review, fix_chat_session_id)
  (c) fix-chat session seeded with user message containing 'do_not_ship'
      and the failing finding titles
  (d) bypass_review=true skips the gate (then 503 because no Vercel token —
      that's the expected success indicator)
  (e) target='preview' skips the gate
  (f) AI-surface twin obeys the gate, defaults to bypass_review=false
"""
import os
import uuid
from datetime import datetime, timezone

import pymongo
import pytest
import requests

_BACKEND = os.environ.get('REACT_APP_BACKEND_URL')
if not _BACKEND:
    with open('/app/frontend/.env') as _f:
        for _line in _f:
            if _line.startswith('REACT_APP_BACKEND_URL='):
                _BACKEND = _line.split('=', 1)[1].strip()
                break
BASE_URL = (_BACKEND or '').rstrip('/')
API = f"{BASE_URL}/api"

OPERATOR_EMAIL = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OPERATOR_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', '123Admin@98')

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')

SEED_PROJECT_ID = 'ship-gate-test'
SEED_FINDING_TITLES = ['Hardcoded secret in config', 'SQL injection in user query']


@pytest.fixture(scope='module')
def mongo_db():
    client = pymongo.MongoClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture(scope='module')
def operator_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login",
               json={'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD},
               timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Operator login failed: {r.status_code}")
    body = r.json()
    if body.get('pending_2fa'):
        pytest.skip('Operator session pending_2fa')
    return s


@pytest.fixture(scope='module')
def ai_key(operator_session):
    r = operator_session.post(f"{API}/operator/deploy/key",
                              json={'regenerate_ai_api_key': True}, timeout=10)
    assert r.status_code == 200
    return r.json()['revealed_ai_api_key']


@pytest.fixture(scope='module', autouse=True)
def seed_blocked_project(mongo_db):
    """Insert a deploy_projects row whose last_code_review verdict is do_not_ship."""
    now = datetime.now(timezone.utc)
    review = {
        'verdict': 'do_not_ship',
        'summary': 'Test summary — multiple critical findings.',
        'findings': [
            {'severity': 'high', 'file': 'config.py', 'line_hint': 'SECRET=...',
             'title': SEED_FINDING_TITLES[0],
             'explanation': 'API key is committed.',
             'suggested_fix': 'Move to env var.'},
            {'severity': 'high', 'file': 'app/users.py', 'line_hint': 'SELECT ...',
             'title': SEED_FINDING_TITLES[1],
             'explanation': 'String interpolation.',
             'suggested_fix': 'Use parameterized queries.'},
        ],
        'missing_files': [],
        'ref': 'main',
        'reviewed_at': now.isoformat(),
    }
    doc = {
        'id': SEED_PROJECT_ID,
        'projectName': 'Ship-Gate Test Project',
        'repo': 'octocat/Hello-World',
        'domain': 'ship-gate-test.tbctools.test',
        'repoType': 'github',
        'gitRef': 'master',
        'last_code_review': review,
        'last_code_review_at': now,
        'created_at': now,
        'updated_at': now,
    }
    mongo_db.deploy_projects.replace_one({'id': SEED_PROJECT_ID}, doc, upsert=True)
    yield doc
    # Cleanup: remove the seed project and any chat sessions/messages created.
    mongo_db.deploy_projects.delete_one({'id': SEED_PROJECT_ID})
    # Best-effort: delete chat sessions seeded by the ship-gate (title prefix).
    sessions = list(mongo_db.chat_sessions.find(
        {'title': {'$regex': '^Fix review:'}}, {'id': 1}
    ))
    for s in sessions:
        mongo_db.chat_messages.delete_many({'session_id': s['id']})
        mongo_db.chat_sessions.delete_one({'id': s['id']})


# ---------- (a) + (b) operator production 412 + body shape ----------
class TestProductionBlocked:
    def test_production_returns_412_with_review_payload(self, operator_session):
        r = operator_session.post(
            f"{API}/operator/deploy/{SEED_PROJECT_ID}/deploy",
            json={'target': 'production'},
            timeout=20,
        )
        assert r.status_code == 412, r.text
        body = r.json()
        detail = body.get('detail') if isinstance(body, dict) else None
        assert isinstance(detail, dict), f"detail not a dict: {body!r}"
        assert detail.get('error') == 'review_blocked'
        assert 'message' in detail and isinstance(detail['message'], str)
        review = detail.get('review')
        assert isinstance(review, dict)
        assert review.get('verdict') == 'do_not_ship'
        assert isinstance(review.get('findings'), list) and len(review['findings']) >= 1
        # fix_chat_session_id should be a non-empty string (uuid-shaped)
        fix_id = detail.get('fix_chat_session_id')
        assert isinstance(fix_id, str) and len(fix_id) >= 8


# ---------- (c) seeded chat session ----------
class TestFixChatSeeded:
    def test_fix_chat_session_has_user_message_with_findings(self, operator_session, mongo_db):
        # Trigger the 412 again (idempotent — each call seeds a new chat session)
        r = operator_session.post(
            f"{API}/operator/deploy/{SEED_PROJECT_ID}/deploy",
            json={'target': 'production'},
            timeout=20,
        )
        assert r.status_code == 412
        fix_id = r.json()['detail']['fix_chat_session_id']
        assert fix_id

        # Try the documented API route first; fall back to Mongo if route shape differs.
        msg_resp = operator_session.get(
            f"{API}/chat/sessions/{fix_id}/messages", timeout=10
        )
        if msg_resp.status_code == 200:
            messages = msg_resp.json()
            if isinstance(messages, dict):
                messages = messages.get('messages') or messages.get('data') or []
            assert isinstance(messages, list) and len(messages) >= 1
            user_msgs = [m for m in messages if m.get('role') == 'user']
            assert user_msgs, "no user messages in seeded chat"
            content = user_msgs[0].get('content', '')
        else:
            # Fall back: read directly from Mongo
            doc = mongo_db.chat_messages.find_one({'session_id': fix_id, 'role': 'user'})
            assert doc, f"no user msg found in chat_messages for session {fix_id}"
            content = doc['content']

        assert 'do_not_ship' in content, content[:300]
        for title in SEED_FINDING_TITLES:
            assert title in content, f"expected finding title {title!r} in chat content"

        # Verify the session is owned by an operator user (not anonymous)
        session = mongo_db.chat_sessions.find_one({'id': fix_id})
        assert session is not None
        assert session.get('user_id'), f"session has no user_id: {session}"


# ---------- (d) bypass_review skips the gate ----------
class TestBypassReview:
    def test_bypass_review_skips_gate_and_attempts_vercel(self, operator_session):
        r = operator_session.post(
            f"{API}/operator/deploy/{SEED_PROJECT_ID}/deploy",
            json={'target': 'production', 'bypass_review': True},
            timeout=20,
        )
        # Gate is skipped — we now hit Vercel which 503s (no token) in preview env.
        # Acceptable outcomes: 503 (no Vercel token), 502 (Vercel error), or 200 (real deploy).
        assert r.status_code != 412, f"bypass did NOT skip the gate: {r.text}"
        assert r.status_code in (200, 502, 503), r.text


# ---------- (e) preview target skips the gate ----------
class TestPreviewSkipsGate:
    def test_preview_does_not_trigger_412(self, operator_session):
        r = operator_session.post(
            f"{API}/operator/deploy/{SEED_PROJECT_ID}/deploy",
            json={'target': 'preview'},
            timeout=20,
        )
        # Gate only fires for production target. Preview should bypass to Vercel.
        assert r.status_code != 412, f"preview hit the ship-gate: {r.text}"
        assert r.status_code in (200, 502, 503), r.text


# ---------- (f) AI-surface twin obeys the gate ----------
class TestAISurfaceObeysGate:
    def test_ai_surface_production_blocked_by_default(self, ai_key):
        H = {'Authorization': f'Bearer {ai_key}', 'Content-Type': 'application/json'}
        r = requests.post(
            f"{API}/projects/{SEED_PROJECT_ID}/deploy",
            headers=H, json={'target': 'production'}, timeout=20,
        )
        assert r.status_code == 412, r.text
        detail = r.json().get('detail')
        assert isinstance(detail, dict)
        assert detail.get('error') == 'review_blocked'
        assert detail.get('review', {}).get('verdict') == 'do_not_ship'

    def test_ai_surface_with_bypass_skips_gate(self, ai_key):
        H = {'Authorization': f'Bearer {ai_key}', 'Content-Type': 'application/json'}
        r = requests.post(
            f"{API}/projects/{SEED_PROJECT_ID}/deploy",
            headers=H, json={'target': 'production', 'bypass_review': True},
            timeout=20,
        )
        assert r.status_code != 412
        assert r.status_code in (200, 502, 503), r.text
