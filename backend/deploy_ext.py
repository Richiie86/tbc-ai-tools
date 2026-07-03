"""Operator-controlled Render deploys.

Why this exists
---------------
The backend runs on Render and deploys separately from the frontend. When new
code lands on `main`, someone has to open the Render dashboard and click
"Manual Deploy". This module lets the operator trigger a redeploy straight from
the app (Server tab → Deploy).

The Render API key is NOT stored here — it reuses the `render_api_key` the
operator already saves in My Keys (settings doc `_id='payment_settings'`), so
there is a single source of truth for that credential. This module only stores
which service to deploy (+ an optional deploy hook) and the last deploy status.

Two ways to trigger a deploy are supported:
  1. API key (from My Keys) + service id -> uses the Render REST API. Also lets
     us list services so the operator can pick one, and read deploy status.
  2. Deploy hook URL -> a simple POST-to-URL that Render provides; no key
     needed. Used as a fallback if only a hook is configured.

Trust model
-----------
- All endpoints are operator-only.
- The API key lives in the shared settings doc; the deploy hook is stored here
  and never returned to the client (only `hook_set` is exposed).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc')

# NOTE: the existing deploy system (deploy_projects_ext.py) owns
# `/api/operator/deploy/{project_id}` with a catch-all GET, which would swallow
# our `/config`, `/services`, `/status` as if "config" were a project id. Use a
# distinct prefix so this Render-redeploy feature never collides with it.
router = APIRouter(prefix='/api/operator/render-deploy', tags=['deploy'])

_CONFIG_ID = 'render_deploy'
_SETTINGS_ID = 'payment_settings'
_RENDER_API = 'https://api.render.com/v1'
_DEFAULT_CONFIG = {
    '_id': _CONFIG_ID,
    'service_id': '',
    'service_name': '',
    'hook_url': '',
    'updated_at': None,
    'last_deploy_at': None,
    'last_deploy_id': None,
    'last_deploy_status': None,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _get_render_api_key() -> str:
    """Read the Render API key the operator saved in My Keys. Single source of
    truth — this module never stores its own copy."""
    try:
        doc = await db.settings.find_one({'_id': _SETTINGS_ID}) or {}
        return (doc.get('render_api_key') or '').strip()
    except Exception as e:
        logger.warning('Could not read render_api_key from settings: %s', e)
        return ''


async def _get_config() -> dict:
    doc = await db.app_deploy_config.find_one({'_id': _CONFIG_ID})
    if not doc:
        return dict(_DEFAULT_CONFIG)
    return {**_DEFAULT_CONFIG, **doc}


def _public(doc: dict, api_key_set: bool) -> dict:
    """Strip secrets before returning to the client."""
    return {
        'api_key_set': api_key_set,
        'service_id': doc.get('service_id', ''),
        'service_name': doc.get('service_name', ''),
        'hook_set': bool(doc.get('hook_url')),
        'updated_at': doc.get('updated_at'),
        'last_deploy_at': doc.get('last_deploy_at'),
        'last_deploy_id': doc.get('last_deploy_id'),
        'last_deploy_status': doc.get('last_deploy_status'),
    }


class DeployConfigUpdate(BaseModel):
    service_id: Optional[str] = None
    service_name: Optional[str] = None
    hook_url: Optional[str] = None


@router.get('/config')
async def read_deploy_config(op: dict = Depends(get_current_operator)):
    """Current deploy configuration. `api_key_set` reflects the Render key
    saved in My Keys (shared settings doc)."""
    return _public(await _get_config(), bool(await _get_render_api_key()))


@router.put('/config')
async def update_deploy_config(body: DeployConfigUpdate, op: dict = Depends(get_current_operator)):
    """Save which Render service to deploy (+ optional hook). The API key
    itself is managed in My Keys, not here."""
    updates: dict = {}
    if body.service_id is not None:
        updates['service_id'] = body.service_id.strip()
    if body.service_name is not None:
        updates['service_name'] = body.service_name.strip()
    if body.hook_url is not None:
        hook = body.hook_url.strip()
        if hook and not hook.startswith('https://'):
            raise HTTPException(400, 'hook_url must start with https://')
        updates['hook_url'] = hook

    if not updates:
        raise HTTPException(400, 'Nothing to update.')

    updates['updated_at'] = _now_iso()
    await db.app_deploy_config.update_one(
        {'_id': _CONFIG_ID}, {'$set': updates}, upsert=True,
    )
    return _public(await _get_config(), bool(await _get_render_api_key()))


@router.get('/services')
async def list_render_services(op: dict = Depends(get_current_operator)):
    """List the operator's Render services so they can pick which one to
    deploy. Requires a saved API key."""
    api_key = await _get_render_api_key()
    if not api_key:
        raise HTTPException(409, 'Add your Render API key in My Keys first.')
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f'{_RENDER_API}/services',
                params={'limit': 100},
                headers={'Authorization': f'Bearer {api_key}',
                         'Accept': 'application/json'},
            )
        if resp.status_code == 401:
            raise HTTPException(401, 'Render rejected the API key. Update it in My Keys.')
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning('Render list services failed: %s', e)
        raise HTTPException(502, 'Could not reach Render. Try again shortly.')

    services = []
    for item in resp.json() or []:
        svc = item.get('service', item) if isinstance(item, dict) else {}
        services.append({
            'id': svc.get('id'),
            'name': svc.get('name'),
            'type': svc.get('type'),
            'branch': (svc.get('branch') or (svc.get('serviceDetails') or {}).get('branch')),
        })
    return {'services': [s for s in services if s.get('id')]}


@router.post('/trigger')
async def trigger_deploy(op: dict = Depends(get_current_operator)):
    """Trigger a redeploy on Render.

    Prefers the API (key + service id) so we can report a deploy id/status;
    falls back to the deploy hook URL if that's all that's configured.
    """
    cfg = await _get_config()
    api_key = await _get_render_api_key()

    # Preferred: REST API with key + service id.
    if api_key and cfg.get('service_id'):
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{_RENDER_API}/services/{cfg['service_id']}/deploys",
                    headers={'Authorization': f'Bearer {api_key}',
                             'Accept': 'application/json',
                             'Content-Type': 'application/json'},
                    json={'clearCache': 'do_not_clear'},
                )
            if resp.status_code == 401:
                raise HTTPException(401, 'Render rejected the API key. Update it in My Keys.')
            if resp.status_code == 404:
                raise HTTPException(404, 'Render service not found. Re-select your service.')
            resp.raise_for_status()
            data = resp.json() if resp.content else {}
            deploy_id = data.get('id') or (data.get('deploy') or {}).get('id')
            status = data.get('status') or (data.get('deploy') or {}).get('status') or 'queued'
            await db.app_deploy_config.update_one(
                {'_id': _CONFIG_ID},
                {'$set': {'last_deploy_at': _now_iso(),
                          'last_deploy_id': deploy_id,
                          'last_deploy_status': status}},
                upsert=True,
            )
            return {'ok': True, 'method': 'api', 'deploy_id': deploy_id, 'status': status}
        except HTTPException:
            raise
        except Exception as e:
            logger.warning('Render API deploy failed: %s', e)
            raise HTTPException(502, 'Deploy request to Render failed. Try again shortly.')

    # Fallback: deploy hook URL.
    if cfg.get('hook_url'):
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(cfg['hook_url'])
            resp.raise_for_status()
            await db.app_deploy_config.update_one(
                {'_id': _CONFIG_ID},
                {'$set': {'last_deploy_at': _now_iso(),
                          'last_deploy_status': 'triggered (hook)'}},
                upsert=True,
            )
            return {'ok': True, 'method': 'hook', 'status': 'triggered'}
        except Exception as e:
            logger.warning('Render hook deploy failed: %s', e)
            raise HTTPException(502, 'Deploy hook call failed. Check the URL.')

    raise HTTPException(409, 'Add a Render API key in My Keys and pick a service, or set a deploy hook URL first.')


@router.get('/status')
async def deploy_status(op: dict = Depends(get_current_operator)):
    """Poll the status of the most recent API-triggered deploy."""
    cfg = await _get_config()
    api_key = await _get_render_api_key()
    if not (api_key and cfg.get('service_id') and cfg.get('last_deploy_id')):
        return {'status': cfg.get('last_deploy_status'), 'deploy_id': cfg.get('last_deploy_id')}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f"{_RENDER_API}/services/{cfg['service_id']}/deploys/{cfg['last_deploy_id']}",
                headers={'Authorization': f'Bearer {api_key}',
                         'Accept': 'application/json'},
            )
        resp.raise_for_status()
        data = resp.json() if resp.content else {}
        status = data.get('status') or (data.get('deploy') or {}).get('status')
        if status:
            await db.app_deploy_config.update_one(
                {'_id': _CONFIG_ID}, {'$set': {'last_deploy_status': status}}, upsert=True,
            )
        return {'status': status, 'deploy_id': cfg['last_deploy_id']}
    except Exception as e:
        logger.warning('Render deploy status failed: %s', e)
        return {'status': cfg.get('last_deploy_status'), 'deploy_id': cfg.get('last_deploy_id')}
