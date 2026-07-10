"""AI coding assistant for the Operator Sandbox tab.

Lets the operator type a natural-language instruction (e.g. "add a
dark-mode toggle to this component"), pick an LLM, optionally include
multiple files as context, and receive a structured JSON envelope of
proposed file edits. The operator reviews the diff and clicks Apply —
we then call the existing `PUT /api/operator/self/file` once per file
to commit the edits to GitHub (which the existing webhook auto-deploys).

Endpoints (all operator-only):

  POST /api/operator/sandbox/ai/propose
      body: {
        instruction: str,           # what the AI should do
        files: [{ path, content }], # context the AI can edit
        model: 'claude-sonnet-4-6' | 'gpt-5.4' | 'gemini-3.1-pro-preview',
        edit_mode: 'single' | 'multi',  # caps the proposal scope
        project_id?: str,           # optional — for session re-use
      }
      returns: {
        files: [{ path, new_content, reason }],
        notes: str,
        model: str,
        session_id: str,
      }

  GET  /api/operator/sandbox/ai/sessions
       List the operator's recent proposals so they can revisit prior
       suggestions without re-prompting.

  PATCH /api/operator/deploy/{project_id}/ai-edit-mode
        Save the per-project edit mode (single|multi) so the Sandbox UI
        remembers the operator's preference per project.

Storage: each proposal is appended to `sandbox_ai_sessions` keyed by
`(operator_id, session_id)`. We DON'T store the full file bodies (only
the diffs + reasons + token usage) — the operator's GitHub repo remains
the source of truth.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/sandbox/ai', tags=['sandbox-ai'])

# Whitelist of models surfaced in the dropdown. Anything else 400s — keeps
# the operator from pasting a random model id that the universal key
# doesn't cover. `(provider, model_id, display_name)`.
SUPPORTED_MODELS: list[tuple[str, str, str]] = [
    ('anthropic', 'claude-sonnet-4-6',      'Claude Sonnet 4.6 (best for code)'),
    ('anthropic', 'claude-opus-4-7',        'Claude Opus 4.7 (deepest reasoning)'),
    ('openai',    'gpt-5.4',                'GPT-5.4 (OpenAI default)'),
    ('openai',    'gpt-5.4-mini',           'GPT-5.4 mini (fast/cheap)'),
    ('gemini',    'gemini-3.1-pro-preview', 'Gemini 3.1 Pro (Google)'),
    ('gemini',    'gemini-3-flash-preview', 'Gemini 3 Flash (fastest)'),
    ('openrouter', 'anthropic/claude-sonnet-4', 'Claude Sonnet 4 (OpenRouter)'),
    ('openrouter', 'openai/gpt-4o-mini', 'GPT-4o Mini (OpenRouter)'),
    ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B (Groq)'),
]
_MODEL_MAP = {m: (p, display) for p, m, display in SUPPORTED_MODELS}

SYSTEM_PROMPT = """You are an expert coding assistant embedded inside an in-app sandbox.
The operator gives you a natural-language instruction and one or more files. \
You must reply with a SINGLE valid JSON object — no prose before or after — \
matching this exact schema:

{
  "notes": "<one-sentence summary of what you changed>",
  "files": [
    {
      "path": "<path of a provided file to edit, OR a brand-new file path to create>",
      "new_content": "<FULL file contents, not a diff>",
      "reason": "<one sentence explaining the change>"
    }
  ]
}

Rules:
1. You may BOTH edit the files provided in the context AND create brand-new
   files when the instruction needs them (e.g. a new page, component, route,
   model, or helper). To create a file, add an entry whose `path` is the new
   file's full repo-relative path (e.g. "frontend/src/pages/Foo.jsx" or
   "backend/foo_ext.py") with its COMPLETE contents in `new_content`. Only
   return `files: []` when the instruction genuinely requires no code change
   (then explain why in `notes`).
2. When you create a new file, also EDIT whatever existing file must reference
   it so the feature is actually wired up and works end-to-end — e.g. add the
   import + route in the app's router, register a new FastAPI router in
   server.py, or add the nav link. A new file that nothing imports is a bug.
   Include those wiring edits in the same `files` array. If a file you must
   wire into was NOT provided in the context, say so clearly in `notes` so it
   can be included on the next pass, and still return the new file(s).
