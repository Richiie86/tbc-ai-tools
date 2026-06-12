"""Marketplace — operators list projects for sale ($10-$100), users buy via Stripe.

Flow:
1. GET /api/marketplace/projects — public list of for-sale projects
2. POST /api/marketplace/checkout — creates Stripe Checkout session for a project
3. Stripe webhook → marks purchase as paid + sends asset URL to buyer email
4. GET /api/marketplace/my-purchases — buyer dashboard (signed-in users)
"""
import os
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from db import db
from auth_utils import get_current_user
from email_utils import send_email
from models import MarketplacePurchase

logger = logging.getLogger('tbc.marketplace')
router = APIRouter(prefix='/api')


# ---------- Schemas ----------
class CheckoutRequest(BaseModel):
    project_id: str
    email: EmailStr  # buyer's delivery address (used even for guests)
    origin_url: str  # e.g. window.location.origin


def _public_project(p: dict) -> dict:
    """Strip internal fields before returning to the public marketplace."""
    return {
        'id': p['id'],
        'title': p.get('title'),
        'summary': p.get('summary') or (p.get('description') or '')[:160],
        'description': p.get('description'),
        'price_usd': float(p.get('price_usd') or 0),
        'tags': p.get('tags') or [],
        'cover_emoji': p.get('cover_emoji') or '📦',
        'created_at': p.get('created_at').isoformat() if isinstance(p.get('created_at'), datetime) else p.get('created_at'),
    }


@router.get('/marketplace/projects')
async def list_marketplace_projects():
    """Public — anyone can browse for-sale projects."""
    cursor = db.projects.find(
        {'is_for_sale': True, 'price_usd': {'$gte': 10, '$lte': 100}, 'asset_url': {'$ne': None}},
        {'_id': 0},
    ).sort('created_at', -1).limit(200)
    return [_public_project(p) async for p in cursor]


@router.get('/marketplace/projects/{project_id}')
async def get_marketplace_project(project_id: str):
    p = await db.projects.find_one({'id': project_id, 'is_for_sale': True})
    if not p:
        raise HTTPException(404, 'Project not found or not for sale')
    return _public_project(p)


@router.post('/marketplace/checkout')
async def marketplace_checkout(req: CheckoutRequest, request: Request):
    p = await db.projects.find_one({'id': req.project_id})
    if not p or not p.get('is_for_sale'):
        raise HTTPException(404, 'Project not for sale')
    price = float(p.get('price_usd') or 0)
    if price < 10 or price > 100:
        raise HTTPException(400, 'Project price out of allowed range ($10–$100)')
    if not p.get('asset_url'):
        raise HTTPException(400, 'Operator has not provided a download asset yet')

    # Try authenticated buyer first (optional)
    buyer_user_id: Optional[str] = None
    try:
        from auth_utils import decode_jwt
        auth = request.headers.get('authorization', '')
        if auth.lower().startswith('bearer '):
            payload = decode_jwt(auth.split(' ', 1)[1])
            buyer_user_id = payload.get('sub')
    except Exception:
        buyer_user_id = None

    # Stripe Checkout via emergentintegrations
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    stripe_key = settings.get('stripe_secret_key') or os.environ.get('STRIPE_API_KEY', '')
    if not stripe_key:
        raise HTTPException(400, 'Stripe is not configured. Ask the operator to add the Stripe secret key.')

    from emergentintegrations.payments.stripe.checkout import StripeCheckout, CheckoutSessionRequest
    sc = StripeCheckout(api_key=stripe_key, webhook_url=f'{req.origin_url.rstrip("/")}/api/webhook/stripe/marketplace')
    success_url = f'{req.origin_url.rstrip("/")}/marketplace/success?session_id={{CHECKOUT_SESSION_ID}}'
    cancel_url = f'{req.origin_url.rstrip("/")}/marketplace/{req.project_id}'
    session = await sc.create_checkout_session(CheckoutSessionRequest(
        amount=price,
        currency='usd',
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={'kind': 'marketplace', 'project_id': req.project_id, 'buyer_email': req.email},
    ))

    purchase = MarketplacePurchase(
        project_id=req.project_id,
        buyer_email=req.email,
        buyer_user_id=buyer_user_id,
        price_paid_usd=price,
        stripe_session_id=session.session_id,
    )
    await db.marketplace_purchases.insert_one(purchase.dict())
    return {'session_id': session.session_id, 'url': session.url}


