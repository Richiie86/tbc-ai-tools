"""BYOK (Bring Your Own Keys) — a COMPANY-ONLY, operator-approved add-on.

This is NOT a self-serve feature and it has NO public price.

How it works
------------
1. A company account contacts us (enquiry endpoint) to ask about BYOK.
2. We agree a monthly price out-of-band, then the **operator approves** the
   account and records the negotiated monthly cost in credits
   (`byok_monthly_credits`).
3. Only an approved account can switch BYOK on. When enabled, their chat runs
   on **their own** provider keys (Anthropic / OpenAI / Gemini / OpenRouter),
   so those messages cost **0 app credits** — they pay their provider directly.
4. The agreed monthly fee is charged on activation and every 30 days by the
   billing pass. If the account can't cover it, BYOK is switched off (keys are
   kept) and it falls back to per-message credits.

Because pricing is negotiated per company, the price is never shown publicly —
users must enquire first, and nothing is visible until the operator approves.

Security
--------
User keys are stored exactly like the operator's own keys (raw string in the
user document) and are **never** returned to the client — only a masked preview
and a boolean "is set" flag. Keys are never logged.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Body

from auth_utils import get_current_user, get_current_operator

logger = logging.getLogger('tbc.byok')

router = APIRouter(prefix='/api')

# Fallback monthly price (credits) if the operator approved an account without
# recording a custom one. Kept internal — never surfaced as a public price.
BYOK_DEFAULT_MONTHLY_COST = 50
# Renewal cadence.
BYOK_PERIOD_DAYS = 30
# Providers a user may bring a key for. These map 1:1 to llm_router providers.
BYOK_PROVIDERS = ('anthropic', 'openai', 'gemini', 'openrouter')


async def get_db():
    from db import db as _db
    return _db


def _monthly_cost(u: dict) -> int:
    """The negotiated monthly price for this account, in credits."""
    v = u.get('byok_monthly_credits')
    try:
        v = int(v)
        if v > 0:
            return v
    except (TypeError, ValueError):
        pass
    return BYOK_DEFAULT_MONTHLY_COST


def _mask_key(k: Optional[str]) -> Optional[str]:
    if not k:
        return None
    if len(k) <= 8:
        return '\u2022\u2022\u2022\u2022' + k[-2:]
    return k[:4] + '\u2022\u2022\u2022\u2022' + k[-4:]


async def _notify_operators(db, subject: str, body: str) -> int:
    """Drop an in-app notification into every operator's inbox (the same bell
    users see). Best-effort: never raises, so it can't break the caller.
    Returns the number of operators notified."""
    try:
        from notifications_ext import Notification
        ops = [op async for op in db.users.find({'role': 'operator'}, {'id': 1})]
        if not ops:
            return 0
        docs = [
            Notification(
                user_id=op['id'],
                kind='dm',
                subject=subject[:200],
                body=body[:1000],
            ).model_dump()
            for op in ops
        ]
        await db.user_notifications.insert_many(docs)
        return len(docs)
    except Exception:  # noqa: BLE001
        logger.warning('Could not notify operators (subject=%s)', subject, exc_info=True)
        return 0


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
    """Status for the account. `approved` gates the whole feature client-side —
    when False, the UI shows only an enquiry prompt (no price, no key fields)."""
    keys = u.get('byok_keys') or {}
    approved = bool(u.get('byok_approved', False))
    return {
        'approved': approved,
        'enabled': bool(u.get('byok_enabled', False)),
        # Only expose the negotiated price to accounts that have been approved.
        'monthly_cost': _monthly_cost(u) if approved else None,
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
        ] if approved else [],
    }


# ===================================================================
# Status  (any logged-in user; unapproved accounts just see approved=False)
# ===================================================================
@router.get('/byok/status')
async def byok_status(user: dict = Depends(get_current_user)):
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    return _status_payload(u)


# ===================================================================
# Enquiry — a user asks us about BYOK (no price shown; operator follows up)
# ===================================================================
@router.post('/byok/enquire')
async def byok_enquire(payload: dict = Body(default={}), user: dict = Depends(get_current_user)):
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    if u.get('byok_approved'):
        return {'success': True, 'already_approved': True}
    # One open enquiry at a time.
    existing = await db.byok_enquiries.find_one({'user_id': u['id'], 'status': 'open'})
    if existing:
        return {'success': True, 'already_pending': True}
    doc = {
        'id': str(uuid.uuid4()),
        'user_id': u['id'],
        'user_email': u.get('email', ''),
        'user_name': u.get('name', ''),
        'company': (payload.get('company') or '').strip()[:200],
        'message': (payload.get('message') or '').strip()[:1000],
        'status': 'open',
        'created_at': datetime.now(timezone.utc),
    }
    await db.byok_enquiries.insert_one(doc)
    logger.info('BYOK enquiry from %s', doc['user_email'])
    # Alert operators in their notification bell so requests aren't missed.
    who = doc['user_email'] or doc['user_name'] or u['id']
    extra = f' — {doc["company"]}' if doc['company'] else ''
    await _notify_operators(
        db,
        subject='New Bring Your Own Keys request',
        body=(
            f'{who}{extra} has requested access to Bring Your Own Keys. '
            f'{("Message: " + doc["message"]) if doc["message"] else "No message provided."} '
            'Review it under Users → open their profile → Bring Your Own Keys to approve and set a price.'
        ),
    )
    return {'success': True, 'submitted': True}


# ===================================================================
# Activate / deactivate  (approved accounts only)
# ===================================================================
@router.post('/byok/activate')
async def byok_activate(user: dict = Depends(get_current_user)):
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    if not u.get('byok_approved'):
        raise HTTPException(403, 'Bring Your Own Keys is not enabled for your account yet. Contact us to request access.')
    if u.get('byok_enabled'):
        return {'success': True, 'already_active': True, **_status_payload(u)}
    cost = _monthly_cost(u)
    if int(u.get('credits', 0)) < cost:
        raise HTTPException(
            402,
            f'You need at least {cost} credits to switch on Bring Your Own Keys. '
            'Top up your credits and try again.',
        )
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {'id': u['id']},
        {
            '$inc': {'credits': -cost},
            '$set': {
                'byok_enabled': True,
                'byok_activated_at': now,
                'byok_next_charge_at': now + timedelta(days=BYOK_PERIOD_DAYS),
            },
        },
    )
    logger.info('BYOK activated for %s (-%d credits)', u.get('email'), cost)
    fresh = await db.users.find_one({'id': u['id']})
    return {'success': True, **_status_payload(fresh)}


@router.post('/byok/deactivate')
async def byok_deactivate(user: dict = Depends(get_current_user)):
    """Turn the add-on off. We keep the saved keys so re-enabling is one click.
    No refund of the current period's fee (matches normal subscriptions)."""
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
# Keys CRUD  (approved accounts only)
# ===================================================================
async def _require_approved(user: dict):
    db = await get_db()
    u = await db.users.find_one({'id': user['sub']})
    if not u:
        raise HTTPException(404, 'User not found')
    if not u.get('byok_approved'):
        raise HTTPException(403, 'Bring Your Own Keys is not enabled for your account.')
    return db, u


