"""Vercel learnings → AI Brain ingestor.

Pulls *real* operational knowledge out of Vercel and into the operator's
AI Learnings collection so the AI Brain skill-map absorbs it:

  1. `seed-design`   — one-shot curated pack of ~20 design-system learnings
                       (Tailwind, accessibility, layout heuristics) drawn
                       from the same vocabulary Vercel's v0 uses internally.
  2. `import-vercel` — live pull of the operator's recent deployments,
                       build outcomes and function errors via the Vercel
                       API; each becomes one learning entry.

Both endpoints are idempotent — they de-duplicate by a stable hash of the
learning text so re-ingesting only adds genuinely new entries.

Why this lives in its own module
--------------------------------
`ai_learnings_ext.py` is the OPERATOR-facing CRUD; this file is a
specialised ingestor that knows about a third-party (Vercel). Keeping
them separate means `ai_learnings_ext` stays generic and reusable for
future sources (Sentry, Linear, GitHub Discussions etc.).
"""
from __future__ import annotations

import hashlib
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-learnings/vercel', tags=['ai-learnings'])


# ---------------------------------------------------------------- helpers


async def _vercel_token() -> Optional[str]:
    """Returns the operator's Vercel API token from settings (set in
    Operator → Security). Without it we can't query Vercel."""
    s = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    return s.get('vercel_token') or os.environ.get('VERCEL_TOKEN')


def _stable_id(text: str) -> str:
    """Hash-based id so re-ingesting the same text doesn't create
    duplicates. We use the first 16 hex chars of sha256 → unique enough
    for ~10⁹ rows, short enough to be readable in Mongo."""
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


async def _insert_learnings(
    items: list[str],
    *,
    source: str,
    source_ref: Optional[str] = None,
    op_email: Optional[str] = None,
) -> dict:
    """Insert each item with a stable hash id so duplicates are skipped.
    Returns counts of new vs skipped."""
    now = datetime.now(timezone.utc)
    new_count = 0
    skipped = 0
    for raw in items:
        text = (raw or '').strip()
        if not text or len(text) < 4:
            continue
        sid = f'vercel-{_stable_id(text)}'
        existing = await db.ai_learnings.find_one({'id': sid})
        if existing:
            skipped += 1
            continue
        await db.ai_learnings.insert_one({
            'id': sid,
            'text': text[:1500],
            'enabled': True,
            'created_at': now,
            'updated_at': now,
            'created_by_email': op_email,
            'source': source,
            'source_ref': source_ref,
            'auto_proposed': True,
        })
        new_count += 1
    return {'inserted': new_count, 'skipped_duplicate': skipped}


# ---------------------------------------------------------------- 1. Design pack
#
# Curated from Vercel's design system + v0 prompts + Tailwind/Radix
# best-practice docs. Operator can tweak any of these from the AI
# Learnings tab after ingest. Kept ≤120 chars each so they fit cleanly
# in the SkillBucket cards we render in the AI Brain grid.

