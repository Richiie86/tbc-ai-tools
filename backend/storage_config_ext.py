"""Screenshot storage layer + operator-configurable storage backend.

Why this exists
---------------
`ai_visual_verify_ext.py` captures a screenshot of every AI build preview but
previously threw it away after the vision verdict. The operator wants those
screenshots PERSISTED and shown everywhere a build/preview appears.

The operator also wants to run their own storage server one day. So storage is
pluggable via a single config doc:

  mode = "default"  -> store JPEG bytes in MongoDB (collection
                       `ai_build_screenshots`) and serve them back through
                       our own endpoint. No extra infra needed.

  mode = "custom"   -> POST the image to the operator's own server and store
                       the returned URL. Flip back to "default" any time from
                       the Server tab (Vercel/Mongo).

Contract for a custom server
----------------------------
On save we POST JSON to `<custom_url>`:
    { "key": "<id>", "content_type": "image/jpeg", "data_base64": "<...>" }
with an optional `Authorization: Bearer <token>` header. The server must
respond 2xx with JSON `{ "url": "https://.../image.jpg" }`. That URL is what
we show in the UI. Retrieval is then served directly by the custom server.

Trust model
-----------
- All config endpoints are operator-only.
- The custom token is stored server-side and never returned to the client
  (only a `custom_token_set` boolean is exposed).
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from typing import Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/storage', tags=['storage-config'])

_CONFIG_ID = 'screenshot_storage'
_DEFAULT_CONFIG = {
    '_id': _CONFIG_ID,
    'mode': 'default',        # 'default' (Vercel/Mongo) | 'custom'
    'custom_url': '',
    'custom_token': '',
    'updated_at': None,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_storage_config() -> dict:
    """Return the raw storage config doc (creating the default if absent)."""
    doc = await db.app_storage_config.find_one({'_id': _CONFIG_ID})
    if not doc:
        return dict(_DEFAULT_CONFIG)
    # Merge over defaults so new fields are always present.
    return {**_DEFAULT_CONFIG, **doc}


def _public_config(doc: dict) -> dict:
    """Strip secrets before sending to the client."""
    return {
        'mode': doc.get('mode', 'default'),
        'custom_url': doc.get('custom_url', ''),
        'custom_token_set': bool(doc.get('custom_token')),
        'updated_at': doc.get('updated_at'),
    }


# ─── Persistence used by ai_visual_verify_ext ──────────────────────────────
async def persist_screenshot(key: str, image_bytes: bytes, content_type: str = 'image/jpeg') -> dict:
    """Store a screenshot according to the active storage mode.

    Returns a small record describing where it landed:
      { 'stored': 'mongo'|'custom', 'url': <optional external url> }
    Never raises — on any failure it falls back to Mongo so a screenshot is
    never silently lost.
    """
    cfg = await get_storage_config()
    mode = cfg.get('mode', 'default')

    if mode == 'custom' and cfg.get('custom_url'):
        try:
            headers = {}
            if cfg.get('custom_token'):
                headers['Authorization'] = f"Bearer {cfg['custom_token']}"
            payload = {
                'key': key,
                'content_type': content_type,
                'data_base64': base64.b64encode(image_bytes).decode('ascii'),
            }
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(cfg['custom_url'], json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json() if resp.content else {}
            url = data.get('url') if isinstance(data, dict) else None
            if url:
                return {'stored': 'custom', 'url': url}
            logger.warning('Custom storage server returned no url for %s; falling back to Mongo', key)
        except Exception as e:
            logger.warning('Custom storage upload failed for %s (%s); falling back to Mongo', key, e)

    # Default: store bytes (base64) in Mongo.
    await db.ai_build_screenshots.update_one(
        {'_id': key},
        {'$set': {
            'data_base64': base64.b64encode(image_bytes).decode('ascii'),
            'content_type': content_type,
            'size': len(image_bytes),
            'created_at': _now_iso(),
        }},
        upsert=True,
    )
    return {'stored': 'mongo'}


async def load_screenshot(key: str) -> Optional[Tuple[bytes, str]]:
    """Load a Mongo-stored screenshot. Returns (bytes, content_type) or None.

    Custom-mode screenshots are served by the custom server directly (we only
    hold their URL), so this only handles the Mongo case.
    """
    doc = await db.ai_build_screenshots.find_one({'_id': key})
    if not doc or not doc.get('data_base64'):
        return None
    try:
        return base64.b64decode(doc['data_base64']), doc.get('content_type', 'image/jpeg')
    except Exception:
        return None


# ─── Config endpoints (operator-only) ──────────────────────────────────────
class StorageConfigUpdate(BaseModel):
    mode: Optional[str] = None            # 'default' | 'custom'
    custom_url: Optional[str] = None
    custom_token: Optional[str] = None    # write-only; '' leaves unchanged


@router.get('/config')
async def read_storage_config(op: dict = Depends(get_current_operator)):
    """Current storage configuration (secrets masked)."""
    return _public_config(await get_storage_config())


@router.put('/config')
async def update_storage_config(body: StorageConfigUpdate, op: dict = Depends(get_current_operator)):
    """Update storage configuration. Used by the Server tab to switch between
    the default (Vercel/Mongo) and a custom server."""
    cfg = await get_storage_config()
    updates = {}

    if body.mode is not None:
        if body.mode not in ('default', 'custom'):
            raise HTTPException(400, "mode must be 'default' or 'custom'")
        updates['mode'] = body.mode

    if body.custom_url is not None:
        url = body.custom_url.strip()
        if url and not (url.startswith('http://') or url.startswith('https://')):
            raise HTTPException(400, 'custom_url must start with http:// or https://')
        updates['custom_url'] = url

    # Only overwrite the token when a non-empty value is supplied.
    if body.custom_token:
        updates['custom_token'] = body.custom_token.strip()

    # Guard: can't switch to custom without a URL.
    effective_mode = updates.get('mode', cfg.get('mode'))
    effective_url = updates.get('custom_url', cfg.get('custom_url'))
    if effective_mode == 'custom' and not effective_url:
        raise HTTPException(400, 'Set a custom server URL before switching to custom storage.')

    updates['updated_at'] = _now_iso()
    await db.app_storage_config.update_one(
        {'_id': _CONFIG_ID}, {'$set': updates}, upsert=True,
    )
    return _public_config(await get_storage_config())


@router.post('/reset')
async def reset_storage_config(op: dict = Depends(get_current_operator)):
    """One-click switch back to the default Vercel/Mongo storage."""
    await db.app_storage_config.update_one(
        {'_id': _CONFIG_ID},
        {'$set': {'mode': 'default', 'updated_at': _now_iso()}},
        upsert=True,
    )
    return _public_config(await get_storage_config())


@router.post('/test')
async def test_storage_config(op: dict = Depends(get_current_operator)):
    """Ping the configured custom server with a tiny 1x1 pixel to confirm it
    accepts uploads and returns a URL."""
    cfg = await get_storage_config()
    if cfg.get('mode') != 'custom' or not cfg.get('custom_url'):
        raise HTTPException(409, 'Custom storage is not configured.')
    # 1x1 transparent PNG.
    pixel = base64.b64decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    )
    result = await persist_screenshot('storage-selftest', pixel, 'image/png')
    if result.get('stored') != 'custom':
        raise HTTPException(502, 'Custom server did not accept the upload (fell back to Mongo). Check URL/token.')
    return {'ok': True, 'url': result.get('url')}
