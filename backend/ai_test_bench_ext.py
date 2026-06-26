"""AI Test Bench — per-model health/regression for every chat LLM.

The operator hits this from the new "AI Tests" tab to verify that every
chat model still responds (no provider outage), responds *fast* (latency
drift), and *respects active learnings* (regression check — the model
should follow whatever the operator approved in the AI Learnings tab).

Three canned probes per model, run *in parallel*:

  1. `health`     — single-token reply to "say hi". Pass = non-empty
                    response within timeout.
  2. `arithmetic` — "What is 17+25?". Pass = answer contains '42'.
                    Deterministic — surfaces model regressions
                    immediately.
  3. `learnings`  — sends a probe that targets an active learning the
                    operator has approved. Pass = response references the
                    learning's keyword. If there are no active learnings
                    we skip this probe gracefully.

Every run is persisted in `ai_model_tests` so the operator can see
*trend* over time. Endpoints are operator-only.
"""
import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    from emergentintegrations.llm.chat import LlmChat, UserMessage
except ModuleNotFoundError:
    # Emergent-only package is not available off-Emergent (e.g. Render).
    # The AI test bench degrades gracefully: _run_probe catches the
    # resulting error and reports it instead of crashing app startup.
    LlmChat = None  # type: ignore
    UserMessage = None  # type: ignore
from fastapi import APIRouter, Depends, HTTPException, Path, Query

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-tests', tags=['ai-tests'])

# Models to expose in the UI. Kept small & curated — running 14 probes
# every click would be slow + expensive. The operator can extend this
# list later if needed.
TEST_MODELS: list[dict] = [
    {'id': 'claude-opus-4-7',          'display': 'Claude Opus 4.7',       'provider': 'anthropic'},
    {'id': 'claude-sonnet-4-6',        'display': 'Claude Sonnet 4.6',     'provider': 'anthropic'},
    {'id': 'claude-haiku-4-5-20251001','display': 'Claude Haiku 4.5',      'provider': 'anthropic'},
    {'id': 'gpt-5.4',                  'display': 'GPT-5.4',               'provider': 'openai'},
    {'id': 'gpt-5.4-mini',             'display': 'GPT-5.4 mini',          'provider': 'openai'},
    {'id': 'gpt-4.1',                  'display': 'GPT-4.1',               'provider': 'openai'},
    {'id': 'gemini-3.1-pro-preview',   'display': 'Gemini 3.1 Pro',        'provider': 'gemini'},
    {'id': 'gemini-3-flash-preview',   'display': 'Gemini 3 Flash',        'provider': 'gemini'},
]

PROBE_TIMEOUT_S = 30.0  # per-probe ceiling; each model has 3 probes.


def _provider_for(model_id: str) -> str:
    for m in TEST_MODELS:
        if m['id'] == model_id:
            return m['provider']
    raise HTTPException(400, f'Unknown model: {model_id}')


async def _run_probe(
    model_id: str,
    provider: str,
    api_key: str,
    prompt: str,
    pass_check,  # callable(text) -> bool
) -> dict:
    """Run one probe and return a structured result dict.
    Never raises — captures exceptions and reports them.
    """
    started = time.perf_counter()
    text = ''
    err: Optional[str] = None
    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f'aitest-{uuid.uuid4()}',
            # Stay terse — we don't want SYSTEM_PROMPT learnings to leak
            # into the latency budget. The learnings-injection probe
            # explicitly re-injects them below.
            system_message='You are a brief test assistant. Reply in one sentence.',
        ).with_model(provider, model_id)
        async def _run():
            full = ''
            from emergentintegrations.llm.chat import TextDelta, StreamDone
            async for ev in chat.stream_message(UserMessage(text=prompt)):
                if isinstance(ev, TextDelta):
                    full += ev.content
                elif isinstance(ev, StreamDone):
                    break
            return full
        text = await asyncio.wait_for(_run(), timeout=PROBE_TIMEOUT_S)
    except asyncio.TimeoutError:
        err = f'timeout after {PROBE_TIMEOUT_S}s'
    except Exception as e:
        err = str(e)[:300]
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if err:
        return {'pass': False, 'latency_ms': elapsed_ms, 'error': err, 'response': ''}
    return {
        'pass': bool(text.strip()) and pass_check(text),
        'latency_ms': elapsed_ms,
        'error': None,
        'response': text.strip()[:500],
    }


