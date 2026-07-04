"""Encryption-at-rest for secret-bearing settings fields.

Goal: a dump of the MongoDB `settings` collection (backup file, screenshot,
insider, accidental log) must NOT reveal raw API tokens/keys. Tokens are
encrypted before they hit the database and decrypted transparently on read
by the thin proxy in `db.py`, so no call site needs to change.

Design choices (deliberate, for a live money-handling app):

  • Stdlib only. We implement authenticated encryption with HMAC-SHA256
    (encrypt-then-MAC, CTR-style keystream) instead of pulling in the native
    `cryptography` package — that keeps the Render build simple and avoids a
    new wheel/Rust build step that could break deploys.

  • Backward compatible + lazy migration. `decrypt_secret` returns any value
    that is NOT in our `enc::v1::` envelope unchanged, so existing PLAINTEXT
    tokens keep working. They get encrypted automatically the next time the
    operator saves settings. Zero downtime, no migration script required.

  • Stable key, never the ephemeral JWT secret. The master key comes from
    `SECRETS_KEY` if set (recommended). If not, we derive a stable key from
    another long-lived secret that already exists in the environment
    (`MONGO_URL`) so the feature is safe to switch on immediately. A leaked
    *data* dump alone still can't be decrypted without that environment
    secret.

  • Fail-safe. If a value can't be authenticated/decrypted (e.g. the key
    changed), we log loudly and return the stored value rather than crashing
    the request — the affected feature degrades to "token not set" instead of
    taking the whole backend down.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets as _secrets

logger = logging.getLogger('tbc.secret_crypto')

# Envelope marker. Anything not starting with this is treated as legacy
# plaintext and returned as-is by decrypt_secret().
_PREFIX = 'enc::v1::'

# Canonical set of secret-bearing field names in the settings document.
# ANY of these encountered on write are encrypted; on read they are decrypted.
SECRET_FIELDS = frozenset({
    'vercel_token',
    'github_token',
    'github_webhook_secret',
    'stripe_secret_key',
    'stripe_webhook_secret',
    'nowpayments_api_key',
    'nowpayments_ipn_secret',
    'paypal_client_secret',
    'resend_api_key',
    'ai_api_key',
    'porkbun_api_key',
    'porkbun_secret_key',
})


def _master_key() -> bytes:
    """Return the raw master key material (stable across restarts).

    Priority:
      1. SECRETS_KEY                  — dedicated, operator-provided (recommended).
      2. MONGO_URL                    — stable in production.
      3. MONGODB_CONNECTION_STRING_2  — the SAME fallback db.py uses to actually
                                        connect. This MUST be included: if the
                                        app connects via this var while MONGO_URL
                                        is unset, omitting it here would drop the
                                        key derivation to the ephemeral per-process
                                        key below — which changes on every restart
                                        and silently corrupts every saved secret
                                        (tokens read back as garbage after a
                                        redeploy). Mirroring db.py keeps the key
                                        stable no matter which Mongo var is set.
    Either way the key never lives in the settings collection it protects, so
    a data dump alone cannot decrypt the tokens.
    """
    raw = (
        os.environ.get('SECRETS_KEY')
        or os.environ.get('MONGO_URL')
        or os.environ.get('MONGODB_CONNECTION_STRING_2')
        or ''
    )
    # Guard against a template/placeholder connection string (e.g. one still
    # containing '<db_password>') producing an unstable-looking key.
    if raw and ('<' in raw or '>' in raw):
        raw = os.environ.get('MONGODB_CONNECTION_STRING_2') or raw
    if not raw:
        # Last-resort: a process-local key. Encryption still works for the
        # lifetime of the process; a restart makes older ciphertext
        # unreadable (handled gracefully by decrypt_secret). We log so the
        # operator knows to set SECRETS_KEY.
        logger.error(
            'No SECRETS_KEY or MONGO_URL available for secret encryption — '
            'using an ephemeral process key. Set SECRETS_KEY to a long random '
            'string so encrypted tokens survive restarts.'
        )
        raw = _secrets.token_urlsafe(48)
    return raw.encode('utf-8')


def _subkeys() -> tuple[bytes, bytes]:
    """Derive independent encryption and MAC keys from the master key.

    Uses HMAC-SHA256 as a simple, well-understood KDF with fixed context
    strings so the two subkeys are cryptographically independent.
    """
    mk = _master_key()
    enc_key = hmac.new(mk, b'tbc-secret-enc-v1', hashlib.sha256).digest()
    mac_key = hmac.new(mk, b'tbc-secret-mac-v1', hashlib.sha256).digest()
    return enc_key, mac_key


def _keystream(enc_key: bytes, nonce: bytes, length: int) -> bytes:
    """CTR-style keystream: HMAC(enc_key, nonce || counter) blocks."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(
            enc_key,
            nonce + counter.to_bytes(8, 'big'),
            hashlib.sha256,
        ).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(_PREFIX)


