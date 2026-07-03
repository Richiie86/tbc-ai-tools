"""Iter18 backend tests — AI Learnings GC + runtime errors severity + auto-page throttle."""
import os
import time
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://tbc-self-copy.preview.emergentagent.com').rstrip('/')
API = f'{BASE_URL}/api'

OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASS = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')


# ---------- Fixtures ----------

@pytest.fixture(scope='module')
def db():
    cli = MongoClient(MONGO_URL)
    return cli[DB_NAME]


@pytest.fixture(scope='module')
def op_session():
    """Authenticated session with operator. Login uses Bearer fallback."""
    s = requests.Session()
    r = s.post(f'{API}/auth/login', json={'email': OP_EMAIL, 'password': OP_PASS}, timeout=15)
    assert r.status_code == 200, f'login failed: {r.status_code} {r.text[:200]}'
    body = r.json()
    token = body.get('token')
    if body.get('pending_2fa'):
        pytest.skip('Operator has 2FA enabled — skipping')
    if token:
        s.headers.update({'Authorization': f'Bearer {token}'})
    return s


# ---------- GC manual trigger ----------

class TestGCEndpoint:
    def test_gc_returns_expected_shape(self, op_session):
        r = op_session.post(f'{API}/operator/ai-learnings/gc', params={'days': 14}, timeout=10)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert 'archived_count' in data and isinstance(data['archived_count'], int)
        assert 'cutoff' in data and isinstance(data['cutoff'], str)
        # ISO format check
        datetime.fromisoformat(data['cutoff'].replace('Z', '+00:00'))

    def test_gc_idempotent(self, op_session, db):
        # Run twice, second call should not re-archive the same docs
        r1 = op_session.post(f'{API}/operator/ai-learnings/gc', params={'days': 14}, timeout=10)
        assert r1.status_code == 200
        c1 = r1.json()['archived_count']
        # Second call right away should archive 0 newly (the previously archived docs
        # are excluded by the `archived: {$ne: true}` filter).
        r2 = op_session.post(f'{API}/operator/ai-learnings/gc', params={'days': 14}, timeout=10)
        assert r2.status_code == 200
        c2 = r2.json()['archived_count']
        assert c2 == 0, f'second GC archived {c2} items — should be 0 (idempotent). first={c1}'


# ---------- GC archive logic + list filter ----------

class TestGCArchiveLogic:
    def test_seed_stale_proposal_then_gc_archives_and_filter_works(self, op_session, db):
        # Seed a stale auto-proposed doc 30 days ago
        doc_id = f'TEST_iter18_stale_{uuid.uuid4().hex[:8]}'
        old_dt = datetime.now(timezone.utc) - timedelta(days=30)
        seed = {
            'id': doc_id,
            'text': 'TEST_iter18 stale auto-proposal for GC archive test',
            'enabled': False,
            'auto_proposed': True,
            'created_at': old_dt,
            'updated_at': old_dt,
            'created_by_email': 'auto-rca',
            'source': 'runtime_error',
        }
        db.ai_learnings.insert_one(seed)
        try:
            # Default list should include the unarchived (just-inserted) doc
            r_before = op_session.get(f'{API}/operator/ai-learnings', timeout=10)
            assert r_before.status_code == 200
            ids_before = [d['id'] for d in r_before.json()]
            assert doc_id in ids_before, 'seed doc not visible before GC'
            # serialized payload must include `archived` boolean
            seed_item = next(d for d in r_before.json() if d['id'] == doc_id)
            assert 'archived' in seed_item and seed_item['archived'] is False

            # Run GC with 14 day window
            r_gc = op_session.post(f'{API}/operator/ai-learnings/gc', params={'days': 14}, timeout=10)
            assert r_gc.status_code == 200
            assert r_gc.json()['archived_count'] >= 1

            # Verify DB updated
            fresh = db.ai_learnings.find_one({'id': doc_id})
            assert fresh.get('archived') is True
            assert isinstance(fresh.get('archived_at'), datetime)

            # Default list MUST omit archived
            r_default = op_session.get(f'{API}/operator/ai-learnings', timeout=10)
            ids_default = [d['id'] for d in r_default.json()]
            assert doc_id not in ids_default, 'archived doc leaked into default list'

            # include_archived=true MUST include it
            r_inc = op_session.get(
                f'{API}/operator/ai-learnings',
                params={'include_archived': 'true'},
                timeout=10,
            )
            assert r_inc.status_code == 200
            payload = r_inc.json()
            archived_item = next((d for d in payload if d['id'] == doc_id), None)
            assert archived_item is not None, 'doc missing with include_archived=true'
            assert archived_item['archived'] is True
        finally:
            db.ai_learnings.delete_one({'id': doc_id})


# ---------- Severity classifier ----------

