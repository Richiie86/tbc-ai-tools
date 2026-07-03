"""BYOK (Bring Your Own Keys) — a user-facing add-on.

What it does
------------
A normal user pays **1 credit per chat message**. With the BYOK add-on switched
on, their chat runs on **their own** provider API keys (Anthropic / OpenAI /
Gemini / OpenRouter), so those messages cost **0 app credits** — they pay their
provider directly. The add-on itself is a flat **50 credits / month**:

  * Activating deducts 50 credits immediately and stamps `byok_next_charge_at`
    to +30 days.
  * A daily billing pass (wired into the APScheduler in server.py) charges the
    next 50 credits when the renewal date passes. If the user doesn't have 50
    credits, BYOK is switched **off** automatically (their keys are kept, so
    turning it back on later is one click) and they fall back to per-message
    credits.

Security
--------
User keys are stored exactly like the operator's own keys (raw string in the
user document) and are **never** returned to the client — only a masked preview
and a boolean "is set" flag. Keys are never logged.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Body

from auth_utils import get_current_user

logger = logging.getLogger('tbc.byok')

router = APIRouter(prefix='/api')

# Flat monthly price of the add-on, in credits.
BYOK_MONTHLY_COST = 50
# Renewal cadence.
BYOK_PERIOD_DAYS = 30
# Providers a user may bring a key for. These map 1:1 to llm_router providers.
BYOK_PROVIDERS = ('anthropic', 'openai', 'gemini', 'openrouter')


async def get_db():
    from db import db as _db
    return _db


def _mask_key(k: Optional[str]) -> Optional[str]:
    if not k:
        return None
    if len(k) <= 8:
        return '\u2022\u2022\u2022\u2022' + k[-2:]
    return k[:4] + '\u2022\u2022\u2022\u2022' + k[-4:]


def _sniff_provider(value: str) -> Optional[str]:
    """Best-effort provider detection from a key prefix. Used to validate that
    the pasted key looks like it belongs to the provider the user selected."""
    v = (value or '').strip()
    if v.startswith('sk-or-'):
        return 'openrouter'
    if v.startswith('sk-ant-'):
        return 'anthropic'
    if v.startswith('AIza'):
        return 'gemini'
    if v.startswith('sk-'):
        return 'openai'
    return None


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if isinstance(dt, datetime) else dt


def _status_payload(u: dict) -> dict:
    keys = u.get('byok_keys') or {}
    return {
        'enabled': bool(u.get('byok_enabled', False)),
        'monthly_cost': BYOK_MONTHLY_COST,
        'credits': int(u.get('credits', 0)),
        'activated_at': _iso(u.get('byok_activated_at')),
        'next_charge_at': _iso(u.get('byok_next_charge_at')),
        'providers': [
            {
                'id': p,
                'set': bool(keys.get(p)),
                'masked': _mask_key(keys.get(p)),
            }
            for p in BYOK_PROVIDERS
        ],
    }


# ===================================================================
# Status
# ===================================================================
@router.get('/byok/status')
async def byok_status(user: dict = Depends(get_current_user)):
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    return _status_payload(u)


# ===================================================================
# Activate / deactivate
# ===================================================================
@router.post('/byok/activate')
async def byok_activate(user: dict = Depends(get_current_user)):
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    if u.get('byok_enabled'):
        return {'success': True, 'already_active': True, **_status_payload(u)}
    if int(u.get('credits', 0)) < BYOK_MONTHLY_COST:
        raise HTTPException(
            402,
            f'You need at least {BYOK_MONTHLY_COST} credits to switch on Bring Your Own Keys. '
            'Top up your credits and try again.',
        )
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {'id': u['id']},
        {
            '$inc': {'credits': -BYOK_MONTHLY_COST},
            '$set': {
                'byok_enabled': True,
                'byok_activated_at': now,
                'byok_next_charge_at': now + timedelta(days=BYOK_PERIOD_DAYS),
            },
        },
    )
    logger.info('BYOK activated for %s (-%d credits)', u.get('email'), BYOK_MONTHLY_COST)
    fresh = await db.users.find_one({'id': u['id']})
    return {'success': True, **_status_payload(fresh)}


@router.post('/byok/deactivate')
async def byok_deactivate(user: dict = Depends(get_current_user)):
    """Turn the add-on off. We keep the saved keys so re-enabling is one click.
    No refund of the current period's 50 credits (matches normal subscriptions)."""
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    await db.users.update_one(
        {'id': u['id']},
        {'$set': {'byok_enabled': False, 'byok_next_charge_at': None}},
    )
    fresh = await db.users.find_one({'id': u['id']})
    return {'success': True, **_status_payload(fresh)}


