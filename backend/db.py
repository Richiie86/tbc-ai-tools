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

_client = AsyncIOMotorClient(os.environ['MONGO_URL'])
db = _client[os.environ['DB_NAME']]
# Re-export the client for callers that need to close the connection on shutdown.
client = _client
