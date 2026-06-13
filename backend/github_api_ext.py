"""GitHub REST API client helpers.

Extracted from `deploy_projects_ext.py` (Feb 2026) so the routing layer
stays focused on FastAPI handlers and orchestration, while every raw HTTP
call to GitHub lives here.

Currently exposes one helper:

  - `stream_github_zip(repo, ref, token)` — async generator that yields
    bytes from GitHub's `/repos/{repo}/zipball[/{ref}]` endpoint so the
    caller can pipe it into a FastAPI `StreamingResponse` without buffering
    the whole archive in memory. Used by both operator-side and AI-agent
    project download endpoints.

Public repos work tokenless (rate-limited to 60/hr); private repos require
the operator to set `github_token` in payment_settings — otherwise GitHub
returns 403/404 and we surface a friendly HTTPException.
"""
from typing import Optional

import httpx
from fastapi import HTTPException

GITHUB_API = 'https://api.github.com'


async def stream_github_zip(repo: str, ref: Optional[str], gh_token: Optional[str]):
    """Yield bytes from GitHub's zipball endpoint. Public repos work tokenless
    (rate-limited); private repos need `github_token` in operator settings.

    Implemented as a generator so we can `StreamingResponse` directly without
    buffering a 100MB+ repo in memory.
    """
    url = f'{GITHUB_API}/repos/{repo}/zipball'
    if ref:
        url = f'{url}/{ref}'
    headers = {'Accept': 'application/vnd.github+json'}
    if gh_token:
        headers['Authorization'] = f'Bearer {gh_token}'
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        async with client.stream('GET', url, headers=headers) as r:
            if r.status_code == 404:
                raise HTTPException(404, f'Repo {repo!r} or ref {ref!r} not found on GitHub')
            if r.status_code == 403:
                raise HTTPException(
                    502,
                    'GitHub rate limit / auth required. Set github_token in operator settings for private repos.',
                )
            if r.status_code >= 400:
                raise HTTPException(502, f'GitHub: HTTP {r.status_code} fetching zip')
            async for chunk in r.aiter_bytes(64 * 1024):
                yield chunk