async def _get_llm_key() -> str:
    """Pull the configured Emergent Universal Key from settings, mirroring
    how server.py builds chat clients. Raises 503 if the operator hasn't
    set it up yet."""
    s = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    # Honour BYO Anthropic/OpenAI keys; only 503 when no provider is set at all.
    from llm_router import resolve_llm_key, NO_LLM_PROVIDER_MSG
    key = resolve_llm_key(s)
    if not key:
        raise HTTPException(503, NO_LLM_PROVIDER_MSG)
    return key


async def _build_probes() -> list[dict]:
    """Build the three probes. The learnings probe is *only* included when
    there's at least one active learning to test against, otherwise it's
    auto-skipped so the result panel doesn't show a false-negative."""
    probes: list[dict] = [
        {
            'name': 'health',
            'prompt': 'Reply with exactly the word: pong',
            'pass_check': lambda t: 'pong' in t.lower(),
        },
        {
            'name': 'arithmetic',
            'prompt': 'What is 17 + 25? Reply with the number only.',
            'pass_check': lambda t: '42' in t,
        },
    ]
    learning = await db.ai_learnings.find_one({'enabled': True}, sort=[('created_at', -1)])
    if learning:
        text = learning.get('text', '')
        # Pick the longest non-stopword token from the learning so the probe
        # tests whether the model actually *attended to* the content, not
        # whether it parrots a stopword. First version of this probe picked
        # the first 4-12 char token which was often "INSIDE" or "When" —
        # almost every model failed it. The improved version below skips
        # common English stopwords and picks the longest distinctive word.
        STOPWORDS = {
            'when', 'then', 'with', 'this', 'that', 'from', 'into', 'your', 'their',
            'never', 'always', 'every', 'some', 'they', 'there', 'have', 'will',
            'inside', 'about', 'because', 'should', 'would', 'could', 'these',
            'those', 'where', 'which', 'while', 'after', 'before',
        }
        candidates = re.findall(r'\b([A-Za-z][A-Za-z0-9-]{4,18})\b', text)
        # Prefer the longest non-stopword.
        candidates = [c for c in candidates if c.lower() not in STOPWORDS]
        if candidates:
            token = max(candidates, key=len)
            probes.append({
                'name': 'learnings',
                'prompt': (
                    f'Read this rule and reply with one short sentence that '
                    f'follows it. Rule: "{text[:240]}"'
                ),
                # Loose match: token appears as substring OR any case variant.
                'pass_check': lambda t, _tok=token: _tok.lower() in t.lower(),
                'meta': {'token': token, 'learning_id': learning.get('id')},
            })
    return probes


async def _run_one_model(model_id: str, api_key: str) -> dict:
    provider = _provider_for(model_id)
    probes = await _build_probes()

    results = await asyncio.gather(*[
        _run_probe(model_id, provider, api_key, p['prompt'], p['pass_check'])
        for p in probes
    ], return_exceptions=False)

    probe_results = []
    for p, r in zip(probes, results):
        probe_results.append({
            'name': p['name'],
            **r,
            **({'meta': p.get('meta')} if p.get('meta') else {}),
        })

    overall_pass = all(r['pass'] for r in probe_results)
    avg_latency = int(sum(r['latency_ms'] for r in probe_results) / max(1, len(probe_results)))
    doc = {
        'id': str(uuid.uuid4()),
        'model': model_id,
        'created_at': datetime.now(timezone.utc),
        'pass': overall_pass,
        'avg_latency_ms': avg_latency,
        'probes': probe_results,
    }
    await db.ai_model_tests.insert_one(doc)
    # Strip mongo's _id before returning
    doc.pop('_id', None)
    return doc


