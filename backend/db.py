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
db = _client[os.environ.get('DB_NAME', 'tbctools')]
# Re-export the client for callers that need to close the connection on shutdown.
client = _client
