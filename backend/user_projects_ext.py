"""User Projects archive + operator oversight.

A user's "project" in this app is a chat session (`chat_sessions`) plus its
messages (`chat_messages`). Two things this module adds:

1. Archive-on-delete
   When a user deletes a project from their own account, we first snapshot the
   whole thing (session metadata + every message + the owner's email) into the
   `archived_projects` collection. That snapshot is deliberately kept even
   after the user's live session is gone, so the operator never loses a
   project just because a user cleaned up their sidebar.

   `archive_session()` is imported and called by server.py's delete flow.

2. Operator "User Projects" tab
   Operator-only endpoints that present a single, unified list of every
   project across all users - both LIVE sessions and ARCHIVED (deleted)
   snapshots - grouped by user email, with:
     - hidden preview (operator reads the messages; the user is never notified
       and nothing about the session changes), and
     - safety-gated permanent delete.

All operator endpoints require `get_current_operator`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth_utils import get_current_operator
from db import db

router = APIRouter(prefix='/api/operator', tags=['user-projects'])


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _now():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Archive helper (called from server.py on user-initiated delete / purge)
# ---------------------------------------------------------------------------
async def archive_session(session_id: str, reason: str = 'user_deleted') -> bool:
    """Snapshot a live session + its messages into `archived_projects`.

    Idempotent per session: re-archiving the same session_id replaces the
    previous snapshot (so the archive always holds the latest state). Returns
    True if a snapshot was written, False if the session no longer exists.

    Never raises to the caller - archival must not block the user's delete.
    """
    try:
        sess = await db.chat_sessions.find_one({'id': session_id})
        if not sess:
            return False

        user_id = sess.get('user_id')
        owner = None
        if user_id:
            owner = await db.users.find_one({'id': user_id}, {'email': 1, 'name': 1})

        msgs = await (
            db.chat_messages.find({'session_id': session_id})
            .sort('created_at', 1)
            .limit(2000)
            .to_list(2000)
        )
        clean_msgs = [
            {
                'role': m.get('role'),
                'content': m.get('content', ''),
                'created_at': _iso(m.get('created_at')),
            }
            for m in msgs
        ]

        doc = {
            'session_id': session_id,
            'user_id': user_id,
            'user_email': (owner or {}).get('email') or 'unknown',
            'user_name': (owner or {}).get('name'),
            'title': sess.get('title') or 'Untitled project',
            'model': sess.get('model'),
            'variant': sess.get('variant'),
            'message_count': len(clean_msgs),
            'messages': clean_msgs,
            'original_created_at': _iso(sess.get('created_at')),
            'original_updated_at': _iso(sess.get('updated_at')),
            'archived_at': _now(),
            'archived_reason': reason,
        }
        await db.archived_projects.update_one(
            {'session_id': session_id},
            {'$set': doc},
            upsert=True,
        )
        return True
    except Exception:
        # Best-effort: archival failure must never break the user's delete.
        return False


# ---------------------------------------------------------------------------
# Operator endpoints
# ---------------------------------------------------------------------------
@router.get('/user-projects')
async def list_user_projects(
    _: dict = Depends(get_current_operator),
    q: Optional[str] = Query(None, description='Filter by email or title'),
):
    """Unified list of every project across all users.

    Combines LIVE sessions (`chat_sessions`) with ARCHIVED snapshots
    (`archived_projects`). A project that was never deleted appears as
    `live`; once a user deletes it, it appears as `archived`. Either way the
    operator can always see it. Results are grouped by user email.
    """
    # --- Live sessions (join user email) ---
    live_sessions = await (
        db.chat_sessions.find(
            {},
            {'id': 1, 'user_id': 1, 'title': 1, 'model': 1, 'variant': 1,
             'created_at': 1, 'updated_at': 1},
        )
        .sort('updated_at', -1)
        .limit(1000)
        .to_list(1000)
    )

    # Batch-resolve emails to avoid N queries.
    user_ids = list({s.get('user_id') for s in live_sessions if s.get('user_id')})
    email_by_id = {}
    if user_ids:
        async for u in db.users.find({'id': {'$in': user_ids}}, {'id': 1, 'email': 1, 'name': 1}):
            email_by_id[u['id']] = {'email': u.get('email'), 'name': u.get('name')}

    items = []
    for s in live_sessions:
        owner = email_by_id.get(s.get('user_id'), {})
        items.append({
            'kind': 'live',
            'id': s['id'],
            'session_id': s['id'],
            'user_id': s.get('user_id'),
            'user_email': owner.get('email') or 'unknown',
            'user_name': owner.get('name'),
            'title': s.get('title') or 'Untitled project',
            'model': s.get('model'),
            'variant': s.get('variant'),
            'updated_at': _iso(s.get('updated_at')),
            'created_at': _iso(s.get('created_at')),
        })

    # --- Archived snapshots ---
    archived = await (
        db.archived_projects.find(
            {},
            {'messages': 0},  # don't ship full transcripts in the list
        )
        .sort('archived_at', -1)
        .limit(1000)
        .to_list(1000)
    )
    for a in archived:
        a.pop('_id', None)
        items.append({
            'kind': 'archived',
            'id': a.get('session_id'),
            'session_id': a.get('session_id'),
            'user_id': a.get('user_id'),
            'user_email': a.get('user_email') or 'unknown',
            'user_name': a.get('user_name'),
            'title': a.get('title') or 'Untitled project',
            'model': a.get('model'),
            'variant': a.get('variant'),
            'message_count': a.get('message_count', 0),
            'updated_at': _iso(a.get('original_updated_at')),
            'created_at': _iso(a.get('original_created_at')),
            'archived_at': _iso(a.get('archived_at')),
            'archived_reason': a.get('archived_reason'),
        })

    # --- Optional text filter ---
    if q:
        needle = q.strip().lower()
        items = [
            it for it in items
            if needle in (it.get('user_email') or '').lower()
            or needle in (it.get('title') or '').lower()
        ]

    # --- Group by user email ---
    groups: dict = {}
    for it in items:
        key = it.get('user_email') or 'unknown'
        g = groups.setdefault(key, {
            'user_email': key,
            'user_name': it.get('user_name'),
            'projects': [],
        })
        g['projects'].append(it)

    grouped = sorted(groups.values(), key=lambda g: g['user_email'])
    return {
        'total': len(items),
        'live': sum(1 for it in items if it['kind'] == 'live'),
        'archived': sum(1 for it in items if it['kind'] == 'archived'),
        'groups': grouped,
    }


@router.get('/user-projects/{kind}/{item_id}/messages')
async def preview_user_project(
    kind: str,
    item_id: str,
    _: dict = Depends(get_current_operator),
):
    """Silent, read-only preview of a project's transcript.

    Reading here does not touch the session, does not update timestamps, and
    does not notify the user in any way - it's a pure operator read.
    """
    if kind == 'live':
        sess = await db.chat_sessions.find_one({'id': item_id})
        if not sess:
            raise HTTPException(404, 'Project not found')
        owner = await db.users.find_one({'id': sess.get('user_id')}, {'email': 1, 'name': 1})
        msgs = await (
            db.chat_messages.find({'session_id': item_id})
            .sort('created_at', 1)
            .limit(2000)
            .to_list(2000)
        )
        return {
            'kind': 'live',
            'title': sess.get('title'),
            'user_email': (owner or {}).get('email') or 'unknown',
            'model': sess.get('model'),
            'variant': sess.get('variant'),
            'messages': [
                {'role': m.get('role'), 'content': m.get('content', ''),
                 'created_at': _iso(m.get('created_at'))}
                for m in msgs
            ],
        }

    if kind == 'archived':
        a = await db.archived_projects.find_one({'session_id': item_id})
        if not a:
            raise HTTPException(404, 'Archived project not found')
        a.pop('_id', None)
        return {
            'kind': 'archived',
            'title': a.get('title'),
            'user_email': a.get('user_email') or 'unknown',
            'model': a.get('model'),
            'variant': a.get('variant'),
            'archived_at': _iso(a.get('archived_at')),
            'archived_reason': a.get('archived_reason'),
            'messages': a.get('messages', []),
        }

    raise HTTPException(400, "kind must be 'live' or 'archived'")


@router.delete('/user-projects/{kind}/{item_id}')
async def operator_delete_user_project(
    kind: str,
    item_id: str,
    _: dict = Depends(get_current_operator),
):
    """Permanently delete a project as the operator.

    - `live`   -> removes the session + its messages (and any archive snapshot).
    - `archived` -> removes the archived snapshot.

    This is a hard delete, which is why the UI gates it behind a Yes/No
    confirmation dialog.
    """
    if kind == 'live':
        res = await db.chat_sessions.delete_one({'id': item_id})
        await db.chat_messages.delete_many({'session_id': item_id})
        await db.archived_projects.delete_one({'session_id': item_id})
        if res.deleted_count == 0:
            raise HTTPException(404, 'Project not found')
        return {'success': True, 'deleted': 'live'}

    if kind == 'archived':
        res = await db.archived_projects.delete_one({'session_id': item_id})
        if res.deleted_count == 0:
            raise HTTPException(404, 'Archived project not found')
        return {'success': True, 'deleted': 'archived'}

    raise HTTPException(400, "kind must be 'live' or 'archived'")
