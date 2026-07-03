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

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse
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
    'vercel_token', 'github_token',
    'webhook_secret', 'ai_api_key',
    'anthropic_api_key', 'openai_api_key', 'gemini_api_key',
    'openrouter_api_key', 'groq_api_key', 'render_api_key',
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


# ---------- Local-disk snapshot rotation (30-day history) ----------------
#
# A daily-rotated copy of `/export` written to local disk so the operator
# can restore from any of the last 30 days without manually re-pasting
# JSON. Storage is at `/app/data/backups/` so it survives container
# restarts but lives inside the persistent volume.
#
# A scheduled job (registered in server.py) calls `_run_snapshot()` once
# a day. The operator can also trigger one manually from the UI.

_BACKUP_DIR = Path(os.environ.get('BACKUP_SNAPSHOT_DIR', '/app/data/backups'))
_BACKUP_RETENTION_DAYS = int(os.environ.get('BACKUP_SNAPSHOT_RETENTION_DAYS', '30'))

# Optional S3 mirror — when `S3_BACKUP_BUCKET` is set every local
# snapshot is *also* uploaded to S3 under `<prefix>/<filename>`. Local
# disk stays the primary; S3 is a redundant off-host copy so the
# operator can survive a pod replacement that drops `/app/data/`.
# Required envs to enable: S3_BACKUP_BUCKET, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY (or an IAM role). Optional: S3_BACKUP_REGION
# (default us-east-1), S3_BACKUP_PREFIX (default 'tbc-backups/').
_S3_BUCKET = os.environ.get('S3_BACKUP_BUCKET')
_S3_REGION = os.environ.get('S3_BACKUP_REGION', 'us-east-1')
_S3_PREFIX = (os.environ.get('S3_BACKUP_PREFIX', 'tbc-backups/')).rstrip('/') + '/'
_s3_client = None  # lazy-init


def _get_s3():
    """Lazy-init the boto3 S3 client. Returns None if S3 isn't
    configured. Never raises — callers fall back to local-only on
    failure so snapshot writes never block on a misconfigured mirror."""
    global _s3_client
    if not _S3_BUCKET:
        return None
    if _s3_client is not None:
        return _s3_client
    try:
        import boto3
        _s3_client = boto3.client('s3', region_name=_S3_REGION)
        logger.info('backup S3 mirror ready: s3://%s/%s (region %s)',
                    _S3_BUCKET, _S3_PREFIX, _S3_REGION)
    except Exception:
        logger.exception('S3 mirror init failed; continuing local-only')
        _s3_client = None
    return _s3_client


def _s3_mirror_put(path: Path) -> bool:
    """Upload a snapshot file to S3. Returns True on success, False on
    any failure (logged, never raised). Local-disk write succeeds
    independently."""
    client = _get_s3()
    if client is None:
        return False
    try:
        key = f'{_S3_PREFIX}{path.name}'
        client.upload_file(str(path), _S3_BUCKET, key)
        logger.info('S3 mirror put ok: s3://%s/%s', _S3_BUCKET, key)
        return True
    except Exception:
        logger.exception('S3 mirror put failed for %s', path.name)
        return False


def _s3_mirror_prune(filenames_to_delete: list[str]) -> int:
    """Delete a list of snapshot filenames from the S3 mirror. Best
    effort — failures are logged but never raised."""
    client = _get_s3()
    if client is None or not filenames_to_delete:
        return 0
    try:
        objects = [{'Key': f'{_S3_PREFIX}{name}'} for name in filenames_to_delete]
        client.delete_objects(
            Bucket=_S3_BUCKET,
            Delete={'Objects': objects, 'Quiet': True},
        )
        logger.info('S3 mirror pruned %s file(s)', len(filenames_to_delete))
        return len(filenames_to_delete)
    except Exception:
        logger.exception('S3 mirror prune failed')
        return 0


def _ensure_backup_dir() -> Path:
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    return _BACKUP_DIR


