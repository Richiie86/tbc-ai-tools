"""Context7 auto-injection.

Automatically pulls up-to-date, version-specific library documentation from
Context7 (https://context7.com) and injects it into the chat system prompt
whenever a user asks a coding / library question. This keeps answers accurate
instead of relying on the model's stale training data.

Design goals:
  • Zero-config: works WITHOUT an API key (low rate limits). An operator can add
    a CONTEXT7_API_KEY (env or settings doc) for higher limits.
  • Cheap & fast: only fires when a known library is detected in the message,
    resolves popular libraries to their Context7 IDs directly (skips a search
    call), and caches results in-memory with a TTL.
  • Never breaks chat: every network path is guarded — on any error we simply
    inject nothing and the chat proceeds normally.

REST API (see https://context7.com/docs/api-guide):
    GET /api/v2/libs/search?libraryName=<n>&query=<q>   -> resolve library id
    GET /api/v2/context?libraryId=<id>&query=<q>&type=json -> doc snippets
    Auth: `Authorization: Bearer <CONTEXT7_API_KEY>` (optional)
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from db import db
from auth_utils import get_current_operator

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/api/operator/context7', tags=['context7'])

_BASE = 'https://context7.com/api/v2'
_HTTP_TIMEOUT = 6.0            # keep chat latency bounded
_CACHE_TTL = 60 * 60 * 6      # 6h — docs change infrequently (per C7 best practice)
_MAX_DOC_CHARS = 6000         # cap injected context to control token cost

# ─── Popular libraries → Context7 IDs ─────────────────────────────────────
# Direct IDs let us skip the search call for common cases (faster, fewer API
# hits). Keys are matched as whole words (case-insensitive) in the message.
_KNOWN: dict[str, str] = {
    'next.js': '/vercel/next.js', 'nextjs': '/vercel/next.js', 'next js': '/vercel/next.js',
    'react': '/facebook/react', 'react.js': '/facebook/react', 'reactjs': '/facebook/react',
    'vue': '/vuejs/core', 'vue.js': '/vuejs/core', 'nuxt': '/nuxt/nuxt',
    'svelte': '/sveltejs/svelte', 'sveltekit': '/sveltejs/kit', 'angular': '/angular/angular',
    'tailwind': '/tailwindlabs/tailwindcss', 'tailwindcss': '/tailwindlabs/tailwindcss',
    'supabase': '/supabase/supabase', 'prisma': '/prisma/prisma', 'drizzle': '/drizzle-team/drizzle-orm',
    'mongodb': '/mongodb/docs', 'mongoose': '/automattic/mongoose', 'postgres': '/postgres/postgres',
    'postgresql': '/postgres/postgres', 'redis': '/redis/redis', 'neon': '/neondatabase/neon',
    'fastapi': '/tiangolo/fastapi', 'django': '/django/django', 'flask': '/pallets/flask',
    'express': '/expressjs/express', 'nestjs': '/nestjs/nest', 'node.js': '/nodejs/node',
    'nodejs': '/nodejs/node', 'stripe': '/stripe/stripe-node', 'clerk': '/clerk/javascript',
    'auth.js': '/nextauthjs/next-auth', 'nextauth': '/nextauthjs/next-auth', 'better-auth': '/better-auth/better-auth',
    'shadcn': '/shadcn-ui/ui', 'shadcn/ui': '/shadcn-ui/ui', 'radix': '/radix-ui/primitives',
    'framer motion': '/framer/motion', 'framer-motion': '/framer/motion', 'motion': '/framer/motion',
    'zustand': '/pmndrs/zustand', 'redux': '/reduxjs/redux', 'react-query': '/tanstack/query',
    'tanstack query': '/tanstack/query', 'tanstack': '/tanstack/query', 'swr': '/vercel/swr',
    'vite': '/vitejs/vite', 'vitest': '/vitest-dev/vitest', 'jest': '/jestjs/jest',
    'playwright': '/microsoft/playwright', 'cypress': '/cypress-io/cypress',
    'ai sdk': '/vercel/ai', 'vercel ai': '/vercel/ai', 'langchain': '/langchain-ai/langchain',
    'openai': '/openai/openai-python', 'anthropic': '/anthropics/anthropic-sdk-python',
    'pandas': '/pandas-dev/pandas', 'numpy': '/numpy/numpy', 'pytorch': '/pytorch/pytorch',
    'tensorflow': '/tensorflow/tensorflow', 'three.js': '/mrdoob/three.js', 'threejs': '/mrdoob/three.js',
    'react three fiber': '/pmndrs/react-three-fiber', 'r3f': '/pmndrs/react-three-fiber',
    'axios': '/axios/axios', 'zod': '/colinhacks/zod', 'typescript': '/microsoft/typescript',
    'graphql': '/graphql/graphql-js', 'apollo': '/apollographql/apollo-client',
    'docker': '/docker/docs', 'kubernetes': '/kubernetes/kubernetes', 'terraform': '/hashicorp/terraform',
}

# Longer keys first so e.g. "react three fiber" wins over "react".
_KNOWN_KEYS = sorted(_KNOWN.keys(), key=len, reverse=True)

# In-memory caches (best-effort; per-worker).
_doc_cache: dict[str, tuple[float, Optional[str]]] = {}
_search_cache: dict[str, tuple[float, Optional[str]]] = {}

# Cached settings read (very short TTL) to avoid a DB hit on every message.
_settings_cache: tuple[float, dict] = (0.0, {})


async def _settings() -> dict:
    global _settings_cache
    ts, val = _settings_cache
    if time.time() - ts < 30:
        return val
    doc = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    _settings_cache = (time.time(), doc)
    return doc


async def _config() -> tuple[bool, Optional[str]]:
    """Return (enabled, api_key). Enabled defaults True. Key: settings > env."""
    s = await _settings()
    enabled = s.get('context7_enabled')
    enabled = True if enabled is None else bool(enabled)
    key = s.get('context7_api_key') or os.environ.get('CONTEXT7_API_KEY') or None
    return enabled, key


def _headers(api_key: Optional[str]) -> dict:
    h = {'Accept': 'application/json'}
    if api_key:
        h['Authorization'] = f'Bearer {api_key}'
    return h


def detect_library(message: str) -> Optional[tuple[str, str]]:
    """Detect the first known library mentioned. Returns (matched_name, id)."""
    if not message:
        return None
    text = message.lower()
    for key in _KNOWN_KEYS:
        # whole-word / phrase match to avoid false hits inside other words
        pattern = r'(?<![a-z0-9])' + re.escape(key) + r'(?![a-z0-9])'
        if re.search(pattern, text):
            return key, _KNOWN[key]
    return None


def _extract_version(message: str, library: str) -> Optional[str]:
    """Pull a version like 'next.js 14' / 'react 18' near the library name."""
    m = re.search(re.escape(library) + r'\s*@?\s*v?(\d+(?:\.\d+){0,2})', message.lower())
    return m.group(1) if m else None


async def _search_library_id(name: str, query: str, api_key: Optional[str]) -> Optional[str]:
    ck = name.lower()
    hit = _search_cache.get(ck)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            r = await client.get(
                f'{_BASE}/libs/search',
                headers=_headers(api_key),
                params={'libraryName': name, 'query': query},
            )
        if r.status_code == 200:
            results = (r.json() or {}).get('results') or []
            lib_id = results[0].get('id') if results else None
        else:
            lib_id = None
    except Exception as e:  # noqa: BLE001
        logger.info('context7 search failed for %s: %s', name, e)
        lib_id = None
    _search_cache[ck] = (time.time(), lib_id)
    return lib_id


def _format_docs(payload: dict, library_id: str) -> Optional[str]:
    """Turn the /context JSON into a compact prompt block, capped in size."""
    parts: list[str] = []
    for sn in (payload.get('codeSnippets') or [])[:6]:
        title = sn.get('codeTitle') or 'Example'
        for code in (sn.get('codeList') or [])[:1]:
            snippet = (code.get('code') or '').strip()
            if snippet:
                parts.append(f'// {title}\n{snippet}')
    for info in (payload.get('infoSnippets') or [])[:4]:
        content = (info.get('content') or '').strip()
        if content:
            parts.append(content)
    if not parts:
        return None
    body = '\n\n'.join(parts)
    if len(body) > _MAX_DOC_CHARS:
        body = body[:_MAX_DOC_CHARS] + '\n… (truncated)'
    return body


async def build_context_block(message: str) -> Optional[str]:
    """Main entry point. Returns a system-prompt block with fresh docs, or None.

    Automatically no-ops when disabled, when no known library is detected, or
    on any network/parse error — so it is always safe to call in the hot path.
    """
    try:
        enabled, api_key = await _config()
        if not enabled:
            return None
        detected = detect_library(message)
        if not detected:
            return None
        name, library_id = detected
        version = _extract_version(message, name)
        if version:
            library_id = f'{library_id}/v{version}' if not version.startswith('v') else f'{library_id}/{version}'

        cache_key = f'{library_id}::{message.strip().lower()[:160]}'
        cached = _doc_cache.get(cache_key)
        if cached and time.time() - cached[0] < _CACHE_TTL:
            docs = cached[1]
        else:
            try:
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, follow_redirects=True) as client:
                    r = await client.get(
                        f'{_BASE}/context',
                        headers=_headers(api_key),
                        params={'libraryId': library_id, 'query': message[:400], 'type': 'json'},
                    )
                docs = _format_docs(r.json(), library_id) if r.status_code == 200 else None
            except Exception as e:  # noqa: BLE001
                logger.info('context7 context fetch failed for %s: %s', library_id, e)
                docs = None
            _doc_cache[cache_key] = (time.time(), docs)

        if not docs:
            return None
        return (
            f'\n\n### UP-TO-DATE LIBRARY DOCS (via Context7 — {name}, id {library_id}):\n'
            'Prefer these current, version-specific docs over prior knowledge when answering.\n'
            f'{docs}\n'
        )
    except Exception as e:  # noqa: BLE001
        logger.warning('context7 build_context_block unexpected error: %s', e)
        return None


# ─── Operator status / config endpoint ────────────────────────────────────
class Context7Update(BaseModel):
    enabled: Optional[bool] = None
    api_key: Optional[str] = None


@router.get('')
async def context7_status(_op: dict = Depends(get_current_operator)):
    enabled, key = await _config()
    s = await _settings()
    return {
        'enabled': enabled,
        'has_key': bool(key),
        'key_source': (
            'settings' if s.get('context7_api_key')
            else ('env' if os.environ.get('CONTEXT7_API_KEY') else None)
        ),
        'known_libraries': len(_KNOWN_KEYS),
        'cached_docs': len(_doc_cache),
        'note': (
            'Automatically injects up-to-date docs on coding/library questions. '
            'Works without a key at low rate limits; add a CONTEXT7_API_KEY for higher limits.'
        ),
    }


@router.put('')
async def context7_update(body: Context7Update, _op: dict = Depends(get_current_operator)):
    global _settings_cache
    updates: dict = {}
    if body.enabled is not None:
        updates['context7_enabled'] = bool(body.enabled)
    if body.api_key is not None:
        # Empty string clears the stored key (falls back to env).
        updates['context7_api_key'] = body.api_key.strip() or None
    if updates:
        await db.settings.update_one(
            {'_id': 'payment_settings'}, {'$set': updates}, upsert=True,
        )
        _settings_cache = (0.0, {})  # invalidate cache
    enabled, key = await _config()
    logger.info('context7 config updated: enabled=%s has_key=%s', enabled, bool(key))
    return {'ok': True, 'enabled': enabled, 'has_key': bool(key)}