@router.get('/marketplace/purchase/{session_id}')
async def marketplace_purchase_status(session_id: str):
    """Polled by the success page until Stripe confirms payment."""
    p = await db.marketplace_purchases.find_one({'stripe_session_id': session_id})
    if not p:
        raise HTTPException(404, 'Purchase not found')
    return {
        'paid': bool(p.get('paid')),
        'delivered': bool(p.get('delivered')),
        'project_id': p.get('project_id'),
    }


@router.post('/webhook/stripe/marketplace')
async def marketplace_stripe_webhook(request: Request):
    """Stripe → here on `checkout.session.completed` for marketplace purchases."""
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    stripe_key = settings.get('stripe_secret_key') or os.environ.get('STRIPE_API_KEY', '')
    if not stripe_key:
        raise HTTPException(400, 'Stripe not configured')
    from emergentintegrations.payments.stripe.checkout import StripeCheckout
    sc = StripeCheckout(api_key=stripe_key, webhook_url='')  # webhook_url unused on verify
    body = await request.body()
    sig = request.headers.get('Stripe-Signature', '')
    try:
        event = await sc.handle_webhook(body, sig)
    except Exception as e:
        logger.error('Stripe marketplace webhook verify failed: %s', e)
        raise HTTPException(400, 'Webhook verification failed')

    if event.event_type != 'checkout.session.completed':
        return {'received': True}

    session_id = event.session_id
    purchase = await db.marketplace_purchases.find_one({'stripe_session_id': session_id})
    if not purchase or purchase.get('paid'):
        return {'received': True, 'skip': True}

    project = await db.projects.find_one({'id': purchase['project_id']})
    asset_url = (project or {}).get('asset_url')

    await db.marketplace_purchases.update_one(
        {'stripe_session_id': session_id},
        {'$set': {'paid': True, 'paid_at': datetime.now(timezone.utc)}},
    )

    # Deliver via email
    try:
        html = _render_delivery_email(project, asset_url, purchase['price_paid_usd'])
        await send_email(purchase['buyer_email'], f'Your download — {project.get("title") if project else "TBC AI Tools"}', html)
        await db.marketplace_purchases.update_one(
            {'stripe_session_id': session_id},
            {'$set': {'delivered': True}},
        )
    except Exception as e:
        logger.error('Marketplace delivery email failed for %s: %s', session_id, e)
    return {'received': True}


def _render_delivery_email(project, asset_url, price):
    title = (project or {}).get('title', 'Your purchase')
    return f"""<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e7e3d6;">
<div style="max-width:560px;margin:0 auto;padding:40px 16px;">
  <div style="background:#13131a;border:1px solid #3a2c08;border-radius:14px;padding:36px;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d4a93a;font-weight:700;">TBC AI Tools · Receipt</div>
    <h1 style="margin:18px 0 6px 0;font-size:22px;color:#f4eed5;">Thank you for your purchase 🎉</h1>
    <p style="margin:6px 0 22px 0;font-size:14px;color:#a8a092;">You bought <strong style="color:#d4a93a;">{title}</strong> for <strong>${price:.2f}</strong>.</p>
    <a href="{asset_url}" style="display:inline-block;padding:13px 26px;background:linear-gradient(135deg,#d4a93a 0%,#b8902a 100%);color:#0a0a0c;text-decoration:none;font-weight:700;border-radius:10px;">Download your files →</a>
    <p style="margin:24px 0 4px 0;font-size:12px;color:#7e7768;">If the button doesn't work, copy this link:</p>
    <p style="margin:0;font-size:12px;color:#d4a93a;word-break:break-all;">{asset_url}</p>
    <p style="margin:24px 0 0 0;font-size:11px;color:#7e7768;">Keep this email — your link is permanent.</p>
  </div>
</div></body></html>"""


@router.get('/marketplace/my-purchases')
async def my_purchases(user: dict = Depends(get_current_user)):
    cursor = db.marketplace_purchases.find(
        {'$or': [{'buyer_user_id': user['sub']}, {'buyer_email': user['email']}]}
    ).sort('created_at', -1).limit(100)
    out = []
    async for p in cursor:
        proj = await db.projects.find_one({'id': p['project_id']}, {'_id': 0, 'title': 1, 'asset_url': 1, 'cover_emoji': 1})
        out.append({
            'id': p['id'],
            'project_id': p['project_id'],
            'project_title': (proj or {}).get('title'),
            'cover_emoji': (proj or {}).get('cover_emoji', '📦'),
            'price_paid_usd': p['price_paid_usd'],
            'paid': p.get('paid'),
            'delivered': p.get('delivered'),
            'asset_url': (proj or {}).get('asset_url') if p.get('paid') else None,
            'created_at': p['created_at'].isoformat() if isinstance(p.get('created_at'), datetime) else p.get('created_at'),
        })
    return out