def encrypt_secret(plain) -> str:
    """Encrypt a plaintext secret into the `enc::v1::` envelope.

    Idempotent: already-encrypted values are returned unchanged. Non-string
    or empty values are returned as-is (nothing to protect).
    """
    if plain is None or plain == '':
        return plain
    if not isinstance(plain, str):
        return plain
    if is_encrypted(plain):
        return plain

    enc_key, mac_key = _subkeys()
    nonce = os.urandom(16)
    data = plain.encode('utf-8')
    ct = bytes(b ^ k for b, k in zip(data, _keystream(enc_key, nonce, len(data))))
    tag = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
    blob = base64.urlsafe_b64encode(nonce + tag + ct).decode('ascii')
    return _PREFIX + blob


def decrypt_secret(value):
    """Decrypt an `enc::v1::` value; pass through anything else unchanged.

    Legacy plaintext (no prefix) is returned as-is so existing tokens keep
    working. On tampering/verification failure we log and return the stored
    value rather than raising, so a key mismatch degrades gracefully instead
    of taking down the request path.
    """
    if not is_encrypted(value):
        return value
    try:
        raw = base64.urlsafe_b64decode(value[len(_PREFIX):].encode('ascii'))
        nonce, tag, ct = raw[:16], raw[16:48], raw[48:]
        enc_key, mac_key = _subkeys()
        expected = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected):
            # Key mismatch (e.g. an old value encrypted under a now-changed
            # key). Degrade to "not set" — as documented — instead of handing
            # back undecryptable ciphertext. Returning the ciphertext would
            # make status readouts show the token as "set" and feed garbage to
            # provider APIs, which is exactly the "app says it's there but it's
            # not" failure. Returning None lets the operator simply re-save.
            logger.error(
                'Secret authentication failed (key mismatch or tampering); '
                'treating as not set. Re-save this secret in Operator settings.'
            )
            return None
        pt = bytes(b ^ k for b, k in zip(ct, _keystream(enc_key, nonce, len(ct))))
        return pt.decode('utf-8')
    except Exception:
        logger.exception('Secret decryption failed; treating as not set.')
        return None


def _walk_encrypt(update_fields: dict) -> dict:
    """Return a shallow copy of a flat field map with secret fields encrypted."""
    out = dict(update_fields)
    for k, v in update_fields.items():
        if k in SECRET_FIELDS:
            out[k] = encrypt_secret(v)
    return out


def encrypt_doc_for_write(doc: dict) -> dict:
    """Encrypt secret fields in a document going into the DB.

    Handles both a raw document (insert) and a Mongo update spec that uses
    `$set` / `$setOnInsert`. Only known secret field names are touched; all
    other data is left byte-for-byte identical.
    """
    if not isinstance(doc, dict):
        return doc
    # Update spec with operators (e.g. {'$set': {...}}).
    if any(isinstance(k, str) and k.startswith('$') for k in doc):
        out = dict(doc)
        for op in ('$set', '$setOnInsert'):
            if isinstance(out.get(op), dict):
                out[op] = _walk_encrypt(out[op])
        return out
    # Plain document (insert_one / replace).
    return _walk_encrypt(doc)


def decrypt_doc_from_read(doc):
    """Decrypt secret fields in a document coming out of the DB."""
    if not isinstance(doc, dict):
        return doc
    for k in list(doc.keys()):
        if k in SECRET_FIELDS:
            doc[k] = decrypt_secret(doc[k])
    return doc
