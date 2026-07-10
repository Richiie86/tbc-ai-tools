"""Operator-managed shared AI learnings.

Every entry here is auto-appended to the chat `SYSTEM_PROMPT` so all
models (Claude / GPT / Gemini / etc.) share the same accumulated
knowledge. The operator can teach their AI new patterns at runtime —
no redeploy needed.

Examples of useful learnings:
  - "When users ask about deployment, ALWAYS point them to the Deploy
     button in the header. Never write Vercel/Heroku tutorials."
  - "Our brand voice is direct, confident, friendly — never apologise
     more than once."
  - "Default to Claude Sonnet for code, Gemini Flash for one-liners,
     GPT-4.1 for long reasoning."

Endpoints (all operator-only):
  GET    /api/operator/ai-learnings       — list (newest first)
  POST   /api/operator/ai-learnings       — create one
  PATCH  /api/operator/ai-learnings/{id}  — enable/disable or edit
  DELETE /api/operator/ai-learnings/{id}  — permanently delete
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-learnings', tags=['ai-learnings'])


class LearningIn(BaseModel):
    text: str = Field(min_length=4, max_length=1_500)
    enabled: bool = True


class LearningPatch(BaseModel):
    text: Optional[str] = Field(default=None, min_length=4, max_length=1_500)
    enabled: Optional[bool] = None


def _serialize(d: dict) -> dict:
    return {
        'id': d.get('id'),
        'text': d.get('text'),
        'enabled': bool(d.get('enabled', True)),
        'created_at': d['created_at'].isoformat() if d.get('created_at') else None,
        'updated_at': d['updated_at'].isoformat() if d.get('updated_at') else None,
        'created_by': d.get('created_by_email'),
        'source': d.get('source'),
        'source_error_id': d.get('source_error_id'),
        'auto_proposed': bool(d.get('auto_proposed', False)),
        'archived': bool(d.get('archived', False)),
    }


@router.get('')
async def list_learnings(
    include_archived: bool = False,
    _op: dict = Depends(get_current_operator),
):
    q: dict = {} if include_archived else {'archived': {'$ne': True}}
    docs = await db.ai_learnings.find(q).sort('created_at', -1).to_list(500)
    return [_serialize(d) for d in docs]


@router.post('', status_code=201)
async def add_learning(body: LearningIn, op: dict = Depends(get_current_operator)):
    doc = {
        'id': str(uuid.uuid4()),
        'text': body.text.strip(),
        'enabled': body.enabled,
        'created_at': datetime.now(timezone.utc),
        'updated_at': datetime.now(timezone.utc),
        'created_by_email': op.get('email'),
    }
    await db.ai_learnings.insert_one(doc)
    logger.info('Operator %s added AI learning: %s', op.get('email'), body.text[:80])
    return _serialize(doc)


@router.patch('/{learning_id}')
async def update_learning(
    learning_id: str,
    body: LearningPatch,
    _op: dict = Depends(get_current_operator),
):
    update: dict = {'updated_at': datetime.now(timezone.utc)}
    if body.text is not None:
        update['text'] = body.text.strip()
    if body.enabled is not None:
        update['enabled'] = body.enabled
    res = await db.ai_learnings.update_one({'id': learning_id}, {'$set': update})
    if res.matched_count == 0:
        raise HTTPException(404, 'Learning not found')
    fresh = await db.ai_learnings.find_one({'id': learning_id})
    return _serialize(fresh)


@router.delete('/{learning_id}')
async def delete_learning(learning_id: str, _op: dict = Depends(get_current_operator)):
    res = await db.ai_learnings.delete_one({'id': learning_id})
    if res.deleted_count == 0:
        raise HTTPException(404, 'Learning not found')
    return {'deleted': learning_id}


# ---------- Auto-archive garbage collection ----------

GC_DAYS_DEFAULT = 14


async def archive_stale_proposals(days: int = GC_DAYS_DEFAULT) -> dict:
    """Soft-archive auto-proposed learnings that the operator never
    approved (still `enabled=false, auto_proposed=true`) within `days`.

    Archive vs delete: we mark them `archived=true` instead of removing
    so the audit trail (e.g. "this error was proposed as a learning and
    the operator chose not to approve") remains queryable. The default
    list endpoint omits archived items.

    Called from the APScheduler job in server.py and also exposed at
    POST /api/operator/ai-learnings/gc for ad-hoc operator-triggered runs.
    """
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, int(days)))
    res = await db.ai_learnings.update_many(
        {
            'enabled': False,
            'auto_proposed': True,
            'archived': {'$ne': True},
            'created_at': {'$lt': cutoff},
        },
        {'$set': {'archived': True, 'archived_at': datetime.now(timezone.utc)}},
    )
    return {'archived_count': int(res.modified_count), 'cutoff': cutoff.isoformat()}


@router.post('/gc')
async def gc(days: int = GC_DAYS_DEFAULT, _op: dict = Depends(get_current_operator)):
    """Operator-triggered manual garbage collection — useful for testing."""
    return await archive_stale_proposals(days=days)


# ---------- Weekly insight digest ----------

@router.get('/digest')
async def digest(
    weeks: int = 1,
    _op: dict = Depends(get_current_operator),
):
    """Markdown digest of every learning added in the last `weeks` weeks,
    grouped by activity. Used by the AI Learnings tab "Generate digest"
    button so the operator gets a one-paragraph personality changelog for
    sharing / archiving.

    Uses any configured small/fast LLM to summarise — falls back to a
    deterministic bullet list if no provider is reachable so the endpoint
    never fails in CI.
    """
    from datetime import timedelta
    import os
    weeks = max(1, min(int(weeks), 12))
    cutoff = datetime.now(timezone.utc) - timedelta(weeks=weeks)
    docs = await db.ai_learnings.find(
        {'created_at': {'$gte': cutoff}},
    ).sort('created_at', -1).to_list(500)

    if not docs:
        return {
            'weeks': weeks,
            'count': 0,
            'markdown': f'_No learnings added in the last {weeks} week{"s" if weeks > 1 else ""}._',
            'fallback': False,
        }

    bullets = '\n'.join(f'- {d.get("text", "").strip()}' for d in docs)
    api_key = ''  # legacy placeholder — llm_router uses the provider key
    try:
        from llm_router import (
            LlmChat, UserMessage, TextDelta, StreamDone, ordered_text_models,
        )
        chain = await ordered_text_models()
        if not chain:
            return {
                'weeks': weeks,
                'count': len(docs),
                'markdown': f'## AI personality changelog — last {weeks} week(s)\n\n{bullets}',
                'fallback': True,
            }
        provider, model = chain[-1] if len(chain) > 1 else chain[0]
        chat = LlmChat(
            api_key=api_key,
            session_id=f'digest-{uuid.uuid4()}',
            system_message=(
                'You are a concise editor. Summarise a list of newly-taught '
                'AI rules into a short markdown digest the operator can share. '
                'Keep it under 250 words. Use "## What your AI learned this week" '
                'as the H2 title, then 2-3 thematic sub-bullets.'
            ),
        ).with_model(provider, model)
        full = ''
        async for ev in chat.stream_message(UserMessage(text=(
            f'These are the {len(docs)} new learnings approved in the last '
            f'{weeks} week(s):\n\n{bullets}\n\nSummarise.'
        ))):
            if isinstance(ev, TextDelta):
                full += ev.content
            elif isinstance(ev, StreamDone):
                break
        return {
            'weeks': weeks,
            'count': len(docs),
            'markdown': full.strip() or f'## AI personality changelog\n\n{bullets}',
            'fallback': False,
        }
    except Exception as e:
        logger.warning('Digest LLM failed (%s) — using deterministic fallback', e)
        return {
            'weeks': weeks,
            'count': len(docs),
            'markdown': f'## AI personality changelog — last {weeks} week(s)\n\n{bullets}',
            'fallback': True,
        }
