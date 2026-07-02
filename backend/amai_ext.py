"""amAI — operator control center for AI quality vs. cost.

What this module does
---------------------
Gives the operator a single dial that decides *how good / how expensive* the
AI should be, mapped onto real models the app already supports (see
``server.py:MODEL_PROVIDERS``). It also reports which bill each request lands
on (the operator's own Anthropic/OpenAI key vs. the shared Emergent budget)
and shows an estimated cost per request / per 100 requests at every level.

Design guarantees (so nothing silently gets worse)
--------------------------------------------------
* The default tier is ``max`` → ``claude-opus-4-7`` — exactly what the app
  used before this feature existed. If the operator never touches the dial,
  behaviour is unchanged.
* The chosen tier only sets the *default model for NEW chat sessions*. Existing
  chats keep whatever model they were created with, and any request that
  explicitly passes a model still wins.
* All tiers use Anthropic models, because the Anthropic key is the one wired
  up here — so lowering the dial never fails with a "missing provider key".

Storage
-------
The selection lives on the shared ``settings`` doc (``_id='payment_settings'``)
under ``ai_quality_tier`` / ``ai_quality_model`` — same place every other
operator setting is kept.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/amai', tags=['amai'])

# Mirror of server.py:DEFAULT_MODEL, kept local to avoid a circular import
# (server.py imports this module to mount the router).
DEFAULT_MODEL = 'claude-opus-4-7'

# ─── Cost model ───────────────────────────────────────────────────────────
# Approximate Anthropic list prices in USD per 1,000,000 tokens. These are
# ESTIMATES for display only — real invoices come from your provider. Kept in
# one place so they're trivial to update when prices change.
_PRICES = {
    # model id                     input $/Mtok  output $/Mtok
    'claude-opus-4-7':            (15.0, 75.0),
    'claude-sonnet-4-6':          (3.0, 15.0),
    'claude-haiku-4-5-20251001':  (1.0, 5.0),
}

# A "typical" request for estimation: system prompt + _CORE_KNOWLEDGE + a bit
# of history on the way in, a medium answer on the way out. Tunable.
_EST_INPUT_TOKENS = 10_000
_EST_OUTPUT_TOKENS = 1_200

# ─── Tiers ────────────────────────────────────────────────────────────────
# Ordered best → cheapest. `percent_min` lets the UI map a 0-100 slider onto
# a fixed tier (deterministic — the same % always resolves to the same model).
_TIERS = [
    {
        'id': 'max',
        'label': 'Max',
        'model': 'claude-opus-4-7',
        'percent_min': 67,
        'blurb': 'Best reasoning & code quality. Same as your current setup.',
    },
    {
        'id': 'balanced',
        'label': 'Balanced',
        'model': 'claude-sonnet-4-6',
        'percent_min': 34,
        'blurb': 'Strong all-rounder at a fraction of the cost.',
    },
    {
        'id': 'economy',
        'label': 'Economy',
        'model': 'claude-haiku-4-5-20251001',
        'percent_min': 0,
        'blurb': 'Fast and very cheap. Great for simple tasks.',
    },
]

_TIER_BY_ID = {t['id']: t for t in _TIERS}
_DEFAULT_TIER_ID = 'max'


def _est_cost(model: str) -> dict:
    """Estimated USD cost for one request and for 100 requests."""
    price_in, price_out = _PRICES.get(model, _PRICES[DEFAULT_MODEL])
    per_req = (
        _EST_INPUT_TOKENS / 1_000_000 * price_in
        + _EST_OUTPUT_TOKENS / 1_000_000 * price_out
    )
    return {
        'per_request': round(per_req, 4),
        'per_100_requests': round(per_req * 100, 2),
    }


def _tier_payload(tier: dict) -> dict:
    return {
        'id': tier['id'],
        'label': tier['label'],
        'model': tier['model'],
        'percent_min': tier['percent_min'],
        'blurb': tier['blurb'],
        'estimated_cost': _est_cost(tier['model']),
    }


async def _settings() -> dict:
    return await db.settings.find_one({'_id': 'payment_settings'}) or {}


async def get_default_model() -> str:
    """Return the model NEW chat sessions should use, per the operator's dial.

    Falls back to ``DEFAULT_MODEL`` (max quality) when unset or invalid, so the
    app never degrades unless the operator explicitly lowers the dial.
    """
    try:
        s = await _settings()
        model = s.get('ai_quality_model')
        if isinstance(model, str) and model in _PRICES:
            return model
    except Exception as e:  # noqa: BLE001
        logger.warning('get_default_model fell back to default: %s', e)
    return DEFAULT_MODEL


def _percent_to_tier(percent: int) -> dict:
    """Map a 0-100 slider value to a fixed tier (deterministic)."""
    for tier in _TIERS:  # ordered best → cheapest
        if percent >= tier['percent_min']:
            return tier
    return _TIER_BY_ID[_DEFAULT_TIER_ID]


# ─── Billing path (whose bill each request lands on) ──────────────────────
async def _billing_status() -> dict:
    import os
    s = await _settings()
    anthropic = bool(
        os.environ.get('ANTHROPIC_API_KEY')
        or os.environ.get('CLAUDE_API_KEY')
        or (isinstance(s.get('anthropic_api_key'), str) and s['anthropic_api_key'].strip())
    )
    openai = bool(
        os.environ.get('OPENAI_API_KEY')
        or (isinstance(s.get('openai_api_key'), str) and s['openai_api_key'].strip())
    )
    if anthropic:
        path, detail = 'own_anthropic', 'Billed to your own Anthropic account.'
    elif openai:
        path, detail = 'own_openai', 'Billed to your own OpenAI account.'
    else:
        path, detail = 'emergent_fallback', (
            'Falling back to the shared Emergent budget — add your own key in '
            'the "My Keys" tab to control spend.'
        )
    return {
        'path': path,
        'detail': detail,
        'anthropic_key_present': anthropic,
        'openai_key_present': openai,
        # The dial's models are all Anthropic, so this is the key that matters.
        'active_tiers_billed_to': 'anthropic' if anthropic else 'emergent',
    }


# ─── API ──────────────────────────────────────────────────────────────────
class TierUpdate(BaseModel):
    tier: Optional[str] = None       # 'max' | 'balanced' | 'economy'
    percent: Optional[int] = None    # 0-100 slider alternative


@router.get('/status')
async def amai_status(_op: dict = Depends(get_current_operator)):
    """Everything the amAI tab needs to render: current selection, all tiers
    with estimated costs, and which bill requests land on."""
    s = await _settings()
    current_tier = s.get('ai_quality_tier') or _DEFAULT_TIER_ID
    if current_tier not in _TIER_BY_ID:
        current_tier = _DEFAULT_TIER_ID
    current_model = await get_default_model()
    return {
        'current_tier': current_tier,
        'current_model': current_model,
        'default_tier': _DEFAULT_TIER_ID,
        'tiers': [_tier_payload(t) for t in _TIERS],
        'billing': await _billing_status(),
        'estimate_basis': {
            'input_tokens': _EST_INPUT_TOKENS,
            'output_tokens': _EST_OUTPUT_TOKENS,
            'note': 'Estimates only. Actual cost varies with prompt size and provider pricing.',
        },
    }


@router.put('/tier')
async def amai_set_tier(body: TierUpdate, _op: dict = Depends(get_current_operator)):
    """Set the AI quality tier by id or by slider percent. Applies to NEW chat
    sessions; existing chats and explicit model choices are unaffected."""
    if body.tier is not None:
        if body.tier not in _TIER_BY_ID:
            raise HTTPException(400, f'Unknown tier: {body.tier}')
        tier = _TIER_BY_ID[body.tier]
    elif body.percent is not None:
        pct = max(0, min(100, int(body.percent)))
        tier = _percent_to_tier(pct)
    else:
        raise HTTPException(400, 'Provide either "tier" or "percent".')

    await db.settings.update_one(
        {'_id': 'payment_settings'},
        {'$set': {
            'ai_quality_tier': tier['id'],
            'ai_quality_model': tier['model'],
        }},
        upsert=True,
    )
    logger.info('amAI quality tier set to %s (%s)', tier['id'], tier['model'])
    return {
        'ok': True,
        'current_tier': tier['id'],
        'current_model': tier['model'],
        'estimated_cost': _est_cost(tier['model']),
    }
