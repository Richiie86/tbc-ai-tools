"""Iter30 — MongoDB collection fix regression tests.

Previous agent fixed 7 code paths that incorrectly queried `db.payment_settings`
when the actual data lives at `db.settings._id='payment_settings'`. This
verifies all affected endpoints retrieve github_token / default_can_deploy
successfully and do NOT surface a 503 'github_token not set' when the token
is configured.

Files of reference:
- auto_fix_loop_ext.py:481 (_auto_merge_sweep)
- ai_build_ext.py:336, 468, 631 (plan/open-pr/preview-url)
- deploy_access_ext.py:40, 234 (_default_can_deploy + op_set_default)
- server.py:646 (signup endpoint default_can_deploy)
"""
import os
import pytest
import requests


def _backend_url() -> str:
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


def _load_backend_env() -> None:
    if os.environ.get('MONGO_URL') and os.environ.get('DB_NAME'):
        return
    try:
        for line in open('/app/backend/.env'):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:
        pass


_load_backend_env()

OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASS = '123Admin@98'


# ───────────────────────── fixtures ─────────────────────────
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
        try:
            import pyotp
            import pymongo
            c = pymongo.MongoClient(os.environ['MONGO_URL'])
            db = c[os.environ['DB_NAME']]
            u = db.users.find_one({'email': OP_EMAIL})
            if u and u.get('totp_secret'):
                code = pyotp.TOTP(u['totp_secret']).now()
                r2 = session.post(f'{BASE_URL}/api/auth/2fa/verify',
                                  json={'totp_code': code})
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


@pytest.fixture(scope='module')
def mongo_db():
    try:
        import pymongo
        c = pymongo.MongoClient(os.environ['MONGO_URL'])
        return c[os.environ['DB_NAME']]
    except Exception as e:
        pytest.skip(f'Mongo not available: {e}')


# ───────────────────── 0. operator login sanity ─────────────────────
def test_operator_login_works(op_token):
    assert op_token, 'Operator token must be obtained'
    assert isinstance(op_token, str)
    assert len(op_token) > 10


# ───────────────────── 1. settings doc is the canonical store ─────────────────────
def test_settings_doc_contains_github_token_and_vercel_token(mongo_db):
    """Pre-condition: the canonical doc at db.settings._id='payment_settings'
    actually contains the secrets the fixed code paths read."""
    doc = mongo_db.settings.find_one({'_id': 'payment_settings'})
    assert doc is not None, "db.settings._id='payment_settings' MUST exist"
    assert doc.get('github_token'), 'github_token must be present in settings doc'
    assert isinstance(doc['github_token'], str)
    assert doc['github_token'].startswith(('ghp_', 'github_pat_')), \
        f"github_token format unexpected: {doc['github_token'][:8]}…"
    assert doc.get('vercel_token'), 'vercel_token must be present in settings doc'


def test_no_legacy_payment_settings_collection(mongo_db):
    """The buggy code paths queried a collection that should never exist.
    Confirms we are not silently writing to it."""
    cols = mongo_db.list_collection_names()
    if 'payment_settings' in cols:
        # If present but empty, OK. If present with rows, that's a tell that
        # something is still writing to the wrong location.
        count = mongo_db.payment_settings.count_documents({})
        assert count == 0, \
            f'Legacy payment_settings collection has {count} docs — code may still be writing there'


# ───────────────────── 2. GET /operator/deploy/projects regression ─────────────────────
def test_deploy_projects_returns_200_no_github_token_503(op_client):
    """The github_token retrieval must succeed. Previously this returned a
    503 'github_token not set' because the code read from the wrong place."""
    r = op_client.get(f'{BASE_URL}/api/operator/deploy/projects')
    assert r.status_code == 200, f'expected 200, got {r.status_code}: {r.text[:400]}'
    body = r.json()
    assert isinstance(body, list), f'expected list, got {type(body)}'
    # Should not surface a github_token complaint in the body
    body_str = r.text.lower()
    assert 'github_token not set' not in body_str
    assert 'github_token' not in body_str or 'token' in body_str


# ───────────────────── 3. deploy-access default (read + write) ─────────────────────
def test_deploy_access_default_get_returns_boolean(op_client):
    """deploy_access_ext.py:40 — _default_can_deploy reads from settings doc."""
    r = op_client.get(f'{BASE_URL}/api/operator/deploy-access/default')
    assert r.status_code == 200, f'{r.status_code}: {r.text[:200]}'
    body = r.json()
    assert 'default_can_deploy' in body
    assert isinstance(body['default_can_deploy'], bool)