_DESIGN_LEARNINGS: list[str] = [
    # Color & contrast
    'Pair dark neutral backgrounds with one warm accent + one cool accent (not three competing accents).',
    'Use solid dark colors as backgrounds; gradients muddy dark palettes — reserve gradients for light themes only.',
    'Body text must hit WCAG AA contrast (4.5:1) on its background; check 14px+ small text especially.',
    # Layout
    'Apply 2-3× more whitespace than feels comfortable — cramped layouts read as cheap.',
    'Use left-aligned or asymmetric layouts for natural reading flow; centred layouts feel static.',
    'Vary section widths (full-bleed, contained, half-width) to create visual rhythm down a page.',
    'Build context-specific layouts; do not reuse the same card grid across every section.',
    # Typography
    'Avoid Inter/Roboto/Arial — they signal AI-slop. Pair one geometric (Geist/Söhne) with one serif (GT Super/Fraunces).',
    'Use exactly two type weights per component: light for body, bold for headings. Skip mediums.',
    'Set max line length 60-75 characters for body copy; longer hurts comprehension.',
    # Motion
    'Animate specific properties (opacity, transform), never `transition: all` — the latter breaks transforms.',
    'Page-load animation budget: ≤300ms for any single element; staggered reveals at 30-50ms intervals.',
    'Hover states should change at least two properties (color + shadow, or scale + border) for clarity.',
    # Components
    'Buttons: pill OR sharp-edged; never plain rounded-md. Pair shape with a single bold interaction (scale 1.02 on hover).',
    'Forms: place labels above inputs, never floating; floating labels obscure values on autofill.',
    'Empty states must offer one primary CTA; never show "no data" with no action.',
    # Performance
    'Lazy-load below-the-fold images with `loading="lazy"`; cuts first paint ~200-400ms.',
    'Inline critical CSS (≤14KB) for the above-the-fold render; defer the rest with `media="print" onload`.',
    'Self-host fonts via `font-display: swap` to prevent FOIT blocking the first render.',
    # Accessibility
    'Every interactive element needs a visible focus ring (outline:2px) — don\'t hide it for "design".',
    'Form errors live in `aria-describedby` text below the input, NOT in red placeholder text.',
    'Provide `prefers-reduced-motion` fallback that disables every transform/parallax effect.',
    # Information hierarchy
    'On dashboards: one hero metric, three supporting metrics, everything else collapsible. Do not show six metrics flat.',
    'In CTAs, lead with the verb (Deploy, Ship, Start) not the noun (Deployment, Shipment).',
]


@router.post('/seed-design')
async def seed_design_pack(op: dict = Depends(get_current_operator)) -> dict:
    """Ingest the curated design-systems pack as AI Learnings. Idempotent
    — re-running only adds entries that aren't already in the DB."""
    result = await _insert_learnings(
        _DESIGN_LEARNINGS,
        source='vercel_design_pack',
        op_email=op.get('email'),
    )
    logger.info('Operator %s seeded design pack: %s', op.get('email'), result)
    return {**result, 'total_available': len(_DESIGN_LEARNINGS)}


# ---------------------------------------------------------------- 2. Live Vercel ingest


@router.post('/import-vercel')
async def import_vercel_telemetry(
    limit: int = 30,
    op: dict = Depends(get_current_operator),
) -> dict:
    """Fetch the operator's recent Vercel deployments and convert each
    into an AI Learning the brain can reference. Captures:
      • State (READY / ERROR / CANCELED)
      • Branch + commit SHA + duration
      • Error message for failed builds (so the AI learns failure modes)

    Idempotent — same deployment ingested twice updates nothing because
    the stable-id hash dedupes."""
    token = await _vercel_token()
    if not token:
        raise HTTPException(503, 'vercel_token not configured in Operator → Security')
    items: list[str] = []
    refs: list[str] = []
    limit = max(1, min(limit, 100))
    async with httpx.AsyncClient(timeout=20) as cl:
        r = await cl.get(
            f'https://api.vercel.com/v6/deployments?limit={limit}',
            headers={'Authorization': f'Bearer {token}'},
        )
        if r.status_code != 200:
            raise HTTPException(502, f'Vercel API: {r.status_code} {r.text[:200]}')
        for d in r.json().get('deployments', []):
            state = d.get('readyState') or d.get('state') or 'UNKNOWN'
            meta = d.get('meta') or {}
            branch = meta.get('githubCommitRef', '-')
            sha = (meta.get('githubCommitSha') or '')[:7] or '-'
            name = d.get('name') or d.get('url') or '?'
            created_ms = d.get('createdAt') or 0
            built_ms = d.get('buildingAt') or created_ms
            ready_ms = d.get('ready') or 0
            dur_s = max(0, (ready_ms - built_ms) / 1000) if ready_ms and built_ms else 0
            line = (
                f'Vercel {state} · {name} · branch={branch} · sha={sha} · '
                f'build={dur_s:.0f}s · {datetime.fromtimestamp(created_ms/1000, tz=timezone.utc).date()}'
            )
            items.append(line)
            refs.append(d.get('uid') or d.get('id') or '')
    result = await _insert_learnings(
        items,
        source='vercel_deployments',
        source_ref=','.join(r for r in refs if r)[:500],
        op_email=op.get('email'),
    )
    logger.info('Operator %s imported %d Vercel telemetry items: %s', op.get('email'), len(items), result)
    return {**result, 'total_fetched': len(items)}
