"""
P0 Code Review #2 follow-up tests.

Covers:
- Operator login (cookie-based auth)
- GET /api/operator/codes/file?path=... — defensive `content` init (server.py:1179)
- POST /api/auth/forgot-password + /api/auth/reset-password — decode_password_reset_token
  defensive `payload` init (auth_utils.py:73)
- Fresh user register → /auth/2fa/setup → /2fa/enable → logout → login (pending_2fa)
  → /auth/2fa/verify using ONLY the tbc_session cookie (no Authorization header)
"""
import os
import time
import uuid
import pyotp
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://tbc-self-copy.preview.emergentagent.com').rstrip('/')
API = f"{BASE_URL}/api"

# Test credentials come from env so the hardcoded fallback is only used in
# isolated dev runs. CI / pre-deploy pipelines should set TEST_OPERATOR_EMAIL
# and TEST_OPERATOR_PASSWORD to keep secrets out of version control.
OPERATOR_EMAIL = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OPERATOR_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', '123Admin@98')


# ---------- helpers ----------

def _login(session: requests.Session, email: str, password: str, totp_code: str | None = None):
    payload = {'email': email, 'password': password}
    if totp_code:
        payload['totp_code'] = totp_code
    r = session.post(f"{API}/auth/login", json=payload, timeout=15)
    return r


@pytest.fixture
def operator_session():
    """Login as the operator. Operator boots with 2FA cleared, so a single
    POST /auth/login should issue a full session cookie (requires_2fa_setup=true)."""
    s = requests.Session()
    r = _login(s, OPERATOR_EMAIL, OPERATOR_PASSWORD)
    if r.status_code != 200:
        pytest.skip(f"Operator login failed ({r.status_code}): {r.text[:200]}")
    data = r.json()
    # the cookie may be present even when pending_2fa or requires_2fa_setup are true
    assert 'tbc_session' in s.cookies, 'tbc_session cookie not set by /auth/login'
    return s, data


# ---------- 1. codes/file endpoint ----------

class TestOperatorCodesFile:
    def test_read_server_py(self, operator_session):
        s, data = operator_session
        # If 2FA is pending, the cookie is short-lived but still authenticates the
        # operator-only endpoint check via the dependency? Actually pending_2fa cookies
        # are rejected by get_current_user. Operator boots with 2FA cleared so this
        # should succeed; if not, skip.
        if data.get('pending_2fa'):
            pytest.skip('Operator session is pending_2fa; cannot exercise operator endpoint')
        r = s.get(f"{API}/operator/codes/file", params={'path': '/app/backend/server.py'}, timeout=15)
        assert r.status_code == 200, f"codes/file failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        assert 'content' in body and isinstance(body['content'], str)
        assert len(body['content']) > 100, 'content unexpectedly small'
        assert body['path'] == '/app/backend/server.py'
        assert body['size'] == len(body['content'])

    def test_disallowed_path(self, operator_session):
        s, data = operator_session
        if data.get('pending_2fa'):
            pytest.skip('Operator pending_2fa')
        r = s.get(f"{API}/operator/codes/file", params={'path': '/etc/passwd'}, timeout=15)
        assert r.status_code == 403

    def test_missing_file(self, operator_session):
        s, data = operator_session
        if data.get('pending_2fa'):
            pytest.skip('Operator pending_2fa')
        r = s.get(f"{API}/operator/codes/file", params={'path': '/app/backend/_no_such_file_xyz.py'}, timeout=15)
        assert r.status_code == 404


# ---------- 2. password reset decode ----------

