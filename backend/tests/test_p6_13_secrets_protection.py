"""P6.13 — Secrets protection tests.

Two pillars:
  1. Sandbox refuses .env / *.pem / *.key / .aws/ paths via the
     /api/operator/self/{tree,file,commit} routes — even when the
     operator allowed the parent prefix.
  2. /api/operator/secrets/reveal is operator-only, requires literal
     confirm="REVEAL", rate-limits per-operator, and returns the actual
     token values plus an audit-log row.
"""
import asyncio
import os
import time

import requests
from motor.motor_asyncio import AsyncIOMotorClient

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv('/app/backend/.env')
except Exception:
    pass

BASE_URL = (
    os.environ.get('REACT_APP_BACKEND_URL')
    or open('/app/frontend/.env').read().split('REACT_APP_BACKEND_URL=')[1].split('\n')[0].strip()
).rstrip('/')

from tests._creds import OP_EMAIL, OP_PASSWORD  # centralised — see /app/backend/tests/_creds.py


def _login() -> requests.Session:
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    s.headers.update({'Authorization': f'Bearer {r.json().get("token")}'})
    return s


# --- Sandbox lockdown ---------------------------------------------------
def test_sandbox_blocks_dotenv_paths():
    s = _login()
    for path in [
        'backend/.env',
        'frontend/.env',
        '.env',
        '.env.local',
        '.env.production',
        'backend/secrets.json',
        'id_rsa',
        'config/cert.pem',
        '.aws/credentials',
    ]:
        r = s.get(f'{BASE_URL}/api/operator/self/file', params={'path': path})
        assert r.status_code in (403, 503), f'{path} returned {r.status_code} (body: {r.text[:200]})'
        if r.status_code == 403:
            assert 'secrets' in r.text.lower() or 'block' in r.text.lower(), r.text


def test_sandbox_commit_rejects_secret_paths():
    s = _login()
    # The write endpoint is PUT /api/operator/self/file (not /commit).
    r = s.put(f'{BASE_URL}/api/operator/self/file', json={
        'path': 'backend/.env',
        'content': 'STRIPE_KEY=stolen',
        'message': 'tries to commit a secret',
    })
    # 403 (denylist hit) is the desired outcome; 503 (no github_token
    # configured in preview) also proves the secret-file path never
    # reached the github API.
    assert r.status_code in (403, 503), r.text


# --- Reveal endpoint ----------------------------------------------------
def test_reveal_requires_auth():
    r = requests.post(f'{BASE_URL}/api/operator/secrets/reveal', json={'confirm': 'REVEAL'})
    assert r.status_code in (401, 403), r.text


def test_reveal_requires_confirm_word():
    s = _login()
    for bad in [{}, {'confirm': ''}, {'confirm': 'reveal'}, {'confirm': 'YES'}]:
        r = s.post(f'{BASE_URL}/api/operator/secrets/reveal', json=bad)
        assert r.status_code == 400, f'{bad} returned {r.status_code}'


def test_reveal_returns_full_values_and_audit_row():
    s = _login()
    # Wait out any previous reveal's cooldown so the test isn't flaky.
    time.sleep(31)
    r = s.post(f'{BASE_URL}/api/operator/secrets/reveal', json={'confirm': 'REVEAL'})
    assert r.status_code == 200, r.text
    body = r.json()
    assert 'values' in body and 'count_configured' in body
    assert isinstance(body['values'], dict)
    # The shape includes every known secret key (value may be None when
    # the operator hasn't configured that integration yet).
    for k in ('vercel_token', 'github_token', 'stripe_secret_key',
              'nowpayments_api_key', 'ai_api_key'):
        assert k in body['values']

    # Verify an audit log row landed.
    async def _check_audit():
        client = AsyncIOMotorClient(os.environ['MONGO_URL'])
        try:
            row = await client[os.environ['DB_NAME']].audit_log.find_one(
                {'action': 'secrets.reveal'},
                sort=[('created_at', -1)],
            )
            return row is not None and OP_EMAIL in (row.get('actor_email') or '')
        finally:
            client.close()
    assert asyncio.run(_check_audit()), 'No audit row for secrets.reveal'


def test_reveal_is_rate_limited_per_operator():
    s = _login()
    # First call should succeed (assuming we're past the cooldown from
    # previous tests). Second immediate call must 429.
    time.sleep(31)
    r1 = s.post(f'{BASE_URL}/api/operator/secrets/reveal', json={'confirm': 'REVEAL'})
    assert r1.status_code == 200, r1.text
    r2 = s.post(f'{BASE_URL}/api/operator/secrets/reveal', json={'confirm': 'REVEAL'})
    assert r2.status_code == 429, r2.text
    assert 'rate-limited' in r2.text.lower()


def test_inventory_is_safe_to_poll_and_never_returns_full_values():
    s = _login()
    r = s.get(f'{BASE_URL}/api/operator/secrets/inventory')
    assert r.status_code == 200, r.text
    body = r.json()
    assert 'present' in body and 'previews' in body
    # Previews must always be masked or null — no raw secret leaks here.
    for k, preview in body['previews'].items():
        if preview is not None:
            assert ('…' in preview or '••••' == preview), f'{k} preview not masked: {preview!r}'
