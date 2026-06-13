"""Runtime error capture + RCA pipeline.

Captures runtime errors from BOTH layers and stores them in `runtime_errors`:

  - **Backend**: FastAPI exception middleware catches every unhandled
    exception and POSTs it to the same internal helper the frontend uses.
  - **Frontend**: `window.onerror` + React ErrorBoundary POST to
    `POST /api/runtime-errors` (open endpoint, rate-limited per IP).

The operator opens the new "Errors" tab in the console to:
  1. See the most recent errors with frequency + last-seen.
  2. Click "Run RCA" — the system asks an LLM to summarise the root
     cause and propose a one-line code fix path.
  3. Click "Open in Sandbox" — deep-link to the Sandbox tab with the
     suggested file path pre-loaded.

This is the *foundational* version. Auto-patching is deliberately
deferred — the operator clicks-through to Sandbox for human review.
"""
import logging
import os
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

# Two routers — one *public* (frontend POSTs errors without auth, that's
# why we rate-limit by IP) and one *operator-only* (read/RCA/dismiss).
public_router = APIRouter(prefix='/api/runtime-errors', tags=['runtime-errors'])
op_router = APIRouter(prefix='/api/operator/runtime-errors', tags=['runtime-errors-operator'])


class ErrorReport(BaseModel):
    message: str = Field(min_length=1, max_length=4_000)
    stack: Optional[str] = Field(default=None, max_length=20_000)
    source: str = Field(default='frontend')  # 'frontend' | 'backend' | 'sandbox'
    url: Optional[str] = Field(default=None, max_length=1_000)
    user_agent: Optional[str] = Field(default=None, max_length=400)
    user_id: Optional[str] = None
    context: Optional[dict] = None


def _signature(report: ErrorReport) -> str:
    """Group errors with the same root signature so frequency counts make
    sense. Pulls the first line of the stack (or message) — same heuristic
    Sentry uses."""
    base = (report.stack or report.message or '').split('\n', 1)[0]
    # Strip volatile bits (line numbers, hashes) so similar errors collide.
    import re
    base = re.sub(r':\d+(:\d+)?', '', base)
    base = re.sub(r'[0-9a-f]{8,}', '*', base)
    return base.strip()[:300] or 'unknown'


# ---------- public ingest ----------

# Per-IP throttle. In-memory dict — fine for a single-pod preview. For
# multi-pod prod we'd swap in Redis, but the worst case is a noisy
# attacker spamming `runtime_errors` and we deal with that in the read
# path with a hash-based dedupe.
_RATE_BUCKET: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW_S = 60
_RATE_MAX = 30  # 30 reports / minute / IP


def _rate_limited(ip: str) -> bool:
    import time
    now = time.time()
    bucket = _RATE_BUCKET[ip]
    # Drop stale entries
    bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW_S]
    if len(bucket) >= _RATE_MAX:
        return True
    bucket.append(now)
    return False


@public_router.post('', status_code=202)
async def ingest(report: ErrorReport, request: Request):
    """Open ingest — frontend ErrorBoundary calls this. Rate-limited by
    IP. Stores raw + signature so the operator dashboard can group by
    fingerprint."""
    ip = request.client.host if request.client else 'unknown'
    if _rate_limited(ip):
        # Soft-fail — we don't want to break the page rendering an error
        # toast because we rate-limited the error report itself.
        return {'accepted': False, 'reason': 'rate_limited'}
    sig = _signature(report)
    now = datetime.now(timezone.utc)
    doc = {
        'id': str(uuid.uuid4()),
        'signature': sig,
        'message': report.message[:4_000],
        'stack': (report.stack or '')[:20_000],
        'source': report.source,
        'url': report.url,
        'user_agent': report.user_agent,
        'user_id': report.user_id,
        'context': report.context or {},
        'ip': ip,
        'created_at': now,
        'last_seen_at': now,
        'count': 1,
        'rca': None,           # populated by /rca/{id}
        'dismissed_at': None,
    }
    # Increment count if signature already exists (within 24h); else insert.
    existing = await db.runtime_errors.find_one({
        'signature': sig,
        'created_at': {'$gte': now - timedelta(hours=24)},
        'dismissed_at': None,
    })
    if existing:
        await db.runtime_errors.update_one(
            {'id': existing['id']},
            {'$inc': {'count': 1}, '$set': {'last_seen_at': now,
                                            'stack': doc['stack'] or existing.get('stack', ''),
                                            'url': doc['url'] or existing.get('url')}},
        )
        return {'accepted': True, 'merged_into': existing['id']}
    await db.runtime_errors.insert_one(doc)
    return {'accepted': True, 'id': doc['id']}


