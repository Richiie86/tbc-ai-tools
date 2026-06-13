"""Operator birthday-rewards programme.

When users register they may supply `dob` (YYYY-MM-DD). Once a day a
background task scans for users whose month-day matches today's, and:

  1. Grants the configured `credits` to their balance.
  2. Drops a celebratory in-app notification with the operator's chosen
     message (and a mention of the `discount_pct` perk, if any).
  3. Stamps `birthday_rewarded_year = today.year` so we never double-pay.

The operator can also fire a one-off birthday DM via
`POST /api/operator/users/{user_id}/birthday-message`.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from auth_utils import get_current_operator
from db import db


logger = logging.getLogger('tbc.birthday')
router = APIRouter(prefix='/api')


_DEFAULT_CFG = {
    'enabled': True,
    'credits': 200,
    'discount_pct': 10,
    'message': (
        '🎂 Happy birthday from the TBCTools team! '
        'We just dropped {credits} credits onto your account as a little gift. '
        'Enjoy {discount_pct}% off any plan upgrade this week.'
    ),
}


async def _get_cfg() -> dict:
    doc = await db.settings.find_one({'_id': 'birthday_rewards'}) or {}
    return {**_DEFAULT_CFG, **{k: v for k, v in doc.items() if k != '_id'}}


def _render(template: str, *, credits: int, discount_pct: int, name: Optional[str]) -> str:
    return (template or '').format(
        credits=credits, discount_pct=discount_pct, name=(name or 'there'),
    )


@router.get('/operator/birthday-rewards')
async def get_birthday_cfg(_: dict = Depends(get_current_operator)):
    cfg = await _get_cfg()
    return cfg


@router.put('/operator/birthday-rewards')
async def update_birthday_cfg(
    payload: dict = Body(...),
    _: dict = Depends(get_current_operator),
):
    """Save the operator's birthday-rewards config.

    Body: {"enabled": true, "credits": 200, "discount_pct": 10, "message": "..."}
    """
    update = {}
    if 'enabled' in payload:
        update['enabled'] = bool(payload['enabled'])
    if 'credits' in payload:
        update['credits'] = max(0, int(payload.get('credits') or 0))
    if 'discount_pct' in payload:
        update['discount_pct'] = max(0, min(100, int(payload.get('discount_pct') or 0)))
    if 'message' in payload:
        update['message'] = str(payload.get('message') or '').strip() or _DEFAULT_CFG['message']
    if not update:
        raise HTTPException(400, 'Nothing to update')
    await db.settings.update_one({'_id': 'birthday_rewards'}, {'$set': update}, upsert=True)
    return await _get_cfg()


@router.post('/operator/users/{user_id}/birthday-message')
async def send_personal_birthday(
    user_id: str,
    payload: dict = Body(default=None),
    op: dict = Depends(get_current_operator),
):
    """Operator-initiated 'happy birthday' DM. Sends the configured (or
    overridden) message and optionally also credits the user — useful when
    the operator wants to wish someone on a date that isn't their DOB
    (e.g. a workspace anniversary)."""
    user = await db.users.find_one({'id': user_id})
    if not user:
        raise HTTPException(404, 'User not found')
    cfg = await _get_cfg()
    body_override = (payload or {}).get('message')
    credits_override = (payload or {}).get('credits')
    grant_credits = bool((payload or {}).get('grant_credits', False))

    credits_to_grant = int(credits_override) if credits_override is not None else int(cfg['credits'])
    discount_pct = int(cfg['discount_pct'])
    message = body_override or cfg['message']
    rendered = _render(message, credits=credits_to_grant, discount_pct=discount_pct, name=user.get('name'))

    if grant_credits and credits_to_grant > 0:
        await db.users.update_one({'id': user_id}, {'$inc': {'credits': credits_to_grant}})

    from notifications_ext import _uid as _notif_uid  # lazy: circular import safety
    await db.user_notifications.insert_one({
        'id': _notif_uid(),
        'user_id': user_id,
        'from_operator_id': op.get('id') or op.get('sub'),
        'kind': 'broadcast',
        'subject': '🎂 Happy birthday!',
        'body': rendered,
        'read_at': None,
        'created_at': datetime.now(timezone.utc),
    })
    return {
        'ok': True,
        'user_id': user_id,
        'credits_granted': credits_to_grant if grant_credits else 0,
    }


# ─── Scheduler ──────────────────────────────────────────────────────────
async def _run_birthday_pass() -> dict:
    """One pass — find every user whose DOB month/day matches today's
    (UTC) and grant rewards. Skips users already rewarded this year.
    Returns counts for observability."""
    cfg = await _get_cfg()
    if not cfg.get('enabled'):
        return {'enabled': False, 'rewarded': 0}

    today = datetime.now(timezone.utc).date()
    today_year = today.year
    today_md = today.strftime('-%m-%d')   # e.g. "-06-13"

    granted = 0
    skipped = 0
    async for u in db.users.find({'dob': {'$regex': f'{today_md}$'}, 'role': 'user'}):
        if u.get('birthday_rewarded_year') == today_year:
            skipped += 1
            continue
        credits = int(cfg.get('credits') or 0)
        discount_pct = int(cfg.get('discount_pct') or 0)
        if credits > 0:
            await db.users.update_one({'id': u['id']}, {'$inc': {'credits': credits}})
        msg = _render(cfg.get('message') or _DEFAULT_CFG['message'],
                      credits=credits, discount_pct=discount_pct, name=u.get('name'))
        from notifications_ext import _uid as _notif_uid
        await db.user_notifications.insert_one({
            'id': _notif_uid(),
            'user_id': u['id'],
            'from_operator_id': None,
            'kind': 'broadcast',
            'subject': '🎂 Happy birthday!',
            'body': msg,
            'read_at': None,
            'created_at': datetime.now(timezone.utc),
        })
        await db.users.update_one(
            {'id': u['id']},
            {'$set': {'birthday_rewarded_year': today_year}},
        )
        granted += 1
        logger.info('Birthday reward: %s got %d credits', u.get('email'), credits)
    return {'enabled': True, 'rewarded': granted, 'skipped_already_done': skipped}


@router.post('/operator/birthday-rewards/run-now')
async def run_birthday_now(_: dict = Depends(get_current_operator)):
    """Manual trigger — useful for QA and for the operator to re-run after
    changing the message wording."""
    return await _run_birthday_pass()


async def birthday_scheduler_loop():
    """Daily loop — wakes once an hour, only does real work once per UTC
    day. Cheap enough that we don't need cron or APScheduler."""
    last_run_day = None
    while True:
        try:
            today = datetime.now(timezone.utc).date()
            if last_run_day != today:
                res = await _run_birthday_pass()
                last_run_day = today
                logger.info('Birthday pass for %s: %s', today, res)
        except Exception as e:
            logger.exception('Birthday scheduler tick failed: %s', e)
        # 1h wake interval — granular enough for "morning of their day"
        # without burning resources.
        await asyncio.sleep(3600)
