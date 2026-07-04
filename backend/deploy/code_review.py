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


def _extract_json(text: str) -> Optional[dict]:
    """Best-effort parse of an LLM response into a dict.

    Handles the real-world ways models break strict-JSON instructions:
      * ```json fenced blocks (anywhere, not just at the very start/end)
      * leading/trailing prose ("Here is the review: { ... } Hope this helps")
      * TRUNCATED output (response cut off by max_tokens mid-object) — we
        balance the braces and close any dangling string so we still recover
        summary + verdict + whatever findings arrived.
      * trailing commas before } or ]

    Returns a dict on success, or None if nothing usable could be recovered.
    """
    if not text:
        return None
    t = text.strip()
    if '```' in t:
        t = re.sub(r'```[a-zA-Z]*\n?', '', t).replace('```', '').strip()
    # Fast path: already valid JSON.
    try:
        obj = json.loads(t)
        return obj if isinstance(obj, dict) else None
    except Exception:  # noqa: BLE001
        pass
    start = t.find('{')
    if start == -1:
        return None
    # Scan for the matching close brace, respecting string literals/escapes,
    # while keeping a stack of open delimiters so we can repair truncated
    # output by closing them in the correct nesting order.
    stack: list[str] = []
    in_str = False
    esc = False
    end = -1
    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in '{[':
            stack.append(ch)
        elif ch in '}]':
            if stack:
                stack.pop()
            if not stack:
                end = i
                break
    candidate = t[start:end + 1] if end != -1 else t[start:]

    def _try(s: str) -> Optional[dict]:
        try:
            obj = json.loads(s)
            return obj if isinstance(obj, dict) else None
        except Exception:  # noqa: BLE001
            return None

    got = _try(candidate)
    if got is not None:
        return got
    # Strip trailing commas and retry.
    got = _try(re.sub(r',\s*([}\]])', r'\1', candidate))
    if got is not None:
        return got
    # Truncation repair: close a dangling string, drop a trailing partial
    # key/comma, then close every still-open delimiter in reverse order.
    if end == -1 and stack:
        repaired = candidate
        if in_str:
            repaired += '"'
        repaired = re.sub(r',\s*$', '', repaired.rstrip())
        closers = {'{': '}', '[': ']'}
        for opener in reversed(stack):
            repaired = re.sub(r',\s*$', '', repaired.rstrip())
            repaired += closers[opener]
        repaired = re.sub(r',\s*([}\]])', r'\1', repaired)
        got = _try(repaired)
        if got is not None:
            return got
    return None


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
    "exact change. Do NOT output anything except the JSON object.\n\n"
    "IMPORTANT REVIEW RULES — avoid these false positives:\n"
    "1. The files below are a SIZE-LIMITED SNAPSHOT. Each file is sampled and "
    "may be cut off; a block ending with the marker '[TRUNCATED]' means the "
    "SNAPSHOT was clipped for length, NOT that the source file is incomplete, "
    "broken, or ends mid-function. NEVER report truncation, a file 'ending "
    "mid-function', or 'unable to verify because the file is cut off' as a "
    "finding — it is an artifact of sampling, not a code defect.\n"
    "2. Do NOT flag AI/LLM model identifier strings (e.g. names like "
    "'claude-sonnet-4-5-20250929', 'gpt-4o', or other dated model ids) as "
    "'invalid', 'non-existent', or 'hallucinated'. You do not have the "
    "provider's current model catalog; newer or date-versioned model names are "
    "frequently valid. Only comment on model usage if the CODE clearly "
    "mishandles it (e.g. an obvious empty string), never on the name itself.\n"
    "3. Files under test/, tests/, or named *_test.py / test_*.py are TEST "
    "code, not production runtime. Do not treat literals there as production "
    "secrets when they are read from environment variables or are obvious "
    "placeholders."
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
    "concerns. If the first reviewer marked do_not_ship, agree with them.\n\n"
    "Do NOT raise concerns based on snapshot truncation ('[TRUNCATED]' means "
    "the sample was clipped for length, not that the file is broken), on AI "
    "model identifier names being 'invalid/non-existent' (you lack the "
    "provider's live catalog), or on literals in test files that are read from "
    "environment variables."
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
        max_tokens=2048,
    ).with_model('anthropic', _SECOND_OPINION_MODEL)
    try:
        raw = await chat.send_message(UserMessage(text=user_msg))
    except Exception as e:
        return {'verdict': 'review_skipped', 'summary': f'Second-opinion failed: {str(e)[:200]}', 'concerns': [], 'reviewer_model': _SECOND_OPINION_MODEL}
    parsed = _extract_json(raw or '') or {}
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

    # Give the reviewer enough output budget to return a full JSON findings
    # array. The old 4096 default truncated the response mid-object on any
    # non-trivial repo, so json.loads failed and we fell back to the
    # "LLM returned non-JSON output" path — which then got hard-gated to
    # do_not_ship by the second opinion. 8192 comfortably fits the schema.
    chat = LlmChat(
        api_key=llm_key,
        session_id=f'code-review-{project["id"]}',
        system_message=_SYSTEM_PROMPT,
        max_tokens=8192,
    ).with_model(provider, model)  # uses whichever provider key the operator has

    try:
        raw = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        raise HTTPException(502, f'LLM error: {str(e)[:300]}')

    # Robust JSON parse: tolerates code fences, surrounding prose, trailing
    # commas, and truncated output (see _extract_json).
    text = (raw or '').strip()
    parsed = _extract_json(text)
    parse_ok = parsed is not None

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
    # Escalate to do_not_ship only when the PRIMARY review actually parsed.
    # If the primary reviewer's JSON could not be recovered, its verdict is a
    # placeholder ("ship_with_fixes" fallback) — letting the second opinion
    # hard-gate on top of an unparseable review was exactly what left the
    # Deploy button permanently blocked. In that case we surface a distinct
    # `review_incomplete` verdict so the operator can retry or force-deploy
    # instead of being stuck.
    if not parse_ok:
        review['verdict'] = 'review_incomplete'
        review['review_incomplete'] = True
    elif second.get('verdict') == 'do_not_ship' and review.get('verdict') != 'do_not_ship':
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
