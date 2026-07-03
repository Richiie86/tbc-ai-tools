"""AI Improvement Suggestions — proactive code-improvement proposals.

What it does
------------
The operator asked for "AIs that suggest improvements like you do as I
code". This module gives every project a `/suggestions` endpoint that:

  1. Samples the repo (reuses `fetch_repo_snapshot` from
     `deploy.code_review`).
  2. Asks GPT-4o to play "senior staff engineer doing a casual code
     review" and produce 3–5 short, actionable suggestions with a
     priority dot (high/medium/low) and a 1-paragraph prompt the AI
     Build pipeline can use to implement the suggestion.
  3. Returns a strict JSON list so the UI can render coloured-dot cards
     with a one-click "Implement this" button → POST to
     `/api/operator/ai-build/plan` with the suggestion as the prompt.

This is intentionally *separate* from the code review:
- Code review = "is this safe to ship right now?" (gate)
- Suggestions = "what could we improve next?" (growth)

Both share the snapshot logic so credits don't double-bill.

Costs / safety
--------------
- One GPT-4o call per click, ≤ ~4 KB context (suggestion list, not full
  diffs).
- Operator-only endpoint.
- Cached per repo+ref for 30 minutes so refreshing the tab doesn't
  re-bill.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/deploy', tags=['deploy-suggestions'])


_SYSTEM_PROMPT = (
    "You are a senior staff engineer doing a friendly, forward-looking code review. "
    "The repo is shipping; you're not gating it — you're suggesting 3–5 high-impact "
    "improvements the team could pick up next. Be opinionated, specific, and concise. "
    "Avoid generic advice ('add tests', 'improve docs') — call out actual files or "
    "patterns you noticed in the sampled code.\n\n"
    "Return STRICT JSON only:\n"
    "{\n"
    '  "summary": "<one sentence: how is the codebase doing overall?>",\n'
    '  "suggestions": [\n'
    '    {\n'
    '      "priority": "high" | "medium" | "low",\n'
    '      "title": "<6-12 word headline>",\n'
    '      "rationale": "<2-3 sentences: why this matters, what you noticed>",\n'
    '      "files": ["<path or glob, max 3>"],\n'
    '      "implementation_prompt": "<a self-contained 2-4 sentence prompt the AI Build pipeline can feed straight to the planner — describe the change like a JIRA ticket. No filler words.>",\n'
    '      "effort": "small" | "medium" | "large"\n'
    '    }\n'
    '  ]\n'
    "}\n"
    "Caps: max 5 suggestions, each title ≤ 80 chars, each rationale ≤ 320 chars, "
    "each implementation_prompt ≤ 480 chars. At least one suggestion MUST be "
    "priority='high' or you've failed the assignment."
)


def _parse_json(text: str) -> dict:
    """Best-effort JSON extraction (strips ```json fences, scrapes braces).

    The vision/text models occasionally wrap their JSON in markdown fences
    even when the prompt says STRICT JSON. We strip those and, if that
    still fails, fall back to a greedy `{.*}` regex.
    """
    text = (text or '').strip()
    text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
    text = re.sub(r'\n?```$', '', text)
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return {}
        return {}


def _coerce_suggestions(parsed: dict) -> dict:
    """Normalise the LLM output. Drops anything outside the schema so the
    UI never has to defensively check shapes."""
    raw_list = parsed.get('suggestions') if isinstance(parsed, dict) else None
    if not isinstance(raw_list, list):
        raw_list = []
    out: list[dict] = []
    for s in raw_list[:5]:
        if not isinstance(s, dict):
            continue
        priority = (s.get('priority') or 'medium').lower()
        if priority not in ('high', 'medium', 'low'):
            priority = 'medium'
        effort = (s.get('effort') or 'medium').lower()
        if effort not in ('small', 'medium', 'large'):
            effort = 'medium'
        files = s.get('files') or []
        if not isinstance(files, list):
            files = []
        out.append({
            'priority': priority,
            'title': str(s.get('title') or 'Untitled suggestion')[:120],
            'rationale': str(s.get('rationale') or '')[:480],
            'files': [str(f)[:200] for f in files][:5],
            'implementation_prompt': str(s.get('implementation_prompt') or '')[:600],
            'effort': effort,
        })
    return {
        'summary': str((parsed or {}).get('summary') or '')[:320],
        'suggestions': out,
    }


@router.post('/{project_id}/suggestions')
async def run_suggestions(
    project_id: str, op: dict = Depends(get_current_operator),
):
    """Generate (or return cached) AI improvement suggestions for this
    deploy project. Cached per repo+ref for 30 minutes."""
    project = await db.deploy_projects.find_one({'id': project_id})
    if not project:
        raise HTTPException(404, 'Project not found')
    repo = (project.get('repo') or '').strip()
    if not repo:
        raise HTTPException(412, 'Project has no GitHub repo configured.')

    settings = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    from llm_router import _openai_key
    llm_key = ''  # legacy placeholder — llm_router uses the provider key
    if not await _openai_key():
        raise HTTPException(503, 'No OpenAI API key configured (Operator → Security).')
    gh_token = settings.get('github_token') or os.environ.get('GITHUB_TOKEN')

    # 30-minute cache — same key shape as the code review module so
    # operators don't re-bill on tab refreshes.
    cached = project.get('last_suggestions')
    if cached and cached.get('ref') == (project.get('gitRef') or 'main'):
        ts = cached.get('reviewed_at')
        try:
            stamp = datetime.fromisoformat(ts) if isinstance(ts, str) else ts
            if stamp and (datetime.now(timezone.utc) - stamp.replace(tzinfo=stamp.tzinfo or timezone.utc)) < timedelta(minutes=30):
                return cached
        except Exception:
            pass  # bad cache → fall through to fresh fetch

    # Reuse the same repo snapshot logic the code review uses — exactly
    # one source of truth for "what files do we look at".
    from deploy.code_review import fetch_repo_snapshot
    from llm_router import LlmChat, UserMessage
    snapshot = await fetch_repo_snapshot(repo, project.get('gitRef'), gh_token)
    if not snapshot['files']:
        raise HTTPException(502, f"Could not sample repo {repo}@{snapshot['ref']}")

    # Keep the payload small — suggestions only need a directory map +
    # the first few KB of each notable file, not full source.
    file_lines = []
    for f in snapshot['files'][:25]:
        head = (f.get('content') or '')[:1500]
        file_lines.append(f"--- {f['path']} ({len(f.get('content') or '')} bytes) ---\n{head}")
    context = '\n\n'.join(file_lines)

    chat = LlmChat(
        api_key=llm_key,
        session_id=f'suggestions-{project_id}-{datetime.now(timezone.utc).timestamp():.0f}',
        system_message=_SYSTEM_PROMPT,
    ).with_model('openai', 'gpt-4o')
    msg = UserMessage(text=(
        f"Repo: {repo}\nBranch: {snapshot['ref']}\n"
        f"Files sampled: {snapshot['file_count']}\n\n"
        f"{context}\n\n"
        f"Project name (operator-facing): {project.get('projectName') or 'this app'}\n"
        f"Return your STRICT JSON suggestions now."
    ))
    try:
        raw = await chat.send_message(msg)
    except Exception as e:
        logger.warning('Suggestions LLM failed for %s: %s', repo, e)
        raise HTTPException(502, f'Suggestion model failed: {str(e)[:200]}') from e

    parsed = _parse_json(raw or '')
    body = _coerce_suggestions(parsed)
    out = {
        **body,
        'project_id': project_id,
        'repo': repo,
        'ref': snapshot['ref'],
        'reviewer_model': 'gpt-4o',
        'files_sampled': [f['path'] for f in snapshot['files']],
        'reviewed_at': datetime.now(timezone.utc).isoformat(),
    }
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'last_suggestions': out, 'updated_at': datetime.now(timezone.utc)}},
    )
    return out


@router.get('/{project_id}/suggestions')
async def get_suggestions(
    project_id: str, op: dict = Depends(get_current_operator),
):
    """Read the cached suggestions — no LLM call. Returns 204 shape
    (`{suggestions: []}`) if none have ever been generated."""
    project = await db.deploy_projects.find_one(
        {'id': project_id}, {'last_suggestions': 1},
    )
    if not project:
        raise HTTPException(404, 'Project not found')
    return project.get('last_suggestions') or {
        'suggestions': [], 'summary': '', 'reviewed_at': None,
    }
