"""iter19 — App settings (banner + lockdown) + runtime-errors throttle bugfix tests.

Covers:
- Public /api/app/announcement (no auth, no lockdown leak)
- Operator GET/PATCH /api/operator/app-settings (partial bodies, empty body, banner_text trim/default/maxlen)
- Login lockdown gate (non-operator -> 503; operator -> 200; invalid creds -> 401 even when locked)
- Register lockdown gate (-> 503 with message)
- runtime_errors_ext._maybe_page_operator: throttle row inserted FIRST (iter18 fix)
"""
import os
import time
import uuid
from typing import Optional

import pytest
import requests
import bcrypt
import pymongo


from tests._creds import OPERATOR_EMAIL, OPERATOR_PASSWORD, require_operator_creds

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://tbc-self-copy.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
# Credentials come from env vars (see tests/_creds.py) — no secrets in source.
OPERATOR_PASS = OPERATOR_PASSWORD

# Direct DB access for seeding/cleanup
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
_client = pymongo.MongoClient(MONGO_URL)
db = _client[DB_NAME]


# ---------- helpers ----------

def _operator_token() -> str:
    require_operator_creds()
    r = requests.post(f"{API}/auth/login", json={"email": OPERATOR_EMAIL, "password": OPERATOR_PASS}, timeout=20)
    assert r.status_code == 200, f"operator login failed: {r.status_code} {r.text}"
    body = r.json()
    tok = body.get("token")
    assert tok, f"no token in operator login response: {body}"
    return tok


