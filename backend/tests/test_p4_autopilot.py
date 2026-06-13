"""P4 tests for the Autopilot SSE loop. Uses httpx.AsyncClient + ASGITransport
against the in-process FastAPI app so we can monkeypatch
deploy_projects_ext._run_code_review without needing GitHub.

Scenarios covered:
  (1) do_not_ship → gate_blocked SSE frame w/ fix_chat_session_id + next_action
  (2) bypass_review=true → no gate_blocked; deploy_start fires; loop_error
      from deploy stage (no Vercel token in test env)
  (3) unknown project id → single loop_error frame with 'Project not found'
  (4) ship verdict → gate is skipped (deploy_start fires)
  (5) AI surface: 401 (regular HTTP) without auth; same SSE shape with Bearer
"""
import json
import os
import sys
from datetime import datetime, timezone

import httpx
import pymongo
import pytest
import pytest_asyncio

pytestmark = pytest.mark.asyncio(loop_scope='module')

sys.path.insert(0, '/app/backend')
import deploy_projects_ext  # noqa: E402
from server import app  # noqa: E402
from auth_utils import get_current_operator, get_current_user  # noqa: E402

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')
SEED_BLOCKED_ID = 'autopilot-test-blocked'
SEED_SHIP_ID = 'autopilot-test-ship'
FAKE_OPERATOR = {'sub': 'autopilot-test-user', 'email': 'autopilot-test@local',
                 'role': 'operator', 'is_operator': True}


def parse_sse_text(body: str) -> list:
    """Parse an SSE response body into [{'event': str, 'data': obj}, ...]."""
    frames = []
    for raw_frame in body.split('\n\n'):
        if not raw_frame.strip():
            continue
        event = None
        data_lines = []
        for line in raw_frame.split('\n'):
            if line.startswith('event:'):
                event = line[len('event:'):].strip()
            elif line.startswith('data:'):
                data_lines.append(line[len('data:'):].strip())
        data_text = '\n'.join(data_lines)
        try:
            data_obj = json.loads(data_text) if data_text else {}
        except Exception:
            data_obj = {'_raw': data_text}
        frames.append({'event': event, 'data': data_obj})
    return frames


@pytest.fixture(scope='module')
def mongo_db():
    return pymongo.MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture(scope='module', autouse=True)
def _seed_projects_and_patch(mongo_db):
    now = datetime.now(timezone.utc)
    base = {
        'projectName': 'Autopilot Test',
        'repo': 'octocat/Hello-World',
        'repoType': 'github',
        'gitRef': 'master',
        'domain': 'autopilot-test.tbctools.test',
        'created_at': now,
        'updated_at': now,
    }
    blocked_doc = {**base, 'id': SEED_BLOCKED_ID,
                   '_verdict_for_test': 'do_not_ship'}
    ship_doc = {**base, 'id': SEED_SHIP_ID,
                'projectName': 'Autopilot Ship',
                'domain': 'autopilot-ship.tbctools.test',
                '_verdict_for_test': 'ship'}
    mongo_db.deploy_projects.replace_one({'id': SEED_BLOCKED_ID}, blocked_doc, upsert=True)
    mongo_db.deploy_projects.replace_one({'id': SEED_SHIP_ID}, ship_doc, upsert=True)

    orig_review = deploy_projects_ext._run_code_review

    async def fake_review(project, settings):
        verdict = project.get('_verdict_for_test', 'ship')
        review = {
            'verdict': verdict,
            'summary': f'Canned review verdict={verdict}',
            'findings': [
                {'severity': 'high', 'file': 'config.py',
                 'title': 'Hardcoded secret',
                 'explanation': 'API key committed.',
                 'suggested_fix': 'Move to env var.'}
            ] if verdict == 'do_not_ship' else [],
            'missing_files': [],
            'ref': project.get('gitRef') or 'main',
            'project_id': project['id'],
            'repo': project['repo'],
            'files_sampled': [],
            'reviewed_at': datetime.now(timezone.utc).isoformat(),
        }
        from db import db as _async_db
        await _async_db.deploy_projects.update_one(
            {'id': project['id']},
            {'$set': {'last_code_review': review,
                      'last_code_review_at': datetime.now(timezone.utc)}},
        )
        return review

    deploy_projects_ext._run_code_review = fake_review

    # Override the operator-auth dependency so we don't need real cookies.
    app.dependency_overrides[get_current_operator] = lambda: FAKE_OPERATOR
    app.dependency_overrides[get_current_user] = lambda: FAKE_OPERATOR

    # Ensure an ai_api_key is configured for the bearer-auth surface.
    test_ai_key = 'tbc_test_p4_autopilot_key'
    mongo_db.settings.update_one(
        {'_id': 'payment_settings'},
        {'$set': {'ai_api_key': test_ai_key}},
        upsert=True,
    )

    yield {'ai_key': test_ai_key}

    deploy_projects_ext._run_code_review = orig_review
    app.dependency_overrides.pop(get_current_operator, None)
    app.dependency_overrides.pop(get_current_user, None)
    mongo_db.deploy_projects.delete_one({'id': SEED_BLOCKED_ID})
    mongo_db.deploy_projects.delete_one({'id': SEED_SHIP_ID})
    sessions = list(mongo_db.chat_sessions.find(
        {'title': {'$regex': '^Fix review:'}}, {'id': 1}))
    for s in sessions:
        mongo_db.chat_messages.delete_many({'session_id': s['id']})
        mongo_db.chat_sessions.delete_one({'id': s['id']})


