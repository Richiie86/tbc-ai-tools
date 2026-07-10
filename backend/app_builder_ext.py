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
import html
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


def _is_meaningful_generated_file(path: str, content: str) -> bool:
    """True when an AI-generated file contains actual app-specific UI/code.

    The template baseline is intentionally safe, but deploying only that baseline
    creates the "empty shell" the operator complained about. This guard lets us
    detect a thin model response and inject a real fallback page before deploy.
    """
    p = (path or '').lower().strip()
    if p not in {'app/page.tsx', 'app/globals.css', 'index.html', 'style.css'}:
        return bool(content and len(content.strip()) > 120)
    text = (content or '').lower()
    shell_markers = (
        'your ai-built app is live',
        'your ai-built site is live',
        'generated and deployed by tbc ai tools',
    )
    return bool(content and len(content.strip()) > 180 and not any(m in text for m in shell_markers))


def _fallback_generated_files(prompt: str, app_name: str, stack: str) -> list[dict]:
    """Deterministic non-empty app when the model returns only a shell.

    This keeps the builder from shipping a generic template. The result is still
    simple, but it is a complete branded landing page based on the user's prompt,
    with clear sections and CTAs instead of an empty starter card.
    """
    safe_name = html.escape(re.sub(r'[^a-zA-Z0-9 ._-]+', '', app_name or 'AI Built App').strip() or 'AI Built App')
    safe_prompt = html.escape((prompt or 'A useful web app').replace('`', "'").strip()[:900])
    if stack == 'static':
        return [
            {'path': 'index.html', 'content': f'''<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{safe_name}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <p class="eyebrow">AI-built launch page</p>
        <h1>{safe_name}</h1>
        <p class="lead">{safe_prompt}</p>
        <div class="actions">
          <a href="#features">Explore features</a>
          <a href="mailto:hello@example.com" class="secondary">Contact us</a>
        </div>
      </section>
      <section id="features" class="grid">
        <article><h2>Fast start</h2><p>Clear onboarding and a focused first screen for users.</p></article>
        <article><h2>Built to ship</h2><p>Deploy-ready structure with responsive styling.</p></article>
        <article><h2>Easy to extend</h2><p>Replace these sections with your real product flows as you iterate.</p></article>
      </section>
    </main>
  </body>
</html>'''},
            {'path': 'style.css', 'content': '''body{margin:0;font-family:Inter,system-ui,sans-serif;background:#08111f;color:#e5f4ff}.page{min-height:100vh;padding:64px 24px}.hero{max-width:960px;margin:0 auto 48px;padding:48px;border:1px solid rgba(56,189,248,.25);border-radius:28px;background:linear-gradient(135deg,rgba(14,165,233,.18),rgba(15,23,42,.9))}.eyebrow{color:#38bdf8;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:700}h1{font-size:clamp(40px,8vw,88px);line-height:.95;margin:16px 0}.lead{font-size:20px;max-width:760px;color:#cbd5e1}.actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:28px}.actions a{background:#38bdf8;color:#06111f;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800}.actions .secondary{background:transparent;color:#e5f4ff;border:1px solid rgba(226,232,240,.35)}.grid{max-width:960px;margin:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.grid article{background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:20px;padding:24px}.grid h2{color:#7dd3fc;margin-top:0}'''}
        ]
    return [
        {'path': 'app/page.tsx', 'content': f'''const features = [
  ['Fast start', 'A focused first screen that explains the product immediately.'],
  ['Built to ship', 'Responsive UI and deploy-ready structure for Vercel.'],
  ['Easy to extend', 'Keep chatting to add real workflows, forms, payments, dashboards, and data.'],
]

export default function Page() {{
  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">AI-built web app</p>
        <h1>{safe_name}</h1>
        <p className="lead">{safe_prompt}</p>
        <div className="actions">
          <a href="#features">Explore features</a>
          <a className="secondary" href="mailto:hello@example.com">Contact us</a>
        </div>
        <div id="features" className="grid">
          {{features.map(([title, text]) => (
            <article key={{title}}>
              <h2>{{title}}</h2>
              <p>{{text}}</p>
            </article>
          ))}}
        </div>
      </section>
    </main>
  )
}}
'''},
        {'path': 'app/globals.css', 'content': '''*{box-sizing:border-box}body{margin:0;background:#020617;color:#f8fafc;font-family:Inter,system-ui,sans-serif}.page{min-height:100vh;padding:64px 24px}.hero{max-width:1040px;margin:0 auto;padding:56px;border:1px solid rgba(56,189,248,.25);border-radius:30px;background:linear-gradient(135deg,rgba(14,165,233,.18),rgba(15,23,42,.96))}.eyebrow{color:#38bdf8;text-transform:uppercase;letter-spacing:.18em;font-size:12px;font-weight:800}h1{font-size:clamp(42px,8vw,92px);line-height:.95;margin:18px 0;color:#fff}.lead{font-size:20px;line-height:1.7;max-width:780px;color:#cbd5e1}.actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:30px}.actions a{background:#38bdf8;color:#06111f;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:900}.actions .secondary{background:transparent;color:#f8fafc;border:1px solid rgba(226,232,240,.35)}.grid{margin-top:56px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.grid article{border:1px solid rgba(148,163,184,.18);border-radius:20px;background:rgba(15,23,42,.74);padding:24px}.grid h2{color:#bae6fd;margin:0 0 8px}.grid p{color:#94a3b8;line-height:1.6;margin:0}'''}
    ]


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
    # A fine-grained PAT that can push to existing repos but lacks account-level
    # repo-creation rights returns 403 "Resource not accessible by personal
    # access token" here. This is the single most common reason a brand-new
    # app deploy fails while editing existing apps still works — so surface an
    # actionable message instead of a cryptic 502.
    if r.status_code == 403 and 'not accessible by personal access token' in (r.text or '').lower():
        raise HTTPException(502, (
            'Your GitHub token can push to existing repos but is not allowed to '
            'CREATE new repositories, so a brand-new app can\'t be provisioned. '
            'This happens with fine-grained tokens (github_pat_…). Fix: in Operator '
            '→ Security, replace it with a CLASSIC token (github.com/settings/tokens/new) '
            'that has the "repo" scope (and "delete_repo" if you want cleanup). '
            'Editing already-deployed apps keeps working either way.'
        ))
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