@router.put('/byok/keys')
async def byok_save_key(payload: dict = Body(...), user: dict = Depends(get_current_user)):
    db, _u = await _require_approved(user)
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
    await db.users.update_one(
        {'id': user['sub']},
        {'$set': {f'byok_keys.{provider}': value}},
    )
    logger.info('BYOK key saved for %s (provider=%s)', user.get('email'), provider)
    u = await db.users.find_one({'id': user['sub']})
    return {'success': True, **_status_payload(u)}


@router.delete('/byok/keys/{provider}')
async def byok_delete_key(provider: str, user: dict = Depends(get_current_user)):
    db, _u = await _require_approved(user)
    provider = (provider or '').strip().lower()
    if provider not in BYOK_PROVIDERS:
        raise HTTPException(400, 'Unsupported provider')
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
    await _require_approved(user)
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
        res = await _validate_key(provider, value)
        # _validate_key returns {'ok', 'identity'|'message'} — normalise to the
        # {ok, identity, error} shape the BYOK UI expects.
        return {
            'ok': bool(res.get('ok')),
            'identity': res.get('identity') or '',
            'error': None if res.get('ok') else (res.get('message') or 'Key failed validation'),
        }
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning('BYOK key test failed (provider=%s): %s', provider, e)
        return {'ok': False, 'identity': '', 'error': 'Could not validate the key right now.'}


# ===================================================================
# Operator — enquiries + approve / revoke / set price
# ===================================================================
@router.get('/operator/byok/enquiries')
async def op_list_enquiries(status: str = 'open', _op: dict = Depends(get_current_operator)):
    db = await get_db()
    query = {} if status == 'all' else {'status': status}
    docs = await db.byok_enquiries.find(query).sort('created_at', -1).to_list(200)
    for d in docs:
        d.pop('_id', None)
        if isinstance(d.get('created_at'), datetime):
            d['created_at'] = d['created_at'].isoformat()
    return docs