@pytest_asyncio.fixture(loop_scope="module")
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as c:
        yield c


# ---------- (1) do_not_ship → gate_blocked ----------
@pytest.mark.asyncio(loop_scope="module")
async def test_do_not_ship_emits_gate_blocked(client):
    r = await client.post(
        f'/api/operator/deploy/{SEED_BLOCKED_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert 'text/event-stream' in r.headers.get('content-type', '')
    frames = parse_sse_text(r.text)
    events = [f['event'] for f in frames]
    assert events[:4] == ['loop_start', 'review_start', 'review_done', 'gate_blocked'], events
    assert events[-1] == 'gate_blocked', events
    assert 'deploy_start' not in events

    gate = frames[3]['data']
    assert gate.get('verdict') == 'do_not_ship'
    fix_id = gate.get('fix_chat_session_id')
    assert isinstance(fix_id, str) and len(fix_id) >= 8
    assert isinstance(gate.get('next_action'), str) and len(gate['next_action']) > 0


# ---------- (2) bypass_review skips gate ----------
@pytest.mark.asyncio(loop_scope="module")
async def test_bypass_review_skips_gate(client):
    r = await client.post(
        f'/api/operator/deploy/{SEED_BLOCKED_ID}/autopilot',
        json={'target': 'preview', 'bypass_review': True, 'watch_timeout_s': 0},
        timeout=30,
    )
    assert r.status_code == 200
    frames = parse_sse_text(r.text)
    events = [f['event'] for f in frames]
    assert 'gate_blocked' not in events, events
    assert events[:4] == ['loop_start', 'review_start', 'review_done', 'deploy_start'], events
    assert events[-1] == 'loop_error', events
    assert frames[-1]['data'].get('stage') == 'deploy'


# ---------- (3) unknown project → single loop_error ----------
@pytest.mark.asyncio(loop_scope="module")
async def test_unknown_project_emits_single_loop_error(client):
    r = await client.post(
        '/api/operator/deploy/no-such-id/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0},
        timeout=30,
    )
    assert r.status_code == 200
    frames = parse_sse_text(r.text)
    assert len(frames) == 1, [f['event'] for f in frames]
    assert frames[0]['event'] == 'loop_error'
    assert 'Project not found' in frames[0]['data'].get('message', '')


# ---------- (4) ship verdict skips gate ----------
@pytest.mark.asyncio(loop_scope="module")
async def test_ship_verdict_skips_gate(client):
    r = await client.post(
        f'/api/operator/deploy/{SEED_SHIP_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0},
        timeout=30,
    )
    assert r.status_code == 200
    frames = parse_sse_text(r.text)
    events = [f['event'] for f in frames]
    assert 'gate_blocked' not in events, events
    assert events[:4] == ['loop_start', 'review_start', 'review_done', 'deploy_start'], events
    assert events[-1] == 'loop_error', events
    assert frames[-1]['data'].get('stage') == 'deploy'


# ---------- (5) AI surface ----------
@pytest.mark.asyncio(loop_scope="module")
async def test_ai_surface_unauth_returns_401(client):
    r = await client.post(
        f'/api/projects/{SEED_BLOCKED_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0},
        timeout=15,
    )
    assert r.status_code == 401
    assert 'text/event-stream' not in r.headers.get('content-type', '')


@pytest.mark.asyncio(loop_scope="module")
async def test_ai_surface_bearer_same_sse_shape(client, _seed_projects_and_patch):
    ai_key = _seed_projects_and_patch['ai_key']
    r = await client.post(
        f'/api/projects/{SEED_BLOCKED_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0},
        headers={'Authorization': f'Bearer {ai_key}'},
        timeout=30,
    )
    assert r.status_code == 200
    assert 'text/event-stream' in r.headers.get('content-type', '')
    frames = parse_sse_text(r.text)
    events = [f['event'] for f in frames]
    assert events[:4] == ['loop_start', 'review_start', 'review_done', 'gate_blocked'], events
