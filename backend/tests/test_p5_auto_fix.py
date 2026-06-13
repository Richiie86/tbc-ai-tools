"""P5 tests for the auto-fix loop (do_not_ship → patch → commit → re-review).

We monkeypatch both `deploy.auto_fix.request_patches` and
`deploy.auto_fix.commit_patches` so the test never talks to GitHub. The
review function is *also* monkeypatched (on the autopilot module) so we can
drive the verdict trajectory deterministically: first call returns
`do_not_ship`, subsequent calls return `ship` (simulating "fix worked").
"""
import json
import os
import sys
from datetime import datetime, timezone

import httpx
import pymongo
import pytest
import pytest_asyncio

pytestmark = pytest.mark.asyncio(loop_scope='session')

sys.path.insert(0, '/app/backend')
from server import app  # noqa: E402
from auth_utils import get_current_operator, get_current_user  # noqa: E402

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')
SEED_ID = 'autofix-test-project'
FAKE_OPERATOR = {
    'sub': 'autofix-test-user', 'email': 'autofix-test@local',
    'role': 'operator', 'is_operator': True,
}


def parse_sse(body: str) -> list:
    out = []
    for raw in body.split('\n\n'):
        if not raw.strip():
            continue
        ev = None
        data_lines = []
        for line in raw.split('\n'):
            if line.startswith('event:'):
                ev = line[6:].strip()
            elif line.startswith('data:'):
                data_lines.append(line[5:].strip())
        try:
            data = json.loads('\n'.join(data_lines)) if data_lines else {}
        except Exception:
            data = {'_raw': '\n'.join(data_lines)}
        out.append({'event': ev, 'data': data})
    return out


@pytest.fixture(scope='module')
def mongo_db():
    return pymongo.MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture(scope='module', autouse=True)
def _patch_and_seed(mongo_db):
    now = datetime.now(timezone.utc)
    seed = {
        'id': SEED_ID, 'projectName': 'AutoFix Project',
        'repo': 'octocat/Hello-World', 'repoType': 'github', 'gitRef': 'master',
        'domain': 'autofix.tbctools.test',
        'created_at': now, 'updated_at': now,
        '_initial_verdict': 'do_not_ship',
    }
    mongo_db.deploy_projects.replace_one({'id': SEED_ID}, seed, upsert=True)

    from deploy import auto_fix as _auto_fix_mod
    from deploy import autopilot as _autopilot_mod

    # Verdict state machine: the first call returns do_not_ship, subsequent
    # calls return ship. The fixture is scoped per-test-run so each test gets
    # a fresh counter via the `verdict_counter` dict.
    counter = {'n': 0}

    async def fake_review(project, settings):
        counter['n'] += 1
        verdict = 'do_not_ship' if counter['n'] == 1 else 'ship'
        review = {
            'verdict': verdict,
            'summary': f'Iteration {counter["n"]}',
            'findings': (
                [{'severity': 'high', 'file': 'README',
                  'title': 'Bad readme',
                  'explanation': 'Sample issue.',
                  'suggested_fix': 'Rewrite README.'}]
                if verdict == 'do_not_ship' else []
            ),
            'missing_files': [],
            'ref': 'master',
            'project_id': project['id'],
            'repo': project['repo'],
            'files_sampled': ['README'],
            'reviewed_at': datetime.now(timezone.utc).isoformat(),
        }
        from db import db as _async_db
        await _async_db.deploy_projects.update_one(
            {'id': project['id']},
            {'$set': {'last_code_review': review,
                      'last_code_review_at': datetime.now(timezone.utc)}},
        )
        return review

    async def fake_request_patches(project, review, settings):
        return {
            'patches': [{'path': 'README',
                         'content': '# Patched by autopilot test',
                         'rationale': 'rewrite readme'}],
            'commit_message': 'fix: address findings',
            'fetched_files': {'README': {'sha': 'cafef00d',
                                         'content': '# old'}},
        }

    async def fake_commit_patches(project, patches, commit_message, fetched_files, settings):
        return [{'path': p['path'], 'new_sha': 'newsha123',
                 'commit_sha': 'commitsha456',
                 'commit_url': 'https://github.com/test/commit/abc',
                 'rationale': p.get('rationale')}
                for p in patches]

    orig_review = _autopilot_mod.run_code_review
    orig_req = _auto_fix_mod.request_patches
    orig_commit = _auto_fix_mod.commit_patches

    _autopilot_mod.run_code_review = fake_review
    _auto_fix_mod.request_patches = fake_request_patches
    _auto_fix_mod.commit_patches = fake_commit_patches

    app.dependency_overrides[get_current_operator] = lambda: FAKE_OPERATOR
    app.dependency_overrides[get_current_user] = lambda: FAKE_OPERATOR

    # Reset the counter at the start of each test by exposing it via the
    # fixture return so individual tests can call `reset()`.
    def reset():
        counter['n'] = 0
    yield {'reset': reset}

    _autopilot_mod.run_code_review = orig_review
    _auto_fix_mod.request_patches = orig_req
    _auto_fix_mod.commit_patches = orig_commit
    app.dependency_overrides.pop(get_current_operator, None)
    app.dependency_overrides.pop(get_current_user, None)
    mongo_db.deploy_projects.delete_one({'id': SEED_ID})