@router.get('/models')
async def list_models(_op: dict = Depends(get_current_operator)):
    """Returns the list of probeable models with their *most recent* test
    result attached (so the table has a status the moment the tab opens
    — no double round-trip needed).
    """
    # Pull last run per model in one go (sort + dedupe in Python — cheap
    # for ~8 rows; saves writing a Mongo aggregation pipeline).
    cursor = db.ai_model_tests.find({}).sort('created_at', -1).limit(200)
    last_by_model: dict[str, dict] = {}
    async for d in cursor:
        if d['model'] not in last_by_model:
            d.pop('_id', None)
            # ISO-stringify the datetime for JSON safety
            if isinstance(d.get('created_at'), datetime):
                d['created_at'] = d['created_at'].isoformat()
            last_by_model[d['model']] = d
    return {
        'models': [
            {**m, 'last_test': last_by_model.get(m['id'])}
            for m in TEST_MODELS
        ],
    }


@router.post('/run/{model_id}')
async def run_one(
    model_id: str = Path(...),
    _op: dict = Depends(get_current_operator),
):
    """Run all probes against one model. Returns the freshly stored result.
    Synchronous — the UI shows a spinner. Total time is bounded by
    `PROBE_TIMEOUT_S` since probes run in parallel.
    """
    _provider_for(model_id)  # validates model
    api_key = await _get_llm_key()
    doc = await _run_one_model(model_id, api_key)
    # ISO-stringify for the response
    if isinstance(doc.get('created_at'), datetime):
        doc['created_at'] = doc['created_at'].isoformat()
    return doc


@router.post('/run-all')
async def run_all(_op: dict = Depends(get_current_operator)):
    """Fan-out across every TEST_MODELS entry in parallel. Returns the new
    state of `/models` so the UI can update in one round-trip."""
    api_key = await _get_llm_key()
    results = await asyncio.gather(*[
        _run_one_model(m['id'], api_key) for m in TEST_MODELS
    ], return_exceptions=True)
    # Surface any per-model exceptions as failed rows rather than 500-ing
    # the whole batch — operator probably still wants to see partial results.
    out = []
    for m, r in zip(TEST_MODELS, results):
        if isinstance(r, Exception):
            out.append({
                **m,
                'last_test': {
                    'pass': False, 'avg_latency_ms': 0,
                    'error': str(r)[:300],
                    'created_at': datetime.now(timezone.utc).isoformat(),
                },
            })
        else:
            if isinstance(r.get('created_at'), datetime):
                r['created_at'] = r['created_at'].isoformat()
            out.append({**m, 'last_test': r})
    return {'models': out}


