"""One-click "Push initial code" — uploads the operator's app source to an
empty GitHub repo via the GitHub Contents API.

The frustration this solves
---------------------------
When the operator configures a brand-new GitHub repo (e.g. fresh
`Richiie86/tbc-ai-tools` with only a README) and clicks Deploy, the
cross-AI review correctly says `do_not_ship` because there is nothing
to ship. The operator's only escape used to be:

  - Open github.com manually
  - Drag-and-drop the project folder
  - Hope they got every file

Now they click ONE button and we push the live `/app` tree to the repo
via the GitHub API. The same `github_token` already configured for the
AI Build flow has Contents:Write — no extra setup.

Safety
------
- Operator-only endpoint (`get_current_operator`).
- Pushes are gated to repos the operator has explicitly configured as a
  `deploy_projects.repo` field — never a free-form path.
- Respects an exclusion list (`.git`, `node_modules`, `__pycache__`,
  `.env*`, etc.) so we never leak credentials or balloon the push with
  build artefacts.
- File-size cap (1 MB per file, 800 files per push) so an accidentally
  huge repo can't wedge the worker.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/deploy', tags=['deploy-initial-push'])

GITHUB_API = 'https://api.github.com'

# Roots we walk to gather the app source. Order matters for readability
# on the GitHub commit history — backend first, frontend second.
_SOURCE_ROOTS = ['backend', 'frontend']

# Top-level files we also push when they exist (most repos want these).
_TOP_LEVEL_INCLUDE = [
    'README.md', 'package.json', 'yarn.lock', '.gitignore', 'vercel.json',
    'pyproject.toml', 'Dockerfile', '.dockerignore', 'tsconfig.json',
]

# Patterns we NEVER push. Most are the usual VCS-ignore set; .env* is
# critical (the operator's real secrets would leak otherwise).
_EXCLUDE_DIR_NAMES = {
    '.git', 'node_modules', '__pycache__', '.pytest_cache', '.venv', 'venv',
    '.next', 'build', 'dist', '.turbo', '.cache', 'coverage', '.idea',
    '.vscode', '.yarn',
}
_EXCLUDE_FILE_PATTERNS = (
    '.env', '.env.local', '.env.development', '.env.production',
    '.env.test', '.DS_Store',
)
_EXCLUDE_FILE_SUFFIXES = (
    '.pyc', '.pyo', '.log', '.lock~',
)

_MAX_FILE_BYTES = 1 * 1024 * 1024     # 1 MB
_MAX_FILES_PER_PUSH = 800
_BATCH_PUSH_PARALLELISM = 4           # parallel PUT requests
_APP_ROOT = Path('/app')


def _should_skip(path: Path) -> bool:
    """Decide whether to skip a single file path."""
    if any(part in _EXCLUDE_DIR_NAMES for part in path.parts):
        return True
    name = path.name
    if name.startswith('.env'):
        return True
    if name in _EXCLUDE_FILE_PATTERNS:
        return True
    if name.endswith(_EXCLUDE_FILE_SUFFIXES):
        return True
    return False


def _gather_files() -> list[Path]:
    """Walk the curated source roots and return file paths to push.

    We deliberately ignore everything outside `_SOURCE_ROOTS` + the
    top-level include list — the goal is "push a deployable snapshot",
    not "mirror the entire container".
    """
    out: list[Path] = []
    for top in _TOP_LEVEL_INCLUDE:
        p = _APP_ROOT / top
        if p.is_file() and not _should_skip(p):
            out.append(p)
    for root_name in _SOURCE_ROOTS:
        root = _APP_ROOT / root_name
        if not root.exists():
            continue
        for p in root.rglob('*'):
            if not p.is_file():
                continue
            if _should_skip(p):
                continue
            try:
                if p.stat().st_size > _MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            out.append(p)
            if len(out) >= _MAX_FILES_PER_PUSH:
                return out
    return out


async def _gh_request(
    client: httpx.AsyncClient, method: str, url: str, token: str,
    json_body: Optional[dict] = None,
) -> httpx.Response:
    return await client.request(
        method, url,
        headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        json=json_body,
    )


async def _resolve_repo_state(
    client: httpx.AsyncClient, repo: str, branch: str, token: str,
) -> tuple[bool, set[str]]:
    """Return (branch_exists, existing_paths). Existing-paths is the set of
    repo paths that already have a file on the branch — we need their
    SHA later for the PUT contents API.
    """
    # Branch exists?
    ref_resp = await _gh_request(
        client, 'GET', f'{GITHUB_API}/repos/{repo}/branches/{branch}', token,
    )
    branch_exists = ref_resp.status_code == 200
    existing: set[str] = set()
    if branch_exists:
        tree_resp = await _gh_request(
            client, 'GET',
            f'{GITHUB_API}/repos/{repo}/git/trees/{branch}?recursive=1',
            token,
        )
        if tree_resp.status_code == 200:
            for t in (tree_resp.json().get('tree') or []):
                if t.get('type') == 'blob':
                    existing.add(t['path'])
    return branch_exists, existing


async def _put_one_file(
    client: httpx.AsyncClient, repo: str, branch: str, token: str,
    local_path: Path, repo_path: str, existing_sha: Optional[str],
) -> tuple[bool, str]:
    """Upload one file via the Contents API. Returns (ok, detail).

    Auto-retries once on a 409 (stale SHA) by re-fetching the blob's
    current SHA — this is the common case when many files are being
    pushed in rapid succession and GitHub's tree-listing cache hands us
    a SHA that's already been rotated by a sibling PUT in the same
    batch. Without this retry the operator-facing "initial push" call
    consistently leaves ~20 files behind on a fresh repo population."""
    try:
        data = local_path.read_bytes()
    except Exception as e:
        return False, f'read failed: {e}'
    encoded = base64.b64encode(data).decode('ascii')

    async def _attempt(sha: Optional[str]) -> 'httpx.Response':
        body: dict = {
            'message': f'Initial push: {repo_path}',
            'content': encoded,
            'branch': branch,
        }
        if sha:
            body['sha'] = sha
        return await _gh_request(
            client, 'PUT',
            f'{GITHUB_API}/repos/{repo}/contents/{repo_path}',
            token, json_body=body,
        )

    r = await _attempt(existing_sha)
    if r.status_code in (200, 201):
        return True, 'ok'
    if r.status_code == 409:
        # Re-fetch the file's current blob SHA and try once more. We add
        # a tiny jitter sleep so any in-flight tree-cache flush has time
        # to settle on GitHub's side.
        await asyncio.sleep(0.5)
        fresh_sha: Optional[str] = None
        meta_r = await _gh_request(
            client, 'GET',
            f'{GITHUB_API}/repos/{repo}/contents/{repo_path}?ref={branch}',
            token,
        )
        if meta_r.status_code == 200:
            fresh_sha = (meta_r.json() or {}).get('sha')
        elif meta_r.status_code == 404:
            # File was deleted between our list and our PUT — drop the
            # SHA and create instead.
            fresh_sha = None
        r2 = await _attempt(fresh_sha)
        if r2.status_code in (200, 201):
            return True, 'ok (retried after 409)'
        return False, f'conflict ({r2.status_code}) after retry: {r2.text[:200]}'
    return False, f'http {r.status_code}: {r.text[:200]}'


@router.post('/{project_id}/initial-push')
async def initial_push(
    project_id: str, op: dict = Depends(get_current_operator),
):
    """Push the live `/app` source to the project's configured GitHub repo.

    Pre-conditions:
      - project.repo is set (`owner/name`)
      - settings.github_token has Contents:Write on that repo

    Behaviour:
      - Walks `/app/{backend,frontend}` + a curated set of top-level
        files, skipping the usual VCS-ignore patterns.
      - Pushes each file via the Contents API. Existing files are
        overwritten (same SHA flow as AI Build).
      - Returns `{pushed, skipped_existing, errors[], branch, repo}`.
    """
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    return await do_initial_push(project, source='operator_manual')


async def do_initial_push(project: dict, *, source: str = 'operator_manual') -> dict:
    """Reusable engine for the one-click push. Used by the HTTP endpoint
    above AND by the auto-fix loop's empty-repo sweep. `source` is
    stamped on the project doc for audit ("operator_manual" /
    "auto_fix_empty_repo")."""
    repo = (project.get('repo') or '').strip()
    if not repo:
        raise HTTPException(412, 'Project has no GitHub repo configured.')

    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not token:
        raise HTTPException(503, 'github_token not set in Operator → Security.')

    branch = (project.get('gitRef') or 'main').strip() or 'main'
    project_id = project['id']

    files = _gather_files()
    if not files:
        raise HTTPException(500, 'No source files found locally to push.')

    pushed = 0
    errors: list[dict] = []
    started = datetime.now(timezone.utc)

    # `timeout` and `limits` both matter when pushing 100+ files:
    # - timeout=30 covers the slowest single PUT (large files)
    # - limits caps concurrent sockets so our semaphore stays the actual
    #   bottleneck, not httpx's pool. Without explicit limits the default
    #   max_connections=100 + keep_alive=20 still allowed a burst that
    #   timed out the GitHub API on multi-file pushes.
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=30.0),
        limits=httpx.Limits(max_connections=_BATCH_PUSH_PARALLELISM * 2,
                            max_keepalive_connections=_BATCH_PUSH_PARALLELISM),
    ) as client:
        branch_exists, _existing = await _resolve_repo_state(client, repo, branch, token)
        if not branch_exists:
            # The repo may have a different default branch (e.g. `master`).
            # We try once more against `master` before bailing — fewer
            # operator-facing surprises.
            for fallback in ('master', 'main'):
                if fallback == branch:
                    continue
                exists2, _ex2 = await _resolve_repo_state(client, repo, fallback, token)
                if exists2:
                    branch = fallback
                    branch_exists = True
                    break
        if not branch_exists:
            raise HTTPException(
                502,
                f"Branch '{branch}' does not exist on {repo}. "
                "Initialise the repo on GitHub first (the README from `Add a README` is enough) — that creates the default branch."
            )

        # ── Git Data API commit ─────────────────────────────────────
        # Pushing 100+ files via the per-file Contents API is fatally
        # racy: each PUT creates a commit, concurrent PUTs see a stale
        # branch HEAD, and ~20 files always 409. We use the Git Data
        # API instead: upload blobs in parallel (race-free, content-
        # addressable), build ONE tree, ONE commit, then update the
        # ref. Atomic AND ~10× faster than sequential Contents API.

        # 1. Get current HEAD commit + tree SHA.
        head_r = await _gh_request(
            client, 'GET', f'{GITHUB_API}/repos/{repo}/git/ref/heads/{branch}', token,
        )
        if head_r.status_code != 200:
            raise HTTPException(502, f'GitHub git/ref failed: {head_r.text[:200]}')
        head_sha = head_r.json()['object']['sha']

        head_commit_r = await _gh_request(
            client, 'GET', f'{GITHUB_API}/repos/{repo}/git/commits/{head_sha}', token,
        )
        if head_commit_r.status_code != 200:
            raise HTTPException(502, f'GitHub git/commits failed: {head_commit_r.text[:200]}')
        base_tree_sha = head_commit_r.json()['tree']['sha']

        # 2. Upload one blob per file (parallel — safe; blobs are
        #    content-addressable, no race possible on creation).
        sem = asyncio.Semaphore(_BATCH_PUSH_PARALLELISM)

        async def _upload_blob(local: Path):
            rel = local.relative_to(_APP_ROOT).as_posix()
            try:
                data = local.read_bytes()
            except OSError as e:
                return rel, None, f'read failed: {e}'
            async with sem:
                r = await _gh_request(
                    client, 'POST', f'{GITHUB_API}/repos/{repo}/git/blobs', token,
                    json_body={
                        'content': base64.b64encode(data).decode('ascii'),
                        'encoding': 'base64',
                    },
                )
            if r.status_code in (200, 201):
                return rel, r.json().get('sha'), None
            # Detect & surface rate-limit specifically so the operator
            # gets an actionable "reset at HH:MM UTC" message instead of
            # a generic "No blobs uploaded".
            if r.status_code == 403 and 'rate limit' in r.text.lower():
                return rel, None, 'rate_limit'
            return rel, None, f'blob http {r.status_code}: {r.text[:150]}'

        results = await asyncio.gather(*[_upload_blob(f) for f in files])
        # If ALL failed with rate_limit, surface a 429 with the reset time
        # rather than a misleading 502.
        if results and all(err == 'rate_limit' for _, _, err in results if err):
            limit_r = await _gh_request(client, 'GET', f'{GITHUB_API}/rate_limit', token)
            try:
                core = limit_r.json().get('resources', {}).get('core', {})
                reset_ts = core.get('reset')
                from datetime import datetime as _dt
                reset_iso = _dt.fromtimestamp(reset_ts, tz=timezone.utc).isoformat() if reset_ts else 'soon'
            except Exception:
                reset_iso = 'soon'
            raise HTTPException(
                429,
                f'GitHub rate limit exhausted ({core.get("used","?")} / {core.get("limit","?")}). '
                f'Resets at {reset_iso}. The Git Data API push will succeed on retry after that.',
            )
        tree_entries: list[dict] = []
        for rel, blob_sha, err in results:
            if err:
                errors.append({'path': rel, 'detail': err})
                continue
            tree_entries.append({
                'path': rel,
                'mode': '100644',  # blob file (use 100755 for exec; not needed here)
                'type': 'blob',
                'sha': blob_sha,
            })

        if not tree_entries:
            raise HTTPException(502, 'No blobs uploaded; nothing to commit.')

        # 3. Create a new tree on top of the existing one. `base_tree`
        #    means GitHub merges our entries with the existing tree,
        #    preserving any files we didn't include (rare for an
        #    initial push, but useful for partial syncs).
        tree_r = await _gh_request(
            client, 'POST', f'{GITHUB_API}/repos/{repo}/git/trees', token,
            json_body={'base_tree': base_tree_sha, 'tree': tree_entries},
        )
        if tree_r.status_code not in (200, 201):
            raise HTTPException(502, f'GitHub git/trees failed: {tree_r.text[:300]}')
        new_tree_sha = tree_r.json()['sha']

        # 4. Create a commit pointing at the new tree.
        commit_msg = (
            f'Initial push from preview: {len(tree_entries)} files '
            f'({source})'
        )
        commit_r = await _gh_request(
            client, 'POST', f'{GITHUB_API}/repos/{repo}/git/commits', token,
            json_body={
                'message': commit_msg,
                'tree': new_tree_sha,
                'parents': [head_sha],
            },
        )
        if commit_r.status_code not in (200, 201):
            raise HTTPException(502, f'GitHub git/commits failed: {commit_r.text[:300]}')
        new_commit_sha = commit_r.json()['sha']

        # 5. Move the branch ref forward to the new commit.
        ref_r = await _gh_request(
            client, 'PATCH', f'{GITHUB_API}/repos/{repo}/git/refs/heads/{branch}', token,
            json_body={'sha': new_commit_sha, 'force': False},
        )
        if ref_r.status_code not in (200, 201):
            raise HTTPException(502, f'GitHub git/refs failed: {ref_r.text[:300]}')

        pushed = len(tree_entries)

    # Stamp the project so the UI can stop showing the "empty repo" CTA.
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {
            'last_initial_push_at': datetime.now(timezone.utc),
            'last_initial_push_count': pushed,
            'last_initial_push_source': source,
            'updated_at': datetime.now(timezone.utc),
        }},
    )

    return {
        'repo': repo,
        'branch': branch,
        'pushed': pushed,
        'skipped': len(files) - pushed,
        'errors': errors[:20],
        'started_at': started.isoformat(),
        'finished_at': datetime.now(timezone.utc).isoformat(),
        'next_step': (
            'Now click Deploy again — the cross-AI review will rerun against '
            'the freshly-pushed code instead of an empty repo.'
        ),
    }


def _iter_files() -> Iterable[Path]:
    """Public-ish helper used by future endpoints (e.g. a `dry-run` count)."""
    return _gather_files()
