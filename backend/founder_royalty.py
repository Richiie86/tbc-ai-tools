"""Founder royalty — 10% of every paid transaction is owed to the
original operator of this codebase. This is BAKED INTO THE CODE so a
clone of the source carries the same obligation.

Design contract:
  • The founder identity (email + license key) is a *code constant*,
    not a DB row. A clone that wants to claim the royalty for itself
    has to literally edit this file — the operator UI cannot.
  • At startup we ensure a License document exists pinned to the
    founder, with status='active' and royalty_pct=10. If a previous
    boot soft-deleted or mutated it, we recreate the original values.
  • Every successful payment hits `record_local_royalty(...)` which:
        1. Writes a `royalties` record owed to the founder (always 10%).
        2. Fires a best-effort POST to the canonical founder report URL
           so the original operator's ledger is kept in sync even from
           a clone. Network failure does NOT block the payment.
  • The licenses CRUD endpoints in `payments_ext` already exist; they
    delegate to `is_founder_license(...)` here to refuse a delete or
    a percentage change on the founder row.

This is enforcement-by-visibility — a determined fork can patch the
source — but it makes the obligation explicit, auditable, and
single-place to update.
"""
import logging
import os
from datetime import datetime, timezone

import httpx

from db import db


logger = logging.getLogger('tbc.royalty')


# ─── HARDCODED FOUNDER IDENTITY ─────────────────────────────────────────
# This is the *original* operator of TBC AI Tools. Every clone of this
# codebase reports 10% of its paid transactions to this license key.
FOUNDER_EMAIL = 'rac.investments.swe@gmail.com'
FOUNDER_LICENSE_KEY = 'TBC-FOUNDER-PRIMARY-LICENSE-DO-NOT-MODIFY'
FOUNDER_HOLDER_NAME = 'TBC AI Tools — original operator'
FOUNDER_COMPANY = 'Tradebridge Club'
# Canonical production endpoint where clones phone-home their royalties.
# Override via FOUNDER_REPORT_URL env if you need to point at a staging
# instance during testing.
FOUNDER_REPORT_URL = os.environ.get(
    'FOUNDER_REPORT_URL',
    'https://tbctools.org/api/license/report-earnings',
)
# The founder royalty is intentionally NOT operator-configurable.
FOUNDER_ROYALTY_PCT: float = 10.0


def is_founder_license(doc: dict) -> bool:
    """True when the supplied license row IS the founder license — used by
    the licenses CRUD routes to block deletes / percentage edits."""
    if not doc:
        return False
    if (doc.get('key') or '').strip() == FOUNDER_LICENSE_KEY:
        return True
    if (doc.get('holder_email') or '').strip().lower() == FOUNDER_EMAIL:
        return True
    return False


async def ensure_founder_license() -> dict:
    """Seed / repair the founder license at startup. Idempotent.

    If a previous boot is missing the row, recreate it. If it was tampered
    with (royalty_pct changed, status revoked, holder email rewritten),
    repair it back to the canonical values so the obligation can never
    be quietly disabled.
    """
    now = datetime.now(timezone.utc)
    canonical = {
        'id': 'license-founder-primary',
        'key': FOUNDER_LICENSE_KEY,
        'holder_name': FOUNDER_HOLDER_NAME,
        'holder_email': FOUNDER_EMAIL,
        'company': FOUNDER_COMPANY,
        'royalty_pct': FOUNDER_ROYALTY_PCT,
        'notes': (
            'Founder license — 10% of every paid transaction in this codebase '
            'is owed to the original operator. This row is recreated at every '
            'startup; the licenses UI refuses to delete or rewrite it.'
        ),
        'status': 'active',
    }
    existing = await db.licenses.find_one({'key': FOUNDER_LICENSE_KEY})
    if not existing:
        canonical['created_at'] = now
        await db.licenses.insert_one(canonical)
        logger.info('Founder license CREATED (royalty %.1f%% to %s)',
                    FOUNDER_ROYALTY_PCT, FOUNDER_EMAIL)
        return canonical

    # Repair drift — only the operator-editable fields are left untouched.
    changes = {}
    if (existing.get('holder_email') or '').strip().lower() != FOUNDER_EMAIL:
        changes['holder_email'] = FOUNDER_EMAIL
    if float(existing.get('royalty_pct') or 0) != FOUNDER_ROYALTY_PCT:
        changes['royalty_pct'] = FOUNDER_ROYALTY_PCT
    if (existing.get('status') or '') != 'active':
        changes['status'] = 'active'
    if changes:
        await db.licenses.update_one({'_id': existing['_id']}, {'$set': changes})
        logger.warning('Founder license REPAIRED — restored fields: %s', list(changes))
    return {**existing, **changes}


async def record_local_royalty(
    *,
    transaction_id: str,
    amount: float,
    currency: str = 'usd',
    payment_method: str | None = None,
    user_email: str | None = None,
    plan_id: str | None = None,
) -> dict | None:
    """Stamp a royalty record AND phone-home to the founder's canonical
    endpoint. Called from the payment confirmation paths (Stripe webhook,
    PayPal capture, NOWPayments IPN).

    Returns the local royalty document on success, None on duplicate. All
    errors are logged but never re-raised — the payment flow must never
    be blocked by a royalty bookkeeping hiccup.
    """
    if not transaction_id or not amount or float(amount) <= 0:
        return None
    try:
        lic = await ensure_founder_license()
        # Idempotency — never double-count the same transaction.
        existing = await db.royalties.find_one({
            'license_id': lic['id'],
            'child_transaction_id': transaction_id,
        })
        if existing:
            return None
        gross = round(float(amount), 2)
        royalty = round(gross * (FOUNDER_ROYALTY_PCT / 100.0), 2)
        now = datetime.now(timezone.utc)
        doc = {
            'id': f'r-{transaction_id}',
            'license_id': lic['id'],
            'license_key': lic['key'],
            'child_transaction_id': transaction_id,
            'child_user_email': user_email,
            'plan_id': plan_id,
            'gross_amount': gross,
            'royalty_amount': royalty,
            'currency': currency or 'usd',
            'payment_method': payment_method,
            'status': 'owed',
            'occurred_at': now,
            'created_at': now,
        }
        await db.royalties.insert_one(doc)
        logger.info(
            'Royalty stamped — tx=%s gross=%.2f royalty=%.2f (%s%%)',
            transaction_id, gross, royalty, FOUNDER_ROYALTY_PCT,
        )
    except Exception:
        logger.exception('Local royalty stamp failed for tx=%s', transaction_id)
        doc = None

    # Phone home — best-effort POST so the founder's ledger stays in sync.
    # We swallow ALL exceptions: network down, founder URL unreachable,
    # license not yet provisioned at the canonical host — none of these
    # should impact the local payment outcome.
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            await c.post(
                FOUNDER_REPORT_URL,
                json={
                    'license_key': FOUNDER_LICENSE_KEY,
                    'child_transaction_id': transaction_id,
                    'child_user_email': user_email,
                    'plan_id': plan_id,
                    'amount': float(amount),
                    'currency': currency or 'usd',
                    'payment_method': payment_method,
                },
            )
    except Exception as e:
        logger.info('Royalty phone-home skipped (%s)', str(e)[:120])

    return doc
