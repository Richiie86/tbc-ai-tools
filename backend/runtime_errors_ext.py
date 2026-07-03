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


# Severity heuristics — keyword patterns. First match wins. Kept small +
# readable on purpose: adding a category is one line. Severity drives the
# auto-page gate: anything `critical` triggers an immediate operator
# email; `warning` and below are silent.
import re as _re_sev
SEVERITY_RULES: list[tuple[str, str]] = [
    ('critical', r'\b(out of memory|segmentation fault|database connection|connection refused|cannot connect|deadlock|stripe.*declined|payment.*failed|chunkloaderror)\b'),
    ('high',     r'\b(unauthorized|forbidden|csrf|cors|invalid token|jwt|webhook.*fail|500|502|503|504)\b'),
    ('warning',  r'\b(typeerror|referenceerror|undefined is not|cannot read|null is not)\b'),
]


def _classify_severity(report: ErrorReport) -> str:
    """Returns 'critical' | 'high' | 'warning' | 'info'. Pure function,
    safe to call inline during ingest. The same heuristic is used for
    backend exceptions via _signature(report)."""
    text = f'{report.message or ""} {(report.stack or "")[:1000]}'.lower()
    for sev, pattern in SEVERITY_RULES:
        if _re_sev.search(pattern, text):
            return sev
    return 'info'


async def _maybe_page_operator(doc: dict) -> None:
    """Fire-and-forget operator notification when severity == 'critical'.
    Throttled to once per (signature, 1h) so a runaway loop doesn't spam
    inboxes. Never raises — capture flow must always succeed.

    IMPORTANT ordering: we insert the throttle row BEFORE attempting the
    email so a failing email server (e.g. Resend down, RESEND_API_KEY
    missing) doesn't silently disable the throttle. The throttle row IS
    the rate-limit primitive; emailing is the side-effect.
    """
    try:
        if doc.get('severity') != 'critical':
            return
        sig = doc.get('signature', '')
        from datetime import timedelta
        one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
        recent_page = await db.runtime_error_pages.find_one({
            'signature': sig, 'paged_at': {'$gte': one_hour_ago},
        })
        if recent_page:
            return
        settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
        op_email = settings.get('operator_email') or (
            (await db.users.find_one({'role': 'operator'}, {'email': 1})) or {}
        ).get('email')
        if not op_email:
            return
        # 1. INSERT the throttle row first — this is what prevents the
        #    next ingest from re-attempting, even if the email below
        #    fails. Without this ordering, a misconfigured email provider
        #    means every critical ingest re-tries indefinitely.
        await db.runtime_error_pages.insert_one({
            'signature': sig,
            'error_id': doc.get('id'),
            'paged_at': datetime.now(timezone.utc),
            'paged_to': op_email,
        })
        # 2. Best-effort email send — failures here are logged but don't
        #    roll back the throttle.
        try:
            from email_utils import send_email
            subject = f'🚨 Critical error: {doc.get("message", "")[:80]}'
            body = (
                f'<p><strong>Severity:</strong> CRITICAL · <strong>Source:</strong> {doc.get("source")}'
                f' · <strong>Count:</strong> {doc.get("count", 1)}</p>'
                f'<p><strong>Message:</strong></p>'
                f'<pre style="background:#1f1f23;color:#f5f5f5;padding:12px;border-radius:6px;font-family:monospace;">'
                f'{(doc.get("message") or "")[:600]}</pre>'
                + (f'<p><strong>URL:</strong> {doc.get("url")}</p>' if doc.get("url") else '')
                + '<p>Open <strong>Operator → Errors</strong> to run RCA and dispatch a fix.</p>'
            )
            await send_email(op_email, subject, body)
        except Exception as e:
            logger.warning('auto-page send_email failed (throttle row was still inserted): %s', e)
        # 3. Best-effort Slack/Discord webhook — same fire-and-forget posture.
        try:
            from webhook_ext import send_event
            await send_event(
                f'Critical error · {doc.get("source", "?")} · {(doc.get("message") or "")[:200]}',
                kind='critical',
            )
        except Exception as e:
            logger.warning('auto-page webhook send failed: %s', e)
    except Exception:
        logger.exception('auto-page operator failed')


