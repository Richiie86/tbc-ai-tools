"""Slack / Discord / generic-JSON webhook bridge.

Sends important events to an operator-configured webhook URL. Both Slack
("incoming webhook") and Discord ("/api/webhooks/...") accept a small
`{text: "..."}` POST, so we don't need provider-specific code — one
helper covers both.

Wired into the existing notification systems:
  - `runtime_errors_ext._maybe_page_operator` — critical-severity errors
  - `ai_test_bench_ext._nightly_drift_alert` — model drift alerts
  - `deploy_projects_ext` (promote flow) — production promotes
  - `runtime_errors_ext.dismiss` — lockdown-audit blocked attempts

Config lives on the singleton settings doc:
  - `settings.webhook_url` — set via PUT /api/operator/webhook
  - `settings.webhook_enabled` — kill-switch without losing the URL
"""
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/webhook', tags=['webhook'])


async def _get_webhook() -> tuple[Optional[str], bool]:
    """Returns (url, enabled). Cheap — one Mongo read."""
    s = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    return s.get('webhook_url'), bool(s.get('webhook_enabled', True))


async def send_event(text: str, *, kind: str = 'info') -> bool:
    """Fire-and-forget — never raises. Returns True on 2xx, False otherwise.

    Slack and Discord both accept `{text: ...}` (Slack natively, Discord
    when content is auto-mapped). We POST that lowest common denominator
    to keep the helper provider-agnostic.

    `kind` is a structural hint used only for emoji prefix — Slack/Discord
    render emojis from text automatically.
    """
    url, enabled = await _get_webhook()
    if not enabled or not url:
        return False
    prefix = {
        'critical': '🚨',
        'drift': '📉',
        'promote': '🚀',
        'lockdown': '🔒',
        'info': 'ℹ️',
    }.get(kind, '•')
    payload = {'text': f'{prefix} {text[:1_900]}', 'content': f'{prefix} {text[:1_900]}'}
    try:
        async with httpx.AsyncClient(timeout=8.0) as cli:
            r = await cli.post(url, json=payload)
        return 200 <= r.status_code < 300
    except Exception as e:
        logger.warning('webhook send failed: %s', e)
        return False


# ---------- operator endpoints ----------

class WebhookConfig(BaseModel):
    url: Optional[str] = Field(default=None, max_length=2_000)
    enabled: Optional[bool] = None


@router.get('')
async def get_config(_op: dict = Depends(get_current_operator)):
    url, enabled = await _get_webhook()
    return {
        'configured': bool(url),
        'enabled': enabled,
        # Mask the URL — return only the hostname so the operator can
        # confirm which workspace without exposing the token in screenshots.
        'host': _mask_host(url),
    }


def _mask_host(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc or None
    except Exception:
        return None


@router.put('')
async def put_config(
    cfg: WebhookConfig,
    _op: dict = Depends(get_current_operator),
):
    update: dict = {}
    if cfg.url is not None:
        url = cfg.url.strip() or None
        # Lightweight validation — full URL parse, must be https + a host.
        if url:
            from urllib.parse import urlparse
            p = urlparse(url)
            if p.scheme != 'https' or not p.netloc:
                raise HTTPException(400, 'Webhook URL must be https:// with a host')
        update['webhook_url'] = url
    if cfg.enabled is not None:
        update['webhook_enabled'] = bool(cfg.enabled)
    if update:
        await db.settings.update_one(
            {'_id': 'payment_settings'}, {'$set': update}, upsert=True,
        )
    return await get_config(_op=_op)


@router.post('/test')
async def test_webhook(_op: dict = Depends(get_current_operator)):
    """Send a ping to verify the webhook is wired correctly."""
    ok = await send_event(
        'Test ping from TBC AI Tools operator console',
        kind='info',
    )
    if not ok:
        raise HTTPException(502, 'Webhook send failed — check URL + connectivity')
    return {'sent': True}
