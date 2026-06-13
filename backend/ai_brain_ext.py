"""AI Brain — per-model learning stats for the Operator dashboard.

Surfaces three views that all read from the same `ai_learnings` collection
the operator manages in the AI Learnings tab:

1. **Maturity bars per model** (`GET /api/operator/ai-brain/maturity`)
     For Claude / GPT / Gemini / generic, returns:
       - total_learnings (enabled count)
       - pending_learnings (auto_proposed + !enabled)
       - last_7d_added
       - approval_rate  (enabled / (enabled+rejected_proxy))

2. **Weekly timeline** (`GET /api/operator/ai-brain/timeline?weeks=12`)
     12-week histogram of learnings added per ISO week, grouped by model.
     Shape: `[{ week: '2026-W22', counts: { claude: 3, gpt: 1, gemini: 0, all: 4 } }, ...]`

3. **Skill groups** (`GET /api/operator/ai-brain/skills`)
     Best-effort tagger — runs a *very cheap* keyword pass over every
     learning's `text` and buckets each into one of a fixed taxonomy
     (deploy, voice, code, security, ux, general). No LLM call — keeps
     the page fast and free. Returns each bucket with its learnings list
     so the UI can render a simple skill-tree-ish grouped view.

All endpoints are operator-only.
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-brain', tags=['ai-brain'])


# Canonical model buckets — anything not matching falls into "other".
# Match against the chat-session's stored model field (server.py:DEFAULT_MODEL
# and resolve_model() use a small set of identifiers).
def _bucket_for_model(model: Optional[str]) -> str:
    m = (model or '').lower()
    if 'claude' in m or 'anthropic' in m or 'sonnet' in m or 'opus' in m or 'haiku' in m:
        return 'claude'
    if 'gpt' in m or 'openai' in m:
        return 'gpt'
    if 'gemini' in m or 'google' in m:
        return 'gemini'
    return 'other'


# Skill taxonomy — keyword → bucket. First match wins. Lower-case the
# learning text once and check `in`. Kept small + readable on purpose;
# adding a category is one line.
SKILL_TAXONOMY: dict[str, tuple[str, ...]] = {
    'deploy':   ('deploy', 'vercel', 'production', 'ship', 'preview-url', 'redeploy', 'promote'),
    'code':     ('code', 'refactor', 'function', 'class ', 'import', 'syntax', 'typescript', 'javascript', 'python', 'patch'),
    'voice':    ('voice', 'tone', 'brand', 'apolog', 'concise', 'short', 'long', 'casual', 'formal', 'never write', 'always write'),
    'security': ('security', 'secret', 'token', 'password', 'auth', '2fa', 'cors', 'permission'),
    'ux':       ('ux', 'design', 'layout', 'spacing', 'colour', 'color', 'button', 'modal', 'toast', 'mobile'),
    'money':    ('payment', 'stripe', 'crypto', 'refund', 'invoice', 'revenue', 'payout', 'royalty', 'license'),
}
DEFAULT_BUCKET = 'general'


def _categorize(text: str) -> str:
    t = (text or '').lower()
    for bucket, kws in SKILL_TAXONOMY.items():
        for kw in kws:
            if kw in t:
                return bucket
    return DEFAULT_BUCKET


async def _annotate_with_model(learnings: list[dict]) -> list[dict]:
    """Backfill `source_model` for legacy learnings missing it by joining
    on chat_sessions[session_id].model. Keeps the API responses internally
    consistent even before every doc has been refreshed by the auto-learner.
    """
    missing = [l for l in learnings if not l.get('source_model') and l.get('source_session_id')]
    if not missing:
        return learnings
    session_ids = list({l['source_session_id'] for l in missing})
    sessions_cursor = db.chat_sessions.find(
        {'id': {'$in': session_ids}}, {'id': 1, 'model': 1},
    )
    by_id = {s['id']: s.get('model') for s in await sessions_cursor.to_list(len(session_ids))}
    for l in missing:
        l['source_model'] = by_id.get(l['source_session_id'])
    return learnings


def _as_aware(d: datetime | None) -> datetime | None:
    """Mongo returns naive datetimes when older docs were stored without
    explicit tzinfo (e.g. via `datetime.utcnow()` in legacy code). Normalise
    every comparison to UTC-aware so the timeline / maturity windows don't
    raise `can't compare offset-naive and offset-aware datetimes`.
    """
    if d is None:
        return None
    if d.tzinfo is None:
        return d.replace(tzinfo=timezone.utc)
    return d


@router.get('/maturity')
async def maturity(_op: dict = Depends(get_current_operator)):
    """Per-model maturity card: total enabled, pending proposals, 7d delta, approval rate."""
    learnings = await db.ai_learnings.find({}).to_list(2_000)
    learnings = await _annotate_with_model(learnings)

    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    buckets: dict[str, dict] = defaultdict(lambda: {
        'total': 0, 'pending': 0, 'last_7d': 0,
        'approved': 0, 'auto_proposed_total': 0,
    })
    # `all` synthesises across every bucket so the UI can render a "headline"
    # card without re-summing client-side.
    for l in learnings:
        b = _bucket_for_model(l.get('source_model'))
        for key in (b, 'all'):
            row = buckets[key]
            if l.get('enabled'):
                row['total'] += 1
            elif l.get('auto_proposed'):
                row['pending'] += 1
            created = _as_aware(l.get('created_at'))
            if created and created >= week_ago:
                row['last_7d'] += 1
            if l.get('auto_proposed'):
                row['auto_proposed_total'] += 1
                if l.get('enabled'):
                    row['approved'] += 1

    out = []
    # Stable model ordering — headline first, then the three frontier ones.
    for key in ('all', 'claude', 'gpt', 'gemini', 'other'):
        if key not in buckets:
            continue
        b = buckets[key]
        approval_rate = (b['approved'] / b['auto_proposed_total']) if b['auto_proposed_total'] else None
        out.append({
            'model': key,
            'total': b['total'],
            'pending': b['pending'],
            'last_7d_added': b['last_7d'],
            'approval_rate': round(approval_rate, 3) if approval_rate is not None else None,
            'auto_proposed_total': b['auto_proposed_total'],
        })
    return {'models': out}


@router.get('/timeline')
async def timeline(
    weeks: int = Query(12, ge=1, le=52),
    _op: dict = Depends(get_current_operator),
):
    """12-week (or N) histogram of learnings per ISO-week, grouped by model.

    Returns rows oldest → newest so a chart can render them left-to-right.
    Each row has counts for every bucket (claude/gpt/gemini/other) plus
    `all`. Missing weeks are filled with zeroes so the chart axis is
    continuous.
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(weeks=weeks)
    learnings = await db.ai_learnings.find(
        {'created_at': {'$gte': cutoff}},
    ).to_list(5_000)
    learnings = await _annotate_with_model(learnings)

    def _week_key(d: datetime) -> str:
        iso = d.isocalendar()
        return f'{iso.year}-W{iso.week:02d}'

    rows: dict[str, dict[str, int]] = defaultdict(lambda: {'claude': 0, 'gpt': 0, 'gemini': 0, 'other': 0, 'all': 0})
    for l in learnings:
        created = _as_aware(l.get('created_at'))
        if not isinstance(created, datetime):
            continue
        wk = _week_key(created)
        b = _bucket_for_model(l.get('source_model'))
        rows[wk][b] += 1
        rows[wk]['all'] += 1

    # Fill missing weeks so the chart has a continuous x-axis.
    out = []
    cursor = cutoff
    seen = set()
    while cursor <= now:
        wk = _week_key(cursor)
        if wk not in seen:
            out.append({'week': wk, 'counts': rows.get(wk, {'claude': 0, 'gpt': 0, 'gemini': 0, 'other': 0, 'all': 0})})
            seen.add(wk)
        cursor += timedelta(days=7)
    # Always include the *current* week even if cursor stepped past it.
    cur_wk = _week_key(now)
    if cur_wk not in seen:
        out.append({'week': cur_wk, 'counts': rows.get(cur_wk, {'claude': 0, 'gpt': 0, 'gemini': 0, 'other': 0, 'all': 0})})
    return {'weeks': out}


