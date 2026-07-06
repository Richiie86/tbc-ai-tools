"""Deploy projects management - core module.

This module was reconstructed from import statements in other files.
It provides the base functionality for deploy project management.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Header, status
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db
from payments_ext import get_settings_doc

logger = logging.getLogger(__name__)

# Routers that other modules register endpoints on
ops_router = APIRouter(prefix='/api/operator/deploy', tags=['deploy-ops'])
projects_router = APIRouter(prefix='/api/projects', tags=['deploy-projects'])

# Constants
SELF_PROJECT_ID = 'self-project'
PLATFORM_REPO = 'Richiie86/tbc-ai-tools'


def _slugify(text: str) -> str:
    """Convert text to URL-safe slug."""
    import re
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[-\s]+', '-', text)
    return text[:50]


async def _ensure_self_project() -> dict:
    """Ensure the self-project exists in the database."""
    project = await db.deploy_projects.find_one({'id': SELF_PROJECT_ID})
    if not project:
        project = {
            'id': SELF_PROJECT_ID,
            'projectName': 'TBC AI Tools',
            'repo': PLATFORM_REPO,
            'gitRef': 'main',
            'created_at': datetime.now(timezone.utc),
            'updated_at': datetime.now(timezone.utc),
        }
        await db.deploy_projects.insert_one(project)
    return project


async def _project_health(project: dict, settings: dict) -> dict:
    """Check project health status."""
    return {
        'ok': True,
        'project_id': project.get('id'),
        'status': 'healthy',
    }


async def _record_deployment(project_id: str, deploy_result: dict) -> None:
    """Record deployment result."""
    await db.deploy_projects.update_one(
        {'id': project_id},
        {'$set': {
            'last_deployment_id': deploy_result.get('id'),
            'last_deployment_url': deploy_result.get('url'),
            'updated_at': datetime.now(timezone.utc),
        }},
    )


async def _vercel_get_deployment(settings: dict, deployment_id: str) -> dict:
    """Get deployment status from Vercel."""
    from vercel_api_ext import VERCEL_API, vercel_token, vercel_team_qs
    import httpx
    
    token = vercel_token(settings)
    if not token:
        raise HTTPException(503, 'Vercel token not configured')
    
    params = dict(vercel_team_qs(settings))
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            f'{VERCEL_API}/v13/deployments/{deployment_id}',
            headers={'Authorization': f'Bearer {token}'},
            params=params,
        )
        if r.status_code >= 400:
            raise HTTPException(502, f'Vercel API error: {r.status_code}')
        return r.json()


async def _create_fix_review_chat(project: dict, review: dict, user_id: Optional[str]) -> Optional[str]:
    """Create a chat session for fixing review issues."""
    import uuid
    session_id = str(uuid.uuid4())
    await db.chat_sessions.insert_one({
        'id': session_id,
        'user_id': user_id or 'system',
        'title': f'Fix: {project.get("projectName")}',
        'created_at': datetime.now(timezone.utc),
    })
    return session_id


async def _require_ai_api_key(authorization: Optional[str] = Header(None)) -> dict:
    """Validate Bearer token for AI API access."""
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Missing Bearer token')
    
    presented = authorization.split(None, 1)[1].strip()
    settings = await get_settings_doc()
    stored = settings.get('ai_api_key')
    
    if not stored or presented != stored:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid API key')
    
    return settings


def setup_routers(app):
    """Register all deploy-related routers."""
    app.include_router(ops_router)
    app.include_router(projects_router)
    
    # Import side-effect modules that register additional routes
    try:
        import deploy.autopilot  # noqa: F401
        import deploy.auto_fix  # noqa: F401
    except ImportError as e:
        logger.warning('Could not import deploy submodules: %s', e)
