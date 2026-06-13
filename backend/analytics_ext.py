"""Operator revenue & growth analytics — Last 30 days.

One endpoint, four series. Aggregates straight off the existing
collections (payment_transactions, users, referral_earnings,
user_notifications) so we don't introduce any new persistence and the
numbers are always live.

Returned shape (one row per day, oldest → newest UTC dates):

  {
    "days":     ["2026-01-15", ...30 ISO dates...],
    "currency": "usd",
    "series": {
      "revenue":     [12.5, 0, 45.0, ...],    # sum of paid amounts
      "signups":     [3, 5, 1, ...],           # users created
      "referrals":   [0, 1, 0, ...],           # referral_earnings rows
      "birthday":    [0, 0, 2, ...],           # birthday notifications sent
    },
    "totals": {
      "revenue_30d":   1234.5,
      "signups_30d":   47,
      "referrals_30d": 4,
      "birthday_30d":  12,
      "mrr_estimate":  410.0     # mean monthly run-rate from the 30d window
    }
  }
"""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc.analytics')
router = APIRouter(prefix='/api/operator/analytics')

# How many days back we report. The UI assumes 30 — bumping this here
# is the only place to change the window.
_WINDOW_DAYS = 30


def _day_keys(start: datetime, days: int) -> list[str]:
    """List of `days` ISO date keys (YYYY-MM-DD) starting at `start` (UTC)."""
    return [(start + timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days)]


async def _series_revenue(start: datetime) -> dict[str, float]:
    """Sum of paid amounts in `payment_transactions` per UTC day."""
    pipeline = [
        {'$match': {
            'payment_status': 'paid',
            'created_at': {'$gte': start},
        }},
        {'$group': {
            '_id': {'$dateToString': {'format': '%Y-%m-%d', 'date': '$created_at'}},
            'total': {'$sum': '$amount'},
        }},
    ]
    out: dict[str, float] = {}
    async for row in db.payment_transactions.aggregate(pipeline):
        # Cast to float — Mongo may return Decimal128 if numbers were stored that way.
        try:
            out[row['_id']] = round(float(row.get('total') or 0), 2)
        except Exception:
            out[row['_id']] = 0.0
    return out


async def _series_count(coll, start: datetime, extra_match: dict | None = None,
                         date_field: str = 'created_at') -> dict[str, int]:
    """Generic per-day count helper. Counts docs in `coll` whose `date_field`
    is in the window, optionally restricted by `extra_match`."""
    match: dict = {date_field: {'$gte': start}}
    if extra_match:
        match.update(extra_match)
    pipeline = [
        {'$match': match},
        {'$group': {
            '_id': {'$dateToString': {'format': '%Y-%m-%d', 'date': f'${date_field}'}},
            'n': {'$sum': 1},
        }},
    ]
    out: dict[str, int] = {}
    async for row in coll.aggregate(pipeline):
        out[row['_id']] = int(row.get('n') or 0)
    return out


@router.get('/30d')
async def thirty_day_analytics(_: dict = Depends(get_current_operator)):
    """Return all four series + totals for the trailing 30-day window."""
    return await compute_30d_analytics()


async def compute_30d_analytics() -> dict:
    """Internal helper — same payload as the endpoint but callable from
    background tasks (alerts scheduler) without faking a FastAPI request."""
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=_WINDOW_DAYS - 1)
    days = _day_keys(start, _WINDOW_DAYS)

    # Fan out four small aggregations.
    revenue_map = await _series_revenue(start)
    signup_map = await _series_count(db.users, start)
    referral_map = await _series_count(db.referral_earnings, start)
    # Founder royalty owed in the window — sum of `royalty_amount` per
    # day where status is anything (owed/remitted/disputed all count).
    royalty_pipeline = [
        {'$match': {'occurred_at': {'$gte': start}}},
        {'$group': {
            '_id': {'$dateToString': {'format': '%Y-%m-%d', 'date': '$occurred_at'}},
            'total': {'$sum': '$royalty_amount'},
        }},
    ]
    royalty_map: dict[str, float] = {}
    async for row in db.royalties.aggregate(royalty_pipeline):
        try:
            royalty_map[row['_id']] = round(float(row.get('total') or 0), 2)
        except Exception:
            royalty_map[row['_id']] = 0.0
    # Birthday rewards leave a notification with this exact subject (see
    # birthday_ext.py). Counting those gives us "rewards issued per day".
    birthday_map = await _series_count(
        db.user_notifications, start,
        extra_match={'subject': '🎂 Happy birthday!'},
    )

    def _flat(m: dict, default=0):
        return [m.get(d, default) for d in days]

    revenue = _flat(revenue_map, 0.0)
    signups = _flat(signup_map)
    referrals = _flat(referral_map)
    royalty = _flat(royalty_map, 0.0)
    birthday = _flat(birthday_map)

    revenue_30d = round(sum(revenue), 2)
    return {
        'days': days,
        'currency': 'usd',
        'series': {
            'revenue': revenue,
            'signups': signups,
            'referrals': referrals,
            'royalty': royalty,
            'birthday': birthday,
        },
        'totals': {
            'revenue_30d': revenue_30d,
            'signups_30d': sum(signups),
            'referrals_30d': sum(referrals),
            'royalty_30d': round(sum(royalty), 2),
            'birthday_30d': sum(birthday),
            # 30d revenue is already a monthly window, so MRR ≈ revenue_30d.
            # Operator can read it as "trailing monthly recurring proxy".
            'mrr_estimate': revenue_30d,
        },
    }
