"""Operator self-edit sandbox.

Lets the operator browse and edit files in the configured "self" repo
(stored in `settings.self_repo`) right from inside the operator UI, then
commit + push via GitHub's Contents API. Combined with the per-project
webhook + `auto_promote`, a one-click "Save" inside the sandbox lands
on production within ~30 s — no IDE needed.

Endpoints
─────────
GET  /api/operator/self/tree?path=...      → list dir entries
GET  /api/operator/self/file?path=...      → read file content (UTF-8)
PUT  /api/operator/self/file               → write + commit a file
GET  /api/operator/self/info               → repo + branch + last_commit hint
"""
import base64
import logging
import os
from typing import List, Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from auth_utils import get_current_operator
from db import db


logger = logging.getLogger('tbc.self_edit')
router = APIRouter(prefix='/api/operator/self', tags=['self-edit'])

GH_API = 'https://api.github.com'

# A safety allowlist — operators can only browse / write inside these
# top-level paths to avoid bricking the deploy by editing .github/
# workflows, README, package manifests, etc by accident.
DEFAULT_EDITABLE_PREFIXES = (
    'frontend/src/', 'frontend/public/',
    'backend/',
    # Many simple sites live at root — index.html, README, etc.
    '', 'src/', 'public/', 'app/',
)

# A HARD denylist — even when the operator has whitelisted a prefix that
# would otherwise contain these files, the sandbox refuses to read or
# write them. This is the safety net that stops a compromised operator
# session (or an LLM with sandbox access) from leaking the production
# Vercel/GitHub/Stripe tokens that live in `.env`. Patterns match against
# the *final* path component as well as the full slug.
import re  # noqa: E402 — kept near the constant it powers
_FORBIDDEN_PATH_PATTERNS = (
    # .env, .env.local, .env.production, ...
    re.compile(r'(^|/)\.env(\.[^/]+)?$', re.IGNORECASE),
    # SSH / TLS private keys
    re.compile(r'(^|/)id_rsa(\..+)?$', re.IGNORECASE),
    re.compile(r'(^|/)[^/]+\.pem$', re.IGNORECASE),
    re.compile(r'(^|/)[^/]+\.key$', re.IGNORECASE),
    re.compile(r'(^|/)[^/]+\.p12$', re.IGNORECASE),
    # Common secret bundles
    re.compile(r'(^|/)secrets?(\.[^/]+)?$', re.IGNORECASE),
    re.compile(r'(^|/)credentials?(\.[^/]+)?$', re.IGNORECASE),
    # Cloud-provider config that often holds long-lived creds
    re.compile(r'(^|/)\.aws/'),
    re.compile(r'(^|/)\.netrc$'),
    re.compile(r'(^|/)\.npmrc$'),
)


async def _get_settings() -> dict:
    return await db.settings.find_one({'_id': 'payment_settings'}) or {}


async def _require_self_repo() -> dict:
    s = await _get_settings()
    repo = (s.get('self_repo') or '').strip()
    if not repo:
        proj = await db.deploy_projects.find_one({}, sort=[('created_at', 1)])
        repo = (proj or {}).get('repo') or ''
    token = (s.get('github_token') or '').strip()
    if not repo or not token:
        raise HTTPException(503, 'Self-edit needs github_token + self_repo (or one deploy project).')
    branch = (s.get('self_git_ref') or 'main').strip() or 'main'
    # Operator can override the safety allowlist via settings; we still
    # always block path traversal regardless of this list.
    prefixes = s.get('self_edit_prefixes') or list(DEFAULT_EDITABLE_PREFIXES)
    return {'repo': repo, 'token': token, 'branch': branch, 'prefixes': tuple(prefixes)}


def _check_path(path: str, prefixes: tuple) -> None:
    """Reject path traversal + force the path inside an editable prefix.
    Also enforces the global secrets denylist so .env / *.pem / etc.
    are unreadable and unwritable through the sandbox no matter what
    prefix the operator allowed."""
    p = (path or '').lstrip('/')
    if '..' in p.split('/'):
        raise HTTPException(400, 'Path traversal not allowed')
    # SECRET-FILE GUARD — applies even to empty `p` to be safe.
    for pat in _FORBIDDEN_PATH_PATTERNS:
        if pat.search('/' + p):
            raise HTTPException(
                403,
                'Refusing to access secrets path. .env / *.pem / *.key and similar '
                'files are blocked by the sandbox — even the operator must use '
                '/api/operator/secrets/reveal to read these values.',
            )
    if not p:
        return  # listing the root is always fine
    # "" prefix means "all roots accepted" — useful for tiny repos.
    if '' in prefixes:
        return
    if not any(p == pref.rstrip('/') or p.startswith(pref) for pref in prefixes if pref):
        raise HTTPException(
            400,
            f'Path must start with one of {[p for p in prefixes if p]}',
        )


