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


@dataclass
class ImageContent:
    """Drop-in shape match for `emergentintegrations.llm.chat.ImageContent`.

    Carries a raw base64 image string (no `data:` prefix)."""
    image_base64: str


@dataclass
class UserMessage:
    """Drop-in shape match for `emergentintegrations.llm.chat.UserMessage`."""
    text: str
    file_contents: Optional[list] = None


@dataclass
class TextDelta:
    """Streaming text chunk — mirrors emergentintegrations' TextDelta."""
    content: str


@dataclass
class StreamDone:
    """Terminal streaming event — mirrors emergentintegrations' StreamDone."""
    pass


def _sniff_image_mime(b64: str) -> str:
    """Best-effort media-type detection from a base64 image payload so direct
    provider calls can label the image correctly (Anthropic requires it)."""
    import base64 as _b64
    try:
        head = _b64.b64decode(b64[:24] + '==', validate=False)[:12]
    except Exception:
        return 'image/png'
    if head[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if head[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if head[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'image/webp'
    return 'image/png'


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
    def _own_anthropic_key(self) -> Optional[str]:
        # Honour the user's own key first. We accept both ANTHROPIC_API_KEY
        # (official) and CLAUDE_API_KEY (the name some Vercel templates use).
        return os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')

    def _own_openai_key(self) -> Optional[str]:
        return os.environ.get('OPENAI_API_KEY')

    # ----------------------------------------------------------------
    # The send method — picks a backend and runs the call.
    # ----------------------------------------------------------------
    @staticmethod
    def _extract(message):
        text = message.text if isinstance(message, UserMessage) else str(message)
        images = list(message.file_contents or []) if isinstance(message, UserMessage) else []
        return text, images

    async def send_message(self, message: UserMessage) -> str:
        text, images = self._extract(message)

        # ---- 1. Direct Anthropic ---------------------------------
        if self._provider == 'anthropic':
            own = self._own_anthropic_key()
            if own:
                try:
                    return await self._send_anthropic_direct(own, text, images)
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
            own = self._own_openai_key()
            if own:
                try:
                    return await self._send_openai_direct(own, text, images)
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        'Direct OpenAI call failed (%s); falling back to emergentintegrations',
                        e,
                    )

        # ---- 3. emergentintegrations fallback --------------------
        return await self._send_emergent(text)

    async def stream_message(self, message: UserMessage):
        """Async generator yielding TextDelta(...) chunks then StreamDone().

        Routes to the operator's BYO Anthropic/OpenAI key when set (zero
        Emergent spend); otherwise falls back to emergentintegrations'
        streaming so behaviour is preserved when no BYO key is present.
        """
        text, images = self._extract(message)

        if self._provider == 'anthropic':
            own = self._own_anthropic_key()
            if own:
                async for ev in self._stream_anthropic_direct(own, text, images):
                    yield ev
                return

        if self._provider == 'openai':
            own = self._own_openai_key()
            if own:
                async for ev in self._stream_openai_direct(own, text, images):
                    yield ev
                return

        async for ev in self._stream_emergent(message):
            yield ev

    # ----------------------------------------------------------------
    # Provider content builders
    # ----------------------------------------------------------------
    def _anthropic_content(self, text: str, images: list):
        blocks = []
        for img in images or []:
            b64 = getattr(img, 'image_base64', None) or (img.get('image_base64') if isinstance(img, dict) else None)
            if not b64:
                continue
            blocks.append({
                'type': 'image',
                'source': {'type': 'base64', 'media_type': _sniff_image_mime(b64), 'data': b64},
            })
        blocks.append({'type': 'text', 'text': text})
        return blocks

    def _openai_content(self, text: str, images: list):
        if not images:
            return text
        parts = [{'type': 'text', 'text': text}]
        for img in images:
            b64 = getattr(img, 'image_base64', None) or (img.get('image_base64') if isinstance(img, dict) else None)
            if not b64:
                continue
            mime = _sniff_image_mime(b64)
            parts.append({'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,{b64}'}})
        return parts

    # ----------------------------------------------------------------
    # Direct SDK paths
    # ----------------------------------------------------------------
    async def _send_anthropic_direct(self, key: str, text: str, images: list = None) -> str:
        # We import lazily so the module loads even if anthropic isn't installed.
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=key)
        resp = await client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            system=self._system,
            messages=[{'role': 'user', 'content': self._anthropic_content(text, images or [])}],
        )
        # `content` is a list of content blocks; the first is usually `text`.
        for block in resp.content or []:
            if getattr(block, 'type', None) == 'text':
                return block.text or ''
            # SDKs sometimes return dict-shaped blocks.
            if isinstance(block, dict) and block.get('type') == 'text':
                return block.get('text', '') or ''
        return ''

    async def _send_openai_direct(self, key: str, text: str, images: list = None) -> str:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key)
        resp = await client.chat.completions.create(
            model=self._model,
            max_tokens=self._max_tokens,
            messages=[
                {'role': 'system', 'content': self._system},
                {'role': 'user', 'content': self._openai_content(text, images or [])},
            ],
        )
        choice = (resp.choices or [None])[0]
        if not choice:
            return ''
        return (choice.message.content or '') if choice.message else ''

    # ----------------------------------------------------------------
    # Direct streaming paths
    # ----------------------------------------------------------------
    async def _stream_anthropic_direct(self, key: str, text: str, images: list = None):
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=key)
        async with client.messages.stream(
            model=self._model,
            max_tokens=self._max_tokens,
            system=self._system,
            messages=[{'role': 'user', 'content': self._anthropic_content(text, images or [])}],
        ) as stream:
            async for chunk in stream.text_stream:
                if chunk:
                    yield TextDelta(content=chunk)
        yield StreamDone()

    async def _stream_openai_direct(self, key: str, text: str, images: list = None):
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key)
        stream = await client.chat.completions.create(
            model=self._model,
            max_tokens=self._max_tokens,
            messages=[
                {'role': 'system', 'content': self._system},
                {'role': 'user', 'content': self._openai_content(text, images or [])},
            ],
            stream=True,
        )
        async for chunk in stream:
            choice = (chunk.choices or [None])[0]
            if not choice:
                continue
            delta = getattr(choice, 'delta', None)
            piece = getattr(delta, 'content', None) if delta else None
            if piece:
                yield TextDelta(content=piece)
        yield StreamDone()

    async def _stream_emergent(self, message):
        """Fallback streaming via emergentintegrations, re-yielding our event
        shims so callers only ever see llm_router types."""
        from emergentintegrations.llm.chat import (
            LlmChat as _Emergent,
            UserMessage as _EmergentMsg,
            TextDelta as _EmergentDelta,
            StreamDone as _EmergentDone,
        )
        text, images = self._extract(message)
        kwargs = {'text': text}
        if images:
            try:
                from emergentintegrations.llm.chat import ImageContent as _EmergentImg
                kwargs['file_contents'] = [_EmergentImg(image_base64=getattr(i, 'image_base64', '')) for i in images]
            except Exception:  # noqa: BLE001
                pass
        chat = _Emergent(
            api_key=self._emergent_key,
            session_id=self._session_id,
            system_message=self._system,
        ).with_model(self._provider or 'openai', self._model or 'gpt-4o-mini')
        async for ev in chat.stream_message(_EmergentMsg(**kwargs)):
            if isinstance(ev, _EmergentDelta):
                yield TextDelta(content=ev.content)
            elif isinstance(ev, _EmergentDone):
                yield StreamDone()

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


