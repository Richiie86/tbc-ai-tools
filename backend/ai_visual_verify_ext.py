"""AI Visual Verification — screenshots a deploy preview and asks a vision
LLM whether the UI rendered correctly. Mirrors what a human (or the main
build agent) does when they screenshot a change before merging.

Why this exists
---------------
The text-only cross-AI code review in `ai_build_ext.py` cannot catch
visual regressions (blank screen, CSS overflow, hidden buttons, broken
images). After a PR opens its Vercel preview URL, this module:

  1. Resolves the latest preview URL for the plan's branch (re-uses
     `ai_build_ext.preview_url`).
  2. Shells out to the Playwright CLI to take a 1280×800 JPEG screenshot.
  3. Sends the screenshot to GPT-4o (vision-capable) with the operator's
     original prompt as context.
  4. Stores `{verdict, summary, concerns[], screenshot_path}` on the
     `ai_build_plans` doc so the AIBuild tab can surface a Pass/Fail pill
     and the auto-merge sweep can use it as an extra gate.

Trust model
-----------
- Operator-only HTTP endpoints (no public surface).
- Playwright runs in a sandboxed subprocess with a hard timeout; no JS
  evaluation in-process.
- Screenshots are written into `/tmp/ai_visual_verify/` and cleaned up
  on a best-effort basis after the vision call.
- The vision model NEVER sees secrets — only the rendered HTML.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import subprocess  # nosec B404 — fixed CLI args, no shell, no user input.
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api/operator/ai-build', tags=['ai-build-visual'])

# Playwright CLI from the plugins venv (installed system-wide with
# chromium already downloaded — see /root/.cache/ms-playwright).
_PLAYWRIGHT_BIN = '/opt/plugins-venv/bin/playwright'
_SCREENSHOT_DIR = Path('/tmp/ai_visual_verify')  # nosec B108 — process-local cache only.
_SCREENSHOT_DIR.mkdir(exist_ok=True, parents=True)

_VISION_SYSTEM_PROMPT = (
    "You are a strict QA engineer reviewing a fresh deploy preview screenshot. "
    "The operator asked an AI to make a code change; you must verify the live "
    "UI is intact. Return STRICT JSON only:\n"
    "{\n"
    '  "verdict": "pass" | "warn" | "fail",\n'
    '  "summary": "<one-line plain-English assessment>",\n'
    '  "concerns": ["<short concern>", ...]\n'
    "}\n"
    "FAIL if: the page is blank, shows an error overlay, has obviously broken "
    "layout (huge unstyled text, overlapping elements, off-screen content), "
    "or the requested feature is clearly missing.\n"
    "WARN if: the page renders but you suspect a regression (cropped text, "
    "missing icons, theme inconsistency).\n"
    "PASS otherwise. Keep it under 6 concerns. Be concise."
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _take_screenshot(url: str, out_path: Path, timeout_s: float = 25.0) -> bool:
    """Shell out to the Playwright CLI. Returns True on success.

    Uses asyncio.create_subprocess_exec so we don't block the event loop.
    Hard timeout so a hung preview can never wedge the worker.
    """
    if not Path(_PLAYWRIGHT_BIN).exists():
        logger.warning('Playwright CLI missing at %s', _PLAYWRIGHT_BIN)
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            _PLAYWRIGHT_BIN, 'screenshot',
            '--browser', 'chromium',
            '--viewport-size', '1280,800',
            '--full-page', 'false',
            '--wait-for-timeout', '3500',
            url, str(out_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            proc.kill()
            logger.warning('Playwright screenshot timed out for %s', url)
            return False
        if proc.returncode != 0:
            logger.warning('Playwright screenshot failed (%s): %s', proc.returncode, stderr[:500])
            return False
        return out_path.exists() and out_path.stat().st_size > 0
    except Exception as e:
        logger.warning('Playwright subprocess error: %s', e)
        return False


async def _vision_verify(llm_key: str, screenshot_path: Path, prompt: str, summary: str) -> dict:
    """Send the screenshot + operator's prompt to a vision model and parse
    the JSON verdict. Always returns a dict — never raises."""
    from llm_router import LlmChat, UserMessage, ImageContent
    import json
    import re

    try:
        b64 = base64.b64encode(screenshot_path.read_bytes()).decode('ascii')
    except Exception as e:
        return {'verdict': 'review_skipped', 'summary': f'screenshot read failed: {e}', 'concerns': []}

    chat = LlmChat(
        api_key=llm_key,
        session_id=f'ai-visual-{datetime.now(timezone.utc).timestamp():.0f}',
        system_message=_VISION_SYSTEM_PROMPT,
    ).with_model('openai', 'gpt-4o-mini')

    msg = UserMessage(
        text=(
            f'Operator request: {prompt[:1000]}\n\n'
            f'Generator summary: {summary[:400]}\n\n'
            f'The attached image is the live deploy preview AFTER the change. '
            f'Verify the UI rendered correctly. Return the verification JSON now.'
        ),
        file_contents=[ImageContent(image_base64=b64)],
    )
    try:
        raw = await chat.send_message(msg)
    except Exception as e:
        logger.warning('Vision verify LLM failed: %s', e)
        return {'verdict': 'review_skipped', 'summary': f'vision LLM failed: {str(e)[:200]}', 'concerns': []}

    text = (raw or '').strip()
    # Strip markdown fences if model wrapped JSON.
    text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
    text = re.sub(r'\n?```$', '', text)
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r'\{.*\}', text, re.DOTALL)
        parsed = {}
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = {}
    return {
        'verdict': parsed.get('verdict') if parsed.get('verdict') in ('pass', 'warn', 'fail') else 'review_skipped',
        'summary': (parsed.get('summary') or '')[:280],
        'concerns': [str(c)[:280] for c in (parsed.get('concerns') or [])][:8],
        'reviewer_model': 'gpt-4o-mini',
    }


async def _resolve_preview_url(plan_doc: dict) -> Optional[str]:
    """Find the freshest Vercel preview URL for the plan's branch.

    Calls back into ai_build_ext.preview_url so we get the same filtering
    + team-scope logic without duplicating the Vercel client.
    """
    from ai_build_ext import preview_url
    fake_user = {'id': plan_doc.get('operator_id') or 'system', 'role': 'operator'}
    try:
        result = await preview_url(plan_doc['plan_id'], user=fake_user)
    except Exception as e:
        logger.warning('preview-url resolution failed for %s: %s', plan_doc.get('plan_id'), e)
        return None
    if isinstance(result, dict):
        return result.get('url')
    return None


async def run_visual_verify(plan_id: str, *, fallback_url: Optional[str] = None) -> dict:
    """Core worker. Resolves URL → screenshots → vision LLM → stores result.

    `fallback_url` is used when the plan has no opened PR yet (e.g. when
    the operator manually triggers the verify against the production URL
    instead of a per-branch preview).
    """
    plan_doc = await db.ai_build_plans.find_one({'plan_id': plan_id})
    if not plan_doc:
        return {'ok': False, 'reason': 'plan_not_found'}

    from llm_router import _openai_key
    llm_key = ''  # legacy placeholder — llm_router uses the provider key
    if not await _openai_key():
        return {'ok': False, 'reason': 'no_llm_key'}

    url = await _resolve_preview_url(plan_doc) if plan_doc.get('branch') else None
    url = url or fallback_url
    if not url:
        # Record the attempt so the UI can show "waiting for preview".
        await db.ai_build_plans.update_one(
            {'plan_id': plan_id},
            {'$set': {'visual_verify': {
                'verdict': 'pending',
                'summary': 'No preview deployment URL available yet.',
                'attempted_at': _now_iso(),
            }}},
        )
        return {'ok': False, 'reason': 'no_preview_url'}

    out_path = _SCREENSHOT_DIR / f'{plan_id}.jpeg'
    ok = await _take_screenshot(url, out_path)
    if not ok:
        await db.ai_build_plans.update_one(
            {'plan_id': plan_id},
            {'$set': {'visual_verify': {
                'verdict': 'review_skipped',
                'summary': 'Could not capture screenshot (Playwright unavailable or page failed to load).',
                'preview_url': url,
                'attempted_at': _now_iso(),
            }}},
        )
        return {'ok': False, 'reason': 'screenshot_failed', 'preview_url': url}

    verdict = await _vision_verify(llm_key, out_path, plan_doc.get('prompt') or '', plan_doc.get('summary') or '')

    # Persist the screenshot so the UI can show it everywhere a build/preview
    # appears. Storage backend (Mongo by default, or the operator's own
    # server) is chosen by storage_config_ext.
    screenshot_meta = {'stored': None}
    try:
        from storage_config_ext import persist_screenshot
        img_bytes = out_path.read_bytes()
        screenshot_meta = await persist_screenshot(f'plan-{plan_id}', img_bytes, 'image/jpeg')
    except Exception as e:
        logger.warning('Screenshot persist failed for %s: %s', plan_id, e)

    record = {
        **verdict,
        'preview_url': url,
        'screenshot_size': out_path.stat().st_size,
        'screenshot_available': screenshot_meta.get('stored') is not None,
        'screenshot_stored': screenshot_meta.get('stored'),
        'screenshot_url': screenshot_meta.get('url'),  # set only in custom mode
        'attempted_at': _now_iso(),
    }
    await db.ai_build_plans.update_one(
        {'plan_id': plan_id},
        {'$set': {'visual_verify': record}},
    )

    # Local /tmp copy is no longer needed — the durable copy lives in storage.
    try:
        out_path.unlink(missing_ok=True)
    except Exception:
        pass

    return {'ok': True, **record}


# ─── Endpoints ────────────────────────────────────────────────────────────
@router.post('/visual-verify/{plan_id}')
async def trigger_visual_verify(plan_id: str, op: dict = Depends(get_current_operator)):
    """Operator-triggered: take a fresh screenshot of the plan's preview
    URL and run the vision verdict. Stores the result on the plan doc."""
    result = await run_visual_verify(plan_id)
    if not result.get('ok'):
        reason = result.get('reason')
        if reason == 'plan_not_found':
            raise HTTPException(404, 'Plan not found')
        if reason == 'no_llm_key':
            raise HTTPException(503, 'No OpenAI API key configured (Operator → Security).')
        if reason == 'no_preview_url':
            raise HTTPException(409, 'No preview deployment URL yet — wait for Vercel to build.')
        if reason == 'screenshot_failed':
            raise HTTPException(502, 'Could not capture preview screenshot — Playwright unavailable or page errored.')
    return result


@router.get('/visual-verify/{plan_id}')
async def get_visual_verify(plan_id: str, op: dict = Depends(get_current_operator)):
    """Read the stored visual verdict (no LLM call)."""
    doc = await db.ai_build_plans.find_one(
        {'plan_id': plan_id},
        {'visual_verify': 1},
    )
    if not doc:
        raise HTTPException(404, 'Plan not found')
    return doc.get('visual_verify') or {'verdict': 'not_run', 'summary': 'No visual verification run yet.'}


@router.get('/visual-verify/{plan_id}/screenshot')
async def get_visual_verify_screenshot(plan_id: str, op: dict = Depends(get_current_operator)):
    """Serve the persisted build screenshot.

    - Mongo mode: streams the JPEG bytes back.
    - Custom mode: redirects to the operator's server URL.
    """
    from fastapi.responses import Response, RedirectResponse
    from storage_config_ext import load_screenshot

    doc = await db.ai_build_plans.find_one(
        {'plan_id': plan_id}, {'visual_verify': 1},
    )
    vv = (doc or {}).get('visual_verify') or {}
    if vv.get('screenshot_stored') == 'custom' and vv.get('screenshot_url'):
        return RedirectResponse(vv['screenshot_url'])

    loaded = await load_screenshot(f'plan-{plan_id}')
    if not loaded:
        raise HTTPException(404, 'No screenshot stored for this plan yet.')
    data, content_type = loaded
    return Response(content=data, media_type=content_type,
                    headers={'Cache-Control': 'private, max-age=60'})


@router.post('/preview-screenshot/{deployment_id}')
async def capture_preview_screenshot(deployment_id: str, body: dict, op: dict = Depends(get_current_operator)):
    """Capture (or re-capture) a screenshot for an arbitrary preview URL so
    the Preview widget can show a live thumbnail. Keyed by deployment id."""
    url = (body or {}).get('url')
    if not url:
        raise HTTPException(400, 'url is required')

    from storage_config_ext import persist_screenshot
    out_path = _SCREENSHOT_DIR / f'preview-{deployment_id}.jpeg'
    ok = await _take_screenshot(url, out_path)
    if not ok:
        raise HTTPException(502, 'Could not capture preview screenshot.')
    try:
        meta = await persist_screenshot(f'preview-{deployment_id}', out_path.read_bytes(), 'image/jpeg')
    finally:
        try:
            out_path.unlink(missing_ok=True)
        except Exception:
            pass
    await db.ai_preview_screenshots.update_one(
        {'_id': deployment_id},
        {'$set': {
            'preview_url': url,
            'stored': meta.get('stored'),
            'url': meta.get('url'),
            'captured_at': _now_iso(),
        }},
        upsert=True,
    )
    return {'ok': True, 'deployment_id': deployment_id, **meta}


@router.get('/preview-screenshot/{deployment_id}')
async def get_preview_screenshot(deployment_id: str, op: dict = Depends(get_current_operator)):
    """Serve a previously captured preview screenshot."""
    from fastapi.responses import Response, RedirectResponse
    from storage_config_ext import load_screenshot

    meta = await db.ai_preview_screenshots.find_one({'_id': deployment_id})
    if meta and meta.get('stored') == 'custom' and meta.get('url'):
        return RedirectResponse(meta['url'])
    loaded = await load_screenshot(f'preview-{deployment_id}')
    if not loaded:
        raise HTTPException(404, 'No screenshot captured for this preview yet.')
    data, content_type = loaded
    return Response(content=data, media_type=content_type,
                    headers={'Cache-Control': 'private, max-age=60'})
