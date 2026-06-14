"""Operator backup / restore — export your data from one environment
and re-import it into another (e.g. preview → production).

Why this exists
---------------
The operator created deploy projects, promo codes, KYC bypass entries,
and auto-fix config in one environment. To bring them across to another
(e.g. from the Emergent preview pod into the live production app at
tbctools.org), they need a self-service copy mechanism — without ever
exposing the raw Mongo connection.

The endpoints below are operator-only and return / accept JSON. The
recommended workflow is:

  1. On SOURCE env: GET /api/operator/backup/export → download JSON
  2. On TARGET env: POST /api/operator/backup/import (paste JSON) →
     each collection is upserted by primary key.

Collections covered
-------------------
- deploy_projects (your Vercel deploy targets)
- promo_codes    (the "Codes" tab)
- kyc_bypass_emails (operator-only KYC allowlist)
- vanished_emails (re-registration block list)
- app_settings   (auto-fix + similar config docs)
- payment_settings (selected non-secret fields only — see below)

What is NOT exported
--------------------
- `users` and `chat_sessions` — privacy + size.
- Raw secrets inside `payment_settings` (Stripe keys, GitHub token,
  etc.) — those should be re-entered manually in the target env so the
  operator stays in control of where their credentials land.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/backup', tags=['operator-backup'])

# Fields stripped from payment_settings on export — these are credentials
# the operator must re-enter manually in the target env (never leave the
# vault automatically). We DO keep non-secret config (toggles, urls).
_SECRET_FIELDS = {
    'stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret',
    'paypal_secret', 'paypal_client_id',
    'nowpayments_api_key', 'nowpayments_ipn_secret',
    'resend_api_key', 'resend_from',
    'emergent_llm_key',
    'vercel_token', 'github_token',
    'webhook_secret', 'ai_api_key',
    'slack_webhook', 'discord_webhook',
}


def _strip_secrets(doc: dict) -> dict:
    """Return a copy with secret fields removed (None placeholder kept so
    the import side knows the field exists but needs re-entry)."""
    out = {k: v for k, v in doc.items() if k != '_id'}
    for k in _SECRET_FIELDS:
        if k in out:
            out[k] = None
    return out


def _no_id(doc: dict) -> dict:
    """Strip Mongo `_id`; everything else stays."""
    return {k: v for k, v in (doc or {}).items() if k != '_id'}


@router.get('/export')
async def export_backup(op: dict = Depends(get_current_operator)):
    """Snapshot the operator's portable data as JSON. Safe to download
    and paste into another environment's `/backup/import`."""
    deploy_projects = [_no_id(d) async for d in db.deploy_projects.find({})]
    promo_codes     = [_no_id(d) async for d in db.promo_codes.find({})]
    kyc_bypass      = [_no_id(d) async for d in db.kyc_bypass_emails.find({})]
    vanished        = [_no_id(d) async for d in db.vanished_emails.find({})]
    app_settings    = [_no_id(d) async for d in db.app_settings.find({})]
    payment_doc     = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    payment_safe    = _strip_secrets(payment_doc) if payment_doc else {}

    return {
        'version': 1,
        'exported_at': datetime.now(timezone.utc).isoformat(),
        'exported_by': op.get('email'),
        'counts': {
            'deploy_projects': len(deploy_projects),
            'promo_codes': len(promo_codes),
            'kyc_bypass_emails': len(kyc_bypass),
            'vanished_emails': len(vanished),
            'app_settings': len(app_settings),
        },
        'deploy_projects': deploy_projects,
        'promo_codes': promo_codes,
        'kyc_bypass_emails': kyc_bypass,
        'vanished_emails': vanished,
        'app_settings': app_settings,
        'payment_settings_no_secrets': payment_safe,
    }


class ImportRequest(BaseModel):
    version: int = 1
    deploy_projects: list[dict] = []
    promo_codes: list[dict] = []
    kyc_bypass_emails: list[dict] = []
    vanished_emails: list[dict] = []
    app_settings: list[dict] = []
    # Two modes:
    #   merge   — upsert by primary key; existing docs not present in
    #             the import are LEFT ALONE (default; safe).
    #   replace — wipe each collection first, then insert the JSON.
    #             Use only when you know the target is empty / stale.
    mode: str = 'merge'


def _pk_for(collection_name: str) -> tuple[str, ...]:
    """Primary key used for upsert per collection. Falls back to `id`."""
    return {
        'deploy_projects':    ('id',),
        'promo_codes':        ('code',),
        'kyc_bypass_emails':  ('email',),
        'vanished_emails':    ('email',),
        'app_settings':       ('_id',),  # app_settings docs use string _id
    }.get(collection_name, ('id',))


async def _import_collection(coll, docs: list[dict], pk: tuple[str, ...], mode: str) -> int:
    """Upsert (or replace) a collection. Returns count written."""
    if mode == 'replace':
        await coll.delete_many({})
    written = 0
    for d in docs:
        if not isinstance(d, dict):
            continue
        key = {k: d.get(k) for k in pk if d.get(k) is not None}
        if not key:
            # No PK present — fall back to plain insert; safe.
            await coll.insert_one(d)
            written += 1
            continue
        await coll.update_one(key, {'$set': d}, upsert=True)
        written += 1
    return written


@router.post('/import')
async def import_backup(
    req: ImportRequest = Body(...),
    op: dict = Depends(get_current_operator),
):
    """Restore JSON produced by `/export`. Operator-only."""
    if req.version != 1:
        raise HTTPException(400, f'Unsupported backup version: {req.version}')
    if req.mode not in ('merge', 'replace'):
        raise HTTPException(400, "mode must be 'merge' or 'replace'")
    counts: dict[str, int] = {}
    counts['deploy_projects']   = await _import_collection(db.deploy_projects,   req.deploy_projects,   _pk_for('deploy_projects'),   req.mode)
    counts['promo_codes']       = await _import_collection(db.promo_codes,       req.promo_codes,       _pk_for('promo_codes'),       req.mode)
    counts['kyc_bypass_emails'] = await _import_collection(db.kyc_bypass_emails, req.kyc_bypass_emails, _pk_for('kyc_bypass_emails'), req.mode)
    counts['vanished_emails']   = await _import_collection(db.vanished_emails,   req.vanished_emails,   _pk_for('vanished_emails'),   req.mode)
    counts['app_settings']      = await _import_collection(db.app_settings,      req.app_settings,      _pk_for('app_settings'),      req.mode)
    try:
        await db.audit_log.insert_one({
            'actor_email': op.get('email'),
            'kind': 'backup.import',
            'target': f"mode={req.mode}",
            'counts': counts,
            'created_at': datetime.now(timezone.utc),
        })
    except Exception:
        pass
    logger.info('Operator %s imported backup: %s', op.get('email'), counts)
    return {
        'success': True,
        'mode': req.mode,
        'written': counts,
        'restored_at': datetime.now(timezone.utc).isoformat(),
    }