async def _build_snapshot_payload(operator_email: str | None = None) -> dict:
    """Re-uses the same shape as `/export` so a snapshot file is a drop-in
    replacement for a freshly downloaded backup. Kept inline rather than
    delegating to the endpoint so the scheduled job doesn't need an HTTP
    round-trip."""
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
        'exported_by': operator_email or 'scheduler',
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


def _list_snapshots() -> list[dict]:
    """Returns the snapshot files newest-first with `{id, created_at,
    size_bytes}`. `id` is the filename minus suffix — used by the
    download endpoint to look the file back up safely (no path
    traversal)."""
    d = _ensure_backup_dir()
    out = []
    for p in sorted(d.glob('snapshot-*.json'), reverse=True):
        try:
            stat = p.stat()
            out.append({
                'id': p.stem,
                'filename': p.name,
                'created_at': datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                'size_bytes': stat.st_size,
            })
        except OSError:
            continue
    return out


def _prune_old_snapshots() -> int:
    """Drop any snapshot file older than the retention window. Returns
    the number of files removed. Also prunes the same files from the
    S3 mirror when one is configured."""
    d = _ensure_backup_dir()
    cutoff = datetime.now(timezone.utc) - timedelta(days=_BACKUP_RETENTION_DAYS)
    removed_names: list[str] = []
    for p in d.glob('snapshot-*.json'):
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
            if mtime < cutoff:
                p.unlink()
                removed_names.append(p.name)
        except OSError:
            continue
    if removed_names:
        _s3_mirror_prune(removed_names)
    return len(removed_names)


async def _run_snapshot(operator_email: str | None = None) -> dict:
    """Write a snapshot to disk + (optionally) mirror to S3 + prune old
    ones. Returns metadata about the new file. Used by both the
    scheduler job and the manual UI."""
    payload = await _build_snapshot_payload(operator_email)
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
    fname = f'snapshot-{stamp}.json'
    path = _ensure_backup_dir() / fname
    path.write_text(json.dumps(payload, indent=2, default=str))
    mirrored = _s3_mirror_put(path)
    pruned = _prune_old_snapshots()
    logger.info('backup snapshot written %s (%s bytes); s3 mirror=%s; pruned %s old files',
                path.name, path.stat().st_size, mirrored, pruned)
    return {
        'id': path.stem,
        'filename': path.name,
        'size_bytes': path.stat().st_size,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'pruned': pruned,
        'retention_days': _BACKUP_RETENTION_DAYS,
        's3_mirrored': mirrored,
        's3_enabled': bool(_S3_BUCKET),
    }


@router.get('/snapshots')
async def list_snapshots(_op: dict = Depends(get_current_operator)):
    """List on-disk snapshots (newest first). 30-day rolling window.
    Includes the S3 mirror status so the UI can flag operators that
    they have / don't have an off-host backup."""
    return {
        'snapshots': _list_snapshots(),
        'retention_days': _BACKUP_RETENTION_DAYS,
        'directory': str(_BACKUP_DIR),
        's3_enabled': bool(_S3_BUCKET),
        's3_bucket': _S3_BUCKET if _S3_BUCKET else None,
        's3_prefix': _S3_PREFIX if _S3_BUCKET else None,
    }


@router.post('/snapshots')
async def create_snapshot(op: dict = Depends(get_current_operator)):
    """Force a snapshot now (in addition to the daily scheduled one).
    Useful right before a risky import-replace or during a migration."""
    meta = await _run_snapshot(op.get('email'))
    return meta


@router.get('/snapshots/{snap_id}/download')
async def download_snapshot(snap_id: str, _op: dict = Depends(get_current_operator)):
    """Stream a snapshot file back to the operator. `snap_id` is the
    filename stem (no .json) — we resolve it through pathlib so a path-
    traversal attempt can never escape the backup directory."""
    # Strip anything other than the snapshot stem chars to be safe.
    safe_id = snap_id.replace('..', '').replace('/', '').strip()
    path = (_ensure_backup_dir() / f'{safe_id}.json').resolve()
    try:
        path.relative_to(_BACKUP_DIR.resolve())
    except ValueError:
        raise HTTPException(400, 'invalid snapshot id')
    if not path.is_file():
        raise HTTPException(404, 'snapshot not found')
    return FileResponse(
        path,
        media_type='application/json',
        filename=f'{safe_id}.json',
    )


