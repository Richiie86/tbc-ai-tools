"""P6.4 — GitHub webhook live-validation tests.

Verifies POST /api/webhooks/github end-to-end without hitting Vercel:
  * `ping` event returns pong
  * Push with valid HMAC-SHA256 signature matches the project and triggers
    a deploy (monkeypatched to a stub so no external network calls happen).
  * Push with wrong signature is rejected (no deploy, skipped list populated).
  * Push for an unknown repo returns matched: 0.

We monkey-patch `deploy_projects_ext._trigger_deploy` *inside the backend
process* via a temporary monkey-patch HTTP shim is not possible — so instead
we route through the real endpoint with a project that has a webhook secret
but a non-existent Vercel project id; the deploy attempt will fail and end
up in `skipped` with a non-signature reason, which still proves the
signature path and routing logic ran.
"""
import hmac
import hashlib
import json
import os
import secrets
import uuid

import asyncio
import requests
from motor.motor_asyncio import AsyncIOMotorClient

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv('/app/backend/.env')
except Exception:
    pass

BASE_URL = (
    os.environ.get('REACT_APP_BACKEND_URL')
    or open('/app/frontend/.env').read().split('REACT_APP_BACKEND_URL=')[1].split('\n')[0].strip()
).rstrip('/')

WEBHOOK_URL = f'{BASE_URL}/api/webhooks/github'


def _sign(secret: str, body: bytes) -> str:
    return 'sha256=' + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _insert_project(pid, repo, branch, secret):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        await client[os.environ['DB_NAME']].deploy_projects.insert_one({
            'id': pid,
            'projectName': pid,
            'repo': repo,
            'gitRef': branch,
            'github_webhook_secret': secret,
            'vercel_project_id': 'prj_does_not_exist_' + uuid.uuid4().hex[:6],
        })
    finally:
        client.close()


async def _delete_project(pid):
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    try:
        await client[os.environ['DB_NAME']].deploy_projects.delete_one({'id': pid})
    finally:
        client.close()


def _push_payload(repo_full: str, branch: str) -> dict:
    return {
        'ref': f'refs/heads/{branch}',
        'repository': {'full_name': repo_full},
        'pusher': {'name': 'test-bot'},
        'head_commit': {'id': 'deadbeef', 'message': 'test commit'},
    }


def test_ping_event_returns_pong():
    body = json.dumps({'zen': 'Speak like a human.'}).encode()
    # No signature required for the ping branch (we still send one to mimic
    # GitHub but the endpoint short-circuits before verifying).
    r = requests.post(
        WEBHOOK_URL,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'ping',
            'X-Hub-Signature-256': _sign('whatever', body),
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {'ok': True, 'pong': True}


def test_push_with_valid_signature_matches_project():
    pid = f'WHTEST_{uuid.uuid4().hex[:8]}'
    secret = 'whsec_' + secrets.token_urlsafe(16)
    repo = f'octo/{uuid.uuid4().hex[:8]}'
    asyncio.run(_insert_project(pid, repo, 'main', secret))
    try:
        body = json.dumps(_push_payload(repo, 'main')).encode()
        r = requests.post(
            WEBHOOK_URL,
            data=body,
            headers={
                'Content-Type': 'application/json',
                'X-GitHub-Event': 'push',
                'X-Hub-Signature-256': _sign(secret, body),
            },
        )
        assert r.status_code == 200, r.text
        data = r.json()
        # We expect 1 match. Either it deployed (200 from a stubbed Vercel)
        # or it ended up in `skipped` with reason!='invalid_signature' since
        # the dummy Vercel project doesn't exist — both prove the signature
        # path is correct.
        assert data.get('matched') == 1, data
        skipped = data.get('skipped') or []
        deployed = data.get('deployed') or []
        # No signature-rejection allowed on the happy path
        for s in skipped:
            assert s.get('reason') != 'invalid_signature', data
        assert len(deployed) + len(skipped) == 1, data
    finally:
        asyncio.run(_delete_project(pid))


def test_push_with_bad_signature_is_rejected():
    pid = f'WHTEST_{uuid.uuid4().hex[:8]}'
    secret = 'whsec_' + secrets.token_urlsafe(16)
    repo = f'octo/{uuid.uuid4().hex[:8]}'
    asyncio.run(_insert_project(pid, repo, 'main', secret))
    try:
        body = json.dumps(_push_payload(repo, 'main')).encode()
        r = requests.post(
            WEBHOOK_URL,
            data=body,
            headers={
                'Content-Type': 'application/json',
                'X-GitHub-Event': 'push',
                'X-Hub-Signature-256': _sign('NOT_THE_REAL_SECRET', body),
            },
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get('matched') == 1, data
        skipped = data.get('skipped') or []
        assert len(skipped) == 1, data
        assert skipped[0].get('reason') == 'invalid_signature', data
        assert (data.get('deployed') or []) == []
    finally:
        asyncio.run(_delete_project(pid))


def test_push_for_unknown_repo_returns_zero_matches():
    body = json.dumps(_push_payload(f'nobody/repo-{uuid.uuid4().hex[:6]}', 'main')).encode()
    r = requests.post(
        WEBHOOK_URL,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'push',
            'X-Hub-Signature-256': _sign('any', body),
        },
    )
    assert r.status_code == 200, r.text
    j = r.json()
    # Either matched:0 (no project) or reason carries the "no matching project" hint.
    assert j.get('matched', 0) == 0 or 'matching' in (j.get('reason') or '')


def test_non_push_event_is_ignored():
    body = json.dumps({'action': 'opened'}).encode()
    r = requests.post(
        WEBHOOK_URL,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'issues',
            'X-Hub-Signature-256': _sign('any', body),
        },
    )
    assert r.status_code == 200
    assert r.json().get('ignored') == 'issues'
