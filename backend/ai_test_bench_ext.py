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

from llm_router import LlmChat, UserMessage
from fastapi import APIRouter, Depends, HTTPException, Path, Query

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-tests', tags=['ai-tests'])

# Models to expose in the UI. Kept small & curated — running 14 probes
# every click would be slow + expensive. The operator can extend this
# list later if needed.
TEST_MODELS: list[dict] = [
    # Keep this list to stable, currently-supported model ids. The previous
    # entries used future/preview ids (gpt-5.4, claude-opus-4-7,
    # gemini-3-flash-preview, etc.) that turn a healthy provider key into a
    # hard FAIL on every probe.
    {'id': 'claude-sonnet-4-5-20250929', 'display': 'Claude Sonnet 4.5',        'provider': 'anthropic'},
    {'id': 'claude-haiku-4-5-20251001',  'display': 'Claude Haiku 4.5',         'provider': 'anthropic'},
    {'id': 'gpt-4.1',                    'display': 'GPT-4.1',                 'provider': 'openai'},
    {'id': 'gpt-4o-mini',                'display': 'GPT-4o Mini',             'provider': 'openai'},
    {'id': 'gemini-2.5-pro',             'display': 'Gemini 2.5 Pro',          'provider': 'gemini'},
    {'id': 'gemini-2.5-flash',           'display': 'Gemini 2.5 Flash',        'provider': 'gemini'},
    {'id': 'anthropic/claude-sonnet-4',   'display': 'Claude Sonnet 4 (OpenRouter)', 'provider': 'openrouter'},
    {'id': 'openai/gpt-4o-mini',          'display': 'GPT-4o Mini (OpenRouter)',     'provider': 'openrouter'},
    {'id': 'google/gemini-2.5-flash',     'display': 'Gemini 2.5 Flash (OpenRouter)', 'provider': 'openrouter'},
    {'id': 'llama-3.3-70b-versatile',     'display': 'Llama 3.3 70B (Groq)',         'provider': 'groq'},
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
            from llm_router import TextDelta, StreamDone
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


async def _any_provider_key() -> bool:
    """True if at least one provider key is available from env or operator settings."""
    from llm_router import any_provider_key_available
    return await any_provider_key_available()


async def _get_llm_key() -> str:
    """Ensure at least one provider key is configured, else 503. The returned
    value is a legacy placeholder — llm_router authenticates each provider
    with its own key internally, so probes ignore this string."""
    if not await _any_provider_key():
        raise HTTPException(
            503,
            'No AI provider key configured. Add Anthropic, OpenAI, Gemini, '
            'OpenRouter, or Groq in Operator → My Keys.',
        )
    return ''


def _create_learnings_pass_check(token: str):
    """Create a pass-check function with proper closure of the token."""
    def pass_check(text: str) -> bool:
        return token.lower() in text.lower()
    return pass_check


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
                # Use proper function closure instead of lambda with default arg
                'pass_check': _create_learnings_pass_check(token),
                'meta': {'token': token, 'learning_id': learning.get('id')},
            })
    return probes


@router.get('/models')
async def get_models(operator=Depends(get_current_operator)):
    """List models available for testing."""
    return {'models': TEST_MODELS}


@router.post('/run/{model_id}')
async def run_model_test(
    model_id: str = Path(...),
    operator=Depends(get_current_operator),
):
    """Run all probes for a single model and return results."""
    provider = _provider_for(model_id)
    await _get_llm_key()  # Ensures at least one key is configured
    probes = await _build_probes()
    
    # Run all probes in parallel for this model
    tasks = [
        _run_probe(model_id, provider, '', probe['prompt'], probe['pass_check'])
        for probe in probes
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    # Package results with probe names
    probe_results = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            probe_result = {
                'pass': False,
                'latency_ms': 0,
                'error': str(result)[:300],
                'response': ''
            }
        else:
            probe_result = result
        
        probe_results.append({
            'name': probes[i]['name'],
            **probe_result,
            'meta': probes[i].get('meta', {})
        })
    
    # Calculate summary stats
    passed = sum(1 for r in probe_results if r['pass'])
    total = len(probe_results)
    avg_latency = sum(r['latency_ms'] for r in probe_results) / total if total > 0 else 0
    
    # Store test run in database
    test_doc = {
        'model_id': model_id,
        'provider': provider,
        'timestamp': datetime.now(timezone.utc),
        'operator_id': operator['id'],
        'probes': probe_results,
        'summary': {
            'passed': passed,
            'total': total,
            'avg_latency_ms': int(avg_latency),
            'success_rate': passed / total if total > 0 else 0
        }
    }
    await db.ai_model_tests.insert_one(test_doc)
    
    return {
        'model_id': model_id,
        'provider': provider,
        'timestamp': test_doc['timestamp'].isoformat(),
        'probes': probe_results,
        'summary': test_doc['summary']
    }


@router.post('/run-all')
async def run_all_model_tests(operator=Depends(get_current_operator)):
    """Run all probes for all models and return results."""
    await _get_llm_key()  # Ensures at least one key is configured
    
    # Run tests for all models in parallel
    tasks = [run_model_test(model['id'], operator) for model in TEST_MODELS]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    # Package results
    model_results = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            model_results.append({
                'model_id': TEST_MODELS[i]['id'],
                'error': str(result)[:300],
                'probes': [],
                'summary': {'passed': 0, 'total': 0, 'avg_latency_ms': 0, 'success_rate': 0}
            })
        else:
            model_results.append(result)
    
    return {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'models': model_results
    }


@router.get('/history')
async def get_test_history(
    model_id: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    operator=Depends(get_current_operator)
):
    """Get historical test results, optionally filtered by model."""
    filter_doc = {}
    if model_id:
        filter_doc['model_id'] = model_id
    
    cursor = db.ai_model_tests.find(filter_doc).sort('timestamp', -1).limit(limit)
    results = await cursor.to_list(length=None)
    
    # Convert ObjectId and datetime for JSON serialization
    for result in results:
        result['_id'] = str(result['_id'])
        result['timestamp'] = result['timestamp'].isoformat()
    
    return {'history': results}
