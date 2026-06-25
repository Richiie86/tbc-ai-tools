"""Iter29 backend tests:
- /api/operator/deploy/projects regression (no 500)
- Vanish + re-register + approve/reject E2E
- KYC bypass allowlist CRUD + is_kyc_bypassed helper
- AI build run-tests endpoint contract
- AutoFixConfig new fields persistence
"""
import os
import asyncio
import uuid
import pytest
import requests

def _backend_url():
    v = os.environ.get('REACT_APP_BACKEND_URL')
    if v:
        return v.rstrip('/')
    try:
        for line in open('/app/frontend/.env'):
            if line.startswith('REACT_APP_BACKEND_URL='):
                return line.split('=', 1)[1].strip().rstrip('/')
    except Exception:
        pass
    return 'http://localhost:8001'
BASE_URL = _backend_url()


def _mongo_env():
    """Load MONGO_URL + DB_NAME from backend/.env when not in os.environ."""
    if os.environ.get('MONGO_URL') and os.environ.get('DB_NAME'):
        return
    try:
        for line in open('/app/backend/.env'):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:
        pass
_mongo_env()
OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASS = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')

VANISH_EMAIL = 'test_vanish_reregister_iter29@example.com'
KYC_EMAIL = 'test_kyc_bypass_iter29@example.com'


@pytest.fixture(scope='module')
def session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    return s


@pytest.fixture(scope='module')
def op_token(session):
    r = session.post(f'{BASE_URL}/api/auth/login',
                     json={'email': OP_EMAIL, 'password': OP_PASS})
    if r.status_code != 200:
        pytest.skip(f'Operator login failed: {r.status_code} {r.text[:200]}')
    body = r.json()
    if body.get('pending_2fa'):
        # try TOTP
        try:
            import pyotp, pymongo
            c = pymongo.MongoClient(os.environ['MONGO_URL'])
            db = c[os.environ['DB_NAME']]
            u = db.users.find_one({'email': OP_EMAIL})
            if u and u.get('totp_secret'):
                code = pyotp.TOTP(u['totp_secret']).now()
                r2 = session.post(f'{BASE_URL}/api/auth/2fa/verify', json={'totp_code': code})
                if r2.status_code == 200:
                    return r2.json().get('token') or body.get('token')
        except Exception as e:
            pytest.skip(f'2FA needed but failed: {e}')
        pytest.skip('Operator requires 2FA and TOTP not available')
    return body.get('token')


@pytest.fixture(scope='module')
def op_client(session, op_token):
    if not op_token:
        pytest.skip('No operator token')
    session.headers.update({'Authorization': f'Bearer {op_token}'})
    return session


# ───────────────────────── deploy/projects regression ─────────────────
def test_deploy_projects_returns_200(op_client):
    r = op_client.get(f'{BASE_URL}/api/operator/deploy/projects')
    assert r.status_code == 200, f'expected 200, got {r.status_code}: {r.text[:300]}'
    data = r.json()
    assert isinstance(data, list)


# ───────────────────────── KYC bypass allowlist ────────────────────────
def test_kyc_bypass_requires_auth():
    r = requests.get(f'{BASE_URL}/api/operator/security/kyc-bypass')
    assert r.status_code in (401, 403)