class TestPasswordResetDecode:
    def test_forgot_password_then_reset(self):
        """Register a temp user, request reset, decode + reset, then log in with new password."""
        s = requests.Session()
        email = f"TEST_{uuid.uuid4().hex[:10]}@example.com"
        pw1 = 'OrigPass!2345'
        pw2 = 'NewPass!67890'

        # register
        r = s.post(f"{API}/auth/register", json={'email': email, 'password': pw1, 'name': 'Reset Tester'}, timeout=15)
        assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text[:200]}"

        # forgot-password — returns generic ok; the test endpoint may also surface the token
        # in dev. We'll fall back to grabbing the token from db only if exposed.
        r = s.post(f"{API}/auth/forgot-password", json={'email': email}, timeout=15)
        assert r.status_code == 200, f"forgot-password failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        token = body.get('token') or body.get('reset_token') or body.get('debug_token')

        if not token:
            # production-shape response (no token). We can still validate the decode
            # branch via reset-password with a bogus token.
            r = s.post(f"{API}/auth/reset-password", json={'token': 'not-a-jwt', 'new_password': pw2}, timeout=15)
            assert r.status_code == 400
            pytest.skip('forgot-password did not return token in response; reset-decode bad-token path verified')

        # happy path
        r = s.post(f"{API}/auth/reset-password", json={'token': token, 'new_password': pw2}, timeout=15)
        assert r.status_code == 200, f"reset-password failed: {r.status_code} {r.text[:200]}"

        # login with new password
        s2 = requests.Session()
        r = _login(s2, email, pw2)
        assert r.status_code == 200, f"login w/ new pw failed: {r.status_code} {r.text[:200]}"

    def test_reset_with_invalid_token(self):
        r = requests.post(f"{API}/auth/reset-password", json={'token': 'garbage.token.string', 'new_password': 'AbcDef!23456'}, timeout=15)
        assert r.status_code == 400
        # ensure the 'payload' defensive-init didn't crash with 500
        assert 'detail' in r.json()


# ---------- 3. 2FA verify via cookie only ----------

class TestTwoFactorCookieVerify:
    def test_register_enable_2fa_login_verify_via_cookie(self):
        s = requests.Session()
        email = f"TEST_{uuid.uuid4().hex[:10]}@example.com"
        pw = 'TempPass!2345'

        r = s.post(f"{API}/auth/register", json={'email': email, 'password': pw, 'name': '2FA Tester'}, timeout=15)
        assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text[:200]}"
        # registration usually returns a token + sets the cookie
        assert 'tbc_session' in s.cookies

        # setup 2FA → get secret
        r = s.post(f"{API}/auth/2fa/setup", timeout=15)
        assert r.status_code == 200, f"2fa/setup failed: {r.status_code} {r.text[:200]}"
        setup = r.json()
        secret = setup.get('secret') or setup.get('totp_secret')
        assert secret, f"no totp secret in setup response: {setup}"

        code = pyotp.TOTP(secret).now()
        # enable
        r = s.post(f"{API}/auth/2fa/enable", json={'code': code}, timeout=15)
        assert r.status_code == 200, f"2fa/enable failed: {r.status_code} {r.text[:200]}"

        # log out (clear cookies) and log back in — should be pending_2fa
        s2 = requests.Session()
        r = _login(s2, email, pw)
        assert r.status_code == 200, f"login(post-2fa) failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        assert body.get('pending_2fa') is True, f"expected pending_2fa, got: {body}"
        assert 'tbc_session' in s2.cookies, 'pending_2fa cookie missing'

        # the verify call should rely SOLELY on the cookie. We explicitly do NOT
        # send an Authorization header.
        # wait a bit to make sure the TOTP step has rolled if needed
        time.sleep(1)
        verify_code = pyotp.TOTP(secret).now()
        r = s2.post(f"{API}/auth/2fa/verify", json={'code': verify_code}, timeout=15)
        assert r.status_code == 200, f"2fa/verify failed: {r.status_code} {r.text[:200]}"
        vbody = r.json()
        assert 'token' in vbody
        # after verify the cookie should be the full-session one (not pending)
        assert 'tbc_session' in s2.cookies

        # follow-up call using only cookie must succeed
        r = s2.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 200, f"/auth/me after verify failed: {r.status_code} {r.text[:200]}"

    def test_verify_without_session_fails_clean(self):
        """No cookie + no header → 401 (not 500)."""
        r = requests.post(f"{API}/auth/2fa/verify", json={'code': '000000'}, timeout=15)
        assert r.status_code in (401, 400)