def test_deploy_access_default_patch_persists_to_settings_doc(op_client, mongo_db):
    """deploy_access_ext.py:234 — op_set_default writes to settings doc.
    Verify by GET-after-PATCH AND by direct Mongo inspection."""
    # Capture current value so we can restore
    r0 = op_client.get(f'{BASE_URL}/api/operator/deploy-access/default')
    original = r0.json()['default_can_deploy']

    try:
        # Flip to True
        r1 = op_client.patch(
            f'{BASE_URL}/api/operator/deploy-access/default',
            json={'default_can_deploy': True},
        )
        assert r1.status_code == 200, f'PATCH true failed: {r1.status_code} {r1.text[:200]}'
        assert r1.json()['default_can_deploy'] is True

        # GET it back — must reflect the new value
        r2 = op_client.get(f'{BASE_URL}/api/operator/deploy-access/default')
        assert r2.status_code == 200
        assert r2.json()['default_can_deploy'] is True

        # Direct Mongo verification — written to db.settings._id='payment_settings'
        doc = mongo_db.settings.find_one({'_id': 'payment_settings'})
        assert doc is not None
        assert doc.get('default_can_deploy') is True, \
            f'Settings doc default_can_deploy not updated: {doc.get("default_can_deploy")}'

        # And NOT into the legacy collection
        legacy_doc = None
        if 'payment_settings' in mongo_db.list_collection_names():
            legacy_doc = mongo_db.payment_settings.find_one({})
        assert legacy_doc is None, \
            f'Legacy payment_settings collection received the write: {legacy_doc}'

        # Flip back to False to confirm round-trip persistence
        r3 = op_client.patch(
            f'{BASE_URL}/api/operator/deploy-access/default',
            json={'default_can_deploy': False},
        )
        assert r3.status_code == 200
        assert r3.json()['default_can_deploy'] is False
        r4 = op_client.get(f'{BASE_URL}/api/operator/deploy-access/default')
        assert r4.json()['default_can_deploy'] is False
    finally:
        # Restore original
        op_client.patch(
            f'{BASE_URL}/api/operator/deploy-access/default',
            json={'default_can_deploy': bool(original)},
        )


# ───────────────────── 4. AI Build /plan endpoint (github_token retrieval) ─────────────────────
def test_ai_build_plan_does_not_return_github_token_missing_503(op_client, mongo_db):
    """ai_build_ext.py:336 — plan() reads github_token. Since the token IS
    configured, we must NOT see a 503 'github_token not set'. Use an existing
    deploy project if any so we get past the project lookup."""
    # Find a project with a repo configured
    proj = mongo_db.deploy_projects.find_one({'repo': {'$exists': True, '$ne': ''}})
    if not proj:
        pytest.skip('No deploy project with repo configured to exercise /plan')
    r = op_client.post(
        f'{BASE_URL}/api/operator/ai-build/plan',
        json={'project_id': proj['id'], 'prompt': 'TEST_iter30_noop verification ping'},
    )
    # Allowed outcomes: 200 (plan generated), 4xx for content/llm reasons,
    # 5xx for LLM/GitHub-side outages — but NOT a 503 about github_token.
    if r.status_code == 503:
        body = r.text.lower()
        assert 'github_token not set' not in body, (
            f"github_token still not retrievable from settings doc: {r.text[:300]}"
        )
    # Don't fail on non-200 — the LLM call may be slow/flaky in the test env.
    assert r.status_code in (200, 400, 404, 409, 422, 500, 502, 503, 504), \
        f'unexpected status {r.status_code}: {r.text[:200]}'


# ───────────────────── 5. AI Build /open-pr (github_token retrieval) ─────────────────────
def test_ai_build_open_pr_does_not_return_github_token_missing_503(op_client):
    """ai_build_ext.py:468 — open-pr also reads github_token. We send a bogus
    plan_id so the endpoint will 404 before reaching github_token check.
    The intent here is to confirm the route exists and the code path doesn't
    pre-503 on token. If we get a 404 plan_id check first, that's also fine."""
    r = op_client.post(
        f'{BASE_URL}/api/operator/ai-build/open-pr',
        json={'plan_id': 'TEST_iter30_does_not_exist_plan'},
    )
    # 404 (plan not found) is the expected first failure → confirms token
    # gate is NOT short-circuiting before plan lookup, OR if it does, it
    # must succeed since the token IS configured.
    assert r.status_code in (404, 409, 422), \
        f'unexpected status {r.status_code}: {r.text[:200]}'
    body = r.text.lower()
    assert 'github_token not set' not in body, (
        f'github_token gate fired on /open-pr despite configured token: {r.text[:300]}'
    )


# ───────────────────── 6. AI Build /preview-url (settings read) ─────────────────────
def test_ai_build_preview_url_does_not_500_on_settings_read(op_client):
    """ai_build_ext.py:631 — preview-url reads settings for vercel_token.
    Bogus plan_id should yield 404 (not a 500 from the settings read)."""
    r = op_client.get(
        f'{BASE_URL}/api/operator/ai-build/preview-url/TEST_iter30_bogus_plan',
    )
    assert r.status_code in (404, 409, 422), \
        f'unexpected status {r.status_code}: {r.text[:200]}'


