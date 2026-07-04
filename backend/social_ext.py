"""Social media — public links + secure account connections.

Two concerns, one settings doc (``_id='social_settings'``):

  • links    — public-facing social URLs (footer / profile icons). Not secret.
  • accounts — the operator's CONNECTED social accounts used for direct
               posting later. These hold access tokens, so they are:
                 - operator-only to read/write (get_current_operator),
                 - stored ENCRYPTED at rest (secret_crypto.encrypt_secret),
                 - NEVER returned to the client (only a masked status is sent).

Direct posting itself needs each platform's approved developer app + OAuth
(weeks of review), so we ship the secure storage + status framework now and
plug the real posting calls in per-platform once credentials are approved.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db
from secret_crypto import encrypt_secret, decrypt_secret

logger = logging.getLogger('tbc.social')

public_router = APIRouter(prefix='/api/social', tags=['social'])
op_router = APIRouter(prefix='/api/operator/social', tags=['social'])

_DOC_ID = 'social_settings'

# Platforms we support connecting for direct posting.
SUPPORTED = ('facebook', 'youtube', 'instagram', 'tiktok')


async def _doc() -> dict:
    return await db.settings.find_one({'_id': _DOC_ID}) or {}


# ─── Public links ───────────────────────────────────────────────────────────
def _clean_link(l: dict) -> dict:
    return {
        'platform': str(l.get('platform', '')).strip().lower(),
        'label': str(l.get('label', '')).strip(),
        'url': str(l.get('url', '')).strip(),
        'enabled': bool(l.get('enabled', True)),
    }


@public_router.get('/links')
async def public_links():
    """Enabled social links for the site footer / public profile."""
    doc = await _doc()
    links = [_clean_link(l) for l in (doc.get('links') or [])]
    return {'links': [l for l in links if l['enabled'] and l['url']]}


@op_router.get('/links')
async def op_get_links(_op: dict = Depends(get_current_operator)):
    doc = await _doc()
    return {'links': [_clean_link(l) for l in (doc.get('links') or [])]}


class LinkItem(BaseModel):
    platform: str
    label: Optional[str] = ''
    url: str
    enabled: bool = True


class LinksUpdate(BaseModel):
    links: List[LinkItem]


@op_router.put('/links')
async def op_set_links(body: LinksUpdate, _op: dict = Depends(get_current_operator)):
    """Replace the full list of public social links."""
    cleaned = []
    for l in body.links:
        url = (l.url or '').strip()
        if not url:
            continue
        if not (url.startswith('http://') or url.startswith('https://')):
            url = 'https://' + url
        cleaned.append({
            'platform': (l.platform or '').strip().lower(),
            'label': (l.label or '').strip(),
            'url': url,
            'enabled': bool(l.enabled),
        })
    await db.settings.update_one(
        {'_id': _DOC_ID}, {'$set': {'links': cleaned}}, upsert=True)
    logger.info('social links updated: %d entries', len(cleaned))
    return {'links': cleaned}


# ─── Connected accounts (secure) ────────────────────────────────────────────
def _mask(token: str) -> str:
    if not token:
        return ''
    t = str(token)
    return ('•' * max(0, len(t) - 4)) + t[-4:] if len(t) > 4 else '••••'


def _account_status(platform: str, acc: dict) -> dict:
    """Client-safe view of a connected account — NEVER includes the token."""
    acc = acc or {}
    return {
        'platform': platform,
        'connected': bool(acc.get('connected')),
        'account_name': acc.get('account_name') or '',
        'token_hint': acc.get('token_hint') or '',
        'connected_at': acc.get('connected_at'),
    }


@op_router.get('/accounts')
async def op_get_accounts(_op: dict = Depends(get_current_operator)):
    """Connection status for every supported platform. No secrets returned."""
    doc = await _doc()
    accounts = doc.get('accounts') or {}
    return {
        'accounts': [_account_status(p, accounts.get(p)) for p in SUPPORTED],
        'supported': list(SUPPORTED),
    }


class ConnectAccount(BaseModel):
    account_name: str
    access_token: str
    # Some platforms (e.g. YouTube) also need a refresh token / channel id.
    refresh_token: Optional[str] = None
    extra_id: Optional[str] = None


@op_router.put('/accounts/{platform}')
async def op_connect_account(
    platform: str, body: ConnectAccount, _op: dict = Depends(get_current_operator)
):
    """Securely store credentials for one platform. Tokens are encrypted at
    rest and never sent back to the browser — only a masked hint is returned."""
    platform = (platform or '').strip().lower()
    if platform not in SUPPORTED:
        raise HTTPException(400, f'Unsupported platform: {platform}')
    token = (body.access_token or '').strip()
    if not token:
        raise HTTPException(400, 'access_token is required')

    record = {
        'connected': True,
        'account_name': (body.account_name or '').strip(),
        'token_hint': _mask(token),
        'access_token': encrypt_secret(token),
        'refresh_token': encrypt_secret((body.refresh_token or '').strip()) if body.refresh_token else '',
        'extra_id': (body.extra_id or '').strip(),
        'connected_at': datetime.now(timezone.utc).isoformat(),
    }
    await db.settings.update_one(
        {'_id': _DOC_ID}, {'$set': {f'accounts.{platform}': record}}, upsert=True)
    logger.info('social account connected: %s (%s)', platform, record['account_name'])
    return _account_status(platform, record)


@op_router.delete('/accounts/{platform}')
async def op_disconnect_account(platform: str, _op: dict = Depends(get_current_operator)):
    platform = (platform or '').strip().lower()
    if platform not in SUPPORTED:
        raise HTTPException(400, f'Unsupported platform: {platform}')
    await db.settings.update_one(
        {'_id': _DOC_ID}, {'$unset': {f'accounts.{platform}': ''}})
    logger.info('social account disconnected: %s', platform)
    return {'ok': True, 'platform': platform, 'connected': False}


async def get_account_token(platform: str) -> Optional[dict]:
    """Server-side helper for the future direct-posting calls: returns the
    DECRYPTED credentials for a platform, or None if not connected. Never call
    this from a request that returns data to the browser."""
    doc = await _doc()
    acc = (doc.get('accounts') or {}).get((platform or '').strip().lower())
    if not acc or not acc.get('connected'):
        return None
    return {
        'account_name': acc.get('account_name'),
        'access_token': decrypt_secret(acc.get('access_token')),
        'refresh_token': decrypt_secret(acc.get('refresh_token')) if acc.get('refresh_token') else '',
        'extra_id': acc.get('extra_id'),
    }