# ---------- operator read/RCA ----------

def _serialize(d: dict) -> dict:
    return {
        'id': d.get('id'),
        'signature': d.get('signature'),
        'message': d.get('message'),
        'stack': d.get('stack'),
        'source': d.get('source'),
        'url': d.get('url'),
        'user_id': d.get('user_id'),
        'count': int(d.get('count') or 1),
        'created_at': d['created_at'].isoformat() if d.get('created_at') else None,
        'last_seen_at': d['last_seen_at'].isoformat() if d.get('last_seen_at') else None,
        'rca': d.get('rca'),
        'dismissed': bool(d.get('dismissed_at')),
    }


@op_router.get('')
async def list_errors(
    include_dismissed: bool = False,
    _op: dict = Depends(get_current_operator),
):
    """Newest-first error list with frequency counts. By default hides
    dismissed errors so the dashboard isn't cluttered with old noise."""
    q: dict = {} if include_dismissed else {'dismissed_at': None}
    cursor = db.runtime_errors.find(q).sort('last_seen_at', -1).limit(200)
    return [_serialize(d) async for d in cursor]


@op_router.post('/{error_id}/rca')
async def run_rca(error_id: str, _op: dict = Depends(get_current_operator)):
    """Ask an LLM for a root-cause analysis + one-line fix suggestion.
    Persists the RCA on the doc so subsequent calls return the cached
    answer instead of re-prompting (the operator clicks "Re-run RCA" to
    force a refresh).
    """
    doc = await db.runtime_errors.find_one({'id': error_id})
    if not doc:
        raise HTTPException(404, 'Error not found')

    api_key = os.environ.get('EMERGENT_LLM_KEY') or ''
    if not api_key:
        raise HTTPException(503, 'EMERGENT_LLM_KEY not configured')

    # Operator-configurable RCA model — falls back to claude-sonnet (the
    # iter17-validated default) when no setting is present. Set via
    # `settings.rca_model` in MongoDB or via the Operator → Security tab.
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    rca_model_id = (settings.get('rca_model') or '').strip()
    # Map provider for emergentintegrations.
    _rca_provider_map = {
        'claude-opus-4-7': 'anthropic',
        'claude-sonnet-4-6': 'anthropic',
        'claude-haiku-4-5-20251001': 'anthropic',
        'gpt-5.4': 'openai',
        'gpt-5.4-mini': 'openai',
        'gpt-4.1': 'openai',
        'gemini-3.1-pro-preview': 'gemini',
        'gemini-3-flash-preview': 'gemini',
    }
    if rca_model_id not in _rca_provider_map:
        rca_model_id = 'claude-sonnet-4-6'
    rca_provider = _rca_provider_map[rca_model_id]

    prompt = (
        f"Error message: {doc.get('message', '')}\n\n"
        f"Stack trace (truncated):\n{(doc.get('stack') or '')[:3_000]}\n\n"
        f"Source: {doc.get('source')}  URL: {doc.get('url') or '—'}\n"
        f"Seen {doc.get('count', 1)} time(s).\n\n"
        "Provide a SHORT root-cause analysis (2-3 sentences) and exactly "
        "one suggested file path + change. Respond strictly as JSON with "
        "keys: root_cause (string), suggested_file (string or null), "
        "suggested_change (string), confidence (low|medium|high)."
    )
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone
        chat = LlmChat(
            api_key=api_key,
            session_id=f'rca-{uuid.uuid4()}',
            system_message=(
                'You are a senior site-reliability engineer doing fast RCA. '
                'Be terse. Only return valid JSON.'
            ),
        ).with_model(rca_provider, rca_model_id)
        full = ''
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                full += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        raise HTTPException(502, f'LLM RCA failed: {e}')

    # Parse the JSON envelope. Lenient — if the model adds a code-fence
    # we strip it before json.loads. When the envelope is malformed we
    # still surface the raw text but tag `parse_fallback:true` so the UI
    # can render a "raw output" warning instead of pretending we got a
    # structured response.
    import json
    import re
    cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', full.strip(), flags=re.MULTILINE)
    try:
        rca = json.loads(cleaned)
        rca['parse_fallback'] = False
    except Exception:
        rca = {
            'root_cause': full.strip()[:600],
            'suggested_file': None,
            'suggested_change': '',
            'confidence': 'low',
            'parse_fallback': True,
        }
    rca['generated_at'] = datetime.now(timezone.utc).isoformat()
    rca['model'] = rca_model_id
    await db.runtime_errors.update_one(
        {'id': error_id}, {'$set': {'rca': rca}},
    )
    return rca


