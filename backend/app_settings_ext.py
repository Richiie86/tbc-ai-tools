"""App-wide settings — banner overlay + login lockdown.

Two operator-controlled toggles that affect the entire app:

1. **Personal-use banner overlay** — when enabled, a translucent red
   banner covers the landing page (`pointer-events:none` so it doesn't
   block clicks). Operator can edit the text live.

2. **Login lockdown** — when enabled, only the operator may log in.
   Every other login (or registration) attempt returns 503 with a
   friendly message. Useful for taking the app private for maintenance
   or for personal-use-only deployments.

Both flags live on a single MongoDB doc `app_settings/_id=main` so the
operator's PUT round-trip is atomic.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

# Two routers — `public_router` is open (landing page reads the banner
# anonymously); `op_router` is operator-only.
public_router = APIRouter(prefix='/api/app', tags=['app-settings'])
op_router = APIRouter(prefix='/api/operator/app-settings', tags=['app-settings-operator'])

_DOC_ID = 'main'
DEFAULT_BANNER_TEXT = 'OBS! This application is only for personal use!'


# ---------- read model ----------

async def get_app_settings() -> dict:
    """Return the singleton app-settings doc, applying defaults so the
    caller never has to deal with missing fields. Used by auth code below
    and by the public banner endpoint."""
    doc = await db.app_settings.find_one({'_id': _DOC_ID}) or {}
    return {
        'banner_enabled': bool(doc.get('banner_enabled', False)),
        'banner_text': (doc.get('banner_text') or DEFAULT_BANNER_TEXT)[:2_000],
        'login_lockdown_enabled': bool(doc.get('login_lockdown_enabled', False)),
    }


async def is_login_locked_down() -> bool:
    """Cheap helper for the auth router. Cached? Not yet — the doc is
    one read, atomic, and the auth path is already async."""
    s = await get_app_settings()
    return s['login_lockdown_enabled']


# ---------- public ----------

@public_router.get('/announcement')
async def public_announcement():
    """Anonymous read — landing page polls this to render the banner.
    Returns ONLY the banner-related fields; lockdown state is operator-
    only because revealing it tips off attackers that auth is closed."""
    s = await get_app_settings()
    return {
        'banner_enabled': s['banner_enabled'],
        'banner_text': s['banner_text'],
    }


# ---------- operator ----------

class AppSettingsPatch(BaseModel):
    banner_enabled: Optional[bool] = None
    banner_text: Optional[str] = Field(default=None, max_length=2_000)
    login_lockdown_enabled: Optional[bool] = None


@op_router.get('')
async def op_get_settings(_op: dict = Depends(get_current_operator)):
    """Operator-only read — includes the lockdown flag the public
    endpoint hides."""
    return await get_app_settings()


@op_router.patch('')
async def op_patch_settings(
    payload: AppSettingsPatch,
    _op: dict = Depends(get_current_operator),
):
    """Atomic upsert. Empty body is a no-op so the operator can save the
    form without changing anything."""
    update: dict = {}
    if payload.banner_enabled is not None:
        update['banner_enabled'] = bool(payload.banner_enabled)
    if payload.banner_text is not None:
        # Trim, but never empty — fall back to the default so the
        # operator can't accidentally publish a blank red overlay.
        txt = payload.banner_text.strip()[:2_000]
        update['banner_text'] = txt or DEFAULT_BANNER_TEXT
    if payload.login_lockdown_enabled is not None:
        update['login_lockdown_enabled'] = bool(payload.login_lockdown_enabled)

    if not update:
        return await get_app_settings()

    await db.app_settings.update_one(
        {'_id': _DOC_ID}, {'$set': update}, upsert=True,
    )
    return await get_app_settings()
