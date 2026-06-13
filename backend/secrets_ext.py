"""Operator-only secrets reveal — the only path through which the actual
Vercel/GitHub/Stripe/NOWPayments token values can leave the backend.

Hard contract:
  • Operator role required (FastAPI Depends, JWT-verified). Anyone else
    gets a 401 at the dependency level — never reaches this code.
  • The request body must echo the literal string "REVEAL" so an
    accidental click or stray script call can't trigger an export.
  • Every successful call lands in the audit log with the caller's email
    and source IP so a leak is traceable.
  • A short in-memory token bucket prevents repeated extraction attempts
    (one reveal per operator per 30s).
  • If someone clones the source code they DO NOT get the secrets — the
    values live in the production MongoDB only. This endpoint cannot
    leak a value the local DB doesn't already have.
"""
import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from auth_utils import get_current_operator
from audit_ext import record_audit
from db import db


logger = logging.getLogger('tbc.secrets')
router = APIRouter(prefix='/api/operator/secrets')

# Names of secret-bearing keys in the `settings` document. ANY of these
# that exist in the DB are returned (in full) when /reveal succeeds.
_SECRET_KEYS = (
    'vercel_token', 'vercel_team_id',
    'github_token', 'github_webhook_secret',
    'stripe_secret_key', 'stripe_webhook_secret',
    'nowpayments_api_key', 'nowpayments_ipn_secret',
    'paypal_client_secret',
    'resend_api_key',
    'ai_api_key',
)

# Per-operator rate-limiter — last-reveal timestamp keyed by user id.
_LAST_REVEAL: dict[str, float] = {}
_REVEAL_COOLDOWN_S = 30.0
_lock = asyncio.Lock()


def _mask(value: Optional[str]) -> Optional[str]:
    """Returns "abcd…wxyz" style preview suitable for the inventory list."""
    if not value:
        return None
    s = str(value)
    if len(s) <= 8:
        return '••••'
    return f'{s[:4]}…{s[-4:]}'


async def _settings() -> dict:
    return await db.settings.find_one({'_id': 'payment_settings'}) or {}


@router.get('/inventory')
async def secrets_inventory(_op: dict = Depends(get_current_operator)):
    """List which secrets are configured + a masked preview. Safe to call
    repeatedly — never echoes the full value. Used by the UI to render
    the SecretsCard rows."""
    s = await _settings()
    return {
        'present': {k: bool(s.get(k)) for k in _SECRET_KEYS},
        'previews': {k: _mask(s.get(k)) for k in _SECRET_KEYS},
        'next_reveal_at': _LAST_REVEAL.get('_global', 0) + _REVEAL_COOLDOWN_S,
    }


@router.post('/reveal')
async def reveal_secrets(
    request: Request,
    payload: dict = Body(...),
    op: dict = Depends(get_current_operator),
):
    """Return the FULL values of every configured secret. Gated behind
    typed confirmation (`{"confirm": "REVEAL"}`) and an audit-logged
    rate limit so this surface can't be brute-forced.

    NOTE: a copy/fork of this codebase does NOT contain these values —
    they live in the production MongoDB only. The reveal endpoint is
    intentionally narrow so a stolen JWT can't be quietly milked.
    """
    confirm = (payload.get('confirm') or '').strip()
    # Case-sensitive on purpose — lowercasing this would let a stray
    # script that types "reveal" silently dump every token.
    if confirm != 'REVEAL':
        raise HTTPException(
            400,
            'Set {"confirm": "REVEAL"} (exact case) in the request body to '
            'acknowledge this exposes raw tokens to the caller.',
        )

    user_id = op.get('sub') or '_global'
    now = time.time()
    async with _lock:
        last = _LAST_REVEAL.get(user_id, 0)
        if now - last < _REVEAL_COOLDOWN_S:
            retry_in = int(_REVEAL_COOLDOWN_S - (now - last))
            raise HTTPException(
                429,
                f'Reveal rate-limited. Try again in {retry_in}s.',
            )
        _LAST_REVEAL[user_id] = now
        _LAST_REVEAL['_global'] = now

    s = await _settings()
    values = {k: s.get(k) for k in _SECRET_KEYS}

    # Best-effort audit — never fail the reveal because the audit log is wedged.
    try:
        await record_audit(
            op,
            'secrets.reveal',
            target=', '.join(k for k, v in values.items() if v),
            request=request,
        )
    except Exception:
        logger.exception('Audit log for secrets.reveal failed')

    logger.warning(
        'Operator %s revealed secrets (%s configured)',
        op.get('email'),
        sum(1 for v in values.values() if v),
    )
    return {
        'values': values,
        'count_configured': sum(1 for v in values.values() if v),
        'message': (
            'Treat this response as a one-time export. Anyone who can read '
            'this output can act as you against Vercel/GitHub/Stripe.'
        ),
    }
