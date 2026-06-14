"""AI Build — operator-only natural-language code changes via Pull Request.

The operator types something like "add a `/sitemap.xml` route" or "make the
status banner red when more than 10 critical errors fired in 24h" and:

  1. The LLM plans the change — returns STRICT JSON with proposed file
     paths + full new contents + a one-sentence rationale per file.
  2. We validate every proposed path against a HARD blocklist (auth,
     payments, schemas, .env) — refusal is logged so the operator can see
     what the AI tried.
  3. The operator reviews the diff in the UI and clicks "Open PR".
  4. We create a new branch (`ai-build/<slug>-<ts>`), commit each file
     to it via the GitHub Contents API (reusing the same helpers
     `deploy/auto_fix.py` already uses), and open a PR against `main`.
  5. Vercel auto-deploys to a preview URL; the operator merges to ship.

Safety guarantees:
  - `BLOCKED_PATH_PATTERNS` is enforced server-side BEFORE we ever ask the
    LLM for content, and AGAIN after the LLM responds. Two-tier defence
    against prompt-injection bypasses.
  - Operator-only (`get_current_operator`) on every endpoint.
  - No direct pushes to main, ever. Each change opens a PR — Vercel handles
    preview deploys; humans merge.
  - Per-file content cap (80 KB) and per-request file cap (12) so a
    hallucinated 1000-file refactor can't blow the rate limit or repo.
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
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-build', tags=['ai-build'])

# ─── Configuration ────────────────────────────────────────────────────────
GITHUB_API = 'https://api.github.com'
_MAX_PATCH_BYTES = 80 * 1024
_MAX_FILES_PER_REQUEST = 12
_MAX_PROMPT_CHARS = 4_000
_CONTEXT_FILES_LIMIT = 8         # how many existing files we hand the LLM as grounding
_CONTEXT_BYTES_PER_FILE = 8_000

# Hard blocklist. Any AI-proposed path matching these gets the whole plan
# rejected. The regex is intentionally generous — better safe than sorry.
BLOCKED_PATH_PATTERNS = [
    re.compile(r'(^|/)\.env(\..*)?$'),                       # any .env
    re.compile(r'(^|/)backend/auth([_-]|\.py$|/)', re.I),    # auth.py, auth_ext.py, auth/*
    re.compile(r'(^|/)backend/.*payment.*\.py$', re.I),      # payments_ext.py, payment_routes.py
    re.compile(r'(^|/)backend/.*stripe.*\.py$', re.I),
    re.compile(r'(^|/)backend/.*nowpayments.*\.py$', re.I),
    re.compile(r'(^|/)backend/.*paypal.*\.py$', re.I),
    re.compile(r'(^|/)backend/models\.py$', re.I),
    re.compile(r'(^|/)secrets[_-]?ext\.py$', re.I),
    re.compile(r'(^|/)\.git/'),
    re.compile(r'(^|/)package-lock\.json$'),
    re.compile(r'(^|/)yarn\.lock$'),
]


def _is_blocked(path: str) -> bool:
    return any(p.search(path) for p in BLOCKED_PATH_PATTERNS)


_SYSTEM_PROMPT = (
    "You are an expert senior engineer adding a small, focused feature to a "
    "production React+FastAPI repo on operator request. Return STRICT JSON "
    "with this schema and nothing else:\n"
    "{\n"
    '  "summary": "<one-line plain-English summary of the change>",\n'
    '  "branch_slug": "<short kebab-case slug, max 40 chars, no leading dashes>",\n'
    '  "files": [\n'
    '    {\n'
    '      "path": "<repo path, relative to repo root>",\n'
    '      "action": "create" | "modify",\n'
    '      "content": "<FULL new file content — never a diff>",\n'
    '      "rationale": "<one-sentence reason>"\n'
    '    }\n'
    '  ]\n'
    "}\n"
    "HARD RULES (zero tolerance):\n"
    "- NEVER touch files matching: .env, backend/auth*, backend/*payment*.py, "
    "backend/*stripe*.py, backend/*nowpayments*.py, backend/*paypal*.py, "
    "backend/models.py, secrets_ext.py, package-lock.json, yarn.lock. Output an "
    "empty files array with a `refusal_reason` if the request would require it.\n"
    "- Output the COMPLETE new contents of each file, NOT a diff.\n"
    "- Keep the change focused — maximum 12 files per request.\n"
    "- Behaviour-preserving on existing routes — no breaking changes.\n"
    "- For new React pages, add a data-testid on the page wrapper.\n"
    "- For new FastAPI endpoints, always prefix with /api and add the router "
    "to server.py via app.include_router.\n"
    "- For new files, include any minimal imports the snapshot suggests the "
    "project already uses.\n"
    "- If you genuinely cannot do this safely, return "
    '{"summary":"refused","branch_slug":"refused","files":[],"refusal_reason":"<why>"}.'
)


# ─── Schemas ──────────────────────────────────────────────────────────────
class PlanRequest(BaseModel):
    project_id: str = Field(..., description='Operator deploy_projects.id')
    prompt: str = Field(..., min_length=4, max_length=_MAX_PROMPT_CHARS)


class PlanResponse(BaseModel):
    plan_id: str
    summary: str
    branch_slug: str
    files: list[dict]
    blocked: list[dict]
    refusal_reason: Optional[str] = None
    model: str
    created_at: str


class OpenPRRequest(BaseModel):
    plan_id: str


# ─── GitHub helpers (thin httpx wrappers — no shared mutable state) ───────
async def _gh_get(client: httpx.AsyncClient, url: str, token: str):
    r = await client.get(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    return r


async def _gh_post(client: httpx.AsyncClient, url: str, token: str, body: dict):
    return await client.post(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }, json=body)


async def _gh_put(client: httpx.AsyncClient, url: str, token: str, body: dict):
    return await client.put(url, headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }, json=body)


async def _fetch_file(client, repo: str, path: str, ref: str, token: str) -> Optional[dict]:
    url = f'{GITHUB_API}/repos/{repo}/contents/{path}?ref={ref}'
    r = await _gh_get(client, url, token)
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        return None
    meta = r.json()
    encoded = meta.get('content') or ''
    try:
        content = base64.b64decode(encoded.replace('\n', '')).decode('utf-8', errors='replace')
    except Exception:
        content = ''
    return {'sha': meta.get('sha'), 'content': content[:_CONTEXT_BYTES_PER_FILE]}


# Bias the LLM's grounding context toward files most likely relevant to the
# prompt. Cheap heuristic — pick the README + top-level structure markers
# plus anything matched by simple keyword extraction.
async def _build_context_snapshot(client, repo: str, ref: str, token: str, prompt: str) -> dict:
    candidates = [
        'README.md',
        'frontend/src/App.js',
        'backend/server.py',
        'frontend/package.json',
        'backend/requirements.txt',
    ]
    # Heuristic: any word in the prompt that looks like a path token
    # (alpha, dot, slash, dash) of length ≥3 gets a probe attempt.
    for token_word in re.findall(r'[A-Za-z0-9_.\-/]{3,}', prompt):
        if '/' in token_word or token_word.endswith('.py') or token_word.endswith('.jsx'):
            candidates.append(token_word)
        if len(candidates) >= 30:
            break
    out: dict[str, dict] = {}
    for path in candidates:
        if len(out) >= _CONTEXT_FILES_LIMIT:
            break
        if _is_blocked(path):
            continue
        info = await _fetch_file(client, repo, path, ref, token)
        if info:
            out[path] = info
    return out


def _strip_codefences(text: str) -> str:
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)
    return text


def _slugify(s: str) -> str:
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s.lower()).strip('-')
    return s[:40] or 'ai-build'


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_plan_id() -> str:
    return f'plan_{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")}'


# ─── Endpoints ────────────────────────────────────────────────────────────
@router.post('/plan', response_model=PlanResponse)
async def plan(req: PlanRequest, user: dict = Depends(get_current_operator)):
    """Generate a JSON patch plan for the operator to review.

    Stored in `ai_build_plans` so the follow-up `/open-pr` call doesn't
    need to re-run the LLM. Plans expire after 24h via index TTL.
    """
    from emergentintegrations.llm.chat import LlmChat, UserMessage

    project = await db.deploy_projects.find_one({'id': req.project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    repo = project.get('repo')
    if not repo:
        raise HTTPException(400, 'Project has no `repo` configured')

    settings = await db.payment_settings.find_one({}) or {}
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        raise HTTPException(503, 'github_token not set in Operator → Security.')
    llm_key = settings.get('emergent_llm_key') or os.environ.get('EMERGENT_LLM_KEY')
    if not llm_key:
        raise HTTPException(503, 'EMERGENT_LLM_KEY not configured.')

    ref = project.get('gitRef') or 'main'
    async with httpx.AsyncClient(timeout=20.0) as client:
        context = await _build_context_snapshot(client, repo, ref, gh_token, req.prompt)

    files_blob = '\n\n'.join(
        f'--- {p} ---\n{info["content"]}' for p, info in context.items()
    ) or '(no context snapshot — repo may be empty or token lacks read scope)'
    user_prompt = (
        f'Repo: {repo}@{ref}\n'
        f'Operator request: {req.prompt}\n\n'
        f'Existing file snapshots for grounding:\n{files_blob}\n\n'
        'Return the JSON plan now.'
    )

    chat = LlmChat(
        api_key=llm_key,
        session_id=f'ai-build-{req.project_id}-{datetime.now(timezone.utc).timestamp():.0f}',
        system_message=_SYSTEM_PROMPT,
    ).with_model('anthropic', 'claude-sonnet-4-5-20250929')
    try:
        raw = await chat.send_message(UserMessage(text=user_prompt))
    except Exception as e:
        logger.warning('AI Build LLM failed: %s', e)
        raise HTTPException(502, f'LLM error: {str(e)[:300]}')

    text = _strip_codefences(raw or '')
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if not m:
            raise HTTPException(502, f'LLM returned non-JSON: {text[:200]}')
        try:
            parsed = json.loads(m.group(0))
        except Exception as e:
            raise HTTPException(502, f'JSON parse failed: {e}')

    files = parsed.get('files') or []
    if not isinstance(files, list):
        raise HTTPException(502, 'LLM returned non-list `files`.')

    # SECOND defence layer — strip blocked paths even if the prompt-leak
    # bypassed the system message. Track them so the UI can show what the
    # AI tried to touch.
    safe: list[dict] = []
    blocked: list[dict] = []
    for f in files[:_MAX_FILES_PER_REQUEST]:
        if not isinstance(f, dict) or not isinstance(f.get('path'), str) or not isinstance(f.get('content'), str):
            continue
        path = f['path'].lstrip('./')
        if _is_blocked(path):
            blocked.append({'path': path, 'reason': 'matches BLOCKED_PATH_PATTERNS'})
            continue
        if len(f['content']) > _MAX_PATCH_BYTES:
            blocked.append({'path': path, 'reason': f'exceeds {_MAX_PATCH_BYTES} bytes'})
            continue
        action = f.get('action') if f.get('action') in ('create', 'modify') else 'modify'
        safe.append({
            'path': path,
            'action': action,
            'content': f['content'],
            'rationale': (f.get('rationale') or '')[:280],
        })

    plan_id = _new_plan_id()
    summary = (parsed.get('summary') or 'AI Build change').strip()[:280]
    branch_slug = _slugify(parsed.get('branch_slug') or summary)
    refusal_reason = parsed.get('refusal_reason')

    doc = {
        'plan_id': plan_id,
        'operator_id': user.get('id'),
        'project_id': req.project_id,
        'repo': repo,
        'ref': ref,
        'prompt': req.prompt,
        'summary': summary,
        'branch_slug': branch_slug,
        'files': safe,
        'blocked': blocked,
        'refusal_reason': refusal_reason,
        'status': 'planned' if safe else 'refused',
        'model': 'claude-sonnet-4-5',
        'created_at': datetime.now(timezone.utc),
    }
    await db.ai_build_plans.insert_one(doc)

    return PlanResponse(
        plan_id=plan_id,
        summary=summary,
        branch_slug=branch_slug,
        files=[{k: v for k, v in f.items() if k != 'content'} | {'content': f['content']} for f in safe],
        blocked=blocked,
        refusal_reason=refusal_reason,
        model='claude-sonnet-4-5',
        created_at=_now_iso(),
    )


@router.post('/open-pr')
async def open_pr(req: OpenPRRequest, user: dict = Depends(get_current_operator)):
    """Apply the saved plan: create a branch, commit each file, open a PR.

    Returns `{pr_url, branch, commits: [...]}` on success. Any GitHub
    failure mid-commit leaves the branch with partial changes — operator
    can still inspect the PR or delete the branch.
    """
    doc = await db.ai_build_plans.find_one({'plan_id': req.plan_id})
    if not doc:
        raise HTTPException(404, 'Plan not found (expired?)')
    if doc.get('status') == 'opened':
        raise HTTPException(409, f'Plan already shipped as {doc.get("pr_url")}')
    if not doc.get('files'):
        raise HTTPException(422, 'Plan has no actionable files (likely refused or all blocked).')

    settings = await db.payment_settings.find_one({}) or {}
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        raise HTTPException(503, 'github_token not set in Operator → Security.')

    repo = doc['repo']
    base_ref = doc.get('ref') or 'main'
    branch = f'ai-build/{doc["branch_slug"]}-{datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")}'

    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Get base branch SHA
        ref_resp = await _gh_get(client, f'{GITHUB_API}/repos/{repo}/git/ref/heads/{base_ref}', gh_token)
        if ref_resp.status_code != 200:
            raise HTTPException(502, f'Could not read base ref `{base_ref}`: {ref_resp.text[:200]}')
        base_sha = (ref_resp.json().get('object') or {}).get('sha')
        if not base_sha:
            raise HTTPException(502, 'No SHA on base ref')

        # 2. Create new branch
        new_ref = await _gh_post(client, f'{GITHUB_API}/repos/{repo}/git/refs', gh_token, {
            'ref': f'refs/heads/{branch}', 'sha': base_sha,
        })
        if new_ref.status_code not in (201, 200):
            raise HTTPException(502, f'Branch create failed: {new_ref.text[:200]}')

        # 3. For each file: fetch current SHA (if modifying) and PUT new content
        commits = []
        for f in doc['files']:
            path = f['path']
            content_b64 = base64.b64encode(f['content'].encode('utf-8')).decode('ascii')
            body = {
                'message': f'ai-build: {f["rationale"] or path}',
                'content': content_b64,
                'branch': branch,
            }
            if f['action'] == 'modify':
                existing = await _fetch_file(client, repo, path, branch, gh_token)
                if existing and existing.get('sha'):
                    body['sha'] = existing['sha']
            put_resp = await _gh_put(client, f'{GITHUB_API}/repos/{repo}/contents/{path}', gh_token, body)
            if put_resp.status_code >= 400:
                logger.warning('ai-build PUT %s → %s %s', path, put_resp.status_code, put_resp.text[:200])
                # Continue so the operator gets a PR with whatever did commit;
                # better than failing the whole batch over one path.
                continue
            j = put_resp.json()
            commits.append({
                'path': path,
                'commit_sha': (j.get('commit') or {}).get('sha'),
                'commit_url': (j.get('commit') or {}).get('html_url'),
            })

        if not commits:
            raise HTTPException(502, 'No files could be committed — check token Contents:Write permission.')

        # 4. Open PR
        pr_body = (
            f'**Operator request:**\n> {doc["prompt"]}\n\n'
            f'**AI summary:** {doc["summary"]}\n\n'
            f'**Files changed ({len(commits)}):**\n'
            + '\n'.join(f'- `{c["path"]}`' for c in commits)
            + '\n\n_Generated by AI Build · review before merging._'
        )
        pr_resp = await _gh_post(client, f'{GITHUB_API}/repos/{repo}/pulls', gh_token, {
            'title': f'AI Build · {doc["summary"][:64]}',
            'head': branch,
            'base': base_ref,
            'body': pr_body[:60_000],
        })
        if pr_resp.status_code not in (200, 201):
            raise HTTPException(502, f'PR create failed: {pr_resp.text[:300]}')
        pr = pr_resp.json()

    await db.ai_build_plans.update_one(
        {'plan_id': req.plan_id},
        {'$set': {
            'status': 'opened',
            'pr_url': pr.get('html_url'),
            'pr_number': pr.get('number'),
            'branch': branch,
            'commits': commits,
            'opened_at': datetime.now(timezone.utc),
        }},
    )
    return {
        'pr_url': pr.get('html_url'),
        'pr_number': pr.get('number'),
        'branch': branch,
        'commits': commits,
    }


@router.get('/history')
async def history(user: dict = Depends(get_current_operator), limit: int = 25):
    """Recent AI Build plans for this operator (most recent first)."""
    cursor = db.ai_build_plans.find(
        {},
        {'plan_id': 1, 'prompt': 1, 'summary': 1, 'status': 1, 'pr_url': 1, 'pr_number': 1, 'created_at': 1, 'opened_at': 1, 'refusal_reason': 1},
    ).sort('created_at', -1).limit(max(1, min(limit, 100)))
    out = []
    async for d in cursor:
        d.pop('_id', None)
        for k in ('created_at', 'opened_at'):
            if d.get(k) and not isinstance(d[k], str):
                d[k] = d[k].isoformat()
        out.append(d)
    return {'entries': out, 'count': len(out)}


@router.delete('/plan/{plan_id}')
async def discard_plan(plan_id: str, user: dict = Depends(get_current_operator)):
    """Discard a planned change before it's opened. Opened PRs stay in DB
    as audit trail — discard only affects plans in 'planned' state."""
    res = await db.ai_build_plans.update_one(
        {'plan_id': plan_id, 'status': 'planned'},
        {'$set': {'status': 'discarded', 'discarded_at': datetime.now(timezone.utc)}},
    )
    if res.modified_count == 0:
        raise HTTPException(404, 'No discardable plan with that id')
    return {'discarded': True}
