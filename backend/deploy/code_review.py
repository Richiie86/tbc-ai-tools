"""Code review subsystem (extracted from `deploy_projects_ext.py`).

Pulls a high-signal snapshot of a project's repo from GitHub, runs an LLM
review with a strict JSON-schema prompt, persists the result on the project
doc, and exposes two HTTP surfaces:

  - `POST /api/operator/deploy/{id}/code-review` — operator cookie auth
  - `POST /api/projects/{id}/code-review`        — Bearer (AI agent) auth

The actual route registration happens by importing this module at the
bottom of `deploy_projects_ext.setup_routers()`, so the shared `ops_router`
and `projects_router` are already defined.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import Depends, HTTPException

# Borrow the shared routers + helpers from the parent module. This is a
# one-way import (parent never imports us back), so no cycle.
from deploy_projects_ext import (
    SELF_PROJECT_ID,
    _ensure_self_project,
    _require_ai_api_key,
    db,
    get_current_operator,
    get_settings_doc,
    ops_router,
    projects_router,
)

GITHUB_API = 'https://api.github.com'

# Keep prompt bounded so a huge repo doesn't blow our token budget; we sample
# the highest-signal files (config + entry points + top-level source).
_PER_FILE_CHARS = 6_000
_TOTAL_CHARS = 40_000

# File patterns we ALWAYS try to include if present (high signal).
_PRIORITY_FILES = (
    'README.md', 'readme.md', 'package.json', 'pyproject.toml',
    'requirements.txt', 'tsconfig.json', 'next.config.js', 'next.config.mjs',
    'vercel.json', 'Dockerfile', '.env.example',
)
# Extensions we consider "code" for the secondary sweep.
_CODE_EXTS = (
    '.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.rb', '.java',
    '.json', '.md', '.yml', '.yaml',
)

# Files that are pure documentation/config scaffolding. A repo containing
# ONLY these (and nothing else) is considered "empty" — there is no real
# source code to review or ship. Used by BOTH the snapshot tree-count and
# the `run_code_review` fast-path so they can never disagree.
_PLACEHOLDER_SUFFIXES = (
    'readme.md', 'readme.rst', 'readme.txt', 'readme',
    'license', 'license.md', 'license.txt', 'license.rst',
    '.gitignore', '.gitattributes', '.editorconfig',
    'code_of_conduct.md', 'contributing.md', 'security.md',
    'changelog.md', 'authors', 'notice', '.env.example',
)


def _is_placeholder_path(path: str) -> bool:
    """True if `path` is a doc/config placeholder (not real source code)."""
    return path.lower().endswith(_PLACEHOLDER_SUFFIXES)


async def _gh_get_json(
    client: httpx.AsyncClient,
    url: str,
    token: Optional[str],
    params: Optional[dict] = None,
):
    headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    r = await client.get(url, headers=headers, params=params)
    if r.status_code == 404:
        return None
    if r.status_code == 403:
        msg = r.json().get('message', 'GitHub rate limit')
        raise HTTPException(
            502,
            f'GitHub: {msg}. Configure a github_token in Operator → Security for private repos / higher limits.',
        )
    if r.status_code >= 400:
        raise HTTPException(502, f'GitHub: HTTP {r.status_code} on {url}')
    return r.json()


async def _gh_get_text(
    client: httpx.AsyncClient, url: str, token: Optional[str],
) -> Optional[str]:
    headers = {'Accept': 'application/vnd.github.raw'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    r = await client.get(url, headers=headers)
    if r.status_code >= 400:
        return None
    return r.text


async def fetch_repo_snapshot(
    repo: str, git_ref: Optional[str], gh_token: Optional[str],
) -> dict:
    """Snapshot the repo's high-signal files for code review.

    Returns a dict with `files: [{path, content, truncated}], file_count, total_chars`.
    Public repos work without a token (rate-limited); private repos require one.
    """
    ref = git_ref or 'main'
    files: list[dict] = []
    total = 0
    async with httpx.AsyncClient(timeout=15.0) as client:
        meta = await _gh_get_json(client, f'{GITHUB_API}/repos/{repo}', gh_token)
        if not meta:
            raise HTTPException(404, f'Repo {repo!r} not found on GitHub')
        default_branch = meta.get('default_branch', 'main')
        ref = ref or default_branch

        tree_resp = await _gh_get_json(
            client, f'{GITHUB_API}/repos/{repo}/git/trees/{ref}', gh_token,
            params={'recursive': '1'},
        )
        if not tree_resp:
            # Branch resolution failed — fall back to the repo default.
            tree_resp = await _gh_get_json(
                client, f'{GITHUB_API}/repos/{repo}/git/trees/{default_branch}', gh_token,
                params={'recursive': '1'},
            )
            ref = default_branch
        if not tree_resp:
            raise HTTPException(502, f'GitHub: could not fetch tree for {repo}@{ref}')

        tree = [t for t in (tree_resp.get('tree') or []) if t.get('type') == 'blob']

        # Count REAL source files across the ENTIRE tree (not just the small
        # sampled subset). This is the authoritative signal for "is the repo
        # empty?" — sampling caps at ~30 files and bucketed selection could
        # otherwise miss code that lives outside the sampled paths, producing
        # a false `repo_empty` verdict that permanently blocks deploys.
        code_blob_count = sum(
            1 for t in tree if not _is_placeholder_path(t.get('path', ''))
        )
        tree_was_truncated = bool(tree_resp.get('truncated'))

        # Bucketed selection: priority files first, then top-level code files.
        chosen_paths: list[str] = []
        for name in _PRIORITY_FILES:
            for t in tree:
                p = t['path']
                if p == name or p.endswith(f'/{name}'):
                    chosen_paths.append(p)
                    break
        for t in tree:
            p = t['path']
            if '/' not in p and p.endswith(_CODE_EXTS) and p not in chosen_paths:
                chosen_paths.append(p)
                if len(chosen_paths) >= 20:
                    break
        if len(chosen_paths) < 20:
            for t in tree:
                p = t['path']
                if p.startswith(('src/', 'backend/', 'frontend/src/', 'app/')) and p.endswith(_CODE_EXTS):
                    if p not in chosen_paths:
                        chosen_paths.append(p)
                        if len(chosen_paths) >= 30:
                            break

        for path in chosen_paths:
            if total >= _TOTAL_CHARS:
                break
            content = await _gh_get_text(
                client, f'{GITHUB_API}/repos/{repo}/contents/{path}', gh_token,
            )
            if content is None:
                continue
            truncated = False
            if len(content) > _PER_FILE_CHARS:
                content = content[:_PER_FILE_CHARS]
                truncated = True
            if total + len(content) > _TOTAL_CHARS:
                content = content[: max(0, _TOTAL_CHARS - total)]
                truncated = True
            files.append({'path': path, 'content': content, 'truncated': truncated})
            total += len(content)

    return {
        'repo': repo,
        'ref': ref,
        'default_branch': default_branch,
        'files': files,
        'file_count': len(files),
        'total_chars': total,
        # Tree-wide signals (authoritative, not limited by sampling).
        'tree_blob_count': len(tree),
        'code_blob_count': code_blob_count,
        'tree_truncated': tree_was_truncated,
    }


_SYSTEM_PROMPT = (
    "You are an expert senior code reviewer. Review the provided files from a "
    "real production repo and return STRICT JSON with the schema:\n"
    "{\n"
    '  "summary": "<one paragraph plain English>",\n'
    '  "verdict": "ship" | "ship_with_fixes" | "do_not_ship",\n'
    '  "findings": [\n'
    "     {\n"
    '       "severity": "high" | "medium" | "low",\n'
    '       "file": "<repo path>",\n'
    '       "line_hint": "<optional snippet or N/A>",\n'
    '       "title": "<short>",\n'
    '       "explanation": "<plain language>",\n'
    '       "suggested_fix": "<concrete code/config change>"\n'
    "     }\n"
    "  ],\n"
    '  "missing_files": ["<file the repo should have but lacks>"]\n'
    "}\n"
    "Focus on: correctness bugs, security holes (secrets, auth, injection), "
    "performance footguns, deployment-readiness, and missing essentials (env "
    "examples, README, build config). Be specific — name files, lines, and the "
    "exact change. Do NOT output anything except the JSON object."
)


_SECOND_OPINION_PROMPT = (
    "You are a second senior code reviewer auditing another AI's review of a "
    "production repo. Return STRICT JSON only:\n"
    "{\n"
    '  "verdict": "ship" | "ship_with_concerns" | "do_not_ship",\n'
    '  "summary": "<one-line>",\n'
    '  "concerns": ["<short>", ...]\n'
    "}\n"
    "Focus ONLY on what the first reviewer might have missed: hallucinated "
    "files, missing imports, security regressions, auth/payment misuse. Be "
    "concise — max 6 concerns. If you broadly agree, return `ship` with empty "
    "concerns. If the first reviewer marked do_not_ship, agree with them."
)


# Model used for the cross-AI second opinion. Defaults to the same
# proven-working model as the primary reviewer (Sonnet 4.5) — the old
# hardcoded "claude-opus-4-5" is NOT a real model name and the provider
# gateway rejected it ("Invalid model name passed in
# model=claude-opus-4-5"), which crashed every second-opinion pass.
# Operators can override this with a valid model id (Anthropic or, via the
# gateway, another provider) using the SECOND_OPINION_MODEL env var.
_SECOND_OPINION_MODEL = (
    os.environ.get('SECOND_OPINION_MODEL') or 'claude-sonnet-4-5-20250929'
)


async def _second_opinion(snapshot: dict, first_review: dict, llm_key: str) -> dict:
    """Run a DIFFERENT-provider reviewer (Claude) over the same snapshot
    + first reviewer's verdict. Cheap audit pass — catches hallucinations
    the primary GPT-4o reviewer might miss. Always returns a dict.
    """
    from llm_router import LlmChat, UserMessage

    blocks = [f"--- {f['path']} ---\n{f['content'][:6_000]}" for f in snapshot['files'][:20]]
    user_msg = (
        f"Repo: {snapshot.get('repo')}@{snapshot.get('ref')}\n"
        f"First reviewer (GPT-4o) verdict: {first_review.get('verdict')}\n"
        f"First reviewer summary: {(first_review.get('summary') or '')[:600]}\n\n"
        f"Files reviewed:\n" + "\n\n".join(blocks)
        + "\n\nReturn the second-opinion JSON now."
    )
    # Second opinion runs over the same snapshot + the first reviewer's
    # verdict. Uses a VALID model id (see _SECOND_OPINION_MODEL) — keeps the
    # pass on the operator's own Anthropic key when set.
    chat = LlmChat(
        api_key=llm_key,
        session_id=f'code-review-second-{datetime.now(timezone.utc).timestamp():.0f}',
        system_message=_SECOND_OPINION_PROMPT,
    ).with_model('anthropic', _SECOND_OPINION_MODEL)
    try:
        raw = await chat.send_message(UserMessage(text=user_msg))
    except Exception as e:
        return {'verdict': 'review_skipped', 'summary': f'Second-opinion failed: {str(e)[:200]}', 'concerns': [], 'reviewer_model': _SECOND_OPINION_MODEL}
    text = (raw or '').strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        try:
            parsed = json.loads(m.group(0)) if m else {}
        except Exception:
            parsed = {}
    return {
        'verdict': parsed.get('verdict') or 'review_skipped',
        'summary': (parsed.get('summary') or '')[:280],
        'concerns': [str(c)[:280] for c in (parsed.get('concerns') or [])][:8],
        'reviewer_model': _SECOND_OPINION_MODEL,
    }


async def run_code_review(project: dict, settings: dict) -> dict:
    """Fetch the repo snapshot, hand it to the LLM, parse JSON. Always returns
    a dict — even on parse failure we surface the raw text so the operator can
    still act on it."""
    from llm_router import LlmChat, UserMessage  # BYO Anthropic key when ANTHROPIC_API_KEY is set

    # Repo precondition — surface a clean 412 instead of letting the
    # downstream `fetch_repo_snapshot` hit GitHub with an empty path
    # (which used to return a confusing "Repo '' not found on GitHub").
    if not (project.get('repo') or '').strip():
        raise HTTPException(
            412,
            {
                'error': 'repo_not_configured',
                'message': (
                    "No GitHub repo configured for this project. "
                    "Open Operator Console → Settings → 'This app source' and "
                    "paste your repo in the form `owner/name`, then click Review again."
                ),
                'configure_url': '/operator?tab=settings#self-source',
            },
        )

    gh_token = (settings or {}).get('github_token') or os.environ.get('GITHUB_TOKEN')
    snapshot = await fetch_repo_snapshot(project['repo'], project.get('gitRef'), gh_token)
    if not snapshot['files']:
        raise HTTPException(502, f"Could not fetch any source files from {project['repo']}@{snapshot['ref']}")

    # FAST-PATH: detect empty / placeholder repo BEFORE we burn LLM credits.
    # A repo with just a README + maybe a LICENSE has nothing to review and
    # nothing to ship; the LLM was previously called twice in this case and
    # confidently said `do_not_ship`, which left the operator stuck in a
    # "fix → review → still empty → fix" loop that drained credits without
    # ever unblocking the deploy.
    #
    # We surface a dedicated `repo_empty` verdict so the frontend can show a
    # one-click "Push initial code" dialog instead of the generic fix/force
    # prompt — that's the action the operator actually needs.
    #
    # IMPORTANT: base this on the AUTHORITATIVE tree-wide `code_blob_count`
    # (computed over the entire GitHub tree), NOT on the small sampled
    # `snapshot['files']` subset. The old sample-based check produced false
    # `repo_empty` verdicts (e.g. "1 file sampled") whenever the bucketed
    # sampler happened to only pull a README, which then permanently blocked
    # deploys for a repo that actually had hundreds of source files.
    code_blob_count = snapshot.get('code_blob_count')
    if code_blob_count is None:
        # Defensive fallback for older snapshots: derive from the sample.
        code_blob_count = len(
            [f for f in snapshot['files'] if not _is_placeholder_path(f['path'])]
        )
    if code_blob_count == 0:
        review = {
            'summary': (
                f"Repository {project['repo']} has no source code yet — only documentation/config "
                f"placeholders ({snapshot['file_count']} file{'s' if snapshot['file_count'] != 1 else ''} sampled). "
                "Push your code first; nothing to deploy until then."
            ),
            'verdict': 'repo_empty',
            'findings': [{
                'severity': 'high',
                'file': project['repo'],
                'line_hint': 'N/A',
                'title': 'Repository has no source code',
                'explanation': (
                    'The cross-AI code reviewer cannot evaluate code that does not exist. '
                    'A README/LICENSE-only repo is treated as empty.'
                ),
                'suggested_fix': (
                    "Use the operator console's one-click 'Push initial code' button "
                    "(Operator → Ops → 'Initial push') to upload this app's current source "
                    "to the configured repo, then re-run Review."
                ),
            }],
            'missing_files': ['source files (package.json, requirements.txt, src/, backend/, …)'],
            'files_sampled': [f['path'] for f in snapshot['files']],
            'project_id': project['id'],
            'repo': project['repo'],
            'ref': snapshot['ref'],
            'reviewed_at': datetime.now(timezone.utc).isoformat(),
            'second_opinion': {
                'verdict': 'repo_empty',
                'summary': 'Skipped — nothing to second-review.',
                'concerns': [],
                'reviewer_model': 'skipped',
            },
            'can_auto_push': True,
        }
        await db.deploy_projects.update_one(
            {'id': project['id']},
            {'$set': {
                'last_code_review': review,
                'last_code_review_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc),
            }},
        )
        return review

    file_blocks = []
    for f in snapshot['files']:
        marker = '  [TRUNCATED]' if f['truncated'] else ''
        file_blocks.append(f"--- FILE: {f['path']}{marker} ---\n{f['content']}")
    prompt = (
        f"Repo: {project['repo']}\n"
        f"Branch: {snapshot['ref']}\n"
        f"Project name: {project.get('projectName', '(unnamed)')}\n"
        f"Domain: {project.get('domain', '(unset)')}\n"
        f"Files sampled: {snapshot['file_count']} ({snapshot['total_chars']} chars)\n\n"
        + '\n\n'.join(file_blocks)
        + '\n\nReturn the strict JSON review object now.'
    )

    # Pick whichever provider the operator actually has a key for (Anthropic,
    # OpenAI, Gemini, OpenRouter or Groq) so Code Review works with ANY key.
    from llm_router import resolve_text_model
    resolved = await resolve_text_model()
    if not resolved:
        raise HTTPException(
            503,
            'No AI provider key configured. Add an OpenAI, Anthropic, Gemini, '
            'OpenRouter or Groq key in Operator → My Keys.',
        )
    provider, model = resolved
    llm_key = ''  # legacy placeholder — llm_router resolves the provider key itself

    chat = LlmChat(
        api_key=llm_key,
        session_id=f'code-review-{project["id"]}',
        system_message=_SYSTEM_PROMPT,
    ).with_model(provider, model)  # uses whichever provider key the operator has

    try:
        raw = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        raise HTTPException(502, f'LLM error: {str(e)[:300]}')

    # Robust JSON parse: strip ```json fences if the model added them.
    text = (raw or '').strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```$', '', text)
    parsed: Optional[dict] = None
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None

    review = parsed or {
        'summary': 'LLM returned non-JSON output (shown below in raw_text).',
        'verdict': 'ship_with_fixes',
        'findings': [],
        'missing_files': [],
        'raw_text': text[:6000],
    }
    review['project_id'] = project['id']
    review['repo'] = project['repo']
    review['ref'] = snapshot['ref']
    review['files_sampled'] = [f['path'] for f in snapshot['files']]
    review['reviewed_at'] = datetime.now(timezone.utc).isoformat()

    # Cross-AI second opinion — Claude audits GPT-4o's verdict. Catches
    # hallucinations + security regressions the primary reviewer missed.
    # Escalation rule: if Claude says `do_not_ship`, we promote the verdict
    # to `do_not_ship` so the existing 412 ship-gate triggers automatically
    # (this is the operator-requested "gate the deploy button in chat"
    #  enforcement layer — same gate, two independent reviewers).
    snapshot_for_review = {**snapshot, 'repo': project['repo']}
    second = await _second_opinion(snapshot_for_review, review, llm_key)
    review['second_opinion'] = second
    if second.get('verdict') == 'do_not_ship' and review.get('verdict') != 'do_not_ship':
        review['verdict_promoted_by'] = 'second_opinion'
        review['verdict'] = 'do_not_ship'

    await db.deploy_projects.update_one(
        {'id': project['id']},
        {'$set': {
            'last_code_review': review,
            'last_code_review_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
        }},
    )
    return review


@ops_router.post('/{project_id}/code-review')
async def op_code_review(
    project_id: str,
    _user: dict = Depends(get_current_operator),
):
    """Run an AI code review on this project's repo."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    settings = await get_settings_doc()
    return await run_code_review(project, settings)


@projects_router.post('/{project_id}/code-review')
async def ai_code_review(
    project_id: str,
    settings: dict = Depends(_require_ai_api_key),
):
    """Bearer-auth twin used by autonomous agents to gate their own loop."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project and project_id == SELF_PROJECT_ID:
        project = await _ensure_self_project()
    if not project:
        raise HTTPException(404, 'Project not found')
    return await run_code_review(project, settings)
