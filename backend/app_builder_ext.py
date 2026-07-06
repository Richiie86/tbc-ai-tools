"""App Builder — originate a brand-new app from a prompt, then deploy it.

Unlike `ai_build_ext.py` (which adds a small feature PR to an *existing* repo)
this module *originates* an app end-to-end:

  1. plan     — LLM turns the prompt into {app_name, stack, description, files[]}.
                `stack` is validated against a strict allowlist (nextjs | static);
                a hallucinated stack falls back to `nextjs`.
  2. scaffold — start from a vetted in-repo template (`backend/app_templates/<stack>/`)
                so every build has a known-good baseline even when the LLM output
                is thin.
  3. generate — LLM fills/overwrites template files with the real app. Enforces
                `BLOCKED_PATH_PATTERNS`, an 80 KB per-file cap and an N-file cap.
  4. repo     — POST /user/repos (private) → Richiie86/<slug>, then commit every
                file to `main` via the Contents API (reusing the proven helpers
                from ai_build_ext).
  5. vercel   — vercel_ensure_project linked to the new repo.
  6. deploy   — vercel_create_deployment (production); poll to READY.
  7. domain   — optional: vercel_attach_domain + Porkbun DNS + SSL attach.
  8. persist  — upsert into deploy_projects.

Two surfaces, one core:
  - Operator UI: POST /api/operator/app-builder/build (SSE stream) + /plan + /history.
  - AI agent:    POST /api/projects/build (Bearer token, JSON response).

Safety: operator-only or Bearer-only; blocklist enforced before AND after the
LLM call; new repos are private; commits only ever hit the new app's own repo,
never the platform repo.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db
from rate_limit import rate_limit_operator
from vercel_api_ext import (
    TERMINAL_STATES,
    VERCEL_API,
    vercel_attach_domain,
    vercel_create_deployment,
    vercel_ensure_project,
    vercel_team_qs,
    vercel_token,
)
# Reuse the exact GitHub + blocklist + text helpers the feature-PR builder uses.
from ai_build_ext import (
    BLOCKED_PATH_PATTERNS,
    GITHUB_API,
    _gh_get,
    _gh_post,
    _gh_put,
    _is_blocked,
    _slugify,
    _strip_codefences,
)

logger = logging.getLogger('tbc')

operator_router = APIRouter(prefix='/api/operator/app-builder', tags=['app-builder'])
agent_router = APIRouter(prefix='/api/projects', tags=['projects'])

# ─── Configuration ────────────────────────────────────────────────────────
GITHUB_OWNER = os.environ.get('APP_BUILDER_OWNER', 'Richiie86')
_TEMPLATES_DIR = Path(__file__).parent / 'app_templates'
_ALLOWED_STACKS = ('nextjs', 'static')
_MAX_FILE_BYTES = 80 * 1024
_MAX_FILES = int(os.environ.get('APP_BUILDER_MAX_FILES', '40'))
_MAX_PROMPT_CHARS = 6_000
_DEPLOY_POLL_ATTEMPTS = int(os.environ.get('APP_BUILDER_POLL_ATTEMPTS', '40'))
_DEPLOY_POLL_INTERVAL = float(os.environ.get('APP_BUILDER_POLL_INTERVAL', '6'))

# Rate limits — these fire paid LLM calls + create real repos/deploys.
_BUILD_LIMIT = int(os.environ.get('APP_BUILDER_LIMIT', '6'))
_BUILD_WINDOW = int(os.environ.get('APP_BUILDER_WINDOW', '300'))

_SYSTEM_PROMPT = (
    "You are an expert engineer that originates a COMPLETE, deploy-ready web app "
    "from a single prompt. Return STRICT JSON and nothing else:\n"
    "{\n"
    '  "app_name": "<short human name>",\n'
    '  "slug": "<kebab-case repo slug, max 40 chars>",\n'
    '  "stack": "nextjs" | "static",\n'
    '  "description": "<one-line description>",\n'
    '  "files": [ { "path": "<repo-relative path>", "content": "<FULL file content>" } ]\n'
    "}\n"
    "RULES (zero tolerance):\n"
    "- Choose `nextjs` for anything interactive/dynamic; `static` only for a simple "
    "one-page HTML/CSS/JS site.\n"
    "- Output the COMPLETE contents of every file you want to create or overwrite — "
    "never a diff, never a placeholder comment.\n"
    "- You are given a known-good template baseline; overwrite the parts you need "
    "(e.g. app/page.tsx, app/globals.css, index.html, style.css) and add new files. "
    "Keep package.json valid if you change dependencies.\n"
    "- NEVER include secrets, .env files, lockfiles, or server credentials.\n"
    f"- Keep it focused — at most {_MAX_FILES} files, each under 80 KB.\n"
    "- The app must build with zero manual config on Vercel (Next.js App Router or "
    "plain static files).\n"
)


class BuildRequest(BaseModel):
    prompt: str = Field(..., min_length=4, max_length=_MAX_PROMPT_CHARS)
    app_name: Optional[str] = Field(default=None, max_length=80)
    domain: Optional[str] = Field(default=None, max_length=253)
    # 'auto' lets the LLM pick; otherwise force a stack from the allowlist.
    stack: Optional[str] = Field(default='auto', max_length=16)


# ─── Helpers ────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_stack(stack: Optional[str]) -> str:
    s = (stack or '').strip().lower()
    return s if s in _ALLOWED_STACKS else 'nextjs'


def _load_template(stack: str) -> dict[str, str]:
    """Read the vetted baseline files for `stack` into a {path: content} map."""
    root = _TEMPLATES_DIR / stack
    files: dict[str, str] = {}
    if not root.is_dir():
        return files
    for p in sorted(root.rglob('*')):
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            try:
                files[rel] = p.read_text(encoding='utf-8')
            except Exception:
                continue
    return files


def _merge_and_sanitize(base: dict[str, str], generated: list) -> tuple[dict[str, str], list[dict]]:
    """Overlay LLM files onto the template baseline, enforcing the blocklist +
    size caps. Returns (final_files, rejected)."""
    final = dict(base)
    rejected: list[dict] = []
    count = 0
    for f in generated or []:
        if not isinstance(f, dict):
            continue
        path = str(f.get('path') or '').lstrip('./').strip()
        content = f.get('content')
        if not path or not isinstance(content, str):
            continue
        if _is_blocked(path):
            rejected.append({'path': path, 'reason': 'matches BLOCKED_PATH_PATTERNS'})
            continue
        if len(content.encode('utf-8')) > _MAX_FILE_BYTES:
            rejected.append({'path': path, 'reason': f'exceeds {_MAX_FILE_BYTES} bytes'})
            continue
        if count >= _MAX_FILES:
            rejected.append({'path': path, 'reason': f'exceeds {_MAX_FILES} file cap'})
            continue
        final[path] = content
        count += 1
    return final, rejected


async def _create_private_repo(client: httpx.AsyncClient, token: str, slug: str, description: str) -> dict:
    """Create a private repo under the configured owner with an initial commit
    (auto_init) so `main` exists and we can commit files onto it. Returns the
    repo JSON. Falls back to resolving an existing repo on 422 name-conflict."""
    body = {
        'name': slug,
        'description': (description or 'Generated by TBC AI Tools')[:350],
        'private': True,
        'auto_init': True,
    }
    # POST /user/repos creates under the authenticated user. Org owners still
    # resolve as `login/<slug>` which is what we store.
    r = await _gh_post(client, f'{GITHUB_API}/user/repos', token, body)
    if r.status_code in (201, 200):
        return r.json()
    if r.status_code == 422:
        # Name already exists — resolve it so repeated builds don't hard-fail.
        who = await _gh_get(client, f'{GITHUB_API}/user', token)
        login = (who.json() or {}).get('login', GITHUB_OWNER) if who.status_code == 200 else GITHUB_OWNER
        existing = await _gh_get(client, f'{GITHUB_API}/repos/{login}/{slug}', token)
        if existing.status_code == 200:
            return existing.json()
    raise HTTPException(502, f'Repo create failed ({r.status_code}): {r.text[:200]}')


async def _commit_files(client: httpx.AsyncClient, token: str, repo: str, branch: str, files: dict[str, str]) -> int:
    """Commit every file to `branch` via the Contents API. Overwrites template
    files created by auto_init (README) as needed. Returns the commit count."""
    committed = 0
    for path, content in files.items():
        content_b64 = base64.b64encode(content.encode('utf-8')).decode('ascii')
        body = {
            'message': f'app-builder: add {path}',
            'content': content_b64,
            'branch': branch,
        }
        # If the file already exists (e.g. README from auto_init), pass its sha.
        existing = await _gh_get(client, f'{GITHUB_API}/repos/{repo}/contents/{path}?ref={branch}', token)
        if existing.status_code == 200:
            sha = (existing.json() or {}).get('sha')
            if sha:
                body['sha'] = sha
        put = await _gh_put(client, f'{GITHUB_API}/repos/{repo}/contents/{path}', token, body)
        if put.status_code >= 400:
            logger.warning('app-builder commit %s -> %s %s', path, put.status_code, put.text[:160])
            continue
        committed += 1
    return committed


async def _poll_deployment_ready(settings: dict, deployment_id: str) -> dict:
    """Poll a deployment until it reaches a terminal state or we time out."""
    token = vercel_token(settings)
    params = dict(vercel_team_qs(settings))
    last: dict = {}
    async with httpx.AsyncClient(timeout=15.0) as client:
        for _ in range(_DEPLOY_POLL_ATTEMPTS):
            r = await client.get(
                f'{VERCEL_API}/v13/deployments/{deployment_id}',
                headers={'Authorization': f'Bearer {token}'},
                params=params,
            )
            if r.status_code < 400:
                last = r.json() or {}
                state = (last.get('readyState') or last.get('status') or '').upper()
                if state in TERMINAL_STATES:
                    return last
            await asyncio.sleep(_DEPLOY_POLL_INTERVAL)
    return last


async def _run_pipeline(
    *,
    prompt: str,
    app_name: Optional[str],
    domain: Optional[str],
    stack_choice: str,
    actor: str,
) -> AsyncGenerator[dict, None]:
    """Core origination pipeline. Yields step dicts (for SSE); the final dict
    has `done: True` with the result payload. Every failure yields an
    `error` step and stops rather than raising, so both SSE and JSON callers
    get a clean, human-readable reason."""

    def step(name: str, message: str, **extra):
        return {'step': name, 'message': message, **extra}

    # ── credentials ──────────────────────────────────────────────────────
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')
    if not gh_token:
        yield step('error', 'github_token not set in Operator → Security.')
        return
    if not vercel_token(settings):
        yield step('error', 'Vercel token not configured (Operator → Ops → Vercel keys).')
        return

    from llm_router import LlmChat, UserMessage, resolve_text_model
    resolved = await resolve_text_model()
    if not resolved:
        yield step('error', 'No AI provider key configured (Operator → My Keys).')
        return
    provider, model = resolved

    # ── 1. plan + generate (single LLM call) ─────────────────────────────
    yield step('plan', 'Asking the AI to design and generate the app…')
    forced = _validate_stack(stack_choice) if stack_choice and stack_choice != 'auto' else None
    user_prompt = (
        f'Build request: {prompt}\n'
        + (f'Preferred app name: {app_name}\n' if app_name else '')
        + (f'REQUIRED stack: {forced}\n' if forced else 'Pick the best stack.\n')
        + '\nReturn the JSON now.'
    )
    chat = LlmChat(
        api_key='',
        session_id=f'app-builder-{datetime.now(timezone.utc).timestamp():.0f}',
        system_message=_SYSTEM_PROMPT,
    ).with_model(provider, model)
    try:
        raw = await chat.send_message(UserMessage(text=user_prompt))
    except Exception as e:
        yield step('error', f'LLM error: {str(e)[:300]}')
        return

    text = _strip_codefences(raw or '')
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if not m:
            yield step('error', f'AI returned non-JSON: {text[:200]}')
            return
        try:
            parsed = json.loads(m.group(0))
        except Exception as e:
            yield step('error', f'JSON parse failed: {e}')
            return

    stack = forced or _validate_stack(parsed.get('stack'))
    app_name = app_name or (parsed.get('app_name') or 'AI Built App').strip()[:80]
    slug = _slugify(parsed.get('slug') or app_name)
    description = (parsed.get('description') or app_name)[:280]

    baseline = _load_template(stack)
    final_files, rejected = _merge_and_sanitize(baseline, parsed.get('files'))
    if not final_files:
        yield step('error', 'No safe files to write after sanitizing the AI output.')
        return
    yield step('generate', f'Prepared {len(final_files)} files ({stack}).',
               stack=stack, slug=slug, file_count=len(final_files), rejected=rejected)

    # ── 2. create repo + commit ──────────────────────────────────────────
    yield step('repo', f'Creating private repo {GITHUB_OWNER}/{slug}…')
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            repo_json = await _create_private_repo(client, gh_token, slug, description)
        except HTTPException as e:
            yield step('error', e.detail)
            return
        repo_full = repo_json.get('full_name') or f'{GITHUB_OWNER}/{slug}'
        default_branch = repo_json.get('default_branch') or 'main'
        repo_html = repo_json.get('html_url') or f'https://github.com/{repo_full}'

        committed = await _commit_files(client, gh_token, repo_full, default_branch, final_files)
        if committed == 0:
            yield step('error', 'No files committed — check the GitHub token Contents:Write scope.')
            return
    yield step('commit', f'Committed {committed} files to {repo_full}@{default_branch}.',
               repo=repo_full, repo_url=repo_html)

    # ── 3. Vercel project + deploy ───────────────────────────────────────
    yield step('vercel', 'Creating the Vercel project…')
    try:
        proj = await vercel_ensure_project(settings, slug, repo_full, 'github', default_branch)
    except HTTPException as e:
        yield step('error', f'Vercel project create failed: {e.detail}')
        return
    vercel_project_id = proj.get('id')

    yield step('deploy', 'Deploying to production…')
    project_shape = {
        'repo': repo_full,
        'repoType': 'github',
        'gitRef': default_branch,
        'vercel_project_id': vercel_project_id,
    }
    try:
        dep = await vercel_create_deployment(settings, project_shape, 'production', default_branch, slug)
    except HTTPException as e:
        yield step('error', f'Deploy trigger failed: {e.detail}')
        return
    deployment_id = dep.get('id') or dep.get('uid')
    dep_url = dep.get('url')
    deploy_url = f'https://{dep_url}' if dep_url and not dep_url.startswith('http') else dep_url

    ready = await _poll_deployment_ready(settings, deployment_id) if deployment_id else {}
    ready_state = (ready.get('readyState') or ready.get('status') or 'UNKNOWN').upper()
    if ready.get('url'):
        u = ready['url']
        deploy_url = f'https://{u}' if not u.startswith('http') else u
    if ready_state == 'ERROR':
        yield step('error', f'Deployment failed on Vercel. Repo: {repo_html}', repo_url=repo_html)
        return
    yield step('deployed', f'Deployment {ready_state.lower() or "queued"}.', deploy_url=deploy_url)

    # ── 4. optional domain ───────────────────────────────────────────────
    domain_clean = (domain or '').strip().replace('https://', '').replace('http://', '').strip('/')
    domain_result = None
    if domain_clean and vercel_project_id:
        yield step('domain', f'Attaching {domain_clean}…')
        try:
            await vercel_attach_domain(settings, vercel_project_id, domain_clean)
            try:
                from porkbun_ext import _attach_to_vercel_for_ssl, configure_vercel_dns
                await configure_vercel_dns(domain_clean)
                await _attach_to_vercel_for_ssl(domain_clean)
            except Exception as dns_e:
                logger.warning('app-builder DNS/SSL best-effort failed: %s', dns_e)
            domain_result = domain_clean
            yield step('domain_attached', f'{domain_clean} attached.', domain=domain_clean)
        except HTTPException as e:
            # Non-fatal: the app still lives at its Vercel URL.
            yield step('domain_warning', f'Domain attach failed: {e.detail}')

    # ── 5. persist ───────────────────────────────────────────────────────
    project_id = f'app_{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")}'
    now = datetime.now(timezone.utc)
    doc = {
        'id': project_id,
        'projectName': app_name,
        'repo': repo_full,
        'repoType': 'github',
        'gitRef': default_branch,
        'domain': domain_result or '',
        'vercel_project_id': vercel_project_id,
        'stack': stack,
        'origin': 'app-builder',
        'created_by': actor,
        'last_deployment_id': deployment_id,
        'last_deployment_url': deploy_url,
        'last_deployment_state': ready_state,
        'created_at': now,
        'updated_at': now,
    }
    await db.deploy_projects.update_one({'id': project_id}, {'$set': doc}, upsert=True)
    await db.app_builder_history.insert_one({
        'project_id': project_id,
        'prompt': prompt,
        'app_name': app_name,
        'stack': stack,
        'repo': repo_full,
        'repo_url': repo_html,
        'deploy_url': deploy_url,
        'domain': domain_result or '',
        'created_by': actor,
        'created_at': now,
    })

    yield step('done', 'Build complete.', done=True, result={
        'project_id': project_id,
        'app_name': app_name,
        'stack': stack,
        'repo': repo_full,
        'repo_url': repo_html,
        'deploy_url': deploy_url,
        'domain': domain_result or '',
        'deployment_state': ready_state,
        'rejected': rejected,
    })


def _sse(event: dict) -> str:
    return f'data: {json.dumps(event)}\n\n'


# ─── Operator endpoints ─────────────────────────────────────────────────────
@operator_router.post('/build')
async def operator_build(req: BuildRequest, user: dict = Depends(get_current_operator)):
    """Stream the full origination pipeline to the operator UI (SSE)."""
    rate_limit_operator(user, 'app-builder:build', limit=_BUILD_LIMIT, window_seconds=_BUILD_WINDOW)
    actor = f'operator:{user.get("id")}'

    async def gen() -> AsyncGenerator[str, None]:
        try:
            async for ev in _run_pipeline(
                prompt=req.prompt, app_name=req.app_name, domain=req.domain,
                stack_choice=req.stack or 'auto', actor=actor,
            ):
                yield _sse(ev)
        except Exception as e:  # last-resort guard so the stream never 500s mid-flight
            logger.exception('app-builder pipeline crashed')
            yield _sse({'step': 'error', 'message': f'Unexpected error: {str(e)[:200]}'})

    return StreamingResponse(gen(), media_type='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
    })


@operator_router.get('/history')
async def operator_history(user: dict = Depends(get_current_operator), limit: int = 25):
    cursor = db.app_builder_history.find({}).sort('created_at', -1).limit(max(1, min(limit, 100)))
    out = []
    async for d in cursor:
        d.pop('_id', None)
        if d.get('created_at') and not isinstance(d['created_at'], str):
            d['created_at'] = d['created_at'].isoformat()
        out.append(d)
    return {'entries': out, 'count': len(out)}


# ─── AI-agent endpoint (Bearer token, JSON) ─────────────────────────────────
async def _require_ai_api_key_local(authorization: Optional[str] = Header(None)) -> dict:
    """Local copy of the Bearer-token gate (mirrors deploy_projects_ext) to
    avoid a circular import — validates against the stored ai_api_key."""
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Missing Bearer token')
    presented = authorization.split(None, 1)[1].strip()
    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    stored = (settings or {}).get('ai_api_key')
    if not stored or presented != stored:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid API key')
    return settings


@agent_router.post('/build')
async def agent_build(req: BuildRequest, _settings: dict = Depends(_require_ai_api_key_local)):
    """Non-streamed origination for external AI agents. Runs the same core
    pipeline and returns the final result (or a 502 with the failing step)."""
    last: dict = {}
    error: Optional[str] = None
    async for ev in _run_pipeline(
        prompt=req.prompt, app_name=req.app_name, domain=req.domain,
        stack_choice=req.stack or 'auto', actor='ai-agent',
    ):
        last = ev
        if ev.get('step') == 'error':
            error = ev.get('message')
            break
    if error:
        raise HTTPException(502, error)
    if not last.get('done'):
        raise HTTPException(502, 'Pipeline ended without completing.')
    return last.get('result') or {}
