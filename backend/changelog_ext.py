"""In-app changelog — "What's new" popover next to the user avatar.

Source of truth lives in `db.changelog`. Entries are inserted automatically
on every successful production promote (alongside the existing GitHub
CHANGELOG.md write — see deploy_projects_ext.py post-promote hook) and can
also be added manually by the operator.

Per-user unread state is tracked via `users.last_changelog_read_at`. The
popover shows a blue dot until the user opens it; opening calls
`POST /api/changelog/mark-read` which stamps the timestamp.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_user, get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/changelog', tags=['changelog'])

_MAX_ENTRIES_PER_FETCH = 30


# ─── Helpers ──────────────────────────────────────────────────────────────
def _iso(dt) -> Optional[str]:
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    try:
        return dt.isoformat()
    except Exception:
        return None


async def _insert_entry(*, title: str, body_md: str = '', tag: Optional[str] = None,
                       project: Optional[str] = None, source: str = 'manual',
                       author_email: Optional[str] = None) -> dict:
    """Shared writer — used by the manual endpoint AND by the post-promote
    hook. Returns the inserted doc (without _id)."""
    doc = {
        'id': str(uuid.uuid4()),
        'title': (title or 'Update').strip()[:200],
        'body_md': (body_md or '').strip()[:8_000],
        'tag': tag,
        'project': project,
        'source': source,
        'author_email': author_email,
        'created_at': datetime.now(timezone.utc),
    }
    await db.changelog.insert_one(doc.copy())
    return doc


# ─── Schemas ──────────────────────────────────────────────────────────────
class CreateEntryRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    body_md: str = Field('', max_length=8_000)
    tag: Optional[str] = Field(None, max_length=64)
    project: Optional[str] = Field(None, max_length=120)


# ─── Endpoints ────────────────────────────────────────────────────────────
@router.get('/public')
async def list_entries_public(limit: int = 20):
    """Anonymous read of the changelog — powers the public `/changelog`
    marketing page. No unread tracking, no PII, no auth. Same data shape
    as the authenticated endpoint minus `unread_count` / `last_read`."""
    limit = max(1, min(limit, _MAX_ENTRIES_PER_FETCH))
    cursor = db.changelog.find({}, {
        'id': 1, 'title': 1, 'body_md': 1, 'tag': 1, 'project': 1, 'source': 1, 'created_at': 1,
    }).sort('created_at', -1).limit(limit)
    entries = []
    async for d in cursor:
        d.pop('_id', None)
        d['created_at'] = _iso(d.get('created_at'))
        entries.append(d)
    return {'entries': entries, 'count': len(entries)}


@router.get('')
async def list_entries(user: dict = Depends(get_current_user), limit: int = 10):
    """Return recent entries + `unread_count` for the calling user.

    `unread_count` is computed against `last_changelog_read_at` on the user
    doc; brand-new accounts see all entries as unread (matches Slack /
    Linear behaviour). Anonymous callers are blocked by the dep — the
    popover only shows once logged in.
    """
    limit = max(1, min(limit, _MAX_ENTRIES_PER_FETCH))
    cursor = db.changelog.find({}).sort('created_at', -1).limit(limit)
    entries = []
    async for d in cursor:
        d.pop('_id', None)
        d['created_at'] = _iso(d.get('created_at'))
        entries.append(d)

    # `get_current_user` returns the JWT payload only — fetch the
    # `last_changelog_read_at` marker straight from the users collection
    # so the unread count is always live.
    user_doc = await db.users.find_one(
        {'id': user.get('sub') or user.get('id')},
        {'last_changelog_read_at': 1},
    ) or {}
    last_read = user_doc.get('last_changelog_read_at')
    if entries:
        # Count entries newer than the user's last read marker.
        if not last_read:
            unread = len(entries)
        else:
            try:
                threshold = last_read if isinstance(last_read, datetime) else datetime.fromisoformat(str(last_read).replace('Z', '+00:00'))
            except Exception:
                threshold = None
            unread = 0
            if threshold:
                for d in entries:
                    try:
                        ts = datetime.fromisoformat(str(d['created_at']).replace('Z', '+00:00'))
                    except Exception:
                        continue
                    if ts > threshold:
                        unread += 1
    else:
        unread = 0
    return {'entries': entries, 'unread_count': unread, 'last_read': _iso(last_read)}


@router.post('/mark-read')
async def mark_read(user: dict = Depends(get_current_user)):
    """Stamp `last_changelog_read_at = now()` on the user. Called once
    when the popover opens — never auto-fires, so an accidental hover
    doesn't clear the unread badge."""
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {'id': user.get('sub') or user.get('id')},
        {'$set': {'last_changelog_read_at': now}},
    )
    return {'marked_at': _iso(now)}


@router.post('')
async def create_entry(req: CreateEntryRequest, op: dict = Depends(get_current_operator)):
    """Operator-only: add a manual changelog entry (announcements, holiday
    schedule, new feature highlights, etc.)."""
    doc = await _insert_entry(
        title=req.title, body_md=req.body_md, tag=req.tag, project=req.project,
        source='manual', author_email=op.get('email'),
    )
    doc['created_at'] = _iso(doc['created_at'])
    return doc


@router.delete('/{entry_id}')
async def delete_entry(entry_id: str, op: dict = Depends(get_current_operator)):
    """Operator-only: remove an entry (typo, accidental promote, etc.)."""
    res = await db.changelog.delete_one({'id': entry_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Entry not found')
    return {'deleted': True}
