"""Persistent secret-encryption key — the permanent fix for 'my saved keys
keep disappearing after a redeploy/migration'.

Background
----------
secret_crypto derives its master key from SECRETS_KEY, else MONGO_URL. In
production SECRETS_KEY was never set, so the key was tied to MONGO_URL. When
the database URL changed (e.g. the Emergent -> Render migration), the derived
key changed too and every previously-saved secret (Porkbun keys, Vercel token,
Stripe keys, ...) silently became undecryptable — the app then behaved as if
the keys were never entered.

Fix
---
On startup we PIN the encryption key to a value stored in the database itself
(a dedicated, non-encrypted config doc — same trust model as the already
plaintext render_api_key). Priority:

  1. If SECRETS_KEY is set in the environment, always honor it (operator-managed).
  2. Else if a pinned key exists in the DB, load it into the environment.
  3. Else (first run) pin the CURRENT master material (MONGO_URL) so any secrets
     that still decrypt right now keep working, then persist it.

After this runs, secret_crypto._master_key() reads the stable SECRETS_KEY, so
the encryption key no longer depends on MONGO_URL and can never be orphaned by
a URL rotation again. Secrets encrypted under the OLD (lost) key remain lost
and must be re-entered once — but only once, permanently.
"""
from __future__ import annotations

import logging
import os

from db import db
from secret_crypto import SECRET_FIELDS, is_encrypted, can_decrypt

logger = logging.getLogger('tbc.secrets_key')

# Stored on the raw (non-encrypted) side of the DB proxy — the settings wrapper
# only encrypts the `settings` collection, so this dedicated collection holds
# the key material in the clear on purpose (it IS the key; encrypting it with
# itself is meaningless).
_KEK_COLLECTION = 'app_config'
_KEK_ID = '__secret_master_key_v1__'


async def ensure_persistent_secret_key() -> str:
    """Guarantee a stable SECRETS_KEY is present in os.environ. Returns a short
    status string ('env' | 'stored' | 'created' | 'unavailable') for logging.

    MUST be called at the very start of app startup, before anything reads or
    writes encrypted settings, so all subsequent encrypt/decrypt calls use the
    stable key."""
    if (os.environ.get('SECRETS_KEY') or '').strip():
        logger.info('[secrets] using operator-provided SECRETS_KEY from env.')
        return 'env'

    col = db[_KEK_COLLECTION]  # raw motor collection (not the encrypted wrapper)

    try:
        doc = await col.find_one({'_id': _KEK_ID}) or {}
    except Exception as e:  # pragma: no cover - db degraded
        logger.error('[secrets] could not read pinned key: %s', e)
        return 'unavailable'

    stored = (doc.get('key') or '').strip()
    if stored:
        os.environ['SECRETS_KEY'] = stored
        logger.info('[secrets] loaded pinned encryption key from database.')
        return 'stored'

    # First run: pin whatever the current master material is (the live
    # MONGO_URL) so secrets that decrypt right now stay valid, then persist it
    # so future URL rotations can never orphan the secrets again.
    current = (
        os.environ.get('MONGO_URL')
        or os.environ.get('MONGODB_CONNECTION_STRING_2')
        or ''
    ).strip()
    if not current or '<' in current or '>' in current:
        logger.error(
            '[secrets] no stable MONGO_URL to pin from; leaving key source as-is. '
            'Set SECRETS_KEY to a long random string to make secrets durable.'
        )
        return 'unavailable'

    try:
        await col.update_one(
            {'_id': _KEK_ID},
            {'$set': {'key': current, 'note': 'pinned secret-encryption key; do not delete'}},
            upsert=True,
        )
        os.environ['SECRETS_KEY'] = current
        logger.info('[secrets] pinned persistent encryption key (migrated from MONGO_URL).')
        return 'created'
    except Exception as e:  # pragma: no cover - db degraded
        logger.error('[secrets] failed to persist pinned key: %s', e)
        return 'unavailable'


async def scrub_undecryptable_secrets() -> list[str]:
    """Clear secret fields that can no longer be decrypted under the current
    (now-pinned) key. Returns the list of field names that were cleared.

    Why this exists
    ---------------
    Secrets saved under an OLD key (before the key was pinned — e.g. tokens
    from before the Emergent -> Render migration) are cryptographically
    unrecoverable. Left in place they:
      • spam a red ERROR on every single settings read, and
      • make status readouts ambiguous ("is my Porkbun key actually saved?").

    Because the value is irretrievable anyway, the only correct action is to
    remove it so the field honestly reads as "not set" and the operator can
    re-enter it once. Fields that decrypt fine (including the Porkbun/Vercel
    keys just re-saved under the current key) are left untouched.

    Runs against the RAW settings collection (bypassing the encrypt/decrypt
    wrapper) so we inspect ciphertext directly and unset without re-encrypting.
    """
    cleared: list[str] = []
    try:
        raw_settings = db._db.settings  # underlying Motor collection (no wrapper)
        cursor = raw_settings.find({})
        async for doc in cursor:
            dead = {
                k for k in SECRET_FIELDS
                if is_encrypted(doc.get(k)) and not can_decrypt(doc.get(k))
            }
            if not dead:
                continue
            await raw_settings.update_one(
                {'_id': doc['_id']},
                {'$unset': {k: '' for k in dead}},
            )
            cleared.extend(sorted(dead))
    except Exception as e:  # pragma: no cover - db degraded
        logger.error('[secrets] self-heal scan failed: %s', e)
        return cleared

    if cleared:
        logger.warning(
            '[secrets] cleared %d undecryptable secret field(s) (encrypted under '
            'a lost key): %s. Re-enter these in Operator settings if you use them.',
            len(cleared), ', '.join(cleared),
        )
    else:
        logger.info('[secrets] self-heal: all stored secrets decrypt cleanly.')
    return cleared
