"""Analytics alert thresholds — push notifications when growth metrics
drift the wrong way.

Operator configures a small set of thresholds + delivery channels:

  • signup_drop_pct        — alert if last-7d signups drop by ≥X% vs prior 7d
  • revenue_stall_days     — alert if there's been ≥N consecutive $0 days

Channels (any combination, all optional):
  • Email      — via the existing Resend integration (email_utils.send_email)
  • Slack      — incoming-webhook URL (https://hooks.slack.com/services/...)
  • Discord    — webhook URL (https://discord.com/api/webhooks/...)

Implementation choices:
  • Settings doc: db.settings({_id:'analytics_alerts'}) — no new collection.
  • Scheduler: hourly tick, real work once per UTC day. Identical pattern
    to birthday_ext so we keep one mental model.
  • Idempotency: a `last_fired_day` field is stamped after a successful
    notification, so a flapping metric doesn't email the operator 24x.
  • Channel failures don't block each other — a broken Slack URL still
    lets email + Discord go out.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from auth_utils import get_current_operator
from db import db
from email_utils import send_email
from analytics_ext import compute_30d_analytics


logger = logging.getLogger('tbc.alerts')
router = APIRouter(prefix='/api/operator/alerts')

_DEFAULT_CFG = {
    'enabled': False,
    'signup_drop_pct': 50,        # %
    'revenue_stall_days': 7,      # consecutive zero-revenue days
    'email_recipients': '',       # comma-separated
    'slack_webhook': '',
    'discord_webhook': '',
    'last_fired_day': None,       # ISO date string (YYYY-MM-DD) of last alert
    'last_fired_reasons': [],     # what triggered the last fire
}


async def _get_cfg() -> dict:
    doc = await db.settings.find_one({'_id': 'analytics_alerts'}) or {}
    return {**_DEFAULT_CFG, **{k: v for k, v in doc.items() if k != '_id'}}


def _redact(cfg: dict) -> dict:
    """Mask the secret tail of webhook URLs before returning to the browser."""
    out = dict(cfg)
    for k in ('slack_webhook', 'discord_webhook'):
        v = out.get(k) or ''
        if v:
            out[k] = v[:32] + '…' if len(v) > 36 else '••••'
    out['email_recipients'] = out.get('email_recipients') or ''
    return out


@router.get('/thresholds')
async def get_thresholds(_: dict = Depends(get_current_operator)):
    return _redact(await _get_cfg())


@router.put('/thresholds')
async def update_thresholds(
    payload: dict = Body(...),
    _: dict = Depends(get_current_operator),
):
    update: dict = {}
    if 'enabled' in payload:
        update['enabled'] = bool(payload['enabled'])
    if 'signup_drop_pct' in payload:
        update['signup_drop_pct'] = max(0, min(100, int(payload.get('signup_drop_pct') or 0)))
    if 'revenue_stall_days' in payload:
        update['revenue_stall_days'] = max(1, min(30, int(payload.get('revenue_stall_days') or 1)))
    if 'email_recipients' in payload:
        update['email_recipients'] = str(payload.get('email_recipients') or '').strip()
    # Webhooks: empty string means "leave alone" (so the redacted form
    # doesn't clobber the real value). Pass an explicit `null` to clear.
    for key in ('slack_webhook', 'discord_webhook'):
        if key in payload:
            v = payload.get(key)
            if v is None:
                update[key] = ''
            elif isinstance(v, str) and v.strip() and not v.endswith('…') and v != '••••':
                update[key] = v.strip()
    if not update:
        raise HTTPException(400, 'Nothing to update')
    await db.settings.update_one({'_id': 'analytics_alerts'}, {'$set': update}, upsert=True)
    return _redact(await _get_cfg())


# ─── Channel dispatch helpers ───────────────────────────────────────────
async def _post_webhook(url: str, payload: dict, label: str) -> bool:
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(url, json=payload)
            if r.status_code >= 400:
                logger.warning('%s alert failed (HTTP %s): %s', label, r.status_code, r.text[:200])
                return False
        return True
    except Exception as e:
        logger.warning('%s alert exception: %s', label, str(e)[:200])
        return False


async def _send_email_all(recipients: str, subject: str, html: str) -> int:
    """Returns count of successful deliveries."""
    if not recipients:
        return 0
    ok = 0
    for addr in [a.strip() for a in recipients.split(',') if a.strip()]:
        try:
            await send_email(addr, subject, html)
            ok += 1
        except Exception as e:
            logger.warning('Email alert to %s failed: %s', addr, str(e)[:200])
    return ok


def _alert_email_html(reasons: list[str]) -> str:
    bullets = ''.join(f'<li>{r}</li>' for r in reasons)
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e7e3d6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0c;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#13131a;border:1px solid #3a2c08;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:32px 36px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d4a93a;font-weight:700;">TBC AI Tools · Growth alert</div>
          <h1 style="margin:18px 0 6px 0;font-size:22px;color:#f4eed5;font-weight:700;">Something needs your attention</h1>
          <ul style="margin:8px 0 22px 22px;font-size:14px;line-height:1.55;color:#a8a092;">{bullets}</ul>
          <p style="margin:22px 0 0 0;font-size:12px;color:#7e7768;">Open the Analytics tab in your Operator Console for the live numbers.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


# ─── Evaluator ──────────────────────────────────────────────────────────
def _evaluate_reasons(cfg: dict, analytics: dict) -> list[str]:
    """Return a list of human-readable reasons the operator should be alerted.
    Empty list = nothing to fire."""
    reasons: list[str] = []
    series = analytics.get('series') or {}
    signups = series.get('signups') or []
    revenue = series.get('revenue') or []

    # 1) Signup drop: compare last 7d vs prior 7d.
    if len(signups) >= 14:
        last7 = sum(signups[-7:])
        prev7 = sum(signups[-14:-7])
        threshold = int(cfg.get('signup_drop_pct') or 0)
        if prev7 > 0 and threshold > 0:
            drop = round(((prev7 - last7) / prev7) * 100)
            if drop >= threshold:
                reasons.append(
                    f'Signups dropped {drop}% over the last 7 days '
                    f'({prev7} → {last7}). Threshold is {threshold}%.'
                )

    # 2) Revenue stall: trailing N consecutive zero-revenue days.
    n = int(cfg.get('revenue_stall_days') or 0)
    if n > 0 and len(revenue) >= n:
        tail = revenue[-n:]
        if all((v or 0) <= 0 for v in tail):
            reasons.append(
                f'No paid revenue for {n} consecutive day{"s" if n != 1 else ""} '
                f'(through {analytics["days"][-1]}).'
            )
    return reasons


async def _dispatch_alert(cfg: dict, reasons: list[str]) -> dict:
    """Fan out one alert to every configured channel. Returns per-channel ok counts."""
    text = 'TBC AI Tools growth alert:\n' + '\n'.join(f'• {r}' for r in reasons)
    slack_ok = await _post_webhook(cfg.get('slack_webhook') or '', {'text': text}, 'Slack')
    discord_ok = await _post_webhook(cfg.get('discord_webhook') or '', {'content': text}, 'Discord')
    email_n = await _send_email_all(
        cfg.get('email_recipients') or '',
        '⚠️ TBC AI Tools — growth alert',
        _alert_email_html(reasons),
    )
    return {'slack': slack_ok, 'discord': discord_ok, 'emails_sent': email_n}


async def _run_alerts_pass(force: bool = False) -> dict:
    cfg = await _get_cfg()
    if not cfg.get('enabled') and not force:
        return {'enabled': False, 'fired': False}

    # Use the internal helper (no FastAPI deps) for background dispatch.
    analytics = await compute_30d_analytics()
    reasons = _evaluate_reasons(cfg, analytics)
    if not reasons:
        return {'enabled': True, 'fired': False, 'reasons': []}

    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    # Idempotency: don't refire the same day's alert.
    if not force and cfg.get('last_fired_day') == today:
        return {'enabled': True, 'fired': False, 'reasons': reasons, 'skipped': 'already_fired_today'}

    dispatch = await _dispatch_alert(cfg, reasons)
    await db.settings.update_one(
        {'_id': 'analytics_alerts'},
        {'$set': {'last_fired_day': today, 'last_fired_reasons': reasons}},
        upsert=True,
    )
    return {'enabled': True, 'fired': True, 'reasons': reasons, 'dispatch': dispatch}


@router.post('/run-now')
async def run_alerts_now(_: dict = Depends(get_current_operator)):
    """Manual trigger — useful for QA. Bypasses the once-per-day idempotency
    so the operator can iterate on the message/threshold quickly."""
    return await _run_alerts_pass(force=True)


@router.post('/test')
async def test_channels(_: dict = Depends(get_current_operator)):
    """Send a 'hello from TBC' message to every configured channel so the
    operator can prove the wiring before relying on it for real alerts."""
    cfg = await _get_cfg()
    reasons = ['This is a test alert from your Operator Console. If you can read this, the channel is wired.']
    dispatch = await _dispatch_alert(cfg, reasons)
    return {'ok': True, 'dispatch': dispatch}


# ─── Scheduler ──────────────────────────────────────────────────────────
async def alerts_scheduler_loop():
    """Daily loop — wakes once an hour, only does real work once per UTC day."""
    last_run_day = None
    while True:
        try:
            today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            if last_run_day != today:
                res = await _run_alerts_pass(force=False)
                last_run_day = today
                logger.info('Alerts pass for %s: %s', today, json.dumps(res, default=str)[:300])
        except Exception as e:
            logger.exception('Alerts scheduler tick failed: %s', e)
        await asyncio.sleep(3600)