@router.get('/snapshots/{snap_id}/diff')
async def diff_snapshot(snap_id: str, _op: dict = Depends(get_current_operator)):
    """Pre-flight diff between a saved snapshot and the current DB state.
    Shown in the BackupCard UI before the operator hits Merge/Replace so
    a destructive restore never surprises them.

    Returns per-collection: snapshot_count, current_count, delta (+/-)
    so the UI can render a compact "+3 deploy projects, -1 promo code"
    strip. Counts only — no row-level diff (keep it cheap)."""
    safe_id = snap_id.replace('..', '').replace('/', '').strip()
    path = (_ensure_backup_dir() / f'{safe_id}.json').resolve()
    try:
        path.relative_to(_BACKUP_DIR.resolve())
    except ValueError:
        raise HTTPException(400, 'invalid snapshot id')
    if not path.is_file():
        raise HTTPException(404, 'snapshot not found')
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f'could not read snapshot: {e}')

    # Pair snapshot list lengths against current collection counts.
    # Order mirrors `/export` so the UI can render in the same order.
    pairs = [
        ('deploy_projects',   db.deploy_projects),
        ('promo_codes',       db.promo_codes),
        ('kyc_bypass_emails', db.kyc_bypass_emails),
        ('vanished_emails',   db.vanished_emails),
        ('app_settings',      db.app_settings),
    ]
    rows = []
    for name, coll in pairs:
        snap_count = len(payload.get(name) or [])
        cur_count = await coll.count_documents({})
        rows.append({
            'collection': name,
            'snapshot_count': snap_count,
            'current_count': cur_count,
            # Merge delta: how many *new* docs the snapshot would add at
            # worst (capped at snap_count). This is approximate — primary-
            # key collisions are upserts not inserts — but it's close
            # enough to flag "this restore would write N rows".
            'merge_delta_max': snap_count,
            # Replace delta: net change if we WIPE then INSERT the snapshot.
            'replace_delta': snap_count - cur_count,
        })

    return {
        'snapshot_id': safe_id,
        'snapshot_exported_at': payload.get('exported_at'),
        'snapshot_exported_by': payload.get('exported_by'),
        'rows': rows,
    }


@router.post('/snapshots/{snap_id}/restore')
async def restore_snapshot(
    snap_id: str,
    mode: str = 'merge',
    op: dict = Depends(get_current_operator),
):
    """Restore a saved snapshot file by id. `mode` follows the same
    semantics as `/import` (merge | replace). Operator-only."""
    if mode not in ('merge', 'replace'):
        raise HTTPException(400, "mode must be 'merge' or 'replace'")
    safe_id = snap_id.replace('..', '').replace('/', '').strip()
    path = (_ensure_backup_dir() / f'{safe_id}.json').resolve()
    try:
        path.relative_to(_BACKUP_DIR.resolve())
    except ValueError:
        raise HTTPException(400, 'invalid snapshot id')
    if not path.is_file():
        raise HTTPException(404, 'snapshot not found')
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f'could not read snapshot: {e}')
    # Reuse the same import pipeline as the JSON-paste flow.
    req = ImportRequest(
        version=payload.get('version', 1),
        deploy_projects=payload.get('deploy_projects', []),
        promo_codes=payload.get('promo_codes', []),
        kyc_bypass_emails=payload.get('kyc_bypass_emails', []),
        vanished_emails=payload.get('vanished_emails', []),
        app_settings=payload.get('app_settings', []),
        mode=mode,
    )
    return await import_backup(req, op)
