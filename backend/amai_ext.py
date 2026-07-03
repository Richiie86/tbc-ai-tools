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
from datetime import datetime, timezone
from typing import Optional, Tuple

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


# ─── Automatic model selection ────────────────────────────────────────────
# When a request uses the special model id ``auto`` (see AUTO_MODEL_ID), we
# look at what the user actually asked for and route it:
#   • coding / debugging / review / planning  → the BEST model (Opus)
#   • plain questions / chit-chat             → the CHEAPEST model (Haiku)
# So every request gets the best quality for the job at the lowest cost, with
# no one having to think about model choice.
AUTO_MODEL_ID = 'auto'

_BEST_MODEL = 'claude-opus-4-7'
_CHEAP_MODEL = 'claude-haiku-4-5-20251001'

# Keyword signals grouped by task kind. Checked against the lower-cased msg.
_REVIEW_SIGNALS = (
    'review', 'audit', 'critique', 'assess', 'evaluate', 'security',
    'vulnerab', 'code smell', 'best practice',
)
_PLAN_SIGNALS = (
    'plan', 'architect', 'design', 'strategy', 'roadmap', 'approach',
    'trade-off', 'tradeoff', 'compare', 'pros and cons', 'should i',
)
_CODE_SIGNALS = (
    'code', 'coding', 'function', 'bug', 'error', 'stack trace', 'traceback',
    'refactor', 'implement', 'build', 'deploy', 'endpoint', 'component',
    'database', 'query', ' sql', 'schema', 'typescript', 'python', 'react',
    'compile', 'exception', 'debug', 'unit test', 'install', 'npm ', 'pip ',
    'api ', 'regex', 'algorithm', 'optimize',
)
# Punctuation / structural signals that all but guarantee it's real code work.
_CODE_SYMBOLS = ('```', 'def ', 'function ', '=>', '{', '};', '</', 'import ', 'class ')


def classify_message(message: str) -> str:
    """Classify a user message as 'code' | 'review' | 'plan' | 'question'.

    Deterministic and dependency-free (no extra LLM call) so it adds zero
    cost/latency. Order matters: strong code signals win, then review, then
    planning, then a length heuristic, else it's a cheap 'question'.
    """
    if not message or not message.strip():
        return 'question'
    if any(sym in message for sym in _CODE_SYMBOLS):
        return 'code'
    text = message.lower()
    if any(k in text for k in _REVIEW_SIGNALS):
        return 'review'
    if any(k in text for k in _PLAN_SIGNALS):
        return 'plan'
    if any(k in text for k in _CODE_SIGNALS):
        return 'code'
    # Long, detailed messages are usually tasks, not quick questions.
    if len(message) > 600:
        return 'plan'
    return 'question'


def model_for_kind(kind: str) -> str:
    """Best model for real work; cheapest model for plain questions."""
    return _BEST_MODEL if kind in ('code', 'review', 'plan') else _CHEAP_MODEL


def pick_auto_model(message: str) -> Tuple[str, str]:
    """Return ``(model_id, kind)`` for an automatic request."""
    kind = classify_message(message)
    return model_for_kind(kind), kind


async def is_auto_default() -> bool:
    """Whether the operator has made Automatic the default for everyone."""
    try:
        s = await _settings()
        return bool(s.get('ai_auto_mode'))
    except Exception:  # noqa: BLE001
        return False


# ─── Usage / spend tracking ───────────────────────────────────────────────
async def record_usage(
    user_id: str,
    model: str,
    *,
    kind: Optional[str] = None,
    source: str = 'chat',
) -> None:
    """Log one AI request with its ESTIMATED cost so the amAI tab can show
    running monthly spend. Fire-and-forget; never breaks the chat flow."""
    try:
        await db.ai_usage.insert_one({
            'user_id': user_id,
            'model': model,
            'kind': kind,
            'source': source,
            'est_cost': _est_cost(model)['per_request'],
            'created_at': datetime.now(timezone.utc),
        })
    except Exception as e:  # noqa: BLE001
        logger.warning('record_usage failed (non-fatal): %s', e)