@router.patch('/operator/users/{user_id}/byok')
async def op_set_byok(user_id: str, body: dict = Body(...), op: dict = Depends(get_current_operator)):
    """Approve / revoke BYOK for a company account and set the negotiated price.

    Body: { "approved": bool, "monthly_credits": int | null }
    Revoking also switches BYOK off (keys are retained).
    """
    db = await get_db()
    target = await db.users.find_one({'id': user_id}, {'email': 1, 'role': 1})
    if not target:
        raise HTTPException(404, 'User not found')
    if target.get('role') == 'operator':
        raise HTTPException(400, 'Operators do not use BYOK — they set the shared keys directly.')

    approved = bool(body.get('approved'))
    set_fields = {'byok_approved': approved, 'updated_at': datetime.now(timezone.utc)}

    # Record / clear the negotiated monthly price when provided.
    if 'monthly_credits' in body:
        mc = body.get('monthly_credits')
        if mc is None:
            set_fields['byok_monthly_credits'] = None
        else:
            try:
                mc = int(mc)
            except (TypeError, ValueError):
                raise HTTPException(400, 'monthly_credits must be a whole number of credits')
            if mc <= 0:
                raise HTTPException(400, 'monthly_credits must be greater than 0')
            set_fields['byok_monthly_credits'] = mc

    update = {'$set': set_fields}
    if not approved:
        # Revoking access also turns the feature off (keys kept for later).
        set_fields['byok_enabled'] = False
        set_fields['byok_next_charge_at'] = None

    await db.users.update_one({'id': user_id}, update)

    # Close any open enquiry from this user and let them know the outcome.
    now = datetime.now(timezone.utc)
    if approved:
        await db.byok_enquiries.update_many(
            {'user_id': user_id, 'status': 'open'},
            {'$set': {'status': 'approved', 'decided_at': now,
                      'decided_by_email': op.get('email', '')}},
        )
        try:
            from notifications_ext import Notification
            price = set_fields.get('byok_monthly_credits') or _monthly_cost(target)
            await db.user_notifications.insert_one(Notification(
                user_id=user_id,
                kind='dm',
                subject='Bring Your Own Keys is now available',
                body=(
                    f'Your account has been approved for Bring Your Own Keys at '
                    f'{price} credits/month. Open Settings \u2192 Bring your own keys to '
                    'add your provider keys and switch it on.'
                ),
            ).model_dump())
        except Exception:  # noqa: BLE001
            logger.warning('Could not notify user %s of BYOK approval', user_id, exc_info=True)
    else:
        await db.byok_enquiries.update_many(
            {'user_id': user_id, 'status': 'open'},
            {'$set': {'status': 'declined', 'decided_at': now,
                      'decided_by_email': op.get('email', '')}},
        )
    logger.info('Operator %s set BYOK approved=%s (price=%s) for %s',
                op.get('email'), approved, set_fields.get('byok_monthly_credits'), target.get('email'))
    fresh = await db.users.find_one({'id': user_id})
    return {'success': True, 'user_id': user_id, **_status_payload(fresh)}


# ===================================================================
# Chat-time helper + monthly billing pass
# ===================================================================
def get_user_key_overrides(db_user: dict) -> dict:
    """Return {provider: key} the chat endpoint should use for THIS user, or {}
    when BYOK is not approved / off / no keys are set. Safe to call every request."""
    if not db_user or not db_user.get('byok_approved') or not db_user.get('byok_enabled'):
        return {}
    keys = db_user.get('byok_keys') or {}
    return {p: k for p, k in keys.items() if p in BYOK_PROVIDERS and k}


async def run_byok_billing_pass() -> dict:
    """Charge the negotiated monthly fee for every BYOK user whose renewal date
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
        cost = _monthly_cost(u)
        if int(u.get('credits', 0)) >= cost:
            await db.users.update_one(
                {'id': u['id']},
                {
                    '$inc': {'credits': -cost},
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
                        f'{cost} credits/month. Top up and switch it '
                        'back on any time. Your saved keys are safe.'
                    ),
                )
                await db.user_notifications.insert_one(notif.model_dump())
            except Exception:
                pass
    if charged or disabled:
        logger.info('BYOK billing pass: charged=%d disabled=%d', len(charged), len(disabled))
    return {'charged': charged, 'disabled': disabled}
