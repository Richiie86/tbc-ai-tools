"""Autopilot loop (extracted from `deploy_projects_ext.py`).

End-to-end ship-and-watch driver: review → ship → watch → react. Streams
typed Server-Sent Events so the operator console can render a live timeline
without polling. Two surfaces:

  - `POST /api/operator/deploy/{id}/autopilot` — operator cookie auth
  - `POST /api/projects/{id}/autopilot`        — Bearer (AI agent) auth

The module is imported for side-effects at the bottom of
`deploy_projects_ext.setup_routers()`; the route registrations hook onto the
shared `ops_router` and `projects_router` defined in the parent.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from deploy_projects_ext import (
    SELF_PROJECT_ID,
    _create_fix_review_chat,
    _ensure_self_project,
    _project_health,
    _record_deployment,
    _require_ai_api_key,
    _vercel_create_deployment,
    _vercel_get_deployment,
    db,
    get_current_operator,
    get_settings_doc,
    ops_router,
    projects_router,
)
from deploy.code_review import run_code_review

logger = logging.getLogger(__name__)


class AutopilotRequest(BaseModel):
    target: str = 'preview'           # 'preview' default for safety
    git_ref: Optional[str] = None
    # When True, autopilot continues past a do_not_ship verdict — useful for
    # demos. Default False keeps the safety net.
    bypass_review: bool = False
    # How long to poll Vercel before giving up (seconds). 0 disables watch.
    watch_timeout_s: int = 90


def _sse(event: str, data: dict) -> str:
    """Format an SSE frame. `event:` lines let the EventSource client switch
    on type instead of parsing a `kind` field."""
    payload = json.dumps(data, default=str)
    return f'event: {event}\ndata: {payload}\n\n'


async def _autopilot_stream(
    project_id: str,
    settings: dict,
    req: AutopilotRequest,
    user_id: Optional[str],
):
    """Drive the AI ship-and-watch loop end-to-end. See module docstring for
    the event taxonomy. Synchronously yields SSE frames until the loop
    terminates (success or error)."""
    try:
        project = await db.deploy_projects.find_one({'id': project_id})
        if not project and project_id == SELF_PROJECT_ID:
            project = await _ensure_self_project()
        if not project:
            yield _sse('loop_error', {'message': 'Project not found', 'project_id': project_id})
            return

        yield _sse('loop_start', {
            'project_id': project_id,
            'project_name': project.get('projectName'),
            'repo': project.get('repo'),
            'ref': req.git_ref or project.get('gitRef'),
            'target': req.target,
            'bypass_review': req.bypass_review,
        })

        # ---- Step 1: review ----------------------------------------------
        yield _sse('review_start', {'project_id': project_id})
        try:
            review = await run_code_review(project, settings)
        except HTTPException as he:
            yield _sse('loop_error', {'stage': 'review', 'status': he.status_code, 'message': str(he.detail)})
            return
        yield _sse('review_done', {
            'verdict': review.get('verdict'),
            'summary': (review.get('summary') or '')[:600],
            'findings_count': len(review.get('findings') or []),
            'findings': (review.get('findings') or [])[:10],
        })

        # ---- Step 2: gate ------------------------------------------------
        if review.get('verdict') == 'do_not_ship' and not req.bypass_review:
            fix_session_id = await _create_fix_review_chat(project, review, user_id)
            yield _sse('gate_blocked', {
                'verdict': review.get('verdict'),
                'fix_chat_session_id': fix_session_id,
                'next_action': 'Open the fix chat or rerun autopilot with bypass_review=true',
            })
            return

        # ---- Step 3: deploy ----------------------------------------------
        yield _sse('deploy_start', {'target': req.target, 'ref': req.git_ref or project.get('gitRef')})
        try:
            deploy_res = await _vercel_create_deployment(settings, project, req.target, req.git_ref)
        except HTTPException as he:
            yield _sse('loop_error', {'stage': 'deploy', 'status': he.status_code, 'message': str(he.detail)})
            return
        await _record_deployment(project_id, deploy_res)
        deployment_id = deploy_res.get('id') or deploy_res.get('uid')
        deployment_url = deploy_res.get('url')
        yield _sse('deploy_started', {
            'deployment_id': deployment_id,
            'url': deployment_url,
            'state': deploy_res.get('readyState') or deploy_res.get('state'),
        })

        # ---- Step 4: watch (poll Vercel) ---------------------------------
        terminal_state = None
        deadline = datetime.now(timezone.utc).timestamp() + max(0, req.watch_timeout_s)
        if deployment_id and req.watch_timeout_s > 0:
            while datetime.now(timezone.utc).timestamp() < deadline:
                await asyncio.sleep(4)
                try:
                    state_res = await _vercel_get_deployment(settings, deployment_id)
                except Exception as e:
                    yield _sse('deploy_state', {'state': 'POLL_ERROR', 'detail': str(e)[:200]})
                    continue
                state = state_res.get('readyState') or state_res.get('state')
                yield _sse('deploy_state', {'state': state, 'deployment_id': deployment_id})
                if state in ('READY', 'ERROR', 'CANCELED'):
                    terminal_state = state
                    break
        yield _sse('deploy_ready', {
            'state': terminal_state or 'WATCH_TIMEOUT',
            'deployment_id': deployment_id,
            'url': deployment_url,
        })

        # ---- Step 5: react (healthcheck) — only on READY -----------------
        if terminal_state == 'READY':
            await db.deploy_projects.update_one(
                {'id': project_id},
                {'$set': {'last_deployment_state': 'READY'}},
            )
            fresh = await db.deploy_projects.find_one({'id': project_id}) or project
            health = await _project_health(fresh, settings)
            yield _sse('health_check', health)
            yield _sse('loop_complete', {
                'ok': health.get('ok'),
                'state': terminal_state,
                'url': deployment_url,
            })
        else:
            yield _sse('loop_complete', {
                'ok': False,
                'state': terminal_state or 'WATCH_TIMEOUT',
                'url': deployment_url,
                'message': 'Deploy did not reach READY within the watch window.',
            })

    except Exception as e:  # absolute last-resort safety net
        logger.exception('autopilot crashed for project %s', project_id)
        yield _sse('loop_error', {'stage': 'unexpected', 'message': str(e)[:300]})


def _autopilot_response(
    project_id: str,
    settings: dict,
    req: AutopilotRequest,
    user_id: Optional[str],
):
    """Wrap the async generator in a StreamingResponse with SSE headers."""
    return StreamingResponse(
        _autopilot_stream(project_id, settings, req, user_id),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',  # disable nginx/CF buffering
            'Connection': 'keep-alive',
        },
    )


@ops_router.post('/{project_id}/autopilot')
async def op_autopilot(
    project_id: str,
    req: AutopilotRequest,
    user: dict = Depends(get_current_operator),
):
    """Run the full propose → review → ship → watch → react loop on this
    project and stream progress as Server-Sent Events.
    """
    settings = await get_settings_doc()
    return _autopilot_response(project_id, settings, req, user.get('sub'))


@projects_router.post('/{project_id}/autopilot')
async def ai_autopilot(
    project_id: str,
    req: AutopilotRequest,
    settings: dict = Depends(_require_ai_api_key),
):
    """AI-surface twin (Bearer token auth). Same SSE stream contract."""
    return _autopilot_response(project_id, settings, req, None)