@op_router.post('/{error_id}/dismiss')
async def dismiss(error_id: str, _op: dict = Depends(get_current_operator)):
    """Mark error as resolved. When the doc has a *high-confidence RCA*,
    we also propose an AI Learning so the AI inherits the lesson learned
    from this real production bug. Operator still has to approve the
    proposal in AI Learnings tab — fully reversible."""
    doc = await db.runtime_errors.find_one({'id': error_id})
    if not doc:
        raise HTTPException(404, 'Error not found')
    now = datetime.now(timezone.utc)
    await db.runtime_errors.update_one(
        {'id': error_id},
        {'$set': {'dismissed_at': now}},
    )
    proposed_learning_id = await _maybe_propose_learning_from_error(doc)
    return {
        'dismissed': error_id,
        'proposed_learning_id': proposed_learning_id,
    }


async def _maybe_propose_learning_from_error(err_doc: dict) -> Optional[str]:
    """When an error has a high-confidence RCA, distil it into a
    pending AI Learning. Returns the new learning's id (for the toast),
    or None when we skip (low confidence, no suggested change, already
    proposed for this signature, etc).

    Never raises — the dismiss flow must always succeed even if the
    learning insert fails.
    """
    try:
        rca = err_doc.get('rca') or {}
        if rca.get('confidence') != 'high':
            return None
        change = (rca.get('suggested_change') or '').strip()
        if not change:
            return None
        sig = err_doc.get('signature', '')
        # Idempotency — don't propose twice for the same error signature.
        already = await db.ai_learnings.find_one({'source_error_signature': sig})
        if already:
            return None
        suggested_file = rca.get('suggested_file') or ''
        text = (
            f'When working on {suggested_file or "the codebase"}: {change} '
            f'(learned from real production error: "{err_doc.get("message", "")[:120]}")'
        )
        new_id = str(uuid.uuid4())
        await db.ai_learnings.insert_one({
            'id': new_id,
            'text': text[:600],
            'enabled': False,  # operator approval gate
            'auto_proposed': True,
            'source': 'runtime_error',
            'source_error_id': err_doc.get('id'),
            'source_error_signature': sig,
            'created_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
            'created_by_email': 'auto-rca',
        })
        return new_id
    except Exception:
        logger.exception('Failed to propose learning from error')
        return None


@op_router.delete('/{error_id}')
async def delete_error(error_id: str, _op: dict = Depends(get_current_operator)):
    res = await db.runtime_errors.delete_one({'id': error_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Error not found')
    return {'deleted': error_id}


# ---------- backend exception ingestion ----------

async def capture_backend_exception(
    exc: BaseException,
    request: Optional[Request] = None,
) -> None:
    """Called from FastAPI's global exception handler in server.py.
    Never raises — runtime error capture must never amplify the problem."""
    try:
        import traceback
        stack = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__))[:20_000]
        report = ErrorReport(
            message=str(exc)[:4_000] or exc.__class__.__name__,
            stack=stack,
            source='backend',
            url=str(request.url) if request else None,
            user_agent=request.headers.get('user-agent') if request else None,
        )
        sig = _signature(report)
        now = datetime.now(timezone.utc)
        existing = await db.runtime_errors.find_one({
            'signature': sig,
            'created_at': {'$gte': now - timedelta(hours=24)},
            'dismissed_at': None,
        })
        if existing:
            await db.runtime_errors.update_one(
                {'id': existing['id']},
                {'$inc': {'count': 1}, '$set': {'last_seen_at': now}},
            )
            return
        await db.runtime_errors.insert_one({
            'id': str(uuid.uuid4()),
            'signature': sig,
            'message': report.message,
            'stack': report.stack or '',
            'source': 'backend',
            'url': report.url,
            'user_agent': report.user_agent,
            'created_at': now,
            'last_seen_at': now,
            'count': 1,
            'rca': None,
            'dismissed_at': None,
        })
    except Exception:
        logger.exception('Failed to capture backend exception')
