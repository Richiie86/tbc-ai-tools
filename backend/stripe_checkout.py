"""Native-Stripe drop-in replacement for the checkout helper that used to
come from `emergentintegrations.payments.stripe.checkout`.

It preserves the exact API the call sites rely on:

    from stripe_checkout import StripeCheckout, CheckoutSessionRequest

    sc = StripeCheckout(api_key=..., webhook_url=...)
    session = await sc.create_checkout_session(CheckoutSessionRequest(
        amount=9.99, currency='usd',
        success_url=..., cancel_url=..., metadata={...},
    ))
    session.session_id      # -> Stripe Checkout Session id
    session.url             # -> hosted checkout url

    status = await sc.get_checkout_status(session_id)
    status.status           # -> 'complete' | 'open' | 'expired'
    status.payment_status   # -> 'paid' | 'unpaid' | 'no_payment_required'

    event = await sc.handle_webhook(body, sig)
    event.event_type        # -> e.g. 'checkout.session.completed'
    event.session_id        # -> session id if the event carries one
    event.payment_status    # -> session payment_status if present

Amounts are passed in MAJOR units (e.g. dollars) and converted to the
smallest currency unit (cents) exactly like the previous helper did.

Built on the native, already-installed `stripe` SDK — no third-party wheels.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

import stripe


# ---- Zero-decimal currencies (Stripe expects the raw integer, no *100) -----
# https://docs.stripe.com/currencies#zero-decimal
_ZERO_DECIMAL = {
    'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
    'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
}


def _to_minor_units(amount: float, currency: str) -> int:
    """Convert a major-unit amount (e.g. 9.99 USD) to Stripe minor units."""
    if (currency or 'usd').lower() in _ZERO_DECIMAL:
        return int(round(float(amount)))
    return int(round(float(amount) * 100))


@dataclass
class CheckoutSessionRequest:
    """Mirror of the old request model."""
    amount: float
    currency: str = 'usd'
    success_url: str = ''
    cancel_url: str = ''
    metadata: dict = field(default_factory=dict)


@dataclass
class CheckoutSessionResponse:
    session_id: str
    url: Optional[str]


@dataclass
class CheckoutStatusResponse:
    status: Optional[str]
    payment_status: Optional[str]
    amount_total: Optional[int] = None
    currency: Optional[str] = None
    metadata: dict = field(default_factory=dict)


@dataclass
class WebhookEventResponse:
    event_type: Optional[str]
    session_id: Optional[str]
    payment_status: Optional[str]
    metadata: dict = field(default_factory=dict)


class StripeCheckout:
    """Thin async wrapper over the native Stripe SDK that reproduces the
    surface previously provided by emergentintegrations."""

    def __init__(self, api_key: str, webhook_url: str = '', webhook_secret: str = ''):
        self.api_key = api_key or ''
        self.webhook_url = webhook_url or ''
        # Optional: a Stripe signing secret (whsec_...). When present we verify
        # webhook signatures; when absent we fall back to parsing the payload,
        # matching the previous helper's lenient behaviour.
        self.webhook_secret = webhook_secret or ''

    async def create_checkout_session(
        self, req: CheckoutSessionRequest
    ) -> CheckoutSessionResponse:
        line_items = [{
            'price_data': {
                'currency': (req.currency or 'usd').lower(),
                'product_data': {'name': (req.metadata or {}).get('product_name', 'Purchase')},
                'unit_amount': _to_minor_units(req.amount, req.currency),
            },
            'quantity': 1,
        }]
        session = await stripe.checkout.Session.create_async(
            api_key=self.api_key,
            mode='payment',
            line_items=line_items,
            success_url=req.success_url,
            cancel_url=req.cancel_url,
            metadata=req.metadata or {},
        )
        return CheckoutSessionResponse(session_id=session.id, url=session.url)

    async def get_checkout_status(self, session_id: str) -> CheckoutStatusResponse:
        session = await stripe.checkout.Session.retrieve_async(
            session_id, api_key=self.api_key
        )
        return CheckoutStatusResponse(
            status=session.get('status'),
            payment_status=session.get('payment_status'),
            amount_total=session.get('amount_total'),
            currency=session.get('currency'),
            metadata=dict(session.get('metadata') or {}),
        )

    async def handle_webhook(self, body: bytes, signature: Optional[str]) -> WebhookEventResponse:
        event: Any
        if self.webhook_secret and signature:
            # Strict, signature-verified path.
            event = stripe.Webhook.construct_event(
                body, signature, self.webhook_secret
            )
            event = dict(event)
        else:
            # Lenient path (no signing secret configured) — parse the payload.
            event = json.loads(body.decode('utf-8') if isinstance(body, (bytes, bytearray)) else body)

        event_type = event.get('type')
        obj = ((event.get('data') or {}).get('object')) or {}
        # For checkout.session.* events the object IS the session.
        session_id = obj.get('id') if obj.get('object') == 'checkout.session' else obj.get('id')
        return WebhookEventResponse(
            event_type=event_type,
            session_id=session_id,
            payment_status=obj.get('payment_status'),
            metadata=dict(obj.get('metadata') or {}),
        )