async def _read_repo_files(
    client: httpx.AsyncClient,
    token: str,
    repo: str,
    branch: str,
    *,
    max_files: int = _MAX_FILES,
    max_file_bytes: int = _MAX_FILE_BYTES,
) -> dict[str, str]:
    """Read the current app source from `repo`@`branch` into a {path: content}
    map, so the chat "iterate" loop can feed the live files back to the LLM.

    Uses the git trees API (recursive) to list paths in one call, then fetches
    each blob. Applies the SAME safety caps as writes (blocklist, per-file size,
    file count) and skips obvious non-source paths (node_modules, .next, build
    output, binaries, lockfiles) so we don't blow the LLM context or pull junk.
    """
    tree_resp = await _gh_get(
        client, f'{GITHUB_API}/repos/{repo}/git/trees/{branch}?recursive=1', token,
    )
    if tree_resp.status_code >= 400:
        raise HTTPException(
            502, f'Could not list repo files ({tree_resp.status_code}): {tree_resp.text[:200]}',
        )
    tree = (tree_resp.json() or {}).get('tree', [])
    _SKIP_DIRS = ('node_modules/', '.next/', '.git/', 'dist/', 'build/', '.vercel/', 'out/')
    _SKIP_SUFFIX = (
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.woff',
        '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.zip', '.lock', '.map',
    )
    _SKIP_EXACT = ('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb')
    files: dict[str, str] = {}
    for node in tree:
        if node.get('type') != 'blob':
            continue
        path = node.get('path') or ''
        if not path or _is_blocked(path):
            continue
        if any(path.startswith(d) or f'/{d}' in path for d in _SKIP_DIRS):
            continue
        if path.split('/')[-1] in _SKIP_EXACT:
            continue
        if path.lower().endswith(_SKIP_SUFFIX):
            continue
        if (node.get('size') or 0) > max_file_bytes:
            continue
        if len(files) >= max_files:
            break
        blob = await _gh_get(
            client, f'{GITHUB_API}/repos/{repo}/contents/{path}?ref={branch}', token,
        )
        if blob.status_code >= 400:
            continue
        data = blob.json() or {}
        if data.get('encoding') != 'base64' or not data.get('content'):
            continue
        try:
            files[path] = base64.b64decode(data['content']).decode('utf-8')
        except Exception:
            continue  # binary / non-utf8 — skip
    return files


