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

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-brain', tags=['ai-brain'])

# Mirror of server.py:DEFAULT_MODEL. Kept local to avoid a circular import
# (server.py imports this module to mount the router). If the server default
# changes, update this too — it only drives the "active" badge in the UI.
DEFAULT_MODEL = 'claude-opus-4-7'


# Canonical AI buckets. The app runs four providers plus a "shared" pool:
#   claude / gpt / gemini / openrouter  → attributed to a specific provider
#   shared                              → learnings with NO single source model
#                                          (taught to every AI at once — this is
#                                          the cross-AI knowledge pool, and was
#                                          previously mislabelled "unknown/other")
# Match against the chat-session's stored model field (server.py:DEFAULT_MODEL
# and resolve_model() use a small set of identifiers).
AI_BUCKETS = ('claude', 'gpt', 'gemini', 'openrouter', 'shared')

# Human labels used anywhere the API needs to name a bucket.
BUCKET_LABEL = {
    'all': 'All models',
    'claude': 'Claude',
    'gpt': 'GPT',
    'gemini': 'Gemini',
    'openrouter': 'OpenRouter',
    'shared': 'Shared (all models)',
}


def _bucket_for_model(model: Optional[str]) -> str:
    m = (model or '').strip().lower()
    if not m or m == 'unknown':
        # No source model recorded → this learning applies to every AI.
        return 'shared'
    if 'claude' in m or 'anthropic' in m or 'sonnet' in m or 'opus' in m or 'haiku' in m:
        return 'claude'
    if 'gpt' in m or 'openai' in m or m.startswith('o1') or m.startswith('o3') or m.startswith('o4'):
        return 'gpt'
    if 'gemini' in m or 'google' in m:
        return 'gemini'
    # Everything else the app can reach goes through OpenRouter
    # (grok, llama, deepseek, mistral, qwen, …).
    return 'openrouter'


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
    # Per-bucket breakdown of the *exact* model identifiers behind each card,
    # so the UI can expand a card and show which concrete models contributed
    # (e.g. the "other" card unpacks into gemini-3-flash-preview, o3, …).
    # Keyed bucket → raw model id → {total, pending}.
    detail: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {'total': 0, 'pending': 0}))

    # `all` synthesises across every bucket so the UI can render a "headline"
    # card without re-summing client-side.
    for l in learnings:
        b = _bucket_for_model(l.get('source_model'))
        raw = (l.get('source_model') or '').strip()
        # A learning with no source model is part of the shared pool — show it
        # as "shared / all models" rather than the confusing "unknown".
        if not raw or raw.lower() == 'unknown':
            raw = 'shared / all models'
        enabled = bool(l.get('enabled'))
        auto = bool(l.get('auto_proposed'))
        for key in (b, 'all'):
            row = buckets[key]
            if enabled:
                row['total'] += 1
            elif auto:
                row['pending'] += 1
            created = _as_aware(l.get('created_at'))
            if created and created >= week_ago:
                row['last_7d'] += 1
            if auto:
                row['auto_proposed_total'] += 1
                if enabled:
                    row['approved'] += 1
            # Track the concrete model under both its own bucket and `all`.
            d = detail[key][raw]
            if enabled:
                d['total'] += 1
            elif auto:
                d['pending'] += 1

    def _breakdown(key: str) -> list[dict]:
        rows = [
            {'model': raw, 'total': v['total'], 'pending': v['pending']}
            for raw, v in detail.get(key, {}).items()
        ]
        # Most active first, then alphabetical for stability.
        rows.sort(key=lambda r: (-r['total'], r['model']))
        return rows

    # The shared pool is injected into EVERY AI's system prompt, so each
    # provider effectively "knows" its own directly-taught learnings PLUS the
    # whole shared pool. Surfacing this as `effective_total` is what makes the
    # cards honest: GPT / Gemini / OpenRouter no longer read a misleading "0".
    shared_total = buckets['shared']['total']

    out = []
    # Stable ordering — headline first, then every provider we support plus the
    # shared pool. We ALWAYS emit each bucket (even at zero) so the view is
    # complete and an AI with no learnings still shows up.
    for key in ('all', *AI_BUCKETS):
        b = buckets[key]  # defaultdict → zero-filled if the bucket was empty
        approval_rate = (b['approved'] / b['auto_proposed_total']) if b['auto_proposed_total'] else None
        # A specific provider inherits the shared pool on top of its own
        # directly-taught learnings. 'all' already counts everything and
        # 'shared' is the pool itself, so neither double-counts.
        is_provider = key not in ('all', 'shared')
        effective_total = b['total'] + shared_total if is_provider else b['total']
        out.append({
            'model': key,
            'label': BUCKET_LABEL.get(key, key.title()),
            'total': b['total'],
            'pending': b['pending'],
            # How much this AI actually knows once the shared pool is applied.
            'effective_total': effective_total,
            # Of `effective_total`, how much came from the shared pool vs.
            # being taught directly to this AI. Lets the UI say "N direct + M shared".
            'shared_total': shared_total if is_provider else 0,
            'inherits_shared': is_provider,
            'last_7d_added': b['last_7d'],
            'approval_rate': round(approval_rate, 3) if approval_rate is not None else None,
            'auto_proposed_total': b['auto_proposed_total'],
            'breakdown': _breakdown(key),
        })
    return {'models': out, 'default_model': DEFAULT_MODEL}


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

    def _zero_counts() -> dict[str, int]:
        return {**{b: 0 for b in AI_BUCKETS}, 'all': 0}

    rows: dict[str, dict[str, int]] = defaultdict(_zero_counts)
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
            out.append({'week': wk, 'counts': rows.get(wk, _zero_counts())})
            seen.add(wk)
        cursor += timedelta(days=7)
    # Always include the *current* week even if cursor stepped past it.
    cur_wk = _week_key(now)
    if cur_wk not in seen:
        out.append({'week': cur_wk, 'counts': rows.get(cur_wk, _zero_counts())})
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


