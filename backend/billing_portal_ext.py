"""Stripe Customer Portal integration.

Adds a single `POST /api/billing/portal` endpoint so paid users can self-serve
invoices, swap cards, and cancel subscriptions without contacting support.

Design:
  • Look up the Stripe customer **by email**. We don't persist `customer_id` on
    the user doc because Stripe Checkout already creates one per session keyed
    on email when one doesn't exist. For users who have ever paid, the customer
    is findable.
  • If no customer is found we return 404 with a clean message — the UI hides
    the menu item for unpaid users, but a determined user calling the API
    directly gets a helpful error rather than a confusing 500.
  • We deliberately use Stripe's REST API directly (httpx) instead of pulling
    a fresh SDK; the same pattern as `_test_stripe` / `_stripe_payout`.
"""
import os
import logging
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth_utils import get_current_user
from payments_ext import get_settings_doc

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/billing', tags=['billing'])


class PortalRequest(BaseModel):
    return_url: str  # frontend page to come back to after the portal closes


async def _stripe_find_customer_by_email(api_key: str, email: str) -> str | None:
    """Returns the most-recent Stripe customer ID for `email`, or None."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            'https://api.stripe.com/v1/customers',
            params={'email': email, 'limit': 1},
            headers={'Authorization': f'Bearer {api_key}'},
        )
    if r.status_code != 200:
        # Surface upstream errors so the operator can debug from the request log.
        logger.warning('Stripe customers lookup failed for %s: %s %s',
                       email, r.status_code, r.text[:200])
        return None
    data = r.json().get('data') or []
    return data[0]['id'] if data else None


async def _stripe_create_portal_session(api_key: str, customer_id: str, return_url: str) -> str:
    payload = urlencode({'customer': customer_id, 'return_url': return_url})
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            'https://api.stripe.com/v1/billing_portal/sessions',
            content=payload,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        )
    if r.status_code != 200:
        try:
            err = r.json().get('error', {})
        except Exception:
            err = {'message': r.text[:200]}
        msg = err.get('message') or err.get('code') or 'Stripe error'
        # Common Stripe 400 is "No configuration provided" — first-time use of
        # the portal requires the operator to activate it in the dashboard.
        if 'configuration' in (msg or '').lower():
            msg = ('Stripe Customer Portal isn\'t configured yet. '
                   'In the Stripe dashboard go to Settings → Billing → Customer portal '
                   'and click "Activate test/live link" once.')
        raise HTTPException(502, f'Stripe portal: {msg}')
    return r.json()['url']


@router.post('/portal')
async def create_portal_session(
    req: PortalRequest,
    http_request: Request,
    user: dict = Depends(get_current_user),
):
    """Mint a one-time Stripe Customer Portal URL for the signed-in user."""
    settings = await get_settings_doc()
    api_key = settings.get('stripe_secret_key') or os.environ.get('STRIPE_API_KEY', '')
    if not api_key:
        raise HTTPException(503, 'Stripe is not configured on this server.')

    email = user.get('email')
    if not email:
        raise HTTPException(401, 'Not signed in')

    # Constrain the return URL to the requesting origin so a malicious caller
    # can't bounce users off the platform via the portal redirect.
    origin = str(http_request.base_url).rstrip('/')
    return_url = req.return_url or f'{origin}/dashboard'
    if not return_url.startswith(('http://', 'https://')):
        return_url = f'{origin}{return_url if return_url.startswith("/") else "/" + return_url}'

    customer_id = await _stripe_find_customer_by_email(api_key, email)
    if not customer_id:
        # User has never paid — point them at /pricing instead of opening an
        # empty portal that would just say "No billing history".
        raise HTTPException(
            404,
            'No billing history yet. Upgrade your plan first to open the Customer Portal.',
        )

    url = await _stripe_create_portal_session(api_key, customer_id, return_url)
    return {'url': url}