async def generate_ai_code_fix(
    repo: str,
    branch: str,
    instruction: str,
    gh_token: str,
    *,
    provider: str,
    model: str,
) -> dict:
    """Read the live app source, hand it + a fix instruction to the LLM, and
    return the changed files — WITHOUT committing.

    This is the shared "act, don't just explain" brain behind the Fix problem
    button and the chat iterate loop: it reads the actual repo, produces real
    file edits, and returns ``{'changed': {path: new_content}, 'notes': str,
    'read': int}``. Committing / opening a PR / redeploying is left to the
    caller so the write target (main vs a PR branch) stays a policy decision.

    Uses the sandbox edit envelope (strict JSON `{files:[{path,new_content}]}`),
    the same contract the chat apply loop relies on, so any current model
    (Claude / GPT / Gemini / OpenRouter) can drive it.
    """
    from sandbox_ai_ext import SYSTEM_PROMPT, _strip_json_envelope
    from llm_router import (
        LlmChat, UserMessage, ordered_text_models,
        record_provider_ok, record_provider_error,
    )

    async with httpx.AsyncClient(timeout=45.0) as client:
        files = await _read_repo_files(client, gh_token, repo, branch)
    if not files:
        raise HTTPException(502, 'Could not read the current app files from the repo.')

    parts = [
        f'INSTRUCTION:\n{instruction.strip()}\n',
        f'EDIT MODE: multi — you may modify ANY of the {len(files)} files below '
        'AND create brand-new files when the instruction needs them (a new page, '
        'component, route, model, or helper). To create a file, add a `files` '
        'entry whose `path` is the new file\'s full repo-relative path with its '
        'COMPLETE contents. When you add a new file, also edit whatever existing '
        'file must import/register it (router, server.py, nav) so the feature is '
        'wired up and actually works. Return the COMPLETE new content for every '
        'file you create or change. Produce the actual code; do NOT reply with a '
        'checklist of manual steps.',
    ]
    for path, content in files.items():
        parts.append(f'\n--- FILE: {path} ---\n{content}')
    user_text = '\n'.join(parts)

    # Fail over across EVERY configured provider so one out-of-credits /
    # dead-model AI never blocks a working one. The caller's (provider, model)
    # is tried FIRST (honours an explicit user pick), then the rest of the
    # health-ordered chain. This is the shared brain behind the Fix-problem
    # button and the chat iterate loop, so both get resilience for free.
    chain = await ordered_text_models(
        primary=(provider, model) if provider else None
    )
    if not chain:
        raise HTTPException(502, 'No AI provider key is configured (Operator -> Security).')
    raw = None
    last_err = None
    for prov_i, model_i in chain:
        chat = LlmChat(
            api_key='',
            session_id=f'fix:{repo}',
            system_message=SYSTEM_PROMPT,
            max_tokens=8192,
        ).with_model(prov_i, model_i)
        try:
            raw = await chat.send_message(UserMessage(text=user_text))
            record_provider_ok(prov_i)
            break
        except Exception as e:  # noqa: BLE001
            last_err = str(e)[:200]
            record_provider_error(prov_i, e)
            # Try the NEXT provider on ANY error (a dead model or
            # out-of-credits on one provider must not stop us reaching a
            # healthy one.
            continue
    if raw is None:
        raise HTTPException(502, f'AI edit failed on every provider. Last error: {last_err}')

    raw_text = raw if isinstance(raw, str) else getattr(raw, 'text', '') or str(raw)
    import json as _json
    try:
        parsed = _json.loads(_strip_json_envelope(raw_text))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, 'The model did not return a valid edit. Try again.') from e

    changed: dict[str, str] = {}
    created: list[str] = []
    edited: list[str] = []
    for entry in parsed.get('files', []) or []:
        p = (entry.get('path') or '').strip().lstrip('./')
        nc = entry.get('new_content')
        if p and isinstance(nc, str) and not _is_blocked(p):
            changed[p] = nc
            # A path we didn't send as context is a brand-new file being created.
            (edited if p in files else created).append(p)
    return {
        'changed': changed,
        'created': created,
        'edited': edited,
        'notes': (parsed.get('notes') or '')[:500],
        'read': len(files),
    }


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

    from llm_router import (
        LlmChat, UserMessage, ordered_text_models,
        record_provider_ok, record_provider_error, _classify_provider_error,
    )
    # Preference-ordered, health-aware provider chain so a build never dies just
    # because the first AI is out of credits — we transparently fail over to the
    # next available provider (same logic as the chat/edit paths).
    chain = await ordered_text_models()
    if not chain:
        yield step('error', 'No AI provider key configured (Operator → My Keys).')
        return

    # ── 1. plan + generate (single LLM call, with failover) ──────────────
    yield step('plan', 'Asking the AI to design and generate the app…')
    forced = _validate_stack(stack_choice) if stack_choice and stack_choice != 'auto' else None
    user_prompt = (
        f'Build request: {prompt}\n'
        + (f'Preferred app name: {app_name}\n' if app_name else '')
        + (f'REQUIRED stack: {forced}\n' if forced else 'Pick the best stack.\n')
        + '\nReturn the JSON now.'
    )
    raw = None
    last_err = None
    for idx, (provider, model) in enumerate(chain):
        chat = LlmChat(
            api_key='',
            session_id=f'app-builder-{datetime.now(timezone.utc).timestamp():.0f}',
            system_message=_SYSTEM_PROMPT,
        ).with_model(provider, model)
        try:
            raw = await chat.send_message(UserMessage(text=user_prompt))
            record_provider_ok(provider)
            if idx > 0:
                yield step('plan', f'Primary AI was unavailable — used {provider} instead.')
            break
        except Exception as e:  # noqa: BLE001
            last_err = str(e)[:300]
            record_provider_error(provider, e)
            # Only fail over for provider-fault errors (credits/auth/rate limit).
            if _classify_provider_error(e) is None or idx == len(chain) - 1:
                yield step('error', f'LLM error: {last_err}')
                return
            yield step('plan', f'{provider} unavailable ({last_err[:60]}) — trying another AI…')
            continue
    if raw is None:
        yield step('error', f'All available AIs failed. Last error: {last_err or "unknown"}')
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
    generated_files = parsed.get('files') or []
    if not any(
        _is_meaningful_generated_file(str(f.get('path') or ''), str(f.get('content') or ''))
        for f in generated_files if isinstance(f, dict)
    ):
        generated_files = list(generated_files) + _fallback_generated_files(prompt, app_name, stack)
        yield step('generate', 'AI output was too thin, so I added a complete non-empty starter app instead of deploying a shell.')
    final_files, rejected = _merge_and_sanitize(baseline, generated_files)
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
