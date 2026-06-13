"""
P6 Session features regression — new endpoints added in this batch:

(a) POST /api/operator/plans/discount-campaign — % off + clear
(b) GET  /api/marketing/banner (public) + PUT /api/operator/marketing/banner
(c) GET/PUT /api/operator/deploy/{project_id}/settings — admin email/pw/env
(d) /api/operator/deploy/key includes github_token presence
(e) Notifications API — operator DM/broadcast/2fa-reminder + user list/read/delete
(f) POST /api/operator/users/{user_id}/credits accepts negative amounts
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://tbc-self-copy.preview.emergentagent.com').rstrip('/')
API = f"{BASE_URL}/api"

OPERATOR_EMAIL = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OPERATOR_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', '123Admin@98')


def _login(session, email, password, totp_code=None):
    payload = {'email': email, 'password': password}
    if totp_code:
        payload['totp_code'] = totp_code
    return session.post(f"{API}/auth/login", json=payload, timeout=15)


@pytest.fixture(scope='module')
def op():
    s = requests.Session()
    r = _login(s, OPERATOR_EMAIL, OPERATOR_PASSWORD)
    if r.status_code != 200:
        pytest.skip(f"Operator login failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    if data.get('pending_2fa'):
        pytest.skip("Operator pending_2fa — TOTP enabled. Clear via RESET_OPERATOR_2FA=true.")
    assert 'tbc_session' in s.cookies
    return s


@pytest.fixture(scope='module')
def fresh_user():
    """Register a fresh user and return (session, user_dict)."""
    s = requests.Session()
    email = f"TEST_p6_{uuid.uuid4().hex[:8]}@test.com"
    pw = 'TestPass123!@'
    r = s.post(f"{API}/auth/register", json={'email': email, 'password': pw, 'name': 'P6 Test'}, timeout=15)
    if r.status_code not in (200, 201):
        pytest.skip(f"Register failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    user = data.get('user') or {}
    return s, user, email, pw


# ===================================================================
# (a) Discount campaign
# ===================================================================
class TestDiscountCampaign:
    def test_apply_and_clear(self, op):
        # snapshot current plans
        r = op.get(f"{API}/operator/plans", timeout=15)
        assert r.status_code == 200, r.text
        before = {p['id']: p for p in r.json()}
        assert before, "No plans to test against"

        # Apply 25% off
        r = op.post(f"{API}/operator/plans/discount-campaign", json={'percent': 25}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get('success') is True
        assert body.get('updated', 0) >= 1

        # GET plans → price should be round(regular*0.75, 2), intro=True
        r2 = op.get(f"{API}/operator/plans", timeout=15)
        assert r2.status_code == 200
        after = {p['id']: p for p in r2.json()}
        for pid, p in after.items():
            reg = float(p.get('regular_price') or 0)
            if reg <= 0:
                continue
            expected = round(reg * 0.75, 2)
            assert abs(float(p['price']) - expected) < 0.01, f"Plan {pid}: price {p['price']} != expected {expected}"
            assert p.get('intro') is True, f"Plan {pid}: intro flag not set"

        # Clear
        r = op.post(f"{API}/operator/plans/discount-campaign", json={'clear': True}, timeout=15)
        assert r.status_code == 200
        r3 = op.get(f"{API}/operator/plans", timeout=15)
        cleared = {p['id']: p for p in r3.json()}
        for pid, p in cleared.items():
            reg = float(p.get('regular_price') or 0)
            if reg <= 0:
                continue
            assert abs(float(p['price']) - reg) < 0.01, f"Plan {pid}: not restored ({p['price']} vs {reg})"
            assert p.get('intro') is False, f"Plan {pid}: intro flag not cleared"


# ===================================================================
# (b) Marketing banner
# ===================================================================
class TestMarketingBanner:
    def test_public_get(self):
        r = requests.get(f"{API}/marketing/banner", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ('enabled', 'messages', 'speed_seconds'):
            assert k in body

    def test_operator_put_and_speed_clamp(self, op):
        payload = {
            'enabled': True,
            'messages': [{'text': 'TEST_P6 Promo', 'href': '/pricing'}, {'text': 'TEST_P6 No href'}],
            'speed_seconds': 9999,  # should clamp to 300
            'starts_at': None,
            'ends_at': None,
        }
        r = op.put(f"{API}/operator/marketing/banner", json=payload, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get('success') is True
        assert r.json().get('messages_count') == 2

        # GET public — clamp + persistence
        r2 = requests.get(f"{API}/marketing/banner", timeout=15)
        body = r2.json()
        assert body['enabled'] is True
        assert body['speed_seconds'] == 300.0, f"Speed not clamped: {body['speed_seconds']}"
        texts = [m['text'] for m in body['messages']]
        assert 'TEST_P6 Promo' in texts and 'TEST_P6 No href' in texts

        # cleanup — disable
        op.put(f"{API}/operator/marketing/banner", json={'enabled': False, 'messages': [], 'speed_seconds': 30}, timeout=15)


# ===================================================================
# (c) Per-project settings
# ===================================================================
class TestProjectSettings:
    def _get_project_id(self, op):
        r = op.get(f"{API}/operator/deploy/projects", timeout=15)
        if r.status_code != 200:
            pytest.skip(f"Cannot list projects: {r.status_code}")
        items = r.json() if isinstance(r.json(), list) else r.json().get('items', [])
        if not items:
            pytest.skip("No deploy projects to test")
        return items[0]['id']

    def test_get_settings_shape(self, op):
        pid = self._get_project_id(op)
        r = op.get(f"{API}/operator/deploy/{pid}/settings", timeout=15)
        assert r.status_code == 200, r.text
        b = r.json()
        assert 'admin_email' in b
        assert 'admin_password_set' in b
        assert isinstance(b.get('env_vars'), list)

    def test_put_settings_env_var_lifecycle(self, op):
        pid = self._get_project_id(op)
        # Set admin_email + a TEST env var
        new_email = f"TEST_p6_admin_{uuid.uuid4().hex[:6]}@test.com"
        r = op.put(f"{API}/operator/deploy/{pid}/settings", json={
            'admin_email': new_email,
            'admin_password': 'NewPw_TEST_p6!',
            'env_vars': {'TEST_P6_VAR': 'shhhh_secret_value'},
        }, timeout=15)
        assert r.status_code == 200, r.text
        b = r.json()
        assert b['admin_email'] == new_email
        assert b['admin_password_set'] is True
        keys = [e['key'] for e in b['env_vars']]
        assert 'TEST_P6_VAR' in keys
        masked = next(e for e in b['env_vars'] if e['key'] == 'TEST_P6_VAR')
        assert masked['present'] is True
        assert masked.get('masked') and 'shhhh_secret_value' not in masked['masked'], "secret leaked in masked"

        # Rotate
        r = op.put(f"{API}/operator/deploy/{pid}/settings", json={
            'env_vars': {'TEST_P6_VAR': 'new_value_2'},
        }, timeout=15)
        assert r.status_code == 200
        masked2 = next(e for e in r.json()['env_vars'] if e['key'] == 'TEST_P6_VAR')
        assert masked2['masked'] != masked['masked']

        # Delete via empty string
        r = op.put(f"{API}/operator/deploy/{pid}/settings", json={
            'env_vars': {'TEST_P6_VAR': ''},
        }, timeout=15)
        assert r.status_code == 200
        keys2 = [e['key'] for e in r.json()['env_vars']]
        assert 'TEST_P6_VAR' not in keys2, "Env var not deleted by empty string"


# ===================================================================
# (d) Settings include github_token
# ===================================================================
class TestDeployKey:
    def test_key_endpoint_has_github_token_field(self, op):
        r = op.get(f"{API}/operator/deploy/key", timeout=15)
        assert r.status_code == 200, r.text
        b = r.json()
        assert 'has_github_token' in b, f"missing has_github_token in {b.keys()}"
        assert isinstance(b['has_github_token'], bool)


# ===================================================================
# (e) Notifications API
# ===================================================================
class TestNotifications:
    def test_audiences(self, op):
        r = op.get(f"{API}/operator/notify/audiences", timeout=15)
        assert r.status_code == 200, r.text
        b = r.json()
        for k in ('total_users', 'no_2fa', 'paid'):
            assert k in b and isinstance(b[k], int)

    def test_user_list_empty_for_fresh(self, fresh_user):
        s, _, _, _ = fresh_user
        r = s.get(f"{API}/notifications", timeout=15)
        assert r.status_code == 200, r.text
        b = r.json()
        assert 'items' in b
        assert 'unread_count' in b

    def test_dm_single_user_and_user_reads(self, op, fresh_user):
        s, user, email, _ = fresh_user
        uid = user.get('id')
        assert uid, "fresh user has no id"
        subj = f"TEST_P6 DM {uuid.uuid4().hex[:6]}"
        r = op.post(f"{API}/operator/users/{uid}/notify", json={
            'subject': subj, 'body': 'hello from p6 tests', 'kind': 'dm',
        }, timeout=15)
        assert r.status_code == 200, r.text
        notif_id = r.json().get('id')
        assert notif_id

        # User can see it
        r2 = s.get(f"{API}/notifications", timeout=15)
        items = r2.json()['items']
        subs = [i['subject'] for i in items]
        assert subj in subs
        assert r2.json()['unread_count'] >= 1

        # Mark read
        r3 = s.post(f"{API}/notifications/{notif_id}/read", timeout=15)
        assert r3.status_code == 200
        assert r3.json().get('updated') == 1

        # Re-read shouldn't update
        r4 = s.post(f"{API}/notifications/{notif_id}/read", timeout=15)
        assert r4.json().get('updated') == 0

        # Delete
        r5 = s.delete(f"{API}/notifications/{notif_id}", timeout=15)
        assert r5.status_code == 200

        # Confirm gone
        r6 = s.get(f"{API}/notifications", timeout=15)
        subs2 = [i['subject'] for i in r6.json()['items']]
        assert subj not in subs2

    def test_2fa_reminder_idempotent_and_creates_fresh(self, op, fresh_user):
        s, _, _, _ = fresh_user
        # First send
        r1 = op.post(f"{API}/operator/notify/2fa-reminder", json={
            'subject': 'TEST_P6 2FA reminder one',
            'body': 'turn on 2fa please',
        }, timeout=15)
        assert r1.status_code == 200, r1.text
        sent1 = r1.json().get('sent')
        assert sent1 >= 1, f"Expected at least 1 send, got {sent1}"

        # Second send — fresh batch, not idempotent suppression
        r2 = op.post(f"{API}/operator/notify/2fa-reminder", json={
            'subject': 'TEST_P6 2FA reminder two',
            'body': 'still no 2fa',
        }, timeout=15)
        assert r2.status_code == 200
        assert r2.json().get('sent') >= 1

        # Fresh user should see both 2fa_reminder kinds
        r3 = s.get(f"{API}/notifications", timeout=15)
        kinds = [i.get('kind') for i in r3.json()['items'] if i.get('subject', '').startswith('TEST_P6 2FA reminder')]
        assert kinds.count('2fa_reminder') >= 2, f"Expected 2 fresh reminders, got {kinds}"

        # cleanup — mark all read
        s.post(f"{API}/notifications/read-all", timeout=15)

    def test_broadcast_only_no_2fa_filter(self, op):
        # Audience count
        r0 = op.get(f"{API}/operator/notify/audiences", timeout=15)
        no_2fa = r0.json()['no_2fa']

        r = op.post(f"{API}/operator/notify/broadcast", json={
            'subject': 'TEST_P6 Broadcast',
            'body': 'hi everyone',
            'kind': 'broadcast',
            'only_no_2fa': True,
        }, timeout=15)
        assert r.status_code == 200, r.text
        sent = r.json().get('sent', 0)
        # sent should be <= no_2fa count (no_2fa is users only; broadcast may also include operator)
        assert sent <= no_2fa + 5, f"Broadcast sent {sent} > no_2fa {no_2fa}"

    def test_read_all(self, fresh_user, op):
        s, user, _, _ = fresh_user
        uid = user.get('id')
        # Send 2 DMs
        for i in range(2):
            op.post(f"{API}/operator/users/{uid}/notify", json={
                'subject': f'TEST_P6 readall {i}', 'body': 'b', 'kind': 'dm',
            }, timeout=15)
        r = s.post(f"{API}/notifications/read-all", timeout=15)
        assert r.status_code == 200
        r2 = s.get(f"{API}/notifications", timeout=15)
        assert r2.json()['unread_count'] == 0

    def test_delete_others_notification_forbidden(self, op, fresh_user):
        # Send DM to fresh user
        s, user, _, _ = fresh_user
        uid = user.get('id')
        r = op.post(f"{API}/operator/users/{uid}/notify", json={
            'subject': 'TEST_P6 cross-user', 'body': 'x', 'kind': 'dm',
        }, timeout=15)
        notif_id = r.json()['id']
        # Operator tries to DELETE — should 404 (not their notification)
        r2 = op.delete(f"{API}/notifications/{notif_id}", timeout=15)
        assert r2.status_code == 404, f"Cross-user delete should 404, got {r2.status_code}"
        # Fresh user can still see + delete
        r3 = s.delete(f"{API}/notifications/{notif_id}", timeout=15)
        assert r3.status_code == 200


# ===================================================================
# (f) Credits adjuster — supports negative amounts
# ===================================================================
class TestCreditsAdjuster:
    def test_add_and_deduct(self, op, fresh_user):
        _, user, _, _ = fresh_user
        uid = user.get('id')

        # GET initial balance
        r = op.get(f"{API}/operator/users", timeout=15)
        # try to find user
        users = r.json() if isinstance(r.json(), list) else r.json().get('items', [])
        initial = next((u.get('credits', 0) for u in users if u.get('id') == uid), None)
        if initial is None:
            pytest.skip("Could not look up initial credits")

        # Add 500
        r = op.post(f"{API}/operator/users/{uid}/credits?amount=500", timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get('success') is True

        # Deduct 100
        r2 = op.post(f"{API}/operator/users/{uid}/credits?amount=-100", timeout=15)
        assert r2.status_code == 200, r2.text

        # Verify net = initial + 400
        r3 = op.get(f"{API}/operator/users", timeout=15)
        u3 = r3.json() if isinstance(r3.json(), list) else r3.json().get('items', [])
        final = next((u.get('credits', 0) for u in u3 if u.get('id') == uid), None)
        assert final == initial + 400, f"Expected {initial+400}, got {final}"
