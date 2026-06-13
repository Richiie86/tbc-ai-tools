"""Per-user deploy access (request / approve / reject).

Lets the operator decide which users can hit the deploy CTAs in their
Dashboard chat. Default for new users is `default_can_deploy` on the
payment_settings row (defaults to `false`, can be flipped by the operator).

Surfaces three "shapes":

- **End-user** (`/api/me/deploy-access`): `GET` returns the current status
  + the user's most recent pending request, `POST /request` submits a new
  request (idempotent — one pending row at a time).
- **Operator** (`/api/operator/deploy-access/*`): list pending requests +
  approve/reject endpoints + a direct `PATCH /users/{id}/deploy-access`
  toggle that bypasses the request flow.
- **Settings** (`/api/operator/deploy-access/default`): `GET/PATCH` the
  org-wide default for new accounts.

Stores requests in a `deploy_access_requests` Mongo collection. Granting
access flips `users.{id}.can_deploy = true` and atomically marks the
related pending request as `approved`.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_operator, get_current_user
from db import db

logger = logging.getLogger('tbc')

router = APIRouter(prefix='/api', tags=['deploy-access'])


# ---------- Helpers --------------------------------------------------
async def _default_can_deploy() -> bool:
    settings = await db.payment_settings.find_one({}) or {}
    return bool(settings.get('default_can_deploy', False))


async def _request_to_out(doc: dict) -> dict:
    if not doc:
        return {}
    return {
        'id': doc['id'],
        'user_id': doc['user_id'],
        'user_email': doc.get('user_email', ''),
        'user_name': doc.get('user_name', ''),
        'message': doc.get('message', ''),
        'status': doc.get('status', 'pending'),
        'created_at': (doc.get('created_at') or datetime.now(timezone.utc)).isoformat(),
        'decided_at': doc['decided_at'].isoformat() if doc.get('decided_at') else None,
        'decided_by': doc.get('decided_by_email'),
    }


# ---------- Models ---------------------------------------------------
class RequestBody(BaseModel):
    message: Optional[str] = Field(default=None, max_length=500)


class ToggleBody(BaseModel):
    can_deploy: bool


class DefaultBody(BaseModel):
    default_can_deploy: bool


# ---------- End-user --------------------------------------------------
@router.get('/me/deploy-access')
async def me_get_access(user: dict = Depends(get_current_user)):
    """Status payload for the dashboard banner / request CTA."""
    is_operator = user.get('role') == 'operator'
    stored = await db.users.find_one(
        {'id': user['sub']},
        {'can_deploy': 1, 'email': 1, 'name': 1},
    ) or {}
    default = await _default_can_deploy()
    # Operators implicitly have access — never block them on this flag.
    can_deploy = is_operator or bool(stored.get('can_deploy', default))
    pending = await db.deploy_access_requests.find_one(
        {'user_id': user['sub'], 'status': 'pending'},
        sort=[('created_at', -1)],
    )
    return {
        'can_deploy': can_deploy,
        'is_operator': is_operator,
        'default_can_deploy': default,
        'pending_request': await _request_to_out(pending) if pending else None,
    }


@router.post('/me/deploy-access/request', status_code=201)
async def me_request_access(
    body: RequestBody,
    user: dict = Depends(get_current_user),
):
    """Submit (or re-surface) a request to the operator. Idempotent —
    returns the existing pending row if the user has one already so the
    UI can show the operator's queue position consistently.
    """
    if user.get('role') == 'operator':
        raise HTTPException(400, 'Operators already have deploy access')
    # If the user is already granted, bail out so the dashboard updates.
    stored = await db.users.find_one(
        {'id': user['sub']}, {'can_deploy': 1, 'email': 1, 'name': 1},
    ) or {}
    if stored.get('can_deploy'):
        raise HTTPException(400, 'Deploy access already granted')
    existing = await db.deploy_access_requests.find_one(
        {'user_id': user['sub'], 'status': 'pending'},
    )
    if existing:
        return await _request_to_out(existing)
    doc = {
        'id': str(uuid.uuid4()),
        'user_id': user['sub'],
        'user_email': stored.get('email', user.get('email', '')),
        'user_name': stored.get('name', ''),
        'message': (body.message or '').strip(),
        'status': 'pending',
        'created_at': datetime.now(timezone.utc),
        'decided_at': None,
        'decided_by_email': None,
    }
    await db.deploy_access_requests.insert_one(doc)
    logger.info('Deploy access requested by %s (%s)', doc['user_email'], doc['id'])
    return await _request_to_out(doc)


# ---------- Operator -------------------------------------------------
@router.get('/operator/deploy-access/requests')
async def op_list_requests(
    status: str = 'pending',
    _op: dict = Depends(get_current_operator),
):
    """List requests filtered by status (default: pending)."""
    valid = {'pending', 'approved', 'rejected', 'all'}
    if status not in valid:
        raise HTTPException(400, f'status must be one of {sorted(valid)}')
    query = {} if status == 'all' else {'status': status}
    docs = await db.deploy_access_requests.find(query).sort('created_at', -1).to_list(200)
    return [await _request_to_out(d) for d in docs]


async def _decide_request(req_id: str, decision: str, operator: dict) -> dict:
    if decision not in {'approved', 'rejected'}:
        raise HTTPException(400, 'Invalid decision')
    doc = await db.deploy_access_requests.find_one({'id': req_id})
    if not doc:
        raise HTTPException(404, 'Request not found')
    if doc.get('status') != 'pending':
        raise HTTPException(409, f"Request already {doc.get('status')}")
    now = datetime.now(timezone.utc)
    await db.deploy_access_requests.update_one(
        {'id': req_id},
        {'$set': {
            'status': decision,
            'decided_at': now,
            'decided_by_email': operator.get('email', ''),
        }},
    )
    if decision == 'approved':
        await db.users.update_one(
            {'id': doc['user_id']},
            {'$set': {'can_deploy': True, 'updated_at': now}},
        )
        logger.info('Granted deploy access to %s (%s) by %s',
                    doc.get('user_email'), doc['user_id'], operator.get('email'))
    fresh = await db.deploy_access_requests.find_one({'id': req_id})
    return await _request_to_out(fresh)


@router.post('/operator/deploy-access/requests/{request_id}/approve')
async def op_approve(request_id: str, op: dict = Depends(get_current_operator)):
    return await _decide_request(request_id, 'approved', op)


@router.post('/operator/deploy-access/requests/{request_id}/reject')
async def op_reject(request_id: str, op: dict = Depends(get_current_operator)):
    return await _decide_request(request_id, 'rejected', op)


@router.patch('/operator/users/{user_id}/deploy-access')
async def op_toggle_user(
    user_id: str,
    body: ToggleBody,
    op: dict = Depends(get_current_operator),
):
    """Direct toggle — bypasses the request queue. Operator UI control."""
    target = await db.users.find_one({'id': user_id}, {'email': 1, 'role': 1})
    if not target:
        raise HTTPException(404, 'User not found')
    if target.get('role') == 'operator':
        # Operators have implicit access — guard against the toggle being
        # accidentally flipped off and then masking the operator's deploy
        # buttons on the next session.
        raise HTTPException(400, 'Operators always have deploy access')
    await db.users.update_one(
        {'id': user_id},
        {'$set': {'can_deploy': bool(body.can_deploy),
                  'updated_at': datetime.now(timezone.utc)}},
    )
    # Mark any pending request as decided so it doesn't linger in the UI.
    if body.can_deploy:
        await db.deploy_access_requests.update_many(
            {'user_id': user_id, 'status': 'pending'},
            {'$set': {
                'status': 'approved',
                'decided_at': datetime.now(timezone.utc),
                'decided_by_email': op.get('email', ''),
            }},
        )
    logger.info('Operator %s set can_deploy=%s for %s',
                op.get('email'), body.can_deploy, target.get('email'))
    return {'user_id': user_id, 'can_deploy': bool(body.can_deploy)}


@router.get('/operator/deploy-access/default')
async def op_get_default(_op: dict = Depends(get_current_operator)):
    return {'default_can_deploy': await _default_can_deploy()}


@router.patch('/operator/deploy-access/default')
async def op_set_default(
    body: DefaultBody,
    _op: dict = Depends(get_current_operator),
):
    await db.payment_settings.update_one(
        {},
        {'$set': {'default_can_deploy': bool(body.default_can_deploy),
                  'updated_at': datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {'default_can_deploy': bool(body.default_can_deploy)}
