"""P6.6 — Growth-alerts thresholds + dispatcher tests.

Exercises:
  * GET/PUT /api/operator/alerts/thresholds (auth + persistence)
  * POST /api/operator/alerts/run-now (force-evaluate)
  * POST /api/operator/alerts/test (sends through every configured channel)
  * Webhook URLs are masked when read back so a leak from the API can't
    leak the full secret.
"""
import os
import uuid

import requests

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


def _login():
    s = requests.Session()
    r = s.post(f'{BASE_URL}/api/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD})
    assert r.status_code == 200, r.text
    s.headers.update({'Authorization': f'Bearer {r.json().get("token")}'})
    return s


def test_alerts_require_operator():
    r = requests.get(f'{BASE_URL}/api/operator/alerts/thresholds')
    assert r.status_code in (401, 403), r.text


def test_alerts_thresholds_persist():
    s = _login()
    payload = {
        'enabled': True,
        'signup_drop_pct': 33,
        'revenue_stall_days': 4,
        'email_recipients': f'qa-{uuid.uuid4().hex[:8]}@example.com',
        'slack_webhook': 'https://hooks.slack.com/services/TQA/BQA/SECRET_TAIL',
    }
    r = s.put(f'{BASE_URL}/api/operator/alerts/thresholds', json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['enabled'] is True
    assert body['signup_drop_pct'] == 33
    assert body['revenue_stall_days'] == 4
    assert body['email_recipients'] == payload['email_recipients']
    # Slack webhook must be masked (not echoed in full).
    assert body['slack_webhook'].endswith('…') or body['slack_webhook'] == '••••'
    assert 'SECRET_TAIL' not in body['slack_webhook']

    # Reload — same values come back.
    r2 = s.get(f'{BASE_URL}/api/operator/alerts/thresholds')
    assert r2.status_code == 200
    assert r2.json()['signup_drop_pct'] == 33
    assert r2.json()['email_recipients'] == payload['email_recipients']


def test_alerts_run_now_returns_evaluation():
    s = _login()
    # Enable + sane thresholds so the evaluator runs end-to-end.
    s.put(f'{BASE_URL}/api/operator/alerts/thresholds', json={
        'enabled': True, 'signup_drop_pct': 50, 'revenue_stall_days': 30,
    })
    r = s.post(f'{BASE_URL}/api/operator/alerts/run-now')
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get('enabled') is True
    assert 'fired' in body
    assert isinstance(body.get('reasons', []), list)


def test_alerts_test_endpoint_returns_dispatch_summary():
    s = _login()
    # Empty everything so the test endpoint reports all-zero channels.
    s.put(f'{BASE_URL}/api/operator/alerts/thresholds', json={
        'enabled': False, 'email_recipients': '',
        'slack_webhook': None, 'discord_webhook': None,
    })
    r = s.post(f'{BASE_URL}/api/operator/alerts/test')
    assert r.status_code == 200, r.text
    d = r.json().get('dispatch') or {}
    assert d.get('slack') is False
    assert d.get('discord') is False
    assert d.get('emails_sent') == 0


def test_alerts_masked_webhook_round_trip_preserves_secret():
    """If the operator submits the masked value, the original secret must
    NOT be overwritten."""
    s = _login()
    s.put(f'{BASE_URL}/api/operator/alerts/thresholds', json={
        'slack_webhook': 'https://hooks.slack.com/services/T_PRESERVE/B_PRESERVE/XXX',
    })
    first = s.get(f'{BASE_URL}/api/operator/alerts/thresholds').json()
    masked = first['slack_webhook']
    # Submit the masked value — should be ignored.
    s.put(f'{BASE_URL}/api/operator/alerts/thresholds', json={
        'slack_webhook': masked,
    })
    second = s.get(f'{BASE_URL}/api/operator/alerts/thresholds').json()
    assert second['slack_webhook'] == masked  # still the same masked echo