@pytest_asyncio.fixture(loop_scope='session')
async def client(_patch_and_seed):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test',
                                 cookies={'tbc_session': 'fake'}) as c:
        yield c


# --- (1) auto_fix_max_iterations=0 → still hits gate_blocked --------------
@pytest.mark.asyncio(loop_scope='session')
async def test_disabled_autofix_still_blocks(client, _patch_and_seed):
    _patch_and_seed['reset']()
    r = await client.post(
        f'/api/operator/deploy/{SEED_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0,
              'auto_fix_max_iterations': 0},
        timeout=30,
    )
    assert r.status_code == 200
    events = [f['event'] for f in parse_sse(r.text)]
    assert 'auto_fix_start' not in events
    assert events[-1] == 'gate_blocked'


# --- (2) auto_fix=1 → fix runs, second review returns ship, deploy fires --
@pytest.mark.asyncio(loop_scope='session')
async def test_autofix_converges_to_ship(client, _patch_and_seed):
    _patch_and_seed['reset']()
    r = await client.post(
        f'/api/operator/deploy/{SEED_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0,
              'auto_fix_max_iterations': 2},
        timeout=30,
    )
    assert r.status_code == 200
    frames = parse_sse(r.text)
    events = [f['event'] for f in frames]
    # Expected ordering:
    #   loop_start, review_start, review_done(do_not_ship),
    #   auto_fix_start, auto_fix_patches, auto_fix_committed,
    #   review_start, review_done(ship),
    #   deploy_start, ... loop_error (no real Vercel)
    assert events[:6] == [
        'loop_start', 'review_start', 'review_done',
        'auto_fix_start', 'auto_fix_patches', 'auto_fix_committed',
    ], events
    assert 'gate_blocked' not in events, events

    # Second review_done event should carry verdict=ship and iteration=1.
    second_review = [f for f in frames if f['event'] == 'review_done'][1]
    assert second_review['data'].get('verdict') == 'ship'
    assert second_review['data'].get('iteration') == 1

    # We then enter the deploy stage (and 503 out because no Vercel token).
    assert 'deploy_start' in events
    assert events[-1] == 'loop_error'


# --- (3) auto_fix=2 but verdict stays do_not_ship → exhausted gate --------
@pytest.mark.asyncio(loop_scope='session')
async def test_autofix_exhausted_emits_gate_blocked(client, mongo_db, _patch_and_seed):
    # Force the fake review to ALWAYS return do_not_ship for this test by
    # rebinding the run_code_review on the autopilot module.
    from deploy import autopilot as _autopilot_mod
    orig = _autopilot_mod.run_code_review

    async def always_block(project, settings):
        review = {
            'verdict': 'do_not_ship', 'summary': 'still bad',
            'findings': [{'severity': 'high', 'file': 'README',
                          'title': 'x', 'explanation': 'y',
                          'suggested_fix': 'z'}],
            'missing_files': [], 'ref': 'master',
            'project_id': project['id'], 'repo': project['repo'],
            'files_sampled': ['README'],
            'reviewed_at': datetime.now(timezone.utc).isoformat(),
        }
        from db import db as _async_db
        await _async_db.deploy_projects.update_one(
            {'id': project['id']},
            {'$set': {'last_code_review': review,
                      'last_code_review_at': datetime.now(timezone.utc)}},
        )
        return review

    _autopilot_mod.run_code_review = always_block
    try:
        r = await client.post(
            f'/api/operator/deploy/{SEED_ID}/autopilot',
            json={'target': 'preview', 'watch_timeout_s': 0,
                  'auto_fix_max_iterations': 2},
            timeout=30,
        )
        assert r.status_code == 200
        events = [f['event'] for f in parse_sse(r.text)]
        # Two fix iterations + a final review that's still do_not_ship.
        assert events.count('auto_fix_start') == 2
        assert events.count('auto_fix_committed') == 2
        assert events[-1] == 'gate_blocked'
    finally:
        _autopilot_mod.run_code_review = orig


# --- (4) Hard cap: caller sends 999 → silently capped at 5 ----------------
@pytest.mark.asyncio(loop_scope='session')
async def test_autofix_max_iterations_hard_capped(client, _patch_and_seed):
    _patch_and_seed['reset']()
    r = await client.post(
        f'/api/operator/deploy/{SEED_ID}/autopilot',
        json={'target': 'preview', 'watch_timeout_s': 0,
              'auto_fix_max_iterations': 999},
        timeout=30,
    )
    assert r.status_code == 200
    frames = parse_sse(r.text)
    loop_start = frames[0]
    assert loop_start['event'] == 'loop_start'
    assert loop_start['data']['auto_fix_max_iterations'] == 5