@pytest.fixture(scope="module")
def op_headers():
    return {"Authorization": f"Bearer {_operator_token()}", "Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def _reset_settings_after_each(op_headers):
    """Ensure clean state both before and after each test."""
    requests.patch(f"{API}/operator/app-settings",
                   headers=op_headers,
                   json={"banner_enabled": False, "login_lockdown_enabled": False},
                   timeout=20)
    yield
    requests.patch(f"{API}/operator/app-settings",
                   headers=op_headers,
                   json={"banner_enabled": False, "login_lockdown_enabled": False},
                   timeout=20)


# ---------- public announcement ----------

class TestPublicAnnouncement:
    def test_public_no_auth_returns_only_banner_fields(self):
        r = requests.get(f"{API}/app/announcement", timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "banner_enabled" in data and isinstance(data["banner_enabled"], bool)
        assert "banner_text" in data and isinstance(data["banner_text"], str)
        # MUST NOT leak lockdown state
        assert "login_lockdown_enabled" not in data


# ---------- operator GET/PATCH ----------

class TestOperatorAppSettings:
    def test_op_get_returns_all_three_fields(self, op_headers):
        r = requests.get(f"{API}/operator/app-settings", headers=op_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("banner_enabled", "banner_text", "login_lockdown_enabled"):
            assert k in data, f"missing key: {k}"

    def test_partial_patch_only_flips_provided_field(self, op_headers):
        # Set baseline: banner_enabled=False, login_lockdown_enabled=False
        # Then PATCH only banner_enabled=true
        r = requests.patch(f"{API}/operator/app-settings",
                           headers=op_headers, json={"banner_enabled": True}, timeout=20)
        assert r.status_code == 200, r.text
        get_r = requests.get(f"{API}/operator/app-settings", headers=op_headers, timeout=20)
        data = get_r.json()
        assert data["banner_enabled"] is True
        assert data["login_lockdown_enabled"] is False  # unchanged

    def test_empty_patch_returns_state_without_mutating(self, op_headers):
        # Set baseline first
        requests.patch(f"{API}/operator/app-settings", headers=op_headers,
                       json={"banner_enabled": True}, timeout=20)
        before = requests.get(f"{API}/operator/app-settings", headers=op_headers, timeout=20).json()
        r = requests.patch(f"{API}/operator/app-settings", headers=op_headers, json={}, timeout=20)
        assert r.status_code == 200, r.text
        after = r.json()
        assert before == after

    def test_banner_text_empty_falls_back_to_default(self, op_headers):
        r = requests.patch(f"{API}/operator/app-settings",
                           headers=op_headers, json={"banner_text": "   "}, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data["banner_text"] == "OBS! This application is only for personal use!"

    def test_banner_text_over_2000_rejected_by_pydantic(self, op_headers):
        big = "x" * 2001
        r = requests.patch(f"{API}/operator/app-settings",
                           headers=op_headers, json={"banner_text": big}, timeout=20)
        # Pydantic max_length=2000 → 422
        assert r.status_code == 422, f"expected 422, got {r.status_code} body={r.text}"

    def test_banner_text_exactly_2000_accepted(self, op_headers):
        s = "y" * 2000
        r = requests.patch(f"{API}/operator/app-settings",
                           headers=op_headers, json={"banner_text": s}, timeout=20)
        assert r.status_code == 200, r.text
        assert r.json()["banner_text"] == s


# ---------- login + register lockdown ----------

@pytest.fixture(scope="module")
def temp_user():
    """Seed a non-operator user directly in MongoDB so we can test the
    lockdown gate without going through /register (which is also gated).
    The test fixture cleans up after the module finishes."""
    email = f"test_iter19_user_{uuid.uuid4().hex[:8]}@example.com"
    password = "Iter19Lockdown@1"
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user_doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "password_hash": pw_hash,
        "name": "iter19 lockdown test",
        "role": "user",
        "plan": "free",
        "credits": 0,
        "token_version": 0,
        "can_deploy": False,
    }
    db.users.insert_one(user_doc)
    yield {"email": email, "password": password}
    db.users.delete_one({"email": email})


class TestLockdown:
    def test_nonoperator_blocked_with_503_when_locked(self, op_headers, temp_user):
        # Enable lockdown
        requests.patch(f"{API}/operator/app-settings", headers=op_headers,
                       json={"login_lockdown_enabled": True}, timeout=20)
        r = requests.post(f"{API}/auth/login",
                          json={"email": temp_user["email"], "password": temp_user["password"]},
                          timeout=20)
        assert r.status_code == 503, f"expected 503, got {r.status_code} body={r.text}"
        assert "operator" in r.text.lower()

    def test_operator_still_allowed_when_locked(self, op_headers):
        requests.patch(f"{API}/operator/app-settings", headers=op_headers,
                       json={"login_lockdown_enabled": True}, timeout=20)
        r = requests.post(f"{API}/auth/login",
                          json={"email": OPERATOR_EMAIL, "password": OPERATOR_PASS}, timeout=20)
        assert r.status_code == 200, f"operator login should succeed during lockdown: {r.status_code} {r.text}"
        assert r.json().get("token")

    def test_invalid_creds_return_401_not_503_when_locked(self, op_headers):
        # Info-leak check: random probes shouldn't be able to detect lockdown
        requests.patch(f"{API}/operator/app-settings", headers=op_headers,
                       json={"login_lockdown_enabled": True}, timeout=20)
        r = requests.post(f"{API}/auth/login",
                          json={"email": f"nobody_{uuid.uuid4().hex[:6]}@example.com",
                                "password": "WrongPass@123"}, timeout=20)
        assert r.status_code == 401, f"expected 401 to avoid info leak, got {r.status_code}"

    def test_register_blocked_with_503_when_locked(self, op_headers):
        requests.patch(f"{API}/operator/app-settings", headers=op_headers,
                       json={"login_lockdown_enabled": True}, timeout=20)
        new_email = f"test_iter19_reg_{uuid.uuid4().hex[:8]}@example.com"
        r = requests.post(f"{API}/auth/register",
                          json={"email": new_email, "password": "Strong@1234", "name": "reg test"},
                          timeout=20)
        assert r.status_code == 503, f"expected 503, got {r.status_code} body={r.text}"
        assert "sign-up" in r.text.lower() or "disabled" in r.text.lower()
        # Cleanup just in case
        db.users.delete_one({"email": new_email})


# ---------- iter18 throttle bugfix ----------

class TestRuntimeErrorPagesThrottle:
    """Critical ingest MUST insert a throttle row into runtime_error_pages
    even when send_email fails (e.g. Resend not configured). This proves
    the iter18 fix (insert-first ordering) is in place.
    """

    SIGNATURE_HINT = "TEST_iter19: database connection lost"

    def _purge(self):
        # Strip any prior runtime_error_pages row whose signature contains our marker.
        # signature() heuristic preserves message text minus :line:col & long hashes.
        db.runtime_error_pages.delete_many({"signature": {"$regex": "TEST_iter19"}})
        db.runtime_errors.delete_many({"message": {"$regex": "TEST_iter19"}})

    def test_throttle_row_inserted_even_when_email_fails(self):
        self._purge()
        # Ingest a critical error (keyword 'database connection' → critical severity)
        r = requests.post(f"{API}/runtime-errors",
                          json={"message": self.SIGNATURE_HINT, "source": "backend"},
                          timeout=20)
        assert r.status_code == 202, f"ingest failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("severity") == "critical", f"expected critical severity, got {body}"

        # Within 5s, the throttle row must exist
        deadline = time.time() + 5
        page_row = None
        while time.time() < deadline:
            page_row = db.runtime_error_pages.find_one({"signature": {"$regex": "TEST_iter19"}})
            if page_row:
                break
            time.sleep(0.3)
        assert page_row is not None, "runtime_error_pages row was NOT inserted — iter18 throttle bug still present"

        # Second ingest: throttle row count should still be 1 (rate-limited)
        r2 = requests.post(f"{API}/runtime-errors",
                           json={"message": self.SIGNATURE_HINT, "source": "backend"},
                           timeout=20)
        assert r2.status_code == 202
        time.sleep(1.0)
        count = db.runtime_error_pages.count_documents({"signature": {"$regex": "TEST_iter19"}})
        assert count == 1, f"throttle should hold to 1 row, found {count}"
        # Cleanup
        self._purge()
