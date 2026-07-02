"""Tiny LLM router that lets operators bring their own provider keys.

Why this exists
---------------
Every LLM call in the app used to go through `emergentintegrations.llm.chat.LlmChat`
which always bills the Emergent Universal LLM Key — a single $11.40 budget that
hits the wall fast on a busy production app. Operators with their own
provider accounts shouldn't have to top up Emergent's budget when they
already have plenty of credit on Anthropic/OpenAI directly.

Behaviour
---------
The router exposes a minimal `LlmChat`-shaped wrapper with `with_model()` and
async `send_message()`. For each call it picks the cheapest viable path:

  1. `anthropic` model + `ANTHROPIC_API_KEY` env set → direct `anthropic` SDK
     (zero Emergent spend; uses the operator's own Anthropic account).
  2. `openai` model + `OPENAI_API_KEY` env set → direct `openai` SDK.
  3. Anything else (or both keys missing) → fall back to `emergentintegrations`
     so existing behaviour is preserved when the operator hasn't BYO'd a key.

The `UserMessage` shim mirrors emergentintegrations' shape so call sites are
near-zero-diff: swap the import path, everything else stays the same.

This file deliberately does NOT depend on emergentintegrations at module load
— we import it lazily so a pod without that package installed still boots.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


async def _settings_ai_key(field: str) -> Optional[str]:
    """Return an AI provider key the operator saved *inside the app*.

    Keys entered in the Operator console → "My Keys" tab live in the
    ``settings`` collection under ``_id='payment_settings'``. Reading them here
    means build tools work with a key pasted in the UI — no hosting env vars,
    no redeploy. Best-effort: any failure returns ``None`` so callers fall back
    to env vars / emergentintegrations.
    """
    try:
        from payments_ext import get_db  # lazy import avoids circular load
        db = await get_db()
        doc = await db.settings.find_one({'_id': 'payment_settings'}) or {}
        val = doc.get(field)
        return val if isinstance(val, str) and val.strip() else None
    except Exception as e:  # noqa: BLE001
        logger.warning('Could not read %s from settings: %s', field, e)
        return None


@dataclass
class UserMessage:
    """Drop-in shape match for `emergentintegrations.llm.chat.UserMessage`."""
    text: str


class LlmChat:
    """`emergentintegrations.llm.chat.LlmChat`-compatible wrapper.

    Operators with their own keys never pay Emergent's budget for those calls.
    Operators without BYO keys keep the old behaviour transparently.
    """

    def __init__(
        self,
        api_key: str,
        session_id: str,
        system_message: str,
        *,
        max_tokens: int = 4096,
    ) -> None:
        self._emergent_key = api_key  # used only if we fall through to emergentintegrations
        self._session_id = session_id
        self._system = system_message
        self._max_tokens = max_tokens
        self._provider: Optional[str] = None
        self._model: Optional[str] = None

    def with_model(self, provider: str, model: str) -> 'LlmChat':
        self._provider = provider
        self._model = model
        return self

    # ----------------------------------------------------------------
    # Routing helpers
    # ----------------------------------------------------------------
    async def _own_anthropic_key(self) -> Optional[str]:
        # Honour the user's own key first. We accept both ANTHROPIC_API_KEY
        # (official) and CLAUDE_API_KEY (the name some Vercel templates use).
        # Env wins; otherwise fall back to the key the operator saved *inside
        # the app* (Secrets card → Operator console), so BYO keys work without
        # ever touching the hosting env vars.
        return (
            os.environ.get('ANTHROPIC_API_KEY')
            or os.environ.get('CLAUDE_API_KEY')
            or await _settings_ai_key('anthropic_api_key')
        )

    async def _own_openai_key(self) -> Optional[str]:
        return (
            os.environ.get('OPENAI_API_KEY')
            or await _settings_ai_key('openai_api_key')
        )

    # ----------------------------------------------------------------
    # The send method — picks a backend and runs the call.
    # ----------------------------------------------------------------
    async def send_message(self, message: UserMessage) -> str:
        text = message.text if isinstance(message, UserMessage) else str(message)

        # ---- 1. Direct Anthropic ---------------------------------
        if self._provider == 'anthropic':
            own = await self._own_anthropic_key()
            if own:
                try:
                    return await self._send_anthropic_direct(own, text)
                except Exception as e:  # noqa: BLE001
                    # Don't kill the call — fall through to emergentintegrations
                    # so the operator's review still completes. We log loud so
                    # they can see what happened in the backend logs.
                    logger.warning(
                        'Direct Anthropic call failed (%s); falling back to emergentintegrations',
                        e,
                    )

        # ---- 2. Direct OpenAI ------------------------------------
        if self._provider == 'openai':
            own = await self._own_openai_key()
            if own:
                try:
                    return await self._send_openai_direct(own, text)
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        'Direct OpenAI call failed (%s); falling back to emergentintegrations',
                        e,
                    )

        # ---- 3. emergentintegrations fallback --------------------
        return await self._send_emergent(text)

    # ----------------------------------------------------------------
    # Direct SDK paths
    # ----------------------------------------------------------------
    async def _send_anthropic_direct(self, key: str, text: str) -> str:
        # We import lazily so the module loads even if anthropic isn't installed.
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=key)
        resp = await client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            system=self._system,
            messages=[{'role': 'user', 'content': text}],
        )
        # `content` is a list of content blocks; the first is usually `text`.
        for block in resp.content or []:
            if getattr(block, 'type', None) == 'text':
                return block.text or ''
            # SDKs sometimes return dict-shaped blocks.
            if isinstance(block, dict) and block.get('type') == 'text':
                return block.get('text', '') or ''
        return ''

    async def _send_openai_direct(self, key: str, text: str) -> str:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key)
        resp = await client.chat.completions.create(
            model=self._model,
            max_tokens=self._max_tokens,
            messages=[
                {'role': 'system', 'content': self._system},
                {'role': 'user', 'content': text},
            ],
        )
        choice = (resp.choices or [None])[0]
        if not choice:
            return ''
        return (choice.message.content or '') if choice.message else ''

    async def _send_emergent(self, text: str) -> str:
        # Late import so this file works even when emergentintegrations isn't
        # installed (e.g. a minimal pod that only uses BYO keys).
        from emergentintegrations.llm.chat import (
            LlmChat as _Emergent,
            UserMessage as _EmergentMsg,
        )
        chat = _Emergent(
            api_key=self._emergent_key,
            session_id=self._session_id,
            system_message=self._system,
        ).with_model(self._provider or 'openai', self._model or 'gpt-4o-mini')
        return await chat.send_message(_EmergentMsg(text=text))


# ----------------------------------------------------------------
# Diagnostic helper (handy from the operator console).
# ----------------------------------------------------------------
def backend_status() -> dict:
    """Returns which providers will use BYO keys vs Emergent's budget.

    Operator console / debug endpoint can surface this so the user can see
    at a glance whether their Anthropic key is being honoured."""
    return {
        'anthropic_byo': bool(os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')),
        'openai_byo': bool(os.environ.get('OPENAI_API_KEY')),
        'emergent_llm_key': bool(os.environ.get('EMERGENT_LLM_KEY')),
    }
