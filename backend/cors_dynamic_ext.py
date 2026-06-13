"""Dynamic CORS middleware.

The default FastAPI `CORSMiddleware` only supports a static list / regex
configured at startup. We want any domain the operator attaches to a
deploy project (via the inline domain editor) — OR adds to the
`cors_settings.extra_origins` list — to be auto-allowed for CORS without
a redeploy.

The middleware:

  1. Builds the allow-list lazily on first request and caches it for 60s.
  2. Sources:
       - `CORS_ORIGINS` env var (comma-separated, '*' = wide-open)
       - All `deploy_projects.domain` values (https://) — the operator
         attaches these via the Ops tab and we honour them automatically.
       - `cors_settings.extra_origins` Mongo doc (operator-managed via the
         `/api/operator/cors-origins` endpoints below).
       - Always-allowed defaults: preview.emergentagent.com,
         emergent.host, tbctools.org (so existing flows keep working
         until the operator curates the list).
  3. Mirrors the Origin header back when matched + the standard
     `Access-Control-Allow-Credentials: true` / methods / headers.
  4. Short-circuits OPTIONS preflight with `200 + CORS headers`.

Cache invalidation: operator-facing endpoints (PATCH /domain, the
`/cors-origins` endpoints below) call `invalidate_cors_cache()` so the
new domain is honoured immediately without waiting for the 60s TTL.
"""
import logging
import os
import re
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

# 60s TTL — long enough to absorb most request bursts, short enough that
# the operator doesn't have to manually refresh after adding a domain.
_CACHE_TTL = 60.0
_state = {
    'origins': None,    # set[str] | None — `None` = not loaded yet
    'wildcard': False,  # True when env CORS_ORIGINS=='*'
    'fetched_at': 0.0,
}

# Always-on fallbacks so the current deployment never breaks if the
# operator has never touched the settings. tbctools.org is the
# production custom domain; the others cover preview/Emergent hosts.
_ALWAYS_ALLOWED_REGEX = re.compile(
    r'^https://([a-z0-9-]+\.)?(preview\.emergentagent\.com|emergent\.host|tbctools\.org)(:\d+)?$',
    re.IGNORECASE,
)


def _norm(origin: str) -> str:
    """Strip trailing slash + lowercase scheme/host so the cache keys
    survive minor formatting variance from operator input."""
    o = (origin or '').strip().rstrip('/')
    if '://' in o:
        scheme, rest = o.split('://', 1)
        host_and_path = rest.split('/', 1)[0]
        return f'{scheme.lower()}://{host_and_path.lower()}'
    return o.lower()


def _origins_from_domain(domain: str) -> list[str]:
    """A stored `domain` value is just a host (e.g. 'foo.tbctools.org'). The
    browser will send the Origin header with the scheme prefix — return
    both https + http variants so local dev still works."""
    d = (domain or '').strip().lower()
    if not d:
        return []
    # Strip any accidental scheme/path the operator pasted in.
    for prefix in ('https://', 'http://'):
        if d.startswith(prefix):
            d = d[len(prefix):]
    d = d.split('/', 1)[0].rstrip('.')
    if not d:
        return []
    return [f'https://{d}', f'http://{d}']


async def _load_origins() -> tuple[set[str], bool]:
    """Build the allow-list from env + Mongo. Returns (set_of_origins,
    wildcard_mode). Wildcard means CORS_ORIGINS env is exactly '*'."""
    env = (os.environ.get('CORS_ORIGINS') or '').strip()
    if env == '*':
        return set(), True
    origins: set[str] = set()
    if env:
        for piece in env.split(','):
            n = _norm(piece)
            if n:
                origins.add(n)
    # Pull every domain operators have attached to a deploy project.
    async for p in db.deploy_projects.find({'domain': {'$ne': None, '$exists': True}}, {'domain': 1}):
        for variant in _origins_from_domain(p.get('domain', '')):
            origins.add(_norm(variant))
    # And the operator-managed extras (one Mongo doc, no schema migration
    # — operator just appends).
    extras_doc = await db.cors_settings.find_one({'_id': 'main'}) or {}
    for e in (extras_doc.get('extra_origins') or []):
        n = _norm(e)
        if n:
            origins.add(n)
    return origins, False


async def _origin_allowed(origin: str) -> bool:
    """Cache-front for the CORS check. Falls back to the always-allowed
    regex when the dynamic list misses, so legacy hosts keep working."""
    if not origin:
        return False
    now = time.monotonic()
    if _state['origins'] is None or (now - _state['fetched_at']) > _CACHE_TTL:
        try:
            origins, wildcard = await _load_origins()
            _state['origins'] = origins
            _state['wildcard'] = wildcard
            _state['fetched_at'] = now
        except Exception as e:
            logger.warning('CORS allow-list load failed: %s', e)
            # Keep the previous cache if we have one, else default to
            # always-allowed regex only.
            if _state['origins'] is None:
                _state['origins'] = set()
                _state['wildcard'] = False
    if _state['wildcard']:
        return True
    if _norm(origin) in _state['origins']:
        return True
    return bool(_ALWAYS_ALLOWED_REGEX.match(origin))


