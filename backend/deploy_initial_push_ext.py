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
    '.vscode', '.emergent', '.yarn',
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
    """Upload one file via the Contents API. Returns (ok, detail)."""
    try:
        data = local_path.read_bytes()
    except Exception as e:
        return False, f'read failed: {e}'
    body: dict = {
        'message': f'Initial push: {repo_path}',
        'content': base64.b64encode(data).decode('ascii'),
        'branch': branch,
    }
    if existing_sha:
        body['sha'] = existing_sha
    r = await _gh_request(
        client, 'PUT',
        f'{GITHUB_API}/repos/{repo}/contents/{repo_path}',
        token, json_body=body,
    )
    if r.status_code in (200, 201):
        return True, 'ok'
    if r.status_code == 409:
        # Likely a stale SHA in a race — caller can retry by re-fetching
        # the tree, but for a one-shot push we just surface the conflict.
        return False, f'conflict ({r.status_code}): {r.text[:200]}'
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
    repo = (project.get('repo') or '').strip()
    if not repo:
        raise HTTPException(412, 'Project has no GitHub repo configured.')

    settings = await db.payment_settings.find_one({}) or {}
    token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not token:
        raise HTTPException(503, 'github_token not set in Operator → Security.')

    branch = (project.get('gitRef') or 'main').strip() or 'main'

    files = _gather_files()
    if not files:
        raise HTTPException(500, 'No source files found locally to push.')

    pushed = 0
    errors: list[dict] = []
    started = datetime.now(timezone.utc)

    async with httpx.AsyncClient(timeout=30.0) as client:
        branch_exists, existing = await _resolve_repo_state(client, repo, branch, token)
        if not branch_exists:
            # The repo may have a different default branch (e.g. `master`).
            # We try once more against `master` before bailing — fewer
            # operator-facing surprises.
            for fallback in ('master', 'main'):
                if fallback == branch:
                    continue
                exists2, ex2 = await _resolve_repo_state(client, repo, fallback, token)
                if exists2:
                    branch = fallback
                    existing = ex2
                    branch_exists = True
                    break
        if not branch_exists:
            raise HTTPException(
                502,
                f"Branch '{branch}' does not exist on {repo}. "
                "Initialise the repo on GitHub first (the README from `Add a README` is enough) — that creates the default branch."
            )

        sem = asyncio.Semaphore(_BATCH_PUSH_PARALLELISM)

        async def _push(local: Path) -> None:
            nonlocal pushed
            rel = local.relative_to(_APP_ROOT).as_posix()
            sha = None
            if rel in existing:
                # Fetch the current blob SHA for an idempotent overwrite.
                meta_r = await _gh_request(
                    client, 'GET',
                    f'{GITHUB_API}/repos/{repo}/contents/{rel}?ref={branch}',
                    token,
                )
                if meta_r.status_code == 200:
                    sha = (meta_r.json() or {}).get('sha')
            async with sem:
                ok, detail = await _put_one_file(client, repo, branch, token, local, rel, sha)
            if ok:
                pushed += 1
            else:
                errors.append({'path': rel, 'detail': detail})

        await asyncio.gather(*[_push(f) for f in files], return_exceptions=False)

    # Stamp the project so the UI can stop showing the "empty repo" CTA.
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {
            'last_initial_push_at': datetime.now(timezone.utc),
            'last_initial_push_count': pushed,
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
