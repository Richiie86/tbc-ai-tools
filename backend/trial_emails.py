"""Trial-expiry email automation.

Two reminders per user:
  • T-3 days: "X days left on your trial" → field `trial_email_3d_sent_at`
  • T-0 (expired): "Your trial just ended" → field `trial_email_expired_sent_at`

Both are sent idempotently — the user record carries a sent timestamp per
reminder, so re-running the cron does nothing once a flag is set.

Scheduled by APScheduler in `server.py` (once an hour) so production deploys
automatically pick it up. Also exposed as `/api/operator/cron/trial-reminders`
for manual triggering / smoke testing.
"""
import os
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query

from auth_utils import get_current_operator
from db import db
from email_utils import (
    send_email,
    render_trial_reminder_email,
    render_trial_expired_email,
)

logger = logging.getLogger('tbc.trial')
router = APIRouter(prefix='/api/operator/cron')


def _upgrade_url() -> str:
    base = (os.environ.get('PUBLIC_APP_URL') or 'https://tbctools.org').rstrip('/')
    return f'{base}/pricing'


async def _plan_name(plan_id: str) -> str:
    if not plan_id:
        return 'Trial'
    p = await db.plans.find_one({'id': plan_id})
    return (p or {}).get('name') or plan_id.replace('_', ' ').title()


async def scan_and_send(dry_run: bool = False) -> dict:
    """Scan users with trial expiry and dispatch the right reminder.

    Returns counters for monitoring + the per-user emails attempted.
    """
    now = datetime.now(timezone.utc)
    window_t3_low = now + timedelta(days=2, hours=12)   # ~2.5 days from now
    window_t3_high = now + timedelta(days=3, hours=12)  # ~3.5 days from now

    counters = {'t3_sent': 0, 'expired_sent': 0, 'skipped_already_sent': 0, 'errors': 0, 'events': []}

    # T-3 reminders: users whose plan_expires_at lands in the ~3-day window
    # and who haven't received the 3-day reminder yet.
    t3_cursor = db.users.find({
        'plan_expires_at': {'$gte': window_t3_low, '$lte': window_t3_high},
        '$or': [
            {'trial_email_3d_sent_at': {'$exists': False}},
            {'trial_email_3d_sent_at': None},
        ],
        'deleted_at': {'$in': [None, False]},
    })
    async for u in t3_cursor:
        exp = u['plan_expires_at']
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        days_left = max(1, int((exp - now).total_seconds() // 86400) + (1 if (exp - now).total_seconds() % 86400 > 0 else 0))
        plan_name = await _plan_name(u.get('plan'))
        try:
            if not dry_run:
                await send_email(
                    to=u['email'],
                    subject=f"{days_left} day{'s' if days_left != 1 else ''} left on your TBC AI Tools trial",
                    html=render_trial_reminder_email(u.get('name'), plan_name, days_left, _upgrade_url()),
                )
                await db.users.update_one({'id': u['id']}, {'$set': {'trial_email_3d_sent_at': now}})
            counters['t3_sent'] += 1
            counters['events'].append({'type': 't3', 'email': u['email'], 'days_left': days_left})
        except Exception as e:
            counters['errors'] += 1
            counters['events'].append({'type': 't3', 'email': u['email'], 'error': str(e)[:160]})
            logger.exception('trial t3 email failed for %s', u['email'])

    # Expired reminders: users whose plan_expires_at is in the past (any time)
    # AND we never sent the expiry email.
    expired_cursor = db.users.find({
        'plan_expires_at': {'$lt': now},
        '$or': [
            {'trial_email_expired_sent_at': {'$exists': False}},
            {'trial_email_expired_sent_at': None},
        ],
        'deleted_at': {'$in': [None, False]},
    })
    async for u in expired_cursor:
        plan_name = await _plan_name(u.get('plan'))
        try:
            if not dry_run:
                await send_email(
                    to=u['email'],
                    subject='Your TBC AI Tools trial just ended',
                    html=render_trial_expired_email(u.get('name'), plan_name, _upgrade_url()),
                )
                await db.users.update_one({'id': u['id']}, {'$set': {'trial_email_expired_sent_at': now}})
            counters['expired_sent'] += 1
            counters['events'].append({'type': 'expired', 'email': u['email']})
        except Exception as e:
            counters['errors'] += 1
            counters['events'].append({'type': 'expired', 'email': u['email'], 'error': str(e)[:160]})
            logger.exception('trial expired email failed for %s', u['email'])

    counters['ran_at'] = now.isoformat()
    counters['dry_run'] = dry_run
    return counters


@router.post('/trial-reminders')
async def cron_trial_reminders(
    _user: dict = Depends(get_current_operator),
    dry_run: bool = Query(False, description='Skip actually sending emails — just report what would go out'),
):
    """Manual trigger for the trial email scan. Used by Ops tab + smoke tests."""
    result = await scan_and_send(dry_run=dry_run)
    return result