def invalidate_cors_cache() -> None:
    """Force the next request to rebuild the allow-list. Called whenever
    the operator mutates a domain or adds an extra origin."""
    _state['origins'] = None
    _state['fetched_at'] = 0.0


class DynamicCORSMiddleware(BaseHTTPMiddleware):
    """Honours the Origin header against the Mongo-backed allow-list."""

    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get('origin', '')
        is_preflight = request.method == 'OPTIONS' and \
            'access-control-request-method' in request.headers

        # OPTIONS preflight — answer directly with CORS headers (or 400
        # when origin is disallowed so the browser surfaces a clear error).
        if is_preflight:
            if origin and await _origin_allowed(origin):
                acr_headers = request.headers.get('access-control-request-headers', '*')
                acr_method = request.headers.get('access-control-request-method', '*')
                return Response(
                    status_code=200,
                    headers={
                        'Access-Control-Allow-Origin': origin,
                        'Access-Control-Allow-Credentials': 'true',
                        'Access-Control-Allow-Methods': acr_method or '*',
                        'Access-Control-Allow-Headers': acr_headers,
                        'Access-Control-Max-Age': '86400',
                        'Vary': 'Origin',
                    },
                )
            # disallowed preflight — still 200 so the browser surfaces
            # the *real* error (CORS rejection client-side) instead of a
            # confusing 4xx from us.
            return Response(status_code=200)

        # Real request — proxy to the app, then attach CORS headers.
        response = await call_next(request)
        if origin and await _origin_allowed(origin):
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Vary'] = 'Origin'
            response.headers.setdefault('Access-Control-Expose-Headers', '*')
        return response


# ---------- Operator-facing CRUD for the dynamic allow-list ----------
router = APIRouter(prefix='/api/operator/cors-origins', tags=['cors'])


class ExtraOriginsUpdate(BaseModel):
    extra_origins: list[str] = Field(default_factory=list, max_length=500)


@router.get('')
async def get_cors_origins(_op: dict = Depends(get_current_operator)):
    """Return the full effective allow-list so the operator can audit it.

    Splits the response by source so it's clear *why* a given origin is
    allowed (env, deploy domains, or operator extras)."""
    env_list = []
    env = (os.environ.get('CORS_ORIGINS') or '').strip()
    wildcard = env == '*'
    if env and not wildcard:
        env_list = [_norm(p) for p in env.split(',') if p.strip()]
    deploy_domains: list[str] = []
    async for p in db.deploy_projects.find({'domain': {'$ne': None, '$exists': True}}, {'domain': 1, 'name': 1, 'id': 1}):
        for variant in _origins_from_domain(p.get('domain', '')):
            deploy_domains.append(variant)
    extras_doc = await db.cors_settings.find_one({'_id': 'main'}) or {}
    extras = list(extras_doc.get('extra_origins') or [])
    return {
        'wildcard': wildcard,
        'env_origins': env_list,
        'deploy_project_origins': deploy_domains,
        'extra_origins': extras,
        'always_allowed_regex': _ALWAYS_ALLOWED_REGEX.pattern,
        'cache_ttl_seconds': int(_CACHE_TTL),
    }


@router.put('')
async def set_extra_origins(
    body: ExtraOriginsUpdate,
    _op: dict = Depends(get_current_operator),
):
    """Replace the operator-managed extras list. Normalises each entry
    (lowercase + strip trailing slash) so duplicates collapse."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in body.extra_origins:
        n = _norm(raw)
        if not n or n in seen:
            continue
        # Light validation — must be a scheme://host pair.
        if not re.match(r'^https?://[a-z0-9.-]+(:\d+)?$', n):
            raise HTTPException(400, f'Invalid origin: {raw!r} (expected scheme://host)')
        seen.add(n)
        cleaned.append(n)
    await db.cors_settings.update_one(
        {'_id': 'main'},
        {'$set': {'extra_origins': cleaned}},
        upsert=True,
    )
    invalidate_cors_cache()
    return {'extra_origins': cleaned, 'count': len(cleaned)}


class SingleOrigin(BaseModel):
    origin: str


@router.post('/add')
async def add_origin(body: SingleOrigin, _op: dict = Depends(get_current_operator)):
    """Append a single origin to the extras list (idempotent)."""
    n = _norm(body.origin)
    if not n or not re.match(r'^https?://[a-z0-9.-]+(:\d+)?$', n):
        raise HTTPException(400, 'Invalid origin (expected scheme://host)')
    await db.cors_settings.update_one(
        {'_id': 'main'},
        {'$addToSet': {'extra_origins': n}},
        upsert=True,
    )
    invalidate_cors_cache()
    return {'added': n}