def test_kyc_bypass_crud_and_helper(op_client):
    # cleanup any pre-existing
    op_client.delete(f'{BASE_URL}/api/operator/security/kyc-bypass/{KYC_EMAIL}')

    # add
    r = op_client.post(f'{BASE_URL}/api/operator/security/kyc-bypass',
                       json={'email': KYC_EMAIL, 'note': 'TEST iter29'})
    assert r.status_code == 200, r.text
    assert r.json().get('email') == KYC_EMAIL

    # idempotent re-add
    r = op_client.post(f'{BASE_URL}/api/operator/security/kyc-bypass',
                       json={'email': KYC_EMAIL, 'note': 'TEST iter29 updated'})
    assert r.status_code == 200

    # list contains it
    r = op_client.get(f'{BASE_URL}/api/operator/security/kyc-bypass')
    assert r.status_code == 200
    emails = [e['email'] for e in r.json().get('emails', [])]
    assert KYC_EMAIL in emails

    # helper check via direct mongo (mirrors is_kyc_bypassed)
    import pymongo
    pc = pymongo.MongoClient(os.environ['MONGO_URL'])
    pdb = pc[os.environ['DB_NAME']]
    assert pdb.kyc_bypass_emails.find_one({'email': KYC_EMAIL.lower()}) is not None

    # delete
    r = op_client.delete(f'{BASE_URL}/api/operator/security/kyc-bypass/{KYC_EMAIL}')
    assert r.status_code == 200
    # second delete → 404
    r = op_client.delete(f'{BASE_URL}/api/operator/security/kyc-bypass/{KYC_EMAIL}')
    assert r.status_code == 404
    assert pdb.kyc_bypass_emails.find_one({'email': KYC_EMAIL.lower()}) is None


# ───────────────────────── Vanish + re-register E2E ────────────────────
@pytest.fixture
def mongo_db():
    import pymongo
    c = pymongo.MongoClient(os.environ['MONGO_URL'])
    return c[os.environ['DB_NAME']]


def test_vanish_reregister_approve_e2e(op_client, mongo_db):
    db = mongo_db
    # cleanup state
    db.users.delete_many({'email': VANISH_EMAIL})
    db.vanished_emails.delete_many({'email': VANISH_EMAIL})

    # 1. Register first time normally → must succeed (no hold)
    pwd = 'TestPass123!'
    r = requests.post(f'{BASE_URL}/api/auth/register',
                      json={'email': VANISH_EMAIL, 'password': pwd, 'name': 'TEST'})
    assert r.status_code in (200, 201), r.text
    user_doc = db.users.find_one({'email': VANISH_EMAIL})
    assert user_doc is not None
    user_id = user_doc['id']

    # 2. Operator vanishes the user (requires confirm_email match)
    r = op_client.post(f'{BASE_URL}/api/operator/users/{user_id}/vanish',
                       json={'confirm_email': VANISH_EMAIL})
    assert r.status_code in (200, 204), f'vanish failed: {r.status_code} {r.text[:200]}'
    assert db.vanished_emails.find_one({'email': VANISH_EMAIL}) is not None, 'vanished_emails should be stamped'

    # 3. Re-register same email → must create with pending_approval=true
    r = requests.post(f'{BASE_URL}/api/auth/register',
                      json={'email': VANISH_EMAIL, 'password': pwd, 'name': 'TEST2'})
    assert r.status_code in (200, 201, 202), f'reregister: {r.status_code} {r.text[:200]}'
    held = db.users.find_one({'email': VANISH_EMAIL})
    assert held is not None
    assert held.get('pending_approval') is True or held.get('status') == 'pending', \
        f"expected pending hold, got pending_approval={held.get('pending_approval')} status={held.get('status')}"
    held_id = held['id']

    # 4. Login for pending user → 403 with pending operator approval message
    r = requests.post(f'{BASE_URL}/api/auth/login',
                      json={'email': VANISH_EMAIL, 'password': pwd})
    assert r.status_code == 403, f'expected 403 on pending login, got {r.status_code}: {r.text[:200]}'
    body_text = r.text.lower()
    assert 'pending' in body_text or 'approval' in body_text, f'message missing: {r.text[:200]}'

    # 5. Pending list contains the held user
    r = op_client.get(f'{BASE_URL}/api/operator/security/pending-users')
    assert r.status_code == 200, r.text
    pending_ids = [u['id'] for u in r.json().get('pending', [])]
    assert held_id in pending_ids

    # 6. Approve
    r = op_client.post(f'{BASE_URL}/api/operator/security/pending-users/{held_id}/approve')
    assert r.status_code == 200, r.text
    # vanished_emails entry dropped
    assert db.vanished_emails.find_one({'email': VANISH_EMAIL}) is None
    # user can now log in
    r = requests.post(f'{BASE_URL}/api/auth/login',
                      json={'email': VANISH_EMAIL, 'password': pwd})
    assert r.status_code == 200, f'approved user login failed: {r.status_code} {r.text[:200]}'

    # cleanup
    db.users.delete_many({'email': VANISH_EMAIL})
    db.vanished_emails.delete_many({'email': VANISH_EMAIL})