async def _spend_summary() -> dict:
    """Aggregate this calendar month's estimated spend, grouped by model and
    by user (so the operator can see who is costing what)."""
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    total, total_requests, by_model, by_user = 0.0, 0, [], []
    try:
        # By model (also drives the month total).
        model_pipeline = [
            {'$match': {'created_at': {'$gte': month_start}}},
            {'$group': {
                '_id': '$model',
                'requests': {'$sum': 1},
                'est_cost': {'$sum': '$est_cost'},
            }},
        ]
        async for row in db.ai_usage.aggregate(model_pipeline):
            cost = float(row.get('est_cost') or 0)
            by_model.append({
                'model': row['_id'],
                'requests': int(row.get('requests') or 0),
                'est_cost': round(cost, 2),
            })
            total += cost
            total_requests += int(row.get('requests') or 0)

        # By user — top spenders this month (capped so the payload stays small).
        user_pipeline = [
            {'$match': {'created_at': {'$gte': month_start}}},
            {'$group': {
                '_id': '$user_id',
                'requests': {'$sum': 1},
                'est_cost': {'$sum': '$est_cost'},
            }},
            {'$sort': {'est_cost': -1}},
            {'$limit': 50},
        ]
        raw_users = [r async for r in db.ai_usage.aggregate(user_pipeline)]
        # Resolve friendly labels (name/email) in one query.
        ids = [r['_id'] for r in raw_users if r.get('_id')]
        labels: dict = {}
        if ids:
            async for u in db.users.find(
                {'id': {'$in': ids}}, {'id': 1, 'name': 1, 'email': 1, 'role': 1}
            ):
                labels[u['id']] = {
                    'label': u.get('name') or u.get('email') or 'Unknown',
                    'email': u.get('email'),
                    'role': u.get('role'),
                }
        for r in raw_users:
            uid = r.get('_id')
            info = labels.get(uid, {})
            by_user.append({
                'user_id': uid,
                'label': info.get('label') or 'Unknown user',
                'email': info.get('email'),
                'role': info.get('role'),
                'requests': int(r.get('requests') or 0),
                'est_cost': round(float(r.get('est_cost') or 0), 2),
            })
    except Exception as e:  # noqa: BLE001
        logger.warning('spend_summary failed: %s', e)
    return {
        'month_start': month_start.isoformat(),
        'total_est_cost': round(total, 2),
        'total_requests': total_requests,
        'by_model': sorted(by_model, key=lambda r: -r['est_cost']),
        'by_user': by_user,
        'note': 'Estimated spend this month. Actual charges come from your provider.',
    }


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
        'auto_mode': bool(s.get('ai_auto_mode')),
        'auto_routing': {
            'best_model': _BEST_MODEL,
            'cheap_model': _CHEAP_MODEL,
            'best_cost': _est_cost(_BEST_MODEL),
            'cheap_cost': _est_cost(_CHEAP_MODEL),
            'best_for': ['coding', 'debugging', 'review', 'planning'],
            'cheap_for': ['questions', 'quick chat', 'simple lookups'],
        },
        'spend': await _spend_summary(),
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


class AutoUpdate(BaseModel):
    enabled: bool


@router.put('/auto')
async def amai_set_auto(body: AutoUpdate, _op: dict = Depends(get_current_operator)):
    """Turn Automatic mode ON/OFF as the default for everyone.

    When ON, new chats default to the 'Automatic' option, which routes coding /
    review / planning to the best model and plain questions to the cheapest.
    Users can always override by picking a specific model in the chat header.
    """
    await db.settings.update_one(
        {'_id': 'payment_settings'},
        {'$set': {'ai_auto_mode': bool(body.enabled)}},
        upsert=True,
    )
    logger.info('amAI auto mode set to %s', bool(body.enabled))
    return {'ok': True, 'auto_mode': bool(body.enabled)}