# ---------- public ingest ----------

# Per-IP throttle. In-memory dict — fine for a single-pod preview. For
# multi-pod prod we use Redis (configured via REDIS_URL env var). When
# REDIS_URL is set we INCR + EXPIRE per IP per minute. If the Redis call
# fails for any reason we fall back to the in-memory bucket so the
# ingest endpoint never hard-fails on a rate-limit lookup.
_RATE_BUCKET: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW_S = 60
_RATE_MAX = 30  # 30 reports / minute / IP

_REDIS_URL = os.environ.get('REDIS_URL')
_UPSTASH_URL = os.environ.get('UPSTASH_REDIS_REST_URL')
_UPSTASH_TOKEN = os.environ.get('UPSTASH_REDIS_REST_TOKEN')
_redis_client = None  # lazy-init — either an upstash-redis async client OR a redis.asyncio client
_redis_kind: str | None = None  # 'upstash' | 'tcp' | None — set after first successful ping
# When Redis fails we don't disable it for the whole process anymore —
# we just back off for a short cooldown. That way a transient KV outage
# self-heals without needing a backend restart.
_REDIS_COOLDOWN_S = 60
_redis_disabled_until: float = 0.0


def _redis_configured() -> bool:
    """True if either backend is wired."""
    return bool((_UPSTASH_URL and _UPSTASH_TOKEN) or _REDIS_URL)


def _client_ip(request: Request) -> str:
    """Return the *real* end-user IP, honouring X-Forwarded-For when the
    request comes through an ingress/reverse-proxy (Kubernetes ingress,
    Cloudflare, Vercel etc.). Falls back to `request.client.host` if the
    header is absent.

    Spoof-resistance: when the env var `TRUSTED_PROXIES` is set (a
    comma-separated CIDR list, e.g. `10.0.0.0/8,172.16.0.0/12`) we only
    honour XFF when the *direct* peer IP (request.client.host) is inside
    that allowlist. Otherwise the header is ignored and the peer IP
    wins. This stops an external attacker spoofing XFF to bypass the
    per-IP rate-limit. When the env var is unset we trust the first hop
    (suitable for our K8s ingress topology — the ingress always
    appends).
    """
    peer = request.client.host if request.client else 'unknown'
    xff = request.headers.get('x-forwarded-for') or request.headers.get('X-Forwarded-For')
    if not xff:
        return peer
    trusted = _trusted_proxies()
    if trusted is not None and not _ip_in_any_cidr(peer, trusted):
        # Peer isn't a trusted proxy — XFF could be spoofed, ignore it.
        return peer
    first = xff.split(',', 1)[0].strip()
    return first or peer


# Cached trusted-proxy CIDR list. Re-parsed when the env var changes
# (rare; usually only on restart).
_TRUSTED_PROXIES_RAW: str | None = None
_TRUSTED_PROXIES_PARSED: list | None = None


def _trusted_proxies():
    """Returns the parsed CIDR list, or None if the env var is unset
    (in which case we trust the first XFF hop unconditionally — current
    behaviour). Lazy-parsed and cached."""
    global _TRUSTED_PROXIES_RAW, _TRUSTED_PROXIES_PARSED
    raw = os.environ.get('TRUSTED_PROXIES')
    if raw == _TRUSTED_PROXIES_RAW and _TRUSTED_PROXIES_PARSED is not None:
        return _TRUSTED_PROXIES_PARSED
    _TRUSTED_PROXIES_RAW = raw
    if not raw:
        _TRUSTED_PROXIES_PARSED = None
        return None
    import ipaddress
    parsed = []
    for piece in raw.split(','):
        piece = piece.strip()
        if not piece:
            continue
        try:
            parsed.append(ipaddress.ip_network(piece, strict=False))
        except ValueError:
            logger.warning('TRUSTED_PROXIES: ignoring invalid CIDR %r', piece)
    _TRUSTED_PROXIES_PARSED = parsed
    return parsed