def test_pending_user_reject(op_client, mongo_db):
    db = mongo_db
    reject_email = 'test_reject_iter29@example.com'
    db.users.delete_many({'email': reject_email})
    db.vanished_emails.insert_one({'email': reject_email})

    pwd = 'TestPass123!'
    r = requests.post(f'{BASE_URL}/api/auth/register',
                      json={'email': reject_email, 'password': pwd, 'name': 'TEST'})
    assert r.status_code in (200, 201, 202)
    held = db.users.find_one({'email': reject_email})
    assert held and (held.get('pending_approval') or held.get('status') == 'pending')

    r = op_client.post(f'{BASE_URL}/api/operator/security/pending-users/{held["id"]}/reject')
    assert r.status_code == 200, r.text
    assert db.users.find_one({'email': reject_email}) is None
    # vanished email stays
    assert db.vanished_emails.find_one({'email': reject_email}) is not None

    db.vanished_emails.delete_many({'email': reject_email})


# ───────────────────────── AI build run-tests endpoint ─────────────────
def test_run_tests_404_for_unknown_plan(op_client):
    r = op_client.post(f'{BASE_URL}/api/operator/ai-build/run-tests/__nonexistent_plan_iter29__')
    assert r.status_code == 404


def test_get_run_tests_404_for_unknown_plan(op_client):
    r = op_client.get(f'{BASE_URL}/api/operator/ai-build/run-tests/__nonexistent_plan_iter29__')
    assert r.status_code == 404


def test_get_run_tests_not_run_for_existing_plan(op_client, mongo_db):
    db = mongo_db
    plan_id = f'TEST_iter29_plan_{uuid.uuid4().hex[:8]}'
    from datetime import datetime, timezone
    db.ai_build_plans.insert_one({
        'plan_id': plan_id,
        'project_id': 'TEST_iter29',
        'status': 'planned',
        'created_at': datetime.now(timezone.utc),
    })
    try:
        r = op_client.get(f'{BASE_URL}/api/operator/ai-build/run-tests/{plan_id}')
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get('verdict') == 'not_run'
    finally:
        db.ai_build_plans.delete_many({'plan_id': plan_id})


# ───────────────────────── AutoFixConfig new fields ────────────────────
def test_auto_fix_config_persists_new_fields(op_client):
    r = op_client.get(f'{BASE_URL}/api/operator/auto-fix/config')
    assert r.status_code == 200
    original = r.json()

    payload = {
        'enabled': False,
        'auto_merge': False,
        'include_health': False,
        'auto_push_empty_repo': True,
        'auto_run_tests': True,
        'per_day_cap': original.get('per_day_cap', 5),
        'per_tick_cap': original.get('per_tick_cap', 3),
        'project_id': original.get('project_id'),
    }
    r = op_client.put(f'{BASE_URL}/api/operator/auto-fix/config', json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get('auto_push_empty_repo') is True
    assert body.get('auto_run_tests') is True

    # round-trip GET
    r = op_client.get(f'{BASE_URL}/api/operator/auto-fix/config')
    assert r.status_code == 200
    body = r.json()
    assert body.get('auto_push_empty_repo') is True
    assert body.get('auto_run_tests') is True

    # restore defaults
    payload['auto_push_empty_repo'] = False
    payload['auto_run_tests'] = False
    op_client.put(f'{BASE_URL}/api/operator/auto-fix/config', json=payload)