3. ALWAYS return the COMPLETE file content for every file you create or touch —
   never a diff, never a snippet. The system writes each file as-is.
4. If an existing file doesn't need to change, OMIT it from the `files` array.
5. Preserve existing imports / exports / public APIs unless explicitly told otherwise.
6. Match the existing code style (indentation, quote marks, semicolons).
7. Do NOT include backticks, ```json fences, or any commentary outside the JSON.
8. This codebase IS the TBCTools platform (repo Richiie86/tbc-ai-tools — a React
   frontend on Vercel + a FastAPI backend on Render + MongoDB), live at
   tbctools.org. Apps users deploy from a chat are SEPARATE projects on their
   own domains (e.g. tbcdomain.com); a 404 there is that separate app, not this
   platform.
9. When the instruction is a runtime error, failed deploy, 404 / "Project not
   found", or missing config, your job is to produce the actual CODE FIX (edit
   the files), NOT to echo back a checklist of manual steps for a human to
   perform. Deploy/config remediation is automated elsewhere — you fix code. If
   the fix truly needs no code change, return `files: []` and say so in one line.
"""


# ---------- Models ---------------------------------------------------
class FileCtx(BaseModel):
    path: str
    content: str = Field(default='', max_length=200_000)


class ProposeBody(BaseModel):
    instruction: str = Field(min_length=2, max_length=8_000)
    files: list[FileCtx] = Field(default_factory=list, max_length=12)
    model: str = Field(default='claude-sonnet-4-6')
    edit_mode: Literal['single', 'multi'] = 'single'
    project_id: Optional[str] = None
    session_id: Optional[str] = None


class EditModeBody(BaseModel):
    ai_edit_mode: Literal['single', 'multi']


# ---------- Helpers --------------------------------------------------
def _strip_json_envelope(text: str) -> str:
    """Best-effort extraction of the JSON object the model was asked to
    return. Some models still wrap in ```json fences despite the system
    prompt — we strip those and take the first balanced {...} block."""
    s = text.strip()
    # Strip ```json … ``` fences if present.
    if s.startswith('```'):
        s = re.sub(r'^```(?:json)?\s*', '', s)
        if s.endswith('```'):
            s = s[: -3]
        s = s.strip()
    # Find the first balanced JSON object.
    start = s.find('{')
    if start < 0:
        return s
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
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
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return s[start: i + 1]
    return s[start:]


async def _record_session(operator: dict, session_id: str, body: ProposeBody,
                          result: dict, raw_len: int) -> None:
    await db.sandbox_ai_sessions.insert_one({
        'id': str(uuid.uuid4()),
        'session_id': session_id,
        'operator_id': operator.get('sub'),
        'operator_email': operator.get('email'),
        'project_id': body.project_id,
        'model': body.model,
        'edit_mode': body.edit_mode,
        'instruction': body.instruction[:2_000],
        'files_in': [f.path for f in body.files],
        'files_out': [f['path'] for f in result.get('files', [])],
        'notes': result.get('notes', '')[:2_000],
        'raw_response_bytes': raw_len,
        'created_at': datetime.now(timezone.utc),
    })


# ---------- Endpoints ------------------------------------------------
@router.get('/models')
async def list_models(_op: dict = Depends(get_current_operator)):
    """Return the dropdown options — used by the SandboxTab model picker."""
    from llm_router import available_providers
    configured = await available_providers()
    models = [
        {'id': m, 'provider': p, 'display': d}
        for (p, m, d) in SUPPORTED_MODELS
        if not configured or p in configured
    ]
    return {
        'default': models[0]['id'] if models else 'claude-sonnet-4-6',
        'models': models,
    }


@router.post('/propose')
async def propose(body: ProposeBody, op: dict = Depends(get_current_operator)):
    if body.model not in _MODEL_MAP:
        raise HTTPException(400, f'Unsupported model: {body.model}')
    if not body.files:
        raise HTTPException(400, 'Provide at least one file as context')
    # Enforce single-file mode.
    if body.edit_mode == 'single' and len(body.files) > 1:
        raise HTTPException(400, 'edit_mode=single but multiple files provided — switch to multi')

    from llm_router import available_providers
    api_key = ''  # legacy placeholder — llm_router uses per-provider keys
    configured = await available_providers()
    if not configured:
        raise HTTPException(503, 'No AI provider key is configured on the backend (Operator → My Keys).')

    # Build the prompt — the model sees the instruction first, then each
    # file body fenced with the path so it can reference them by name.
    parts = [f'INSTRUCTION:\n{body.instruction.strip()}\n']
    if body.edit_mode == 'single':
        parts.append('EDIT MODE: single — only the file below may be modified.')
    else:
        parts.append(f'EDIT MODE: multi — you may modify ANY of the {len(body.files)} files below.')
    for f in body.files:
        parts.append(f'\n--- FILE: {f.path} ---\n{f.content}')
    user_text = '\n'.join(parts)

    session_id = body.session_id or str(uuid.uuid4())
    provider, _ = _MODEL_MAP[body.model]
    if provider not in configured:
        raise HTTPException(503, f'{provider} key is not configured. Add it in Operator → My Keys or pick a configured model.')
    # Lazy import — keeps provider SDKs out of the import path when unused.
    from llm_router import LlmChat, UserMessage
    chat = LlmChat(
        api_key=api_key,
        session_id=f'sandbox-ai:{session_id}',
        system_message=SYSTEM_PROMPT,
    ).with_model(provider, body.model)

    try:
        # Non-streaming here — we need the full JSON envelope before we
        # can render the diff anyway. (Streaming a partial JSON is more
        # trouble than it's worth for this UX.)
        raw = await chat.send_message(UserMessage(text=user_text))
    except Exception as e:
        logger.warning('LLM call failed (model=%s): %s', body.model, e)
        raise HTTPException(502, f'LLM error: {e}') from e

    raw_text = raw if isinstance(raw, str) else getattr(raw, 'text', '') or str(raw)
    clean = _strip_json_envelope(raw_text)
    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError as e:
        logger.warning('LLM returned non-JSON: %s | head=%r', e, raw_text[:300])
        raise HTTPException(
            502,
            'The model did not return valid JSON. Try again, or pick a different model.',
        )

    # Light validation so we don't write garbage to GitHub on Apply.
    files_out: list[dict] = []
    valid_paths = {f.path for f in body.files}
    for entry in parsed.get('files', []) or []:
        p = (entry.get('path') or '').strip()
        nc = entry.get('new_content')
        if not p or nc is None:
            continue
        if p not in valid_paths and body.edit_mode == 'single':
            logger.info('LLM tried to edit out-of-scope path %r in single-file mode — dropping', p)
            continue
        files_out.append({
            'path': p,
            'new_content': nc if isinstance(nc, str) else str(nc),
            'reason': (entry.get('reason') or '').strip()[:500],
        })

    result = {
        'session_id': session_id,
        'model': body.model,
        'notes': (parsed.get('notes') or '').strip()[:1_000],
        'files': files_out,
    }
    await _record_session(op, session_id, body, result, len(raw_text))
    return result


@router.get('/sessions')
async def list_sessions(
    project_id: Optional[str] = None,
    limit: int = 20,
    _op: dict = Depends(get_current_operator),
):
    """Recent proposals — newest first, optionally filtered by project."""
    query: dict = {}
    if project_id:
        query['project_id'] = project_id
    cursor = db.sandbox_ai_sessions.find(query).sort('created_at', -1).limit(min(limit, 50))
    out = []
    async for d in cursor:
        out.append({
            'id': d.get('id'),
            'session_id': d.get('session_id'),
            'project_id': d.get('project_id'),
            'model': d.get('model'),
            'edit_mode': d.get('edit_mode'),
            'instruction': d.get('instruction'),
            'files_in': d.get('files_in', []),
            'files_out': d.get('files_out', []),
            'notes': d.get('notes'),
            'created_at': d.get('created_at').isoformat() if d.get('created_at') else None,
        })
    return out


# ---------- Per-project edit mode persistence ------------------------
proj_router = APIRouter(prefix='/api/operator/deploy', tags=['sandbox-ai'])


@proj_router.patch('/{project_id}/ai-edit-mode')
async def set_edit_mode(
    project_id: str,
    body: EditModeBody,
    _op: dict = Depends(get_current_operator),
):
    res = await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {'ai_edit_mode': body.ai_edit_mode,
                  'updated_at': datetime.now(timezone.utc)}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, 'Project not found')
    return {'project_id': project_id, 'ai_edit_mode': body.ai_edit_mode}
