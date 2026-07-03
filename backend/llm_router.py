"""LLM router — a self-contained, provider-native chat client.

Why this exists
---------------
Every LLM call in the app used to go through a third-party wrapper that always
billed a single shared "universal" key. This module removes that dependency
entirely and talks to each provider directly with the operator's own keys:

  * Anthropic  -> `anthropic.AsyncAnthropic`
  * OpenAI     -> `openai.AsyncOpenAI`
  * Gemini     -> `google.genai` async client

It exposes the exact same shapes the rest of the codebase already imports, so
call sites do not change beyond their import path:

  * ``UserMessage(text=..., file_contents=[ImageContent(...)])``
  * ``ImageContent(image_base64=...)``
  * ``TextDelta`` (has ``.content``) and ``StreamDone`` (sentinel) stream events
  * ``LlmChat(api_key, session_id, system_message, max_tokens=...)``
        ``.with_model(provider, model)``
        async ``send_message(UserMessage) -> str``
        async generator ``stream_message(UserMessage)`` -> TextDelta/StreamDone

Keys are resolved per provider, in this order:
  1. Hosting environment variables (e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY /
     GEMINI_API_KEY), then
  2. Keys the operator saved inside the app (Operator console → Security /
     My Keys), stored in the ``settings`` doc ``_id='payment_settings'``.

Everything imports lazily so a pod missing one provider SDK still boots and can
serve the providers it does have.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
from dataclasses import dataclass, field
from typing import AsyncIterator, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Message / event shapes (drop-in replacements for the old wrapper types)
# ---------------------------------------------------------------------------
@dataclass
class ImageContent:
    """A single image attachment. Carries raw base64 (no data: prefix)."""
    image_base64: str


@dataclass
class UserMessage:
    """A user turn: text plus optional image attachments."""
    text: str
    file_contents: List[ImageContent] = field(default_factory=list)


@dataclass
class TextDelta:
    """A streamed chunk of assistant text."""
    content: str


@dataclass
class StreamDone:
    """Sentinel yielded once the stream has finished."""
    pass


# ---------------------------------------------------------------------------
# Key resolution
# ---------------------------------------------------------------------------
async def _settings_ai_key(field_name: str) -> Optional[str]:
    """Return a provider key the operator saved *inside the app*.

    Best-effort: any failure returns ``None`` so callers fall back cleanly.
    """
    try:
        from payments_ext import get_db  # lazy import avoids circular load
        db = await get_db()
        doc = await db.settings.find_one({'_id': 'payment_settings'}) or {}
        val = doc.get(field_name)
        return val if isinstance(val, str) and val.strip() else None
    except Exception as e:  # noqa: BLE001
        logger.warning('Could not read %s from settings: %s', field_name, e)
        return None


async def _anthropic_key() -> Optional[str]:
    return (
        os.environ.get('ANTHROPIC_API_KEY')
        or os.environ.get('CLAUDE_API_KEY')
        or await _settings_ai_key('anthropic_api_key')
    )


async def _openai_key() -> Optional[str]:
    return (
        os.environ.get('OPENAI_API_KEY')
        or await _settings_ai_key('openai_api_key')
    )


async def _gemini_key() -> Optional[str]:
    return (
        os.environ.get('GEMINI_API_KEY')
        or os.environ.get('GOOGLE_API_KEY')
        or await _settings_ai_key('gemini_api_key')
    )


async def _openrouter_key() -> Optional[str]:
    """OpenRouter: one key unlocks 300+ models across every major vendor."""
    return (
        os.environ.get('OPENROUTER_API_KEY')
        or await _settings_ai_key('openrouter_api_key')
    )


async def any_provider_key_available() -> bool:
    """True if a key for any supported provider is configured (env or app
    settings). Used by endpoints that just need *some* model to be usable."""
    return bool(
        (await _anthropic_key())
        or (await _openai_key())
        or (await _gemini_key())
        or (await _openrouter_key())
    )


async def resolve_vision_model() -> Optional[tuple]:
    """Pick a vision-capable (provider, model) from whatever key is configured.

    Callers that need to send an image (e.g. visual build verification) must
    NOT hardcode a single provider — an operator may only have, say, an
    OpenRouter key. This returns the best available (provider, model) pair, or
    ``None`` when no provider key is set at all.

    Preference order favours the cheapest solid vision model per provider,
    trying a direct provider key first and falling back to OpenRouter (whose
    single key unlocks the same models via OpenAI-compatible slugs).
    """
    if await _openai_key():
        return ('openai', 'gpt-4o-mini')
    if await _openrouter_key():
        # OpenRouter slug for the same cheap vision model.
        return ('openrouter', 'openai/gpt-4o-mini')
    if await _anthropic_key():
        return ('anthropic', 'claude-sonnet-4-5-20250929')
    if await _gemini_key():
        return ('gemini', 'gemini-2.0-flash')
    return None


async def resolve_text_model() -> Optional[tuple]:
    """Pick a strong general (provider, model) from whatever key is configured.

    Used by text-only build steps (planning, code review) so an operator who
    only has, e.g., an OpenRouter key can still drive the app instead of being
    forced to add an Anthropic key. Returns ``None`` when no key is set.

    Prefers Anthropic's Sonnet for build quality, then OpenAI, then the same
    class of model via OpenRouter, then Gemini.
    """
    if await _anthropic_key():
        return ('anthropic', 'claude-sonnet-4-5-20250929')
    if await _openai_key():
        return ('openai', 'gpt-4o')
    if await _openrouter_key():
        return ('openrouter', 'anthropic/claude-3.5-sonnet')
    if await _gemini_key():
        return ('gemini', 'gemini-2.0-flash')
    return None


def _sniff_mime(raw: bytes) -> str:
    """Guess an image mime type from magic bytes; default to PNG."""
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if raw[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if raw[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp'
    return 'image/png'


def _decode_image(image_base64: str) -> tuple[bytes, str]:
    """Return (raw_bytes, mime) from a base64 string (data-URL prefix ok)."""
    b64 = image_base64
    if b64.startswith('data:') and ',' in b64:
        b64 = b64.split(',', 1)[1]
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):
        raw = b''
    return raw, _sniff_mime(raw)


class ProviderKeyMissing(RuntimeError):
    """Raised when no key is configured for the requested provider."""


# ---------------------------------------------------------------------------
# The chat client
# ---------------------------------------------------------------------------
class LlmChat:
    """Provider-native chat client with a stable, wrapper-compatible API."""

    def __init__(
        self,
        api_key: str = '',
        session_id: str = '',
        system_message: str = '',
        *,
        max_tokens: int = 4096,
        key_overrides: Optional[dict] = None,
    ) -> None:
        # api_key is accepted for signature compatibility but no longer used
        # for auth — each provider is authenticated with its own key.
        self._legacy_key = api_key
        self._session_id = session_id
        self._system = system_message or ''
        self._max_tokens = max_tokens
        self._provider: Optional[str] = None
        self._model: Optional[str] = None
        # Per-request key overrides: {provider: key}. Used by the BYOK add-on so
        # a user's chat runs on THEIR OWN key instead of the operator/app key.
        # Empty for normal (app-credit) chats.
        self._key_overrides: dict = key_overrides or {}

    def _override_key(self, provider: str) -> Optional[str]:
        k = self._key_overrides.get(provider)
        return k if isinstance(k, str) and k.strip() else None

    def with_model(self, provider: str, model: str) -> 'LlmChat':
        self._provider = (provider or '').lower()
        self._model = model
        return self

    # ------------------------------------------------------------------
    # Non-streaming
    # ------------------------------------------------------------------
    async def send_message(self, message: UserMessage) -> str:
        text = message.text if isinstance(message, UserMessage) else str(message)
        images = getattr(message, 'file_contents', None) or []
        provider = self._provider or 'anthropic'

        if provider == 'anthropic':
            return await self._anthropic(text, images, stream=False)  # type: ignore[return-value]
        if provider == 'openai':
            return await self._openai(text, images, stream=False)  # type: ignore[return-value]
        if provider in ('gemini', 'google'):
            return await self._gemini(text, images, stream=False)  # type: ignore[return-value]
        if provider == 'openrouter':
            return await self._openrouter(text, images, stream=False)  # type: ignore[return-value]
        raise ProviderKeyMissing(f'Unknown provider: {provider}')

    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------
    async def stream_message(self, message: UserMessage) -> AsyncIterator[object]:
        text = message.text if isinstance(message, UserMessage) else str(message)
        images = getattr(message, 'file_contents', None) or []
        provider = self._provider or 'anthropic'

        if provider == 'anthropic':
            async for ev in await self._anthropic(text, images, stream=True):  # type: ignore[misc]
                yield ev
        elif provider == 'openai':
            async for ev in await self._openai(text, images, stream=True):  # type: ignore[misc]
                yield ev
        elif provider in ('gemini', 'google'):
            async for ev in await self._gemini(text, images, stream=True):  # type: ignore[misc]
                yield ev
        elif provider == 'openrouter':
            async for ev in await self._openrouter(text, images, stream=True):  # type: ignore[misc]
                yield ev
        else:
            raise ProviderKeyMissing(f'Unknown provider: {provider}')

    # ==================================================================
    # Anthropic
    # ==================================================================
    async def _anthropic(self, text: str, images: list, *, stream: bool):
        key = self._override_key('anthropic') or await _anthropic_key()
        if not key:
            raise ProviderKeyMissing(
                'No Anthropic API key configured. Add one in Operator → Security '
                '(anthropic_api_key) or set ANTHROPIC_API_KEY.'
            )
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=key)

        content: list = []
        for img in images:
            raw, mime = _decode_image(img.image_base64)
            content.append({
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': mime,
                    'data': base64.b64encode(raw).decode() if raw else img.image_base64,
                },
            })
        content.append({'type': 'text', 'text': text})
        messages = [{'role': 'user', 'content': content}]

        if not stream:
            resp = await client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                system=self._system,
                messages=messages,
            )
            for block in resp.content or []:
                if getattr(block, 'type', None) == 'text':
                    return block.text or ''
                if isinstance(block, dict) and block.get('type') == 'text':
                    return block.get('text', '') or ''
            return ''

        async def _gen():
            async with client.messages.stream(
                model=self._model,
                max_tokens=self._max_tokens,
                system=self._system,
                messages=messages,
            ) as s:
                async for chunk in s.text_stream:
                    if chunk:
                        yield TextDelta(content=chunk)
            yield StreamDone()

        return _gen()

    # ==================================================================
    # OpenAI
    # ==================================================================
    def _openai_token_kwarg(self) -> dict:
        # Newer reasoning / GPT-5 models use max_completion_tokens instead of
        # max_tokens. Pick the right one so we don't get a 400.
        m = (self._model or '').lower()
        if m.startswith(('o1', 'o3', 'o4', 'gpt-5')):
            return {'max_completion_tokens': self._max_tokens}
        return {'max_tokens': self._max_tokens}

    async def _openai(self, text: str, images: list, *, stream: bool):
        key = self._override_key('openai') or await _openai_key()
        if not key:
            raise ProviderKeyMissing(
                'No OpenAI API key configured. Add one in Operator → Security '
                '(openai_api_key) or set OPENAI_API_KEY.'
            )
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key)
        return await self._openai_compatible(client, text, images, stream=stream)

    # ==================================================================
    # OpenRouter — one key, 300+ models. OpenAI-compatible surface, so we
    # reuse the exact same chat-completions path with a custom base_url.
    # The model id is the full OpenRouter slug (e.g. "meta-llama/llama-3.1-70b-instruct").
    # ==================================================================
    async def _openrouter(self, text: str, images: list, *, stream: bool):
        key = self._override_key('openrouter') or await _openrouter_key()
        if not key:
            raise ProviderKeyMissing(
                'No OpenRouter API key configured. Add one in Operator → Security '
                '(openrouter_api_key) or set OPENROUTER_API_KEY.'
            )
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=key,
            base_url='https://openrouter.ai/api/v1',
            default_headers={
                # Optional attribution headers OpenRouter recommends.
                'HTTP-Referer': os.environ.get('OPENROUTER_SITE_URL', 'https://tbctools.org'),
                'X-Title': os.environ.get('OPENROUTER_SITE_NAME', 'TBC AI Tools'),
            },
        )
        return await self._openai_compatible(client, text, images, stream=stream)

    # ------------------------------------------------------------------
    # Shared OpenAI-compatible chat-completions path (OpenAI + OpenRouter).
    # ------------------------------------------------------------------
    async def _openai_compatible(self, client, text: str, images: list, *, stream: bool):
        user_content: list = [{'type': 'text', 'text': text}]
        for img in images:
            raw, mime = _decode_image(img.image_base64)
            b64 = base64.b64encode(raw).decode() if raw else img.image_base64
            user_content.append({
                'type': 'image_url',
                'image_url': {'url': f'data:{mime};base64,{b64}'},
            })
        messages = [
            {'role': 'system', 'content': self._system},
            {'role': 'user', 'content': user_content},
        ]
        token_kw = self._openai_token_kwarg()

        if not stream:
            try:
                resp = await client.chat.completions.create(
                    model=self._model, messages=messages, **token_kw,
                )
            except Exception as e:  # noqa: BLE001 — retry once without token cap
                if 'max_tokens' in str(e) or 'max_completion_tokens' in str(e):
                    resp = await client.chat.completions.create(
                        model=self._model, messages=messages,
                    )
                else:
                    raise
            choice = (resp.choices or [None])[0]
            if not choice or not choice.message:
                return ''
            return choice.message.content or ''

        async def _gen():
            try:
                s = await client.chat.completions.create(
                    model=self._model, messages=messages, stream=True, **token_kw,
                )
            except Exception as e:  # noqa: BLE001
                if 'max_tokens' in str(e) or 'max_completion_tokens' in str(e):
                    s = await client.chat.completions.create(
                        model=self._model, messages=messages, stream=True,
                    )
                else:
                    raise
            async for chunk in s:
                choices = getattr(chunk, 'choices', None) or []
                if not choices:
                    continue
                delta = choices[0].delta
                piece = getattr(delta, 'content', None) if delta else None
                if piece:
                    yield TextDelta(content=piece)
            yield StreamDone()

        return _gen()

    # ==================================================================
    # Gemini (google-genai)
    # ==================================================================
    async def _gemini(self, text: str, images: list, *, stream: bool):
        key = self._override_key('gemini') or await _gemini_key()
        if not key:
            raise ProviderKeyMissing(
                'No Gemini API key configured. Add one in Operator → Security '
                '(gemini_api_key) or set GEMINI_API_KEY.'
            )
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=key)

        contents: list = [text]
        for img in images:
            raw, mime = _decode_image(img.image_base64)
            if raw:
                contents.append(types.Part.from_bytes(data=raw, mime_type=mime))
        config = types.GenerateContentConfig(
            system_instruction=self._system or None,
            max_output_tokens=self._max_tokens,
        )

        if not stream:
            resp = await client.aio.models.generate_content(
                model=self._model, contents=contents, config=config,
            )
            return resp.text or ''

        async def _gen():
            async for chunk in await client.aio.models.generate_content_stream(
                model=self._model, contents=contents, config=config,
            ):
                piece = getattr(chunk, 'text', None)
                if piece:
                    yield TextDelta(content=piece)
            yield StreamDone()

        return _gen()


# ---------------------------------------------------------------------------
# Diagnostic helper (surfaced in the operator console).
# ---------------------------------------------------------------------------
def backend_status() -> dict:
    """Which providers have a key available from the environment."""
    return {
        'anthropic_byo': bool(os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')),
        'openai_byo': bool(os.environ.get('OPENAI_API_KEY')),
        'gemini_byo': bool(os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY')),
        'openrouter_byo': bool(os.environ.get('OPENROUTER_API_KEY')),
    }


# ---------------------------------------------------------------------------
# OpenRouter model catalog (for the model picker). Cached for a few minutes
# so we don't hit the network on every /chat/models request.
# ---------------------------------------------------------------------------
_OR_CACHE: dict = {'at': 0.0, 'models': []}
_OR_CACHE_TTL = 600  # seconds


async def fetch_openrouter_models() -> List[dict]:
    """Return the live OpenRouter model list as [{id, label}], or [] if no
    key / on error. Cached in-process for _OR_CACHE_TTL seconds."""
    import time
    key = await _openrouter_key()
    if not key:
        return []
    now = time.time()
    if _OR_CACHE['models'] and (now - _OR_CACHE['at']) < _OR_CACHE_TTL:
        return _OR_CACHE['models']
    try:
        import httpx
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(
                'https://openrouter.ai/api/v1/models',
                headers={'Authorization': f'Bearer {key}'},
            )
        if r.status_code != 200:
            logger.warning('OpenRouter models fetch failed: %s', r.status_code)
            return _OR_CACHE['models']
        data = r.json().get('data') or []
        models = []
        for m in data:
            mid = m.get('id')
            if not mid:
                continue
            models.append({'id': mid, 'label': m.get('name') or mid})
        models.sort(key=lambda x: x['label'].lower())
        _OR_CACHE['models'] = models
        _OR_CACHE['at'] = now
        return models
    except Exception as e:  # noqa: BLE001
        logger.warning('OpenRouter models fetch error: %s', e)
        return _OR_CACHE['models']
