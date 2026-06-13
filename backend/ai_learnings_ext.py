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
    }


@router.get('')
async def list_learnings(_op: dict = Depends(get_current_operator)):
    docs = await db.ai_learnings.find({}).sort('created_at', -1).to_list(200)
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

    Uses a small LLM call (Gemini Flash via Emergent Universal Key) to
    summarise — falls back to a deterministic bullet list if the LLM is
    unreachable so the endpoint never fails in CI.
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
    api_key = os.environ.get('EMERGENT_LLM_KEY') or ''
    if not api_key:
        # Deterministic fallback — keep the endpoint useful even without
        # the LLM key configured (e.g. CI).
        return {
            'weeks': weeks,
            'count': len(docs),
            'markdown': f'## AI personality changelog — last {weeks} week(s)\n\n{bullets}',
            'fallback': True,
        }
    try:
        from emergentintegrations.llm.chat import (
            LlmChat, UserMessage, TextDelta, StreamDone,
        )
        chat = LlmChat(
            api_key=api_key,
            session_id=f'digest-{uuid.uuid4()}',
            system_message=(
                'You are a concise editor. Summarise a list of newly-taught '
                'AI rules into a short markdown digest the operator can share. '
                'Keep it under 250 words. Use "## What your AI learned this week" '
                'as the H2 title, then 2-3 thematic sub-bullets.'
            ),
        ).with_model('gemini', 'gemini-3-flash-preview')
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
