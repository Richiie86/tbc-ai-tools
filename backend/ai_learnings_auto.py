"""Auto-self-learning for the chat AI.

After each chat reply, this module asks a small/fast LLM to scan the
recent conversation and extract any *pattern the AI should remember
next time* — typically when the user corrected the AI's response.
Proposals are persisted to `ai_learnings` with `enabled=False` +
`auto_proposed=True` so the operator must approve them via the
Operator Console → AI Learnings tab before they go live.

Sampling: only ~20% of replies trigger an extraction (cheap LLM
calls, but they add up). The threshold is `AI_AUTOLEARN_SAMPLE` env
var (default 0.2).

Safety:
  - Proposals are NEVER auto-enabled — operator review is mandatory.
  - Duplicate-suppressed: we hash the proposal text and skip inserts
    if an identical learning already exists.
  - Cap at 1k chars per learning to prevent prompt-flooding attacks.
"""
import hashlib
import logging
import os
import random
import uuid
from datetime import datetime, timezone

from db import db

logger = logging.getLogger('tbc')

_SAMPLE_RATE = float(os.environ.get('AI_AUTOLEARN_SAMPLE', '0.2'))
_MAX_LEARNING_CHARS = 1_000

EXTRACTOR_PROMPT = """You are watching a chat between a user and an AI assistant.
Your job: in ONE short sentence (≤ 30 words), extract any pattern the AI assistant
should remember for next time.

Only return a learning IF:
  - The user corrected the AI ("no, do X instead", "stop writing tutorials", etc.)
  - The user asked the AI to permanently change a behaviour
  - The user revealed a recurring preference (brand voice, default model, etc.)

If NONE of those apply, return EXACTLY: NO_LEARNING

Otherwise return ONLY the one-sentence learning, no quotes, no preamble.

Example outputs:
  - When the user asks to deploy, always nudge them to the Deploy button instead of writing a tutorial.
  - Use Swedish quotes (« ») for direct quotations.
  - NO_LEARNING
"""


async def propose_learning_from_session(
    session_id: str,
    history: list[dict],
    api_key: str,
    chat_model: str | None = None,
) -> None:
    """Background task — never raises.

    `chat_model` is the model the *user* was talking to when the learning
    surfaced. Stored on the proposal so the AI Brain tab can group
    learnings by model and render per-model maturity.
    """
    try:
        if not api_key:
            return
        if random.random() > _SAMPLE_RATE:
            return
        # Trim history to last 6 turns for cost control.
        recent = history[-6:]
        if len(recent) < 2:
            return  # not enough conversation to learn from
        convo_text = '\n'.join(
            f"[{m.get('role', '?')}]: {(m.get('content') or '')[:1000]}"
            for m in recent
        )
        # Use a cheap/fast model regardless of which one the user picked
        # for the main conversation — the operator pays once per main
        # reply, NOT once per extraction.
        from llm_router import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            session_id=f'autolearn:{session_id}',
            system_message=EXTRACTOR_PROMPT,
        ).with_model('gemini', 'gemini-3-flash-preview')
        raw = await chat.send_message(UserMessage(text=convo_text))
        text = (raw if isinstance(raw, str) else getattr(raw, 'text', '') or str(raw)).strip()
        # Strip code-fences / quotes the model sometimes adds.
        text = text.strip('`"\' \n')
        if not text or text.upper().startswith('NO_LEARNING'):
            return
        if len(text) > _MAX_LEARNING_CHARS:
            text = text[:_MAX_LEARNING_CHARS]
        # Duplicate suppression — hash the normalized text.
        h = hashlib.sha1(text.lower().encode('utf-8')).hexdigest()
        if await db.ai_learnings.find_one({'content_hash': h}):
            logger.debug('Auto-learning duplicate, skipping: %s', text[:60])
            return
        await db.ai_learnings.insert_one({
            'id': str(uuid.uuid4()),
            'text': text,
            'enabled': False,  # operator approval gate
            'auto_proposed': True,
            'content_hash': h,
            'source_session_id': session_id,
            'source_model': chat_model,
            'created_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
            'created_by_email': 'auto-learner',
        })
        logger.info('Auto-proposed learning: %s', text[:80])
    except Exception as e:
        # Never let this break the chat reply — log and move on.
        logger.warning('Auto-learning extraction failed: %s', e)