# ===================================================================
# Keys CRUD
# ===================================================================
@router.put('/byok/keys')
async def byok_save_key(payload: dict = Body(...), user: dict = Depends(get_current_user)):
    provider = (payload.get('provider') or '').strip().lower()
    value = (payload.get('value') or '').strip()
    if provider not in BYOK_PROVIDERS:
        raise HTTPException(400, f'Unsupported provider. Choose one of: {", ".join(BYOK_PROVIDERS)}')
    if not value:
        raise HTTPException(400, 'Empty key')
    # Soft prefix check — warn only, don't hard-block (providers rotate formats).
    sniffed = _sniff_provider(value)
    if sniffed and sniffed != provider:
        raise HTTPException(
            400,
            f'That key looks like a {sniffed} key, not a {provider} key. '
            'Double-check which provider you selected.',
        )
    db = await get_db()
    await db.users.update_one(
        {'id': user['sub']},
        {'$set': {f'byok_keys.{provider}': value}},
    )
    logger.info('BYOK key saved for %s (provider=%s)', user.get('email'), provider)
    u = await db.users.find_one({'id': user['sub']})
    return {'success': True, **_status_payload(u)}


@router.delete('/byok/keys/{provider}')
async def byok_delete_key(provider: str, user: dict = Depends(get_current_user)):
    provider = (provider or '').strip().lower()
    if provider not in BYOK_PROVIDERS:
        raise HTTPException(400, 'Unsupported provider')
    db = await get_db()
    await db.users.update_one(
        {'id': user['sub']},
        {'$unset': {f'byok_keys.{provider}': ''}},
    )
    u = await db.users.find_one({'id': user['sub']})
    return {'success': True, **_status_payload(u)}


@router.post('/byok/keys/test')
async def byok_test_key(payload: dict = Body(...), user: dict = Depends(get_current_user)):
    """Live-validate a pasted key against the provider before saving.
    Reuses the operator Secrets validator so behaviour is identical."""
    provider = (payload.get('provider') or '').strip().lower()
    value = (payload.get('value') or '').strip()
    if provider not in BYOK_PROVIDERS:
        raise HTTPException(400, 'Unsupported provider')
    if not value:
        raise HTTPException(400, 'Empty key')
    # Gemini isn't in the operator validator set; do a light format check.
    if provider == 'gemini':
        ok = value.startswith('AIza') and len(value) > 20
        return {'ok': ok, 'identity': 'Gemini key format OK' if ok else '',
                'error': None if ok else 'That does not look like a Google/Gemini API key.'}
    try:
        from payments_ext import _validate_key
        return await _validate_key(provider, value)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning('BYOK key test failed (provider=%s): %s', provider, e)
        return {'ok': False, 'identity': '', 'error': 'Could not validate the key right now.'}


# ===================================================================
# Chat-time helper + monthly billing pass
# ===================================================================
def get_user_key_overrides(db_user: dict) -> dict:
    """Return {provider: key} the chat endpoint should use for THIS user, or {}
    when BYOK is off / no keys are set. Safe to call for every request."""
    if not db_user or not db_user.get('byok_enabled'):
        return {}
    keys = db_user.get('byok_keys') or {}
    return {p: k for p, k in keys.items() if p in BYOK_PROVIDERS and k}


async def run_byok_billing_pass() -> dict:
    """Charge the 50-credit monthly fee for every BYOK user whose renewal date
    has passed. Users without enough credits are switched off (keys retained).
    Idempotent per period — advancing `byok_next_charge_at` prevents re-charge.
    """
    db = await get_db()
    now = datetime.now(timezone.utc)
    charged, disabled = [], []
    cursor = db.users.find({'byok_enabled': True, 'byok_next_charge_at': {'$lte': now}})
    async for u in cursor:
        # Operators never get charged.
        if u.get('role') == 'operator':
            continue
        if int(u.get('credits', 0)) >= BYOK_MONTHLY_COST:
            await db.users.update_one(
                {'id': u['id']},
                {
                    '$inc': {'credits': -BYOK_MONTHLY_COST},
                    '$set': {'byok_next_charge_at': now + timedelta(days=BYOK_PERIOD_DAYS)},
                },
            )
            charged.append(u.get('email'))
        else:
            await db.users.update_one(
                {'id': u['id']},
                {'$set': {'byok_enabled': False, 'byok_next_charge_at': None}},
            )
            disabled.append(u.get('email'))
            # Best-effort in-app notification so the user knows why chat went
            # back to per-message credits.
            try:
                from notifications_ext import Notification
                notif = Notification(
                    user_id=u['id'],
                    kind='dm',
                    subject='Bring Your Own Keys paused',
                    body=(
                        f'We couldn\u2019t renew your BYOK add-on \u2014 it needs '
                        f'{BYOK_MONTHLY_COST} credits/month. Top up and switch it '
                        'back on any time. Your saved keys are safe.'
                    ),
                )
                await db.user_notifications.insert_one(notif.model_dump())
            except Exception:
                pass
    if charged or disabled:
        logger.info('BYOK billing pass: charged=%d disabled=%d', len(charged), len(disabled))
    return {'charged': charged, 'disabled': disabled}
