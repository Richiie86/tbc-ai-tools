"""AI Tools registry + runtime augmentations.

A small, honest registry of tools the chat AI can actually use. Each tool is
wired into the chat system prompt using the same safe prompt-injection pattern
as context7_ext (no fragile function-calling loop; every path is a no-op on
failure so chat never breaks).

Currently implemented, fully-functional tools:
  • web_search        — inject live web results on time-sensitive/factual
                        questions. Uses Serper (SERPER_API_KEY) or Brave
                        (BRAVE_API_KEY); disabled until a key is present.
  • sequential_thinking — inject a structured step-by-step reasoning scaffold
                        for complex coding / planning / review tasks. No key,
                        no network, zero cost.

Operator endpoints:
    GET  /api/operator/tools            -> list tools with status
    PUT  /api/operator/tools/{tool_id}  -> enable/disable + optional api_key
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import db
from auth_utils import get_current_operator

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/api/operator/tools', tags=['tools'])

_HTTP_TIMEOUT = 6.0
_SEARCH_CACHE_TTL = 60 * 15   # 15 min — live results, but avoid hammering
_MAX_SEARCH_CHARS = 3500

# ─── Settings cache (mirrors context7_ext for a light DB footprint) ───────
_settings_cache: tuple[float, dict] = (0.0, {})


async def _settings() -> dict:
    global _settings_cache
    ts, val = _settings_cache
    if time.time() - ts < 30:
        return val
    doc = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    _settings_cache = (time.time(), doc)
    return doc


def _invalidate_settings():
    global _settings_cache
    _settings_cache = (0.0, {})


# ─── Web search config ────────────────────────────────────────────────────
def _web_search_key(s: dict) -> tuple[Optional[str], Optional[str]]:
    """Return (provider, api_key). Prefers a settings key, then env.

    Serper takes precedence over Brave when both are available."""
    settings_key = s.get('web_search_api_key')
    settings_provider = s.get('web_search_provider')
    if settings_key:
        return (settings_provider or 'serper'), settings_key
    if os.environ.get('SERPER_API_KEY'):
        return 'serper', os.environ['SERPER_API_KEY']
    if os.environ.get('BRAVE_API_KEY'):
        return 'brave', os.environ['BRAVE_API_KEY']
    return None, None


# Signals that a question likely needs *current* information from the web.
_SEARCH_SIGNALS = (
    'latest', 'newest', 'current', 'right now', 'today', 'this week',
    'this year', 'recent', 'nowadays', 'up to date', 'up-to-date',
    'news', 'released', 'release date', 'just announced', 'changelog',
    'price of', 'stock price', 'exchange rate', 'weather', 'who won',
    'search for', 'look up', 'google', 'find online', 'on the web',
    '2024', '2025', '2026', '2027',
)


def needs_web_search(message: str) -> bool:
    if not message:
        return False
    text = message.lower()
    return any(sig in text for sig in _SEARCH_SIGNALS)


_search_cache: dict[str, tuple[float, Optional[str]]] = {}


async def _run_web_search(query: str, provider: str, api_key: str) -> Optional[str]:
    ck = f'{provider}:{query.strip().lower()[:160]}'
    hit = _search_cache.get(ck)
    if hit and time.time() - hit[0] < _SEARCH_CACHE_TTL:
        return hit[1]
    block: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, follow_redirects=True) as client:
            if provider == 'brave':
                r = await client.get(
                    'https://api.search.brave.com/res/v1/web/search',
                    headers={'Accept': 'application/json', 'X-Subscription-Token': api_key},
                    params={'q': query, 'count': 5},
                )
                if r.status_code == 200:
                    results = ((r.json() or {}).get('web') or {}).get('results') or []
                    block = _format_results(
                        [(x.get('title'), x.get('url'), x.get('description')) for x in results[:5]]
                    )
            else:  # serper (default)
                r = await client.post(
                    'https://google.serper.dev/search',
                    headers={'X-API-KEY': api_key, 'Content-Type': 'application/json'},
                    json={'q': query, 'num': 5},
                )
                if r.status_code == 200:
                    organic = (r.json() or {}).get('organic') or []
                    block = _format_results(
                        [(x.get('title'), x.get('link'), x.get('snippet')) for x in organic[:5]]
                    )
    except Exception as e:  # noqa: BLE001
        logger.info('web_search failed (%s): %s', provider, e)
        block = None
    _search_cache[ck] = (time.time(), block)
    return block


def _format_results(rows: list[tuple]) -> Optional[str]:
    parts: list[str] = []
    for title, url, snippet in rows:
        if not (title and snippet):
            continue
        parts.append(f'- {title}\n  {snippet}\n  ({url})')
    if not parts:
        return None
    body = '\n'.join(parts)
    if len(body) > _MAX_SEARCH_CHARS:
        body = body[:_MAX_SEARCH_CHARS] + '\n… (truncated)'
    return body


# ─── Sequential thinking ──────────────────────────────────────────────────
_SEQUENTIAL_SCAFFOLD = (
    '\n\n### SEQUENTIAL THINKING (internal):\n'
    'This looks like a complex task. Before answering, reason it through in '
    'clear ordered steps: (1) restate the goal and constraints, (2) break the '
    'problem into sub-steps, (3) work through each sub-step, (4) verify the '
    'result and note edge cases, then (5) give a concise final answer. Keep the '
    'reasoning tight and focused — do not pad.\n'
)


# ─── Public runtime entry point ───────────────────────────────────────────
async def build_tools_block(message: str, kind: Optional[str] = None) -> tuple[str, list[str]]:
    """Return (prompt_block, used_tool_ids). Safe to call in the chat hot path.

    ``kind`` is the amAI task classification (code/review/plan/question) so the
    sequential-thinking tool can target complex tasks only."""
    block = ''
    used: list[str] = []
    try:
        s = await _settings()

        # Web search — only when enabled, keyed, and the message needs it.
        if s.get('tool_web_search_enabled'):
            provider, key = _web_search_key(s)
            if key and needs_web_search(message):
                results = await _run_web_search(message[:300], provider, key)
                if results:
                    block += (
                        '\n\n### LIVE WEB SEARCH RESULTS '
                        f'(via {provider}, current as of now):\n'
                        'Use these to answer with up-to-date facts; cite the '
                        'source URLs where relevant.\n'
                        f'{results}\n'
                    )
                    used.append('web_search')

        # Sequential thinking — complex tasks only, no cost.
        if s.get('tool_sequential_enabled') and kind in ('code', 'review', 'plan'):
            block += _SEQUENTIAL_SCAFFOLD
            used.append('sequential_thinking')
    except Exception as e:  # noqa: BLE001
        logger.warning('build_tools_block unexpected error: %s', e)
    return block, used


# ─── Registry / operator endpoints ────────────────────────────────────────
def _tool_registry(s: dict) -> list[dict]:
    provider, key = _web_search_key(s)
    return [
        {
            'id': 'web_search',
            'name': 'Web Search',
            'category': 'Research',
            'description': (
                'Fetches live web results (via Serper or Brave) and feeds them '
                'to the AI when a question needs current information — news, '
                'prices, latest releases, anything time-sensitive.'
            ),
            'trigger': 'Automatic on time-sensitive / factual questions',
            'enabled': bool(s.get('tool_web_search_enabled')),
            'needs_key': True,
            'has_key': bool(key),
            'provider': provider,
            'key_source': (
                'settings' if s.get('web_search_api_key')
                else ('env' if (os.environ.get('SERPER_API_KEY') or os.environ.get('BRAVE_API_KEY')) else None)
            ),
        },
        {
            'id': 'sequential_thinking',
            'name': 'Sequential Thinking',
            'category': 'Reasoning',
            'description': (
                'Guides the AI to reason step-by-step (goal → sub-steps → '
                'verify → answer) on complex coding, review and planning tasks '
                'for more reliable results.'
            ),
            'trigger': 'Automatic on coding / review / planning tasks',
            'enabled': bool(s.get('tool_sequential_enabled')),
            'needs_key': False,
            'has_key': True,
            'provider': None,
            'key_source': None,
        },
    ]


_VALID_TOOL_IDS = {'web_search', 'sequential_thinking'}
_ENABLED_FIELD = {
    'web_search': 'tool_web_search_enabled',
    'sequential_thinking': 'tool_sequential_enabled',
}


@router.get('')
async def list_tools(_op: dict = Depends(get_current_operator)):
    s = await _settings()
    return {
        'tools': _tool_registry(s),
        'note': (
            'These tools augment every chat automatically when enabled. Web '
            'Search needs a Serper or Brave API key.'
        ),
    }


class ToolUpdate(BaseModel):
    enabled: Optional[bool] = None
    api_key: Optional[str] = None
    provider: Optional[str] = None  # 'serper' | 'brave'


@router.put('/{tool_id}')
async def update_tool(tool_id: str, body: ToolUpdate, _op: dict = Depends(get_current_operator)):
    if tool_id not in _VALID_TOOL_IDS:
        raise HTTPException(status_code=404, detail='Unknown tool')
    updates: dict = {}
    if body.enabled is not None:
        updates[_ENABLED_FIELD[tool_id]] = bool(body.enabled)
    if tool_id == 'web_search':
        if body.api_key is not None:
            updates['web_search_api_key'] = body.api_key.strip() or None
        if body.provider is not None:
            prov = body.provider.strip().lower()
            if prov and prov not in ('serper', 'brave'):
                raise HTTPException(status_code=400, detail='provider must be serper or brave')
            updates['web_search_provider'] = prov or None
    if updates:
        await db.settings.update_one(
            {'_id': 'payment_settings'}, {'$set': updates}, upsert=True,
        )
        _invalidate_settings()
    s = await _settings()
    tool = next((t for t in _tool_registry(s) if t['id'] == tool_id), None)
    logger.info('tool %s updated: %s', tool_id, updates)
    return {'ok': True, 'tool': tool}
