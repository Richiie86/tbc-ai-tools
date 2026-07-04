"""Shared MongoDB client — single source of truth.

Both `server.py` and the extension modules (`payments_ext.py`, `referrals_ext.py`)
import the same `db` handle from here. This eliminates the previous circular
`from server import db` lazy import pattern.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv(Path(__file__).parent / '.env')


def _resolve_mongo_url() -> str:
    """Pick a usable MongoDB connection string.

    Prefer MONGO_URL, but fall back to MONGODB_CONNECTION_STRING_2 when
    MONGO_URL is unset or still contains the Atlas '<db_password>' placeholder
    (a common copy/paste mistake). This keeps the app connecting even if one
    of the two env vars holds the raw template instead of a real password.
    """
    candidates = [
        os.environ.get('MONGO_URL'),
        os.environ.get('MONGODB_CONNECTION_STRING_2'),
    ]
    for url in candidates:
        if url and '<' not in url and '>' not in url:
            return url
    # Nothing valid found — surface a clear error instead of a cryptic auth fail.
    raise RuntimeError(
        'No valid MongoDB connection string found. Set MONGO_URL (or '
        'MONGODB_CONNECTION_STRING_2) to a real connection string with the '
        '<db_password> placeholder replaced by your actual password.'
    )


_client = AsyncIOMotorClient(_resolve_mongo_url())
_raw_db = _client[os.environ.get('DB_NAME', 'tbctools')]
# Re-export the client for callers that need to close the connection on shutdown.
client = _client


# ---------------------------------------------------------------------------
# Transparent encryption-at-rest for the `settings` collection.
#
# Secret-bearing fields (github_token, vercel_token, stripe_secret_key, ...)
# are encrypted before they are written to MongoDB and decrypted on read, so
# a leaked data dump never exposes raw credentials. This is done at the DB
# layer on purpose: every existing `db.settings.find_one/update_one/...` call
# site is protected without change, so no payment or deploy read path can be
# accidentally missed. See secret_crypto.py for the scheme.
# ---------------------------------------------------------------------------
from secret_crypto import encrypt_doc_for_write, decrypt_doc_from_read  # noqa: E402


class _SecureSettingsCollection:
    """Wraps the Motor `settings` collection, encrypting secret fields on
    write and decrypting them on read. Only find_one/update_one/insert_one
    are intercepted (the only mutating/reading ops used on settings);
    everything else (count_documents, etc.) is delegated untouched."""

    def __init__(self, col):
        self._col = col

    async def find_one(self, *args, **kwargs):
        doc = await self._col.find_one(*args, **kwargs)
        return decrypt_doc_from_read(doc)

    async def update_one(self, filter, update, *args, **kwargs):
        return await self._col.update_one(
            filter, encrypt_doc_for_write(update), *args, **kwargs
        )

    async def insert_one(self, document, *args, **kwargs):
        return await self._col.insert_one(
            encrypt_doc_for_write(document), *args, **kwargs
        )

    def __getattr__(self, name):
        # Delegate any other attribute/method (count_documents, aggregate,
        # index helpers, etc.) to the underlying Motor collection.
        return getattr(self._col, name)


class _DBProxy:
    """Thin proxy over the Motor database that returns the secure wrapper for
    the `settings` collection and delegates everything else unchanged."""

    def __init__(self, real_db):
        self._db = real_db
        self._settings = _SecureSettingsCollection(real_db.settings)

    def __getattr__(self, name):
        if name == 'settings':
            return self._settings
        return getattr(self._db, name)

    def __getitem__(self, name):
        if name == 'settings':
            return self._settings
        return self._db[name]


db = _DBProxy(_raw_db)