# Sentinel handed to LlmChat when the operator has a BYO provider key but no
# Emergent key. LlmChat routes directly to Anthropic/OpenAI in that case and
# never reads this value, so any truthy string is fine.
BYO_KEY_SENTINEL = 'byo-provider-key'


def resolve_llm_key(settings: Optional[dict] = None) -> Optional[str]:
    """Resolve the api_key to hand to LlmChat, honouring BYO provider keys.

    Historically every AI endpoint guarded on the Emergent Universal LLM key
    (``if not llm_key: raise 503``). That guard predates BYO support and now
    wrongly blocks operators who configured their own ANTHROPIC_API_KEY /
    OPENAI_API_KEY instead of an Emergent key.

    Resolution order:
      1. Emergent key (operator settings, then env) — return it as-is.
      2. No Emergent key, but a BYO Anthropic/OpenAI key is set → return the
         sentinel so the caller's truthiness guard passes; LlmChat will route
         directly to the BYO provider and ignore this value.
      3. Nothing configured → return None so callers raise their 503.
    """
    settings = settings or {}
    emergent = settings.get('emergent_llm_key') or os.environ.get('EMERGENT_LLM_KEY')
    if emergent:
        return emergent
    status = backend_status()
    if status['anthropic_byo'] or status['openai_byo']:
        return BYO_KEY_SENTINEL
    return None


# Human-readable message reused by the 503 guards so the operator knows the
# new (cheaper) recommended path, not just the legacy Emergent key.
NO_LLM_PROVIDER_MSG = (
    'No LLM provider configured. Set ANTHROPIC_API_KEY (recommended) or '
    'OPENAI_API_KEY in the backend environment, or an Emergent key in '
    'Operator → Security.'
)
