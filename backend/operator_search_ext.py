"""Universal operator search — one endpoint that fans out across the
collections the operator actually wants to find: users, deploy
projects, payments, and audit entries.

Why a dedicated endpoint
------------------------
The operator's command palette in the navbar (`OperatorSearch.jsx`)
fires this on every keystroke (debounced 250ms). Letting the palette
hit four separate endpoints would mean 4× round trips per keystroke +
4× auth checks; this collapses that into one cheap Mongo fan-out.

Costs
-----
- Hard cap of 8 hits per collection (so a typo on a single letter can't
  fetch thousands of users).
- Indexes are NOT created here — the collections are small enough that
  collection scan + `$regex` is fast at this scale. Revisit if the
  users collection ever crosses ~100k.
- Operator-only (`get_current_operator`).
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, Query

from auth_utils import get_current_operator
from db import db

router = APIRouter(prefix='/api/operator', tags=['operator-search'])


def _safe_regex(q: str) -> dict:
    """Anchored case-insensitive contains. Escapes regex metacharacters
    so a user typing `.+*` doesn't blow up the query."""
    return {'$regex': re.escape(q), '$options': 'i'}


@router.get('/search')
async def universal_search(
    q: str = Query('', min_length=0, max_length=120),
    op: dict = Depends(get_current_operator),
):
    """Fans out across users / deploy projects / contacts / audit and
    returns a uniform shape the frontend can render directly:

        {
          "users":    [{id, email, name, role, plan}],
          "projects": [{id, projectName, repo, domain}],
          "contacts": [{id, name, email, subject}],
          "audit":    [{id, kind, target, actor_email, created_at}]
        }

    Empty query returns the most recent rows in each bucket — useful
    when the palette is opened with no input yet.
    """
    qn = (q or '').strip()
    out: dict[str, list[dict]] = {
        'users': [], 'projects': [], 'contacts': [], 'audit': [],
    }

    # ── Users (email + name) ───────────────────────────────────────
    user_filter = (
        {'$or': [{'email': _safe_regex(qn)}, {'name': _safe_regex(qn)}]}
        if qn else {}
    )
    async for u in db.users.find(
        user_filter,
        {'id': 1, 'email': 1, 'name': 1, 'role': 1, 'plan': 1, 'status': 1},
    ).sort('created_at', -1).limit(8):
        out['users'].append({
            'id': u.get('id'),
            'email': u.get('email'),
            'name': u.get('name') or '',
            'role': u.get('role') or 'user',
            'plan': u.get('plan') or '',
            'status': u.get('status') or 'active',
        })

    # ── Deploy projects (name + repo + domain) ─────────────────────
    proj_filter = (
        {'$or': [
            {'projectName': _safe_regex(qn)},
            {'repo': _safe_regex(qn)},
            {'domain': _safe_regex(qn)},
        ]} if qn else {}
    )
    async for p in db.deploy_projects.find(
        proj_filter,
        {'id': 1, 'projectName': 1, 'repo': 1, 'domain': 1},
    ).sort('updated_at', -1).limit(8):
        out['projects'].append({
            'id': p.get('id'),
            'projectName': p.get('projectName') or '',
            'repo': p.get('repo') or '',
            'domain': p.get('domain') or '',
        })

    # ── Contact form submissions ───────────────────────────────────
    if qn:
        contact_filter = {'$or': [
            {'email': _safe_regex(qn)},
            {'name': _safe_regex(qn)},
            {'subject': _safe_regex(qn)},
        ]}
        async for c in db.contacts.find(
            contact_filter,
            {'id': 1, 'name': 1, 'email': 1, 'subject': 1, 'created_at': 1},
        ).sort('created_at', -1).limit(6):
            out['contacts'].append({
                'id': c.get('id'),
                'name': c.get('name') or '',
                'email': c.get('email') or '',
                'subject': (c.get('subject') or '')[:120],
            })

    # ── Audit log (only when there's an actual query — too noisy otherwise) ─
    if qn:
        audit_filter = {'$or': [
            {'target': _safe_regex(qn)},
            {'actor_email': _safe_regex(qn)},
            {'kind': _safe_regex(qn)},
        ]}
        async for a in db.audit_log.find(
            audit_filter,
            {'_id': 0, 'kind': 1, 'target': 1, 'actor_email': 1, 'created_at': 1},
        ).sort('created_at', -1).limit(6):
            out['audit'].append({
                'kind': a.get('kind') or '',
                'target': a.get('target') or '',
                'actor_email': a.get('actor_email') or '',
                'created_at': a.get('created_at').isoformat() if a.get('created_at') else None,
            })

    return {
        'query': qn,
        **out,
        'total': sum(len(v) for v in out.values()),
    }
