"""
P1 refactor regression tests.

Verifies the operator backend endpoints touched by the refactor still produce the
same payload shapes and status codes:
- GET  /api/operator/ops/health
- POST /api/operator/withdraw/cron
- POST /api/operator/test-connection/{provider}
- GET  /api/operator/transactions/export

The refactor was purely structural (helper extraction); behaviour must be unchanged.
"""
import os
import uuid
import pytest
import requests

_BACKEND = os.environ.get('REACT_APP_BACKEND_URL')
if not _BACKEND:
    # fall back to the .env file used by the running frontend
    try:
        with open('/app/frontend/.env') as _f:
            for _line in _f:
                if _line.startswith('REACT_APP_BACKEND_URL='):
                    _BACKEND = _line.split('=', 1)[1].strip()
                    break
    except Exception:
        pass
BASE_URL = (_BACKEND or '').rstrip('/')
API = f"{BASE_URL}/api"

OPERATOR_EMAIL = 'rac.investments.swe@gmail.com'
OPERATOR_PASSWORD = '123Admin@98'


@pytest.fixture(scope='module')
def operator_session():
    """Login as operator. Operator boots with 2FA cleared so a single login should
    return a fully authenticated session cookie."""
    s = requests.Session()
    r = s.post(f"{API}/auth/login",
               json={'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD},
               timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Operator login failed: {r.status_code} {r.text[:200]}")
    body = r.json()
    if body.get('pending_2fa'):
        pytest.skip('Operator session is pending_2fa; refactor endpoints are operator-only')
    assert 'tbc_session' in s.cookies
    return s


# ---------- ops/health ----------
class TestOpsHealth:
    def test_health_payload_shape(self, operator_session):
        r = operator_session.get(f"{API}/operator/ops/health", timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        data = r.json()
        # Top-level keys
        for k in ('generated_at', 'summary', 'commit', 'checks'):
            assert k in data, f"missing key {k}"
        # summary shape — `warning` was added in Feb 2026 to surface non-core
        # services that aren't RUNNING. `ok` boolean still mirrors `level=ok`
        # so old clients keep working.
        s = data['summary']
        assert all(k in s for k in ('total', 'passing', 'failing'))
        assert s['total'] == len(data['checks'])
        warning = s.get('warning', 0)
        assert s['passing'] + warning + s['failing'] == s['total']
        # checks shape — each must have {key, label, ok}
        keys = []
        for c in data['checks']:
            assert 'key' in c and 'ok' in c and 'label' in c, f"bad check: {c}"
            keys.append(c['key'])
        # required check categories (extracted helpers must still emit these)
        assert 'mongo' in keys, 'missing mongo check'
        assert any(k.startswith('env.') for k in keys), 'missing env.* checks'
        assert any(k.startswith('settings.') for k in keys), 'missing settings.* checks'
        assert 'payments.master_switch' in keys, 'missing master_payments check'
        assert 'frontend' in keys, 'missing frontend check'
        assert 'disk' in keys, 'missing disk check'
        assert any(k.startswith('svc.') for k in keys), 'missing svc.* checks'


# ---------- withdraw/cron ----------
class TestWithdrawCron:
    def test_cron_returns_ran_at_and_attempts(self, operator_session):
        r = operator_session.post(f"{API}/operator/withdraw/cron", timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert 'ran_at' in body
        assert 'attempts' in body
        assert isinstance(body['attempts'], list)
        # Each attempt (if any) must have provider+status
        for a in body['attempts']:
            assert 'provider' in a
            assert 'status' in a
            assert a['provider'] in ('stripe', 'nowpayments')


# ---------- test-connection ----------
class TestConnectionDispatch:
    @pytest.mark.parametrize('provider', ['paypal', 'stripe', 'resend'])
    def test_known_providers_return_ok_message(self, operator_session, provider):
        r = operator_session.post(f"{API}/operator/test-connection/{provider}", timeout=30)
        assert r.status_code == 200, f"{provider}: {r.status_code} {r.text[:200]}"
        body = r.json()
        assert 'ok' in body and isinstance(body['ok'], bool)
        assert 'message' in body and isinstance(body['message'], str)

    def test_unknown_provider_returns_400(self, operator_session):
        r = operator_session.post(f"{API}/operator/test-connection/bogus_provider",
                                  timeout=15)
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text[:200]}"
        body = r.json()
        assert 'detail' in body
        assert 'bogus_provider' in body['detail'] or 'Unknown' in body['detail']


# ---------- transactions/export ----------
class TestTransactionsExport:
    def test_export_no_data_returns_404(self, operator_session):
        # very narrow future-dated range guaranteed to be empty
        params = {'from': '2099-01-01', 'to': '2099-01-02'}
        r = operator_session.get(f"{API}/operator/transactions/export",
                                 params=params, timeout=30)
        assert r.status_code == 404, f"expected 404, got {r.status_code} {r.text[:200]}"
        body = r.json()
        assert 'detail' in body
        assert 'No transactions' in body['detail'] or 'no transactions' in body['detail'].lower()

    def test_export_invalid_date_returns_400(self, operator_session):
        params = {'from': 'not-a-date'}
        r = operator_session.get(f"{API}/operator/transactions/export",
                                 params=params, timeout=15)
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text[:200]}"
        body = r.json()
        assert 'detail' in body

    def test_export_with_data_returns_pdf(self, operator_session):
        # All-time, paid only — if the system has any paid tx, expect a PDF.
        # Otherwise we skip (cannot manufacture a paid tx from black-box).
        r = operator_session.get(f"{API}/operator/transactions/export", timeout=60)
        if r.status_code == 404:
            pytest.skip('No paid transactions in DB to exercise PDF export branch')
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        ct = r.headers.get('content-type', '')
        assert 'application/pdf' in ct, f"unexpected content-type: {ct}"
        # PDF magic bytes
        assert r.content[:4] == b'%PDF', 'response body is not a PDF'
        assert len(r.content) > 500, 'PDF unexpectedly small'



# ---------- billing/portal ----------
class TestBillingPortal:
    """Stripe Customer Portal session creation.

    We can't easily simulate a paying customer from the outside, but we *can*
    verify the endpoint exists, validates auth, validates input shape, and
    returns the documented 404 for users with no Stripe billing history.
    """

    def test_unauthenticated_rejected(self):
        r = requests.post(f"{API}/billing/portal",
                          json={'return_url': BASE_URL + '/dashboard'},
                          timeout=10)
        assert r.status_code == 401, f"unauth caller should get 401, got {r.status_code}"

    def test_operator_with_no_billing_returns_404_or_503(self, operator_session):
        # Operator account has never paid -> Stripe customer lookup returns
        # no rows -> we expect 404. If Stripe is not configured on this server
        # (CI), we accept 503 instead so the test can still pass.
        r = operator_session.post(
            f"{API}/billing/portal",
            json={'return_url': BASE_URL + '/'},
            timeout=15,
        )
        assert r.status_code in (404, 503), (
            f"expected 404 (no billing history) or 503 (no key), got {r.status_code} {r.text[:200]}"
        )
        body = r.json()
        assert 'detail' in body, 'missing detail in error body'


# ---------- Credit packs ----------
class TestCreditPacks:
    """The OutOfCreditsDialog top-up flow needs:
       (a) The three `credits_<N>` plans to exist (idempotent seed).
       (b) The public /payments/plans endpoint to NOT list them.
       (c) The operator /operator/plans endpoint to list them so the operator
           can still edit the price in the Plans tab.
    """

    def test_public_plans_excludes_credit_packs(self):
        r = requests.get(f"{API}/payments/plans", timeout=10)
        assert r.status_code == 200
        plan_ids = [p['id'] for p in r.json()]
        for pack in ('credits_100', 'credits_500', 'credits_1000'):
            assert pack not in plan_ids, f"public /plans leaked hidden pack {pack}"

    def test_operator_plans_includes_credit_packs(self, operator_session):
        r = operator_session.get(f"{API}/operator/plans", timeout=10)
        assert r.status_code == 200
        plan_ids = [p['id'] for p in r.json()]
        for pack in ('credits_100', 'credits_500', 'credits_1000'):
            assert pack in plan_ids, f"credit pack {pack} not seeded"