def _gh_headers(token: str) -> dict:
    return {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }


@router.get('/info')
async def self_info(_op: dict = Depends(get_current_operator)):
    """Surface enough metadata for the sandbox UI to render its header."""
    cfg = await _require_self_repo()
    return {
        'repo': cfg['repo'],
        'branch': cfg['branch'],
        'editable_paths': list(cfg['prefixes']),
    }


@router.get('/tree')
async def self_tree(
    path: str = Query(''),
    _op: dict = Depends(get_current_operator),
):
    """List directory entries via the Contents API."""
    cfg = await _require_self_repo()
    p = path.lstrip('/')
    if p:
        _check_path(p, cfg['prefixes'])
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            f"{GH_API}/repos/{cfg['repo']}/contents/{p}",
            params={'ref': cfg['branch']},
            headers=_gh_headers(cfg['token']),
        )
    if r.status_code == 404:
        return {'entries': [], 'path': p}
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"GitHub tree: {r.text[:200]}")
    raw = r.json()
    # Contents API returns either a list (dir) or a dict (file).
    items = raw if isinstance(raw, list) else [raw]
    entries = [
        {
            'name': it['name'],
            'path': it['path'],
            'type': it['type'],     # "file" | "dir" | "symlink"
            'size': it.get('size'),
            'sha': it.get('sha'),
        }
        for it in items
    ]
    # Dirs first, then files; alphabetical inside each group.
    entries.sort(key=lambda e: (e['type'] != 'dir', e['name'].lower()))
    return {'entries': entries, 'path': p}


@router.get('/file')
async def self_read_file(
    path: str = Query(...),
    _op: dict = Depends(get_current_operator),
):
    cfg = await _require_self_repo()
    _check_path(path, cfg['prefixes'])
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            f"{GH_API}/repos/{cfg['repo']}/contents/{path.lstrip('/')}",
            params={'ref': cfg['branch']},
            headers=_gh_headers(cfg['token']),
        )
    if r.status_code == 404:
        raise HTTPException(404, 'File not found on this branch')
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f'GitHub read: {r.text[:200]}')
    data = r.json()
    if data.get('type') != 'file':
        raise HTTPException(400, 'Not a file')
    raw_b64 = data.get('content') or ''
    try:
        content = base64.b64decode(raw_b64).decode('utf-8')
    except Exception:
        raise HTTPException(415, 'Binary file — not editable in the sandbox')
    return {
        'path': data['path'],
        'sha': data['sha'],
        'size': data['size'],
        'content': content,
        'html_url': data.get('html_url'),
    }


@router.put('/file')
async def self_write_file(
    payload: dict = Body(...),
    op: dict = Depends(get_current_operator),
):
    """Commit a file edit. Body:
        {"path": "frontend/src/...", "content": "...", "sha": "<previous sha>",
         "message": "tweak landing copy"}

    Returns the new sha + commit hash so the UI can update without re-reading.
    """
    cfg = await _require_self_repo()
    path = (payload.get('path') or '').strip()
    if not path:
        raise HTTPException(400, 'path required')
    _check_path(path, cfg['prefixes'])
    content = payload.get('content')
    if content is None:
        raise HTTPException(400, 'content required (empty string is fine)')
    sha = (payload.get('sha') or '').strip() or None
    message = (payload.get('message') or f'sandbox: edit {os.path.basename(path)}').strip()
    body: dict = {
        'message': message,
        'content': base64.b64encode(content.encode('utf-8')).decode('ascii'),
        'branch': cfg['branch'],
        # Show the operator's identity in the GitHub commit log.
        'committer': {
            'name': 'TBC Operator Sandbox',
            'email': op.get('email') or 'operator@tbctools.org',
        },
    }
    if sha:
        body['sha'] = sha

    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.put(
            f"{GH_API}/repos/{cfg['repo']}/contents/{path.lstrip('/')}",
            headers=_gh_headers(cfg['token']),
            json=body,
        )
    if r.status_code >= 400:
        # Surface GitHub's exact reason — usually "sha mismatch" on
        # concurrent edits.
        msg = ''
        try:
            msg = r.json().get('message') or r.text[:200]
        except Exception:
            msg = r.text[:200]
        raise HTTPException(r.status_code, f'GitHub write: {msg}')

    data = r.json()
    return {
        'ok': True,
        'path': path,
        'new_sha': (data.get('content') or {}).get('sha'),
        'commit_sha': (data.get('commit') or {}).get('sha'),
        'commit_url': (data.get('commit') or {}).get('html_url'),
        # The GitHub webhook will fan-out to any matching deploy project
        # so a redeploy is already in flight when this returns.
        'auto_deploy_triggered_if_webhook_set': True,
    }