# ───────────────────── 7. initial-push uses correct settings location ─────────────────────
def test_initial_push_does_not_return_github_token_missing_503(op_client, mongo_db):
    """deploy_initial_push_ext.py:233 — also reads settings. Use a bogus
    project_id to verify the endpoint shape; main goal is no 503 on token."""
    r = op_client.post(
        f'{BASE_URL}/api/operator/deploy/TEST_iter30_bogus_project/initial-push',
    )
    # 404 expected (project not found). Token gate must NOT fire incorrectly.
    assert r.status_code in (404, 412), \
        f'unexpected status {r.status_code}: {r.text[:200]}'
    body = r.text.lower()
    assert 'github_token not set' not in body, (
        f'github_token gate fired on /initial-push despite configured token: {r.text[:300]}'
    )


# ───────────────────── 8. signup endpoint reads default_can_deploy from settings ─────────────────────
def test_signup_reads_default_can_deploy_from_settings_doc(op_client, mongo_db):
    """server.py:646 — signup reads default_can_deploy from db.settings doc.
    Strategy: set default_can_deploy=True, register a new user, verify
    can_deploy=True on the resulting user doc; then flip to False and
    verify a second user gets can_deploy=False."""
    import uuid as _uuid
    suffix = _uuid.uuid4().hex[:8]
    email_true = f'TEST_iter30_signup_true_{suffix}@example.com'
    email_false = f'TEST_iter30_signup_false_{suffix}@example.com'
    created_ids: list[str] = []

    # Capture and restore at the end
    r0 = op_client.get(f'{BASE_URL}/api/operator/deploy-access/default')
    original = r0.json()['default_can_deploy']

    try:
        # Phase 1: default_can_deploy=True
        op_client.patch(
            f'{BASE_URL}/api/operator/deploy-access/default',
            json={'default_can_deploy': True},
        )
        # Use the bare /api/auth/register endpoint
        # Some apps require date of birth — try a common shape
        register_payload = {
            'email': email_true,
            'password': 'TestPass123!',
            'name': 'Iter30 Test True',
            'first_name': 'Iter30',
            'last_name': 'TestTrue',
            'dob': '1990-01-01',
        }
        # Make sure unauth'd session does not have op auth header attached
        bare = requests.Session()
        bare.headers.update({'Content-Type': 'application/json'})
        r1 = bare.post(f'{BASE_URL}/api/auth/register', json=register_payload)
        if r1.status_code not in (200, 201):
            pytest.skip(
                f'Cannot exercise signup flow: register returned '
                f'{r1.status_code} {r1.text[:200]}'
            )
        # Inspect the resulting user doc — register endpoint lowercases the email
        u_true = mongo_db.users.find_one({'email': email_true.lower()})
        assert u_true is not None, f'User not persisted for {email_true.lower()}'
        created_ids.append(u_true['id'])
        assert u_true.get('can_deploy') is True, (
            f"can_deploy should be True (default_can_deploy=True); "
            f"got {u_true.get('can_deploy')}"
        )

        # Phase 2: default_can_deploy=False
        op_client.patch(
            f'{BASE_URL}/api/operator/deploy-access/default',
            json={'default_can_deploy': False},
        )
        register_payload['email'] = email_false
        r2 = bare.post(f'{BASE_URL}/api/auth/register', json=register_payload)
        assert r2.status_code in (200, 201), \
            f'Second register failed: {r2.status_code} {r2.text[:200]}'
        u_false = mongo_db.users.find_one({'email': email_false.lower()})
        assert u_false is not None
        created_ids.append(u_false['id'])
        assert u_false.get('can_deploy') is False, (
            f"can_deploy should be False (default_can_deploy=False); "
            f"got {u_false.get('can_deploy')}"
        )
    finally:
        # Cleanup test users + restore setting
        for uid in created_ids:
            try:
                mongo_db.users.delete_one({'id': uid})
            except Exception:
                pass
        try:
            mongo_db.vanished_emails.delete_many(
                {'email': {'$in': [email_true.lower(), email_false.lower()]}}
            )
        except Exception:
            pass
        op_client.patch(
            f'{BASE_URL}/api/operator/deploy-access/default',
            json={'default_can_deploy': bool(original)},
        )


# ───────────────────── 9. backend health: no startup crash about github_token ─────────────────────
def test_backend_logs_show_no_github_token_lookup_errors():
    """The auto-fix scheduled job runs in the background. Verify recent
    backend logs don't show errors about github_token being missing
    (which would mean a code path is still reading from the wrong place)."""
    import subprocess
    try:
        out = subprocess.check_output(
            ['tail', '-n', '500', '/var/log/supervisor/backend.err.log'],
            stderr=subprocess.STDOUT, timeout=5,
        ).decode('utf-8', errors='ignore').lower()
    except Exception as e:
        pytest.skip(f'Cannot read backend logs: {e}')
    # Look for symptomatic phrases. We accept the strings appearing in
    # request handler errors (those are fine — that's the gate working);
    # we are looking for runtime crashes in background jobs.
    bad = 'traceback' in out and 'github_token' in out
    assert not bad, (
        'Backend logs contain a traceback mentioning github_token — '
        'a code path may still be reading the wrong collection.'
    )
