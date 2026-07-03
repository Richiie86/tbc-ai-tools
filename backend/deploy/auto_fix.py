"""Auto-fix engine — closes the autopilot loop without operator clicks.

When the AI code review verdict is `do_not_ship`, this module:
  1. Fetches the current contents of every file mentioned in the findings
     (via the GitHub Contents API with `github_token` from settings).
  2. Asks the LLM for STRICT JSON patches (`[{path, content, rationale}]`)
     using the same Emergent LLM key the rest of the platform uses.
  3. Commits each patch to the project's tracked branch via PUT
     `/repos/{repo}/contents/{path}` (one commit per file, sharing a base
     commit message + suffix so the history reads as a coherent fix).
  4. Returns the list of new commit SHAs so the caller can re-run the
     autopilot loop on the new HEAD.

Safety:
  - Skips files that don't already exist (we only patch what we know).
  - Caps per-file content at 80 KB so a hallucinated 10 MB blob can't blow
    the commit endpoint.
  - The caller (autopilot loop) enforces a max-iteration ceiling so a
    pathological review can't trigger an infinite commit storm.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import HTTPException

from deploy_projects_ext import db

logger = logging.getLogger(__name__)

GITHUB_API = 'https://api.github.com'
_MAX_PATCH_BYTES = 80 * 1024            # per-file cap on AI-generated content
_PATCH_FETCH_CHARS = 12_000             # per-file cap on context we hand the LLM
_PATCH_TOTAL_CHARS = 60_000             # absolute prompt-context cap


_SYSTEM_PROMPT = (
    "You are an expert senior engineer fixing the findings of an AI code "
    "review on a real production repo. Return STRICT JSON with this schema "
    "and nothing else:\n"
    "{\n"
    '  "commit_message": "<conventional-commit subject>",\n'
    '  "patches": [\n'
    '    {\n'
    '      "path": "<repo path>",\n'
    '      "content": "<FULL new file content>",\n'
    '      "rationale": "<one sentence on why this fixes the finding>"\n'
    '    }\n'
    '  ]\n'
    "}\n"
    "Rules:\n"
    "- Output the COMPLETE new contents of each file, not a diff.\n"
    "- Only patch files that exist in the supplied snapshot.\n"
    "- Address every HIGH and MEDIUM finding; LOW ones are optional.\n"
    "- Keep behaviour-preserving — no API breaks, no dependency upgrades.\n"
    "- If you genuinely cannot fix a finding, omit the patch and explain in "
    "the `commit_message` body."
)


async def _gh_get(client: httpx.AsyncClient, url: str, token: str, accept: str = 'application/vnd.github+json'):
    r = await client.get(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': accept,
        'X-GitHub-Api-Version': '2022-11-28',
    })
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        raise HTTPException(502, f'GitHub GET {url} → {r.status_code} {r.text[:200]}')
    return r


async def _gh_put(client: httpx.AsyncClient, url: str, token: str, body: dict):
    r = await client.put(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }, json=body)
    if r.status_code >= 400:
        raise HTTPException(
            502,
            f'GitHub PUT {url} → {r.status_code} {r.text[:300]}. '
            f'Token may be missing `Contents: Write` on this repo.',
        )
    return r.json()


async def _fetch_paths_for_patch(
    client: httpx.AsyncClient,
    repo: str,
    paths: list[str],
    ref: str,
    token: str,
) -> dict[str, dict]:
    """Return {path: {sha, content (utf-8 string)}} for each file that exists.
    Missing files are silently dropped — the LLM only patches what's there.
    """
    out: dict[str, dict] = {}
    total = 0
    for path in paths:
        if total >= _PATCH_TOTAL_CHARS:
            break
        url = f'{GITHUB_API}/repos/{repo}/contents/{path}?ref={ref}'
        meta_resp = await _gh_get(client, url, token)
        if meta_resp is None:
            continue
        meta = meta_resp.json()
        # GitHub returns base64-encoded content on the metadata endpoint.
        encoded = meta.get('content') or ''
        try:
            content = base64.b64decode(encoded.replace('\n', '')).decode('utf-8', errors='replace')
        except Exception:
            content = ''
        if len(content) > _PATCH_FETCH_CHARS:
            content = content[:_PATCH_FETCH_CHARS]
        total += len(content)
        out[path] = {'sha': meta.get('sha'), 'content': content}
    return out


def _findings_to_paths(review: dict) -> list[str]:
    """Deduped list of file paths mentioned in the findings, sorted by
    severity bucket (high first) so a low-budget snapshot still hits the most
    important ones."""
    bucket = {'high': [], 'medium': [], 'low': []}
    for f in review.get('findings') or []:
        path = (f.get('file') or '').strip()
        if not path or path in bucket['high'] + bucket['medium'] + bucket['low']:
            continue
        bucket.get(f.get('severity', 'low'), bucket['low']).append(path)
    return bucket['high'] + bucket['medium'] + bucket['low']


async def request_patches(project: dict, review: dict, settings: dict) -> dict:
    """Ask the LLM for a JSON patch set that resolves the findings.
    Returns {patches: [...], commit_message: str}. Raises HTTPException on
    fetch or LLM failure."""
    from llm_router import LlmChat, UserMessage

    gh_token = (settings or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        raise HTTPException(
            503,
            'github_token not configured — auto-fix needs `Contents: Write` to commit patches. '
            'Set it in Operator → Security.',
        )
    llm_key = (settings or {}).get('emergent_llm_key') or os.environ.get('EMERGENT_LLM_KEY')
    if not llm_key:
        raise HTTPException(503, 'Emergent LLM key not configured for auto-fix.')

    paths = _findings_to_paths(review)
    if not paths:
        raise HTTPException(422, 'Review had no file-specific findings to patch.')

    ref = review.get('ref') or project.get('gitRef') or 'main'
    async with httpx.AsyncClient(timeout=20.0) as client:
        files = await _fetch_paths_for_patch(client, project['repo'], paths, ref, gh_token)
    if not files:
        raise HTTPException(502, 'Could not fetch any candidate files from GitHub for the auto-fix.')

    findings_blob = '\n'.join(
        f"- [{f.get('severity', 'low').upper()}] {f.get('file', '?')}: {f.get('title', '')}\n"
        f"    {f.get('explanation', '')}\n"
        f"    Suggested fix: {f.get('suggested_fix', '')}"
        for f in (review.get('findings') or [])
    )
    files_blob = '\n\n'.join(
        f"--- FILE: {path} ---\n{info['content']}" for path, info in files.items()
    )
    prompt = (
        f"Project: {project.get('projectName')} ({project['repo']}@{ref})\n"
        f"Review summary: {review.get('summary', '(none)')}\n\n"
        f"Findings:\n{findings_blob}\n\n"
        f"Current file contents (snapshot):\n{files_blob}\n\n"
        "Return the JSON patch object now."
    )

    chat = LlmChat(
        api_key=llm_key,
        session_id=f'auto-fix-{project["id"]}-{datetime.now(timezone.utc).timestamp():.0f}',
        system_message=_SYSTEM_PROMPT,
    ).with_model('openai', 'gpt-4o')
    try:
        raw = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        raise HTTPException(502, f'LLM error during auto-fix: {str(e)[:300]}')

    text = (raw or '').strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if not m:
            raise HTTPException(502, f'Auto-fix LLM returned non-JSON: {text[:200]}')
        try:
            parsed = json.loads(m.group(0))
        except Exception as e:
            raise HTTPException(502, f'Auto-fix LLM JSON parse failed: {e}')

    patches = parsed.get('patches') or []
    # Defence-in-depth: drop patches that exceed the per-file cap.
    safe_patches = [
        p for p in patches
        if isinstance(p, dict)
        and isinstance(p.get('path'), str)
        and isinstance(p.get('content'), str)
        and len(p['content']) <= _MAX_PATCH_BYTES
    ]
    return {
        'patches': safe_patches,
        'commit_message': parsed.get('commit_message') or 'fix: address autopilot review findings',
        'fetched_files': files,  # passes the {path: {sha}} map through so commit step doesn't re-GET
    }


async def commit_patches(
    project: dict,
    patches: list[dict],
    commit_message: str,
    fetched_files: dict,
    settings: dict,
) -> list[dict]:
    """Apply each patch via PUT /repos/{repo}/contents/{path}. One commit per
    file so each finding gets its own audit-trail entry. Returns a list of
    {path, sha (new), commit_url}."""
    gh_token = (settings or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        raise HTTPException(503, 'github_token not configured')

    ref = project.get('gitRef') or 'main'
    results: list[dict] = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for p in patches:
            path = p['path']
            content = p['content']
            existing = fetched_files.get(path)
            if not existing:
                # We didn't snapshot this file — skip rather than risk a
                # blind create on the wrong path.
                logger.warning('auto-fix: skipping unsnapshot path %s', path)
                continue
            body = {
                'message': f'{commit_message}\n\n[autopilot] {p.get("rationale", "")}'.strip(),
                'content': base64.b64encode(content.encode('utf-8')).decode('ascii'),
                'sha': existing['sha'],
                'branch': ref,
            }
            res = await _gh_put(
                client, f'{GITHUB_API}/repos/{project["repo"]}/contents/{path}',
                gh_token, body,
            )
            commit = res.get('commit') or {}
            results.append({
                'path': path,
                'new_sha': (res.get('content') or {}).get('sha'),
                'commit_sha': commit.get('sha'),
                'commit_url': commit.get('html_url'),
                'rationale': p.get('rationale'),
            })

    # Persist a tiny audit trail on the project doc so the operator can see
    # the history of auto-fix attempts even after the dialog closes.
    await db.deploy_projects.update_one(
        {'id': project['id']},
        {'$push': {'auto_fix_history': {
            '$each': [{
                'committed_at': datetime.now(timezone.utc).isoformat(),
                'commit_message': commit_message,
                'patches': results,
            }],
            '$slice': -20,  # keep last 20 attempts only
        }}},
    )
    return results