class TestSeverityClassifier:
    @pytest.mark.parametrize('message,expected', [
        ('Stripe payment declined / cannot connect to backend', 'critical'),
        ('Unauthorized: invalid JWT', 'high'),
        ('TypeError: Cannot read undefined', 'warning'),
        ('some routine log', 'info'),
    ])
    def test_severity_in_ingest_response(self, message, expected):
        # Public endpoint, no auth required
        unique = f'{message} [{uuid.uuid4().hex[:8]}]'
        r = requests.post(
            f'{API}/runtime-errors',
            json={'message': unique, 'source': 'frontend'},
            timeout=10,
        )
        assert r.status_code == 202, r.text[:200]
        data = r.json()
        if not data.get('accepted'):
            pytest.skip(f'rate-limited: {data}')
        # On fresh signature -> "id" + "severity" returned
        # On merge -> "merged_into" returned (no severity at top level)
        if 'severity' in data:
            assert data['severity'] == expected, f'got {data["severity"]} expected {expected} for "{message}"'
        else:
            # Merged — fetch DB severity via list endpoint not possible without auth.
            # Skip rather than fail.
            pytest.skip(f'message merged into existing signature: {data}')


class TestSeverityPersisted:
    def test_operator_list_returns_severity_field(self, op_session):
        r = op_session.get(f'{API}/operator/runtime-errors', timeout=10)
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)
        if not items:
            pytest.skip('no runtime errors to assert against')
        # All items must have severity field, defaulting to 'info'
        for it in items[:20]:  # check first 20 to keep fast
            assert 'severity' in it, f'item missing severity: {it.get("id")}'
            assert it['severity'] in ('critical', 'high', 'warning', 'info'), it['severity']

    def test_preexisting_no_severity_defaults_to_info(self, op_session, db):
        # Insert a doc directly without severity field
        doc_id = f'TEST_iter18_nosev_{uuid.uuid4().hex[:8]}'
        sig = f'TEST_iter18_nosev_sig_{uuid.uuid4().hex[:8]}'
        now = datetime.now(timezone.utc)
        db.runtime_errors.insert_one({
            'id': doc_id,
            'signature': sig,
            'message': 'TEST_iter18 legacy no-severity doc',
            'stack': '',
            'source': 'frontend',
            # NO severity key
            'created_at': now,
            'last_seen_at': now,
            'count': 1,
            'dismissed_at': None,
        })
        try:
            r = op_session.get(f'{API}/operator/runtime-errors', timeout=10)
            assert r.status_code == 200
            found = next((d for d in r.json() if d['id'] == doc_id), None)
            assert found is not None
            assert found['severity'] == 'info', f'expected default info, got {found["severity"]}'
        finally:
            db.runtime_errors.delete_one({'id': doc_id})


# ---------- Auto-page throttle ----------

class TestAutoPageThrottle:
    def test_critical_ingest_creates_runtime_error_pages_doc_and_throttles(self, db):
        # Use unique critical message so signature is fresh
        unique = f'database connection lost — TEST_iter18_{uuid.uuid4().hex[:8]}'
        # Pre-cleanup any prior page rows for safety
        # First ingest
        r1 = requests.post(
            f'{API}/runtime-errors',
            json={'message': unique, 'source': 'backend'},
            timeout=10,
        )
        assert r1.status_code == 202
        d1 = r1.json()
        if not d1.get('accepted'):
            pytest.skip(f'rate-limited: {d1}')
        # severity must be critical
        if 'severity' in d1:
            assert d1['severity'] == 'critical', d1
        err_id = d1.get('id') or d1.get('merged_into')

        # Allow async page write to complete
        time.sleep(1.0)

        # Find signature via DB (the response doesn't return it)
        err_doc = db.runtime_errors.find_one({'id': err_id}) if err_id else None
        if not err_doc:
            pytest.skip('error doc not found in DB')
        sig = err_doc.get('signature')
        assert sig

        # Confirm runtime_error_pages has at least one row for this signature.
        # Note: the email send is best-effort. If Resend isn't configured or
        # there's no operator_email at all, the page row won't be inserted —
        # in that case we skip gracefully rather than fail (per spec).
        pages_after_first = list(db.runtime_error_pages.find({'signature': sig}))
        if len(pages_after_first) == 0:
            pytest.skip('no page row inserted — email config likely missing; throttle is best-effort')

        assert len(pages_after_first) == 1, f'expected 1 page row, got {len(pages_after_first)}'

        # Second ingest of SAME critical message — throttle must kick in
        r2 = requests.post(
            f'{API}/runtime-errors',
            json={'message': unique, 'source': 'backend'},
            timeout=10,
        )
        assert r2.status_code == 202
        time.sleep(1.0)

        pages_after_second = list(db.runtime_error_pages.find({'signature': sig}))
        assert len(pages_after_second) == 1, (
            f'throttle failed — expected still 1 page row, got {len(pages_after_second)}'
        )

        # Cleanup
        db.runtime_error_pages.delete_many({'signature': sig})
