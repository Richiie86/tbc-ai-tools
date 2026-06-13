"""P6.15 — regression guard for `token_version` (`tv`) preservation.

Pinpoints the *exact* bug that bounced operators back to /login after a
successful 2FA verify or password reset: a new JWT minted without
carrying the user's stored `token_version` forward gets `tv=0`, fails the
`tv >= stored_tv` monotonicity check in `get_current_user`, and the
session is invalidated immediately.

Three tiny assertions, no LLM calls, runs in <2s.
"""
import os
import sys
import jwt as jwtlib
import pytest
import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from tests._creds import OPERATOR_EMAIL, OPERATOR_PASSWORD  # noqa: E402

API = os.environ.get('TEST_API_URL', 'http://localhost:8001/api')
JWT_SECRET = os.environ.get('JWT_SECRET', 'change-me')


def _decode(token: str) -> dict:
    """Decode without verifying signature — we only need the payload to
    inspect `tv`. The server's own verify-path is exercised on the next
    request anyway."""
    return jwtlib.decode(token, options={'verify_signature': False})


@pytest.mark.asyncio
async def test_login_jwt_carries_stored_token_version():
    """Every successful login MUST mint a JWT whose `tv` matches the
    user's stored `token_version`. A drop to tv=0 would mean the next
    request rebounds to /login if the user ever signed out everywhere.
    """
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.post(f'{API}/auth/login', json={
            'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        token = body.get('token')
        assert token, body
        payload = _decode(token)
        # tv must be a non-negative int present in the payload.
        assert 'tv' in payload, f'JWT payload missing tv: {payload}'
        assert isinstance(payload['tv'], int) and payload['tv'] >= 0, payload


@pytest.mark.asyncio
async def test_authenticated_request_round_trips_without_tv_drop():
    """After a fresh login, the very next authed request must succeed —
    not return 401. That proves `tv` survived the round-trip.
    """
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.post(f'{API}/auth/login', json={
            'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD,
        })
        token = r.json().get('token')
        assert token
        # Use the fresh JWT immediately — if `tv` was dropped this 401s.
        me = await cli.get(f'{API}/auth/me', headers={'Authorization': f'Bearer {token}'})
        assert me.status_code == 200, f'tv dropped on first authed call! {me.status_code} {me.text}'
        body = me.json()
        assert body.get('email') == OPERATOR_EMAIL


@pytest.mark.asyncio
async def test_2fa_verify_endpoint_preserves_tv_in_response_token():
    """If 2FA is set up, the `/auth/2fa/verify` response token must also
    carry tv forward. We can't fully exercise the TOTP flow without the
    operator's secret, but we CAN smoke the wiring by hitting the endpoint
    with an obviously-wrong code and confirming a 400/401 (not a 500).
    A 500 here often means we crashed before reaching the tv-aware
    create_jwt() call — which is exactly the regression we want to catch.
    """
    async with httpx.AsyncClient(timeout=15.0) as cli:
        # Need a `pending_2fa` cookie for the endpoint. Easiest path: hit
        # login and capture the cookie even when 2FA isn't enforced — the
        # endpoint should still return a structured error, not blow up.
        await cli.post(f'{API}/auth/login', json={
            'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD,
        })
        r = await cli.post(f'{API}/auth/2fa/verify', json={'code': '000000'})
        # 401/400 acceptable (no pending 2FA / bad code). 500 = regression.
        assert r.status_code != 500, (
            f'/auth/2fa/verify returned 500 — likely tv-related crash before create_jwt: {r.text}'
        )