def _ip_in_any_cidr(ip: str, networks: list) -> bool:
    """True if `ip` is inside any of `networks`. Safe on malformed input."""
    if not ip or ip == 'unknown':
        return False
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in n for n in networks)


async def _get_redis():
    """Lazy-init the shared Redis client. Returns None when Redis isn't
    configured OR is currently in cooldown after a recent failure (so
    transient outages self-heal automatically).

    Two backends supported:
      * Upstash REST  — when `UPSTASH_REDIS_REST_URL` + `_TOKEN` are set.
                        Uses the HTTPS REST API (works through firewalls
                        that block raw TCP, and matches how Vercel KV
                        ships credentials).
      * Redis TCP     — when `REDIS_URL` is set (`rediss://default:...`).
                        Native Redis protocol via `redis.asyncio`.
    REST is preferred when both are set because it avoids opening a
    persistent TCP socket from every backend pod.
    """
    global _redis_client, _redis_disabled_until, _redis_kind
    if not _redis_configured():
        return None
    import time
    if _redis_disabled_until and time.time() < _redis_disabled_until:
        return None
    if _redis_client is not None:
        return _redis_client
    try:
        if _UPSTASH_URL and _UPSTASH_TOKEN:
            from upstash_redis.asyncio import Redis as UpstashRedis
            _redis_client = UpstashRedis(url=_UPSTASH_URL, token=_UPSTASH_TOKEN)
            # Ping once so a bad token surfaces here rather than on every request.
            pong = await _redis_client.ping()
            if pong != 'PONG':
                raise RuntimeError(f'unexpected ping reply: {pong!r}')
            _redis_kind = 'upstash'
            logger.info('runtime-errors rate-limiter: Upstash REST ready (%s)', _UPSTASH_URL)
        else:
            from redis.asyncio import from_url
            _redis_client = from_url(
                _REDIS_URL,
                socket_connect_timeout=2,
                socket_timeout=2,
                decode_responses=True,
            )
            await _redis_client.ping()
            _redis_kind = 'tcp'
            logger.info('runtime-errors rate-limiter: Redis TCP ready (%s)', _REDIS_URL.split('@')[-1][:40])
        _redis_disabled_until = 0.0
    except Exception as e:  # noqa: BLE001
        logger.warning('Redis rate-limiter unavailable, falling back to in-memory for %ss: %s', _REDIS_COOLDOWN_S, e)
        _redis_client = None
        _redis_kind = None
        _redis_disabled_until = time.time() + _REDIS_COOLDOWN_S
    return _redis_client


def _rate_limited_inmem(ip: str) -> bool:
    """Local fallback — single-pod accurate, multi-pod undercounts."""
    import time
    now = time.time()
    bucket = _RATE_BUCKET[ip]
    bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW_S]
    if len(bucket) >= _RATE_MAX:
        return True
    bucket.append(now)
    return False


async def _rate_limited(ip: str) -> bool:
    """Cross-pod-correct rate limiter. Tries Redis first; falls back to
    the in-memory bucket if Redis is unset, in cooldown, or unreachable
    so the ingest endpoint stays available even when Vercel KV is
    having a bad day.
    """
    global _redis_disabled_until
    client = await _get_redis()
    if client is None:
        return _rate_limited_inmem(ip)
    try:
        # Fixed-window counter: key expires after _RATE_WINDOW_S, so the
        # worst case is a 2x burst across a boundary — acceptable for
        # spam protection.
        key = f'rl:rt_err:{ip}'
        count = await client.incr(key)
        if count == 1:
            await client.expire(key, _RATE_WINDOW_S)
        return count > _RATE_MAX
    except Exception as e:  # noqa: BLE001
        import time
        logger.warning('Redis rate-limit call failed, falling back to in-memory for %ss: %s', _REDIS_COOLDOWN_S, e)
        _redis_disabled_until = time.time() + _REDIS_COOLDOWN_S
        return _rate_limited_inmem(ip)