@router.get('/skills')
async def skills(_op: dict = Depends(get_current_operator)):
    """Group enabled learnings into a fixed skill taxonomy via cheap keyword
    matching (NO LLM call — kept free + instant). Each bucket returns a
    count and the list of learnings, sorted newest-first.
    """
    learnings = await db.ai_learnings.find(
        {'enabled': True},
    ).sort('created_at', -1).to_list(2_000)
    learnings = await _annotate_with_model(learnings)

    by_bucket: dict[str, list[dict]] = defaultdict(list)
    for l in learnings:
        bucket = _categorize(l.get('text', ''))
        by_bucket[bucket].append({
            'id': l.get('id'),
            'text': l.get('text'),
            'model': _bucket_for_model(l.get('source_model')),
            'created_at': l['created_at'].isoformat() if l.get('created_at') else None,
        })

    # Stable order: known buckets first, then general fallback.
    order = ('deploy', 'code', 'voice', 'security', 'ux', 'money', 'general')
    out = []
    for b in order:
        if b in by_bucket:
            out.append({'bucket': b, 'count': len(by_bucket[b]), 'items': by_bucket[b]})
    # Any unexpected bucket name (taxonomy drift) — append at the end.
    for b in by_bucket:
        if b not in order:
            out.append({'bucket': b, 'count': len(by_bucket[b]), 'items': by_bucket[b]})
    return {'buckets': out, 'total': sum(len(v) for v in by_bucket.values())}