@router.get('/history')
async def history(
    model: str = Query(...),
    days: int = Query(7, ge=1, le=90),
    _op: dict = Depends(get_current_operator),
):
    """Last N days of runs for one model — for the per-model expand panel
    in the UI (sparkline of pass-rate / latency over time)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    cursor = db.ai_model_tests.find(
        {'model': model, 'created_at': {'$gte': cutoff}},
    ).sort('created_at', -1).limit(500)
    out = []
    async for d in cursor:
        d.pop('_id', None)
        if isinstance(d.get('created_at'), datetime):
            d['created_at'] = d['created_at'].isoformat()
        out.append(d)
    return {'history': out}


# ---------- Nightly drift-alert cron ----------

async def _nightly_drift_alert() -> dict:
    """Run every model's probes, compare to *yesterday's* run for the same
    model, and email the operator if any model flipped PASS → FAIL or its
    avg-latency degraded by >50%. Designed for APScheduler — never raises.

    Idempotent: stores a `nightly_runs` doc per UTC date so it won't re-fire
    if the scheduler triggers twice in the same day.
    """
    import os
    today = datetime.now(timezone.utc).date().isoformat()
    # Idempotency guard.
    existing = await db.nightly_runs.find_one({'_id': f'aitest-{today}'})
    if existing:
        return {'skipped': True, 'reason': 'already ran today'}

    api_key = os.environ.get('EMERGENT_LLM_KEY') or ''
    if not api_key:
        return {'skipped': True, 'reason': 'no llm key'}

    # Snapshot yesterday's results so we can diff after the run.
    yesterday_cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    prev_by_model: dict[str, dict] = {}
    cursor = db.ai_model_tests.find(
        {'created_at': {'$gte': yesterday_cutoff - timedelta(hours=24),
                        '$lt':  yesterday_cutoff + timedelta(hours=6)}},
    ).sort('created_at', -1)
    async for d in cursor:
        if d['model'] not in prev_by_model:
            prev_by_model[d['model']] = d

    # Run every model in parallel.
    new_results: list[dict] = []
    for m in TEST_MODELS:
        try:
            new_results.append(await _run_one_model(m['id'], api_key))
        except Exception as e:
            logger.warning('Nightly probe failed for %s: %s', m['id'], e)

    # Diff and build alert lines.
    alerts: list[str] = []
    for r in new_results:
        prev = prev_by_model.get(r['model'])
        if not prev:
            continue  # no baseline yet — first ever run for this model
        was_pass = bool(prev.get('pass'))
        now_pass = bool(r.get('pass'))
        if was_pass and not now_pass:
            failed = [p['name'] for p in r.get('probes', []) if not p['pass']]
            alerts.append(f'• {r["model"]} flipped PASS → FAIL ({", ".join(failed) or "all probes"})')
        prev_lat = int(prev.get('avg_latency_ms') or 0)
        now_lat = int(r.get('avg_latency_ms') or 0)
        if prev_lat and now_lat and now_lat > int(prev_lat * 1.5):
            alerts.append(
                f'• {r["model"]} tail latency creeping up: {prev_lat}ms → {now_lat}ms (+{int((now_lat - prev_lat) / prev_lat * 100)}%)'
            )

    # Persist idempotency marker even when no alerts so we don't re-run.
    await db.nightly_runs.insert_one({
        '_id': f'aitest-{today}',
        'created_at': datetime.now(timezone.utc),
        'models_tested': len(new_results),
        'alerts': alerts,
    })

    if not alerts:
        return {'sent': False, 'models_tested': len(new_results), 'alerts': 0}

    # Email the operator. Failure here is non-fatal — the marker is set
    # so we won't loop, and the operator can still check the AI Tests tab.
    try:
        from email_utils import send_email
        settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
        op_email = settings.get('operator_email') or (
            (await db.users.find_one({'role': 'operator'}, {'email': 1})) or {}
        ).get('email')
        if op_email:
            subject = f'⚠️ AI Test Bench — {len(alerts)} model alert(s)'
            body = (
                '<p>Your nightly AI test pass detected drift on the following models:</p>'
                '<pre style="font-family:monospace;background:#1f1f23;color:#f5f5f5;padding:12px;border-radius:6px;">'
                + '\n'.join(alerts)
                + '</pre>'
                '<p>View full results in <strong>Operator → AI Tests</strong>.</p>'
            )
            await send_email(op_email, subject, body)
            try:
                from webhook_ext import send_event
                await send_event(
                    f'AI Test Bench drift — {len(alerts)} alert(s):\n' + '\n'.join(alerts),
                    kind='drift',
                )
            except Exception as e:
                logger.warning('Nightly drift webhook failed: %s', e)
            return {'sent': True, 'to': op_email, 'alerts': len(alerts)}
    except Exception as e:
        logger.warning('Nightly drift email failed: %s', e)
    return {'sent': False, 'alerts': len(alerts), 'reason': 'email failed'}


@router.post('/cron/run-now')
async def trigger_nightly_run(_op: dict = Depends(get_current_operator)):
    """Operator-only manual trigger for the nightly drift run — useful for
    testing the alert path without waiting 24 hours."""
    # Bypass the idempotency guard for manual triggers.
    today = datetime.now(timezone.utc).date().isoformat()
    await db.nightly_runs.delete_one({'_id': f'aitest-{today}'})
    return await _nightly_drift_alert()