@public_router.post('', status_code=202)
async def ingest(report: ErrorReport, request: Request):
    """Open ingest — frontend ErrorBoundary calls this. Rate-limited by
    IP (Redis when REDIS_URL is set, in-memory otherwise). Stores raw +
    signature so the operator dashboard can group by fingerprint."""
    ip = _client_ip(request)
    if await _rate_limited(ip):
        # Soft-fail — we don't want to break the page rendering an error
        # toast because we rate-limited the error report itself.
        return {'accepted': False, 'reason': 'rate_limited'}
    sig = _signature(report)
    severity = _classify_severity(report)
    now = datetime.now(timezone.utc)
    doc = {
        'id': str(uuid.uuid4()),
        'signature': sig,
        'message': report.message[:4_000],
        'stack': (report.stack or '')[:20_000],
        'source': report.source,
        'severity': severity,
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
        # Re-fetch so the paging heuristic has the updated count.
        existing['count'] = int(existing.get('count', 0)) + 1
        existing['severity'] = existing.get('severity') or severity
        await _maybe_page_operator(existing)
        return {'accepted': True, 'merged_into': existing['id']}
    await db.runtime_errors.insert_one(doc)
    await _maybe_page_operator(doc)
    return {'accepted': True, 'id': doc['id'], 'severity': severity}


# ---------- operator read/RCA ----------

def _serialize(d: dict) -> dict:
    return {
        'id': d.get('id'),
        'signature': d.get('signature'),
        'message': d.get('message'),
        'stack': d.get('stack'),
        'source': d.get('source'),
        'severity': d.get('severity') or 'info',
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


@op_router.get('/limiter-status')
async def limiter_status(_op: dict = Depends(get_current_operator)):
    """Returns the live state of the runtime-errors rate-limiter so the
    operator can see at a glance whether requests are being counted in
    Upstash/Redis (cross-pod-correct) or in-memory (per-pod). Exposes:

    - `configured`: bool — is `REDIS_URL` or `UPSTASH_*` env set
    - `state`: 'live' | 'cooldown' | 'off' — current effective state
    - `backend`: 'tcp' | 'upstash' | 'inmem' — which backend is active
    - `cooldown_remaining_s`: int (>=0) — seconds until next Redis retry
    - `host`: str — masked host of the configured Redis (for the UI tooltip)
    - `trusted_proxies_configured`: bool
    - `window_s` / `max_per_window`: ints — the bucket config
    """
    import time
    now = time.time()
    cooldown_left = int(max(0, _redis_disabled_until - now)) if _redis_disabled_until else 0
    if not _redis_configured():
        state, backend = 'off', 'inmem'
    elif cooldown_left > 0:
        state, backend = 'cooldown', 'inmem'
    elif _redis_client is None:
        # Configured but not yet lazy-inited — counts as off until first request.
        state, backend = 'off', 'inmem'
    else:
        state, backend = 'live', _redis_kind or 'inmem'

    host = None
    if _UPSTASH_URL:
        host = _UPSTASH_URL.replace('https://', '').replace('http://', '')
    elif _REDIS_URL:
        # Strip credentials but keep host:port for the UI tooltip.
        try:
            host = _REDIS_URL.split('@', 1)[1]
        except IndexError:
            host = '(redacted)'

    return {
        'configured': _redis_configured(),
        'state': state,
        'backend': backend,
        'cooldown_remaining_s': cooldown_left,
        'host': host,
        'trusted_proxies_configured': bool(os.environ.get('TRUSTED_PROXIES')),
        'window_s': _RATE_WINDOW_S,
        'max_per_window': _RATE_MAX,
    }


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

    from llm_router import any_provider_key_available
    api_key = ''  # legacy placeholder — llm_router uses per-provider keys
    if not await any_provider_key_available():
        raise HTTPException(503, 'No AI provider key configured (Operator → Security).')

    # Operator-configurable RCA model — falls back to claude-sonnet (the
    # iter17-validated default) when no setting is present. Set via
    # `settings.rca_model` in MongoDB or via the Operator → Security tab.
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    rca_model_id = (settings.get('rca_model') or '').strip()
    # Map model id to its provider.
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
        from llm_router import LlmChat, UserMessage, TextDelta, StreamDone
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


def _would_propose_learning(err_doc: dict) -> Optional[str]:
    """Returns the proposed learning *text* without writing anything to the
    DB — used by the UI to show 'This dismiss will propose a learning'
    inline before the operator clicks. Returns None when the gate doesn't
    fire (low confidence, empty suggestion, etc).
    """
    rca = err_doc.get('rca') or {}
    if rca.get('confidence') != 'high':
        return None
    change = (rca.get('suggested_change') or '').strip()
    if not change:
        return None
    suggested_file = rca.get('suggested_file') or ''
    return (
        f'When working on {suggested_file or "the codebase"}: {change} '
        f'(learned from real production error: "{err_doc.get("message", "")[:120]}")'
    )[:600]


@op_router.get('/{error_id}/dismiss-preview')
async def dismiss_preview(error_id: str, _op: dict = Depends(get_current_operator)):
    """Lightweight read-only — tells the UI whether dismissing this error
    will auto-propose a learning, and if so what the proposal would say."""
    doc = await db.runtime_errors.find_one({'id': error_id})
    if not doc:
        raise HTTPException(404, 'Error not found')
    proposed = _would_propose_learning(doc)
    return {
        'would_propose': proposed is not None,
        'preview_text': proposed,
    }


class DismissBody(BaseModel):
    """Optional body for dismiss — `skip_propose=true` lets the operator
    dismiss an error WITHOUT auto-proposing a Learning from its RCA.
    Useful for one-off errors that aren't worth teaching the AI about."""
    skip_propose: bool = False


@op_router.post('/{error_id}/dismiss')
async def dismiss(
    error_id: str,
    body: Optional[DismissBody] = None,
    _op: dict = Depends(get_current_operator),
):
    """Mark error as resolved. When the doc has a *high-confidence RCA*
    AND `skip_propose` is not set, we also propose an AI Learning so the
    AI inherits the lesson learned from this real production bug.
    Operator still has to approve the proposal in AI Learnings tab —
    fully reversible."""
    doc = await db.runtime_errors.find_one({'id': error_id})
    if not doc:
        raise HTTPException(404, 'Error not found')
    now = datetime.now(timezone.utc)
    await db.runtime_errors.update_one(
        {'id': error_id},
        {'$set': {'dismissed_at': now}},
    )
    skip = bool(body and body.skip_propose)
    proposed_learning_id = (
        None if skip else await _maybe_propose_learning_from_error(doc)
    )
    return {
        'dismissed': error_id,
        'proposed_learning_id': proposed_learning_id,
        'skipped_propose': skip,
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
        text = _would_propose_learning(err_doc)
        if not text:
            return None
        sig = err_doc.get('signature', '')
        # Idempotency — don't propose twice for the same error signature.
        already = await db.ai_learnings.find_one({'source_error_signature': sig})
        if already:
            return None
        new_id = str(uuid.uuid4())
        await db.ai_learnings.insert_one({
            'id': new_id,
            'text': text,
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
        severity = _classify_severity(report)
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
            existing['count'] = int(existing.get('count', 0)) + 1
            existing['severity'] = existing.get('severity') or severity
            await _maybe_page_operator(existing)
            return
        doc = {
            'id': str(uuid.uuid4()),
            'signature': sig,
            'message': report.message,
            'stack': report.stack or '',
            'source': 'backend',
            'severity': severity,
            'url': report.url,
            'user_agent': report.user_agent,
            'created_at': now,
            'last_seen_at': now,
            'count': 1,
            'rca': None,
            'dismissed_at': None,
        }
        await db.runtime_errors.insert_one(doc)
        await _maybe_page_operator(doc)
    except Exception:
        logger.exception('Failed to capture backend exception')