# ===================================================================
# Cross-AI learning — proposals queue + one-press sync
# -------------------------------------------------------------------
# Every ENABLED learning is already injected into the shared system prompt,
# so all AIs read the same knowledge. What makes an AI "behind" is having
# auto-proposed learnings that the operator hasn't reviewed yet. This section
# lets the operator:
#   • see each pending proposal, which AI raised it, and Add or Skip it
#   • see which AIs are "not up to date" (have unreviewed proposals)
#   • press one button to bring everything up to date
# ===================================================================
def _proposal_public(l: dict) -> dict:
    bucket = _bucket_for_model(l.get('source_model'))
    created = _as_aware(l.get('created_at'))
    return {
        'id': l.get('id'),
        'text': l.get('text'),
        'source_ai': bucket,
        'source_ai_label': BUCKET_LABEL.get(bucket, bucket.title()),
        'source_model': l.get('source_model'),
        'source': l.get('source'),
        'created_at': created.isoformat() if created else None,
    }


async def _pending_proposals() -> list[dict]:
    """Auto-proposed learnings the operator hasn't approved or skipped yet."""
    docs = await db.ai_learnings.find({
        'auto_proposed': True,
        'enabled': {'$ne': True},
        'archived': {'$ne': True},
    }).sort('created_at', -1).to_list(500)
    return await _annotate_with_model(docs)


async def _sync_meta() -> dict:
    doc = await db.ai_brain_meta.find_one({'_id': 'sync'}) or {}
    ls = _as_aware(doc.get('last_synced_at'))
    return {
        'last_synced_at': ls.isoformat() if ls else None,
        'last_synced_by': doc.get('last_synced_by'),
    }


@router.get('/proposals')
async def list_proposals(_op: dict = Depends(get_current_operator)):
    """Full review queue — newest first — with the source AI attached."""
    pending = await _pending_proposals()
    return {
        'proposals': [_proposal_public(l) for l in pending],
        'count': len(pending),
    }


@router.get('/sync-status')
async def sync_status(_op: dict = Depends(get_current_operator)):
    """Per-AI up-to-date status. An AI is 'behind' if it has unreviewed
    proposals. Always returns every bucket so the field is complete."""
    pending = await _pending_proposals()
    by_bucket: dict[str, int] = defaultdict(int)
    for l in pending:
        by_bucket[_bucket_for_model(l.get('source_model'))] += 1

    ais = [{
        'ai': b,
        'label': BUCKET_LABEL.get(b, b.title()),
        'pending': by_bucket.get(b, 0),
        'up_to_date': by_bucket.get(b, 0) == 0,
    } for b in AI_BUCKETS]

    meta = await _sync_meta()
    return {
        'ais': ais,
        'pending_total': len(pending),
        'all_up_to_date': len(pending) == 0,
        **meta,
    }


@router.post('/proposals/{learning_id}/approve')
async def approve_proposal(learning_id: str, _op: dict = Depends(get_current_operator)):
    """Add a proposal to the shared brain — every AI picks it up next reply."""
    res = await db.ai_learnings.update_one(
        {'id': learning_id},
        {'$set': {'enabled': True, 'updated_at': datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, 'Proposal not found')
    return {'approved': learning_id}


@router.post('/proposals/{learning_id}/skip')
async def skip_proposal(learning_id: str, _op: dict = Depends(get_current_operator)):
    """Skip a proposal — soft-archived so it leaves the queue but the audit
    trail is kept (never silently deleted)."""
    res = await db.ai_learnings.update_one(
        {'id': learning_id},
        {'$set': {'archived': True, 'archived_at': datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, 'Proposal not found')
    return {'skipped': learning_id}


@router.post('/sync')
async def sync_now(payload: dict = Body(default={}), op: dict = Depends(get_current_operator)):
    """One-press sync: approve every pending proposal so all AIs are up to
    date. Pass {"ai": "gpt"} to bring a single AI up to date instead."""
    only = (payload or {}).get('ai')
    pending = await _pending_proposals()
    if only:
        pending = [l for l in pending if _bucket_for_model(l.get('source_model')) == only]

    ids = [l.get('id') for l in pending if l.get('id')]
    approved = 0
    if ids:
        res = await db.ai_learnings.update_many(
            {'id': {'$in': ids}},
            {'$set': {'enabled': True, 'updated_at': datetime.now(timezone.utc)}},
        )
        approved = int(res.modified_count)

    now = datetime.now(timezone.utc)
    await db.ai_brain_meta.update_one(
        {'_id': 'sync'},
        {'$set': {'last_synced_at': now, 'last_synced_by': op.get('email')}},
        upsert=True,
    )
    return {'approved': approved, 'ai': only or 'all', 'synced_at': now.isoformat()}
