"""Iter28 backend tests:
- /api/operator/deploy/{id}/suggestions POST/GET (404/412/auth, cache)
- /api/operator/ai-build/plan accepts optional `source` field
- auto-fix config exposes auto_push_empty_repo (default false)
- _auto_fix_empty_repo_sweep helper exists, called before runtime-error sweep
- do_initial_push reusable helper importable from auto_fix_loop_ext path
- /initial-push 404 for unknown projects (regression)
"""
import os
import uuid
import asyncio
from datetime import datetime, timezone

import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
API = f'{BASE_URL}/api'
OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')


@pytest.fixture(scope='module')
def op_token():
    r = requests.post(f'{API}/auth/login', json={
        'email': OP_EMAIL, 'password': OP_PASSWORD,
    }, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()['token']


@pytest.fixture(scope='module')
def op_headers(op_token):
    return {'Authorization': f'Bearer {op_token}'}


# ─── Helpers: direct mongo for seed/cleanup ────────────────────────────────
@pytest.fixture(scope='module')
def mongo():
    from pymongo import MongoClient
    client = MongoClient(os.environ['MONGO_URL'])
    yield client[os.environ['DB_NAME']]
    client.close()


# ─── Suggestions endpoint ─────────────────────────────────────────────────
class TestSuggestionsAuth:
    def test_post_requires_auth(self):
        r = requests.post(f'{API}/operator/deploy/anything/suggestions', timeout=10)
        assert r.status_code in (401, 403), r.text

    def test_get_requires_auth(self):
        r = requests.get(f'{API}/operator/deploy/anything/suggestions', timeout=10)
        assert r.status_code in (401, 403), r.text


class TestSuggestionsContract:
    def test_post_unknown_project_404(self, op_headers):
        r = requests.post(f'{API}/operator/deploy/TEST_iter28_unknown_{uuid.uuid4().hex}/suggestions',
                          headers=op_headers, timeout=10)
        assert r.status_code == 404, r.text

    def test_get_unknown_project_404(self, op_headers):
        r = requests.get(f'{API}/operator/deploy/TEST_iter28_unknown_{uuid.uuid4().hex}/suggestions',
                         headers=op_headers, timeout=10)
        assert r.status_code == 404, r.text

    def test_post_project_without_repo_412(self, op_headers, mongo):
        pid = f'TEST_iter28_norepo_{uuid.uuid4().hex}'
        mongo.deploy_projects.insert_one({
            'id': pid, 'projectName': 'TEST iter28 norepo', 'repo': '',
            'created_at': datetime.now(timezone.utc),
        })
        try:
            r = requests.post(f'{API}/operator/deploy/{pid}/suggestions',
                              headers=op_headers, timeout=10)
            assert r.status_code == 412, r.text
        finally:
            mongo.deploy_projects.delete_one({'id': pid})

    def test_get_no_cache_returns_empty(self, op_headers, mongo):
        """GET on a project with no last_suggestions returns {suggestions:[]}."""
        pid = f'TEST_iter28_nocache_{uuid.uuid4().hex}'
        mongo.deploy_projects.insert_one({
            'id': pid, 'projectName': 'TEST iter28 nocache',
            'repo': 'fake/repo', 'created_at': datetime.now(timezone.utc),
        })
        try:
            r = requests.get(f'{API}/operator/deploy/{pid}/suggestions',
                             headers=op_headers, timeout=10)
            assert r.status_code == 200, r.text
            data = r.json()
            assert data.get('suggestions') == []
        finally:
            mongo.deploy_projects.delete_one({'id': pid})

    def test_get_cached_payload_shape(self, op_headers, mongo):
        """GET returns the seeded cache payload as-is."""
        pid = f'TEST_iter28_cached_{uuid.uuid4().hex}'
        seeded = {
            'summary': 'Looks healthy',
            'suggestions': [{
                'priority': 'high', 'title': 'Add Redis ratelimit',
                'rationale': 'demo', 'files': ['backend/server.py'],
                'implementation_prompt': 'Add a Redis ratelimit.', 'effort': 'medium',
            }],
            'reviewed_at': datetime.now(timezone.utc).isoformat(),
            'ref': 'main', 'repo': 'fake/repo', 'project_id': pid,
            'reviewer_model': 'gpt-4o', 'files_sampled': ['backend/server.py'],
        }
        mongo.deploy_projects.insert_one({
            'id': pid, 'projectName': 'TEST iter28 cached', 'repo': 'fake/repo',
            'last_suggestions': seeded, 'created_at': datetime.now(timezone.utc),
        })
        try:
            r = requests.get(f'{API}/operator/deploy/{pid}/suggestions',
                             headers=op_headers, timeout=10)
            assert r.status_code == 200, r.text
            data = r.json()
            assert data['summary'] == 'Looks healthy'
            assert len(data['suggestions']) == 1
            assert data['suggestions'][0]['priority'] == 'high'
            assert data['suggestions'][0]['title'] == 'Add Redis ratelimit'
        finally:
            mongo.deploy_projects.delete_one({'id': pid})


# ─── AI build plan accepts source field ────────────────────────────────────
class TestPlanRequestSource:
    def test_plan_request_model_accepts_source(self):
        from ai_build_ext import PlanRequest
        req = PlanRequest(project_id='x', prompt='hello world', source='suggestion')
        assert req.source == 'suggestion'

    def test_plan_request_default_source_is_manual(self):
        from ai_build_ext import PlanRequest
        req = PlanRequest(project_id='x', prompt='hello world')
        assert req.source == 'manual'

    def test_plan_endpoint_does_not_422_on_source(self, op_headers):
        """The endpoint may fail later (no project), but should NOT 422 on the source field."""
        r = requests.post(f'{API}/operator/ai-build/plan',
                          headers=op_headers,
                          json={'project_id': 'TEST_iter28_doesnotexist',
                                'prompt': 'add a sitemap.xml route', 'source': 'suggestion'},
                          timeout=10)
        # Should be 404 (project not found) not 422 (validation)
        assert r.status_code != 422, r.text
        assert r.status_code == 404, r.text


# ─── Auto-fix config exposes auto_push_empty_repo ──────────────────────────
class TestAutoFixConfig:
    def test_status_includes_auto_push_empty_repo(self, op_headers):
        r = requests.get(f'{API}/operator/auto-fix/status', headers=op_headers, timeout=10)
        assert r.status_code == 200, r.text
        cfg = r.json().get('config') or {}
        assert 'auto_push_empty_repo' in cfg, f'config missing auto_push_empty_repo: {cfg}'
        # Default false
        assert cfg['auto_push_empty_repo'] is False


# ─── Helpers exist and are importable ──────────────────────────────────────
class TestHelperImports:
    def test_do_initial_push_importable(self):
        from deploy_initial_push_ext import do_initial_push
        assert callable(do_initial_push)

    def test_empty_repo_sweep_helper_exists(self):
        from auto_fix_loop_ext import _auto_fix_empty_repo_sweep
        assert callable(_auto_fix_empty_repo_sweep)

    def test_empty_repo_sweep_called_in_run_auto_fix_tick(self):
        """Verify _auto_fix_empty_repo_sweep is called BEFORE the runtime-error
        cursor read in run_auto_fix_tick — by reading the module source."""
        import inspect
        from auto_fix_loop_ext import run_auto_fix_tick
        src = inspect.getsource(run_auto_fix_tick)
        assert '_auto_fix_empty_repo_sweep' in src
        empty_pos = src.find('_auto_fix_empty_repo_sweep')
        runtime_pos = src.find('db.runtime_errors.find')
        assert empty_pos > 0 and runtime_pos > 0
        assert empty_pos < runtime_pos, 'empty_repo sweep must be called BEFORE runtime-error sweep'

    def test_empty_repo_sweep_output_shape(self):
        """When auto_push_empty_repo=False, the helper returns empty stats (no-op)."""
        from auto_fix_loop_ext import _auto_fix_empty_repo_sweep
        out = asyncio.run(_auto_fix_empty_repo_sweep({'auto_push_empty_repo': False}))
        assert out == {'processed': 0, 'pushed': 0, 'errors': []}


# ─── /initial-push regression ──────────────────────────────────────────────
class TestInitialPushRegression:
    def test_unknown_project_404(self, op_headers):
        r = requests.post(f'{API}/operator/deploy/TEST_iter28_unknown_pid_{uuid.uuid4().hex}/initial-push',
                          headers=op_headers, timeout=10)
        assert r.status_code == 404, r.text

    def test_requires_auth(self):
        r = requests.post(f'{API}/operator/deploy/anything/initial-push', timeout=10)
        assert r.status_code in (401, 403), r.text


# ─── Baseline: deploy & ai-build endpoints still respond ───────────────────
class TestBaselineRegression:
    def test_deploy_projects_list(self, op_headers):
        r = requests.get(f'{API}/operator/deploy/projects', headers=op_headers, timeout=10)
        assert r.status_code == 200, r.text

    def test_ai_build_history(self, op_headers):
        r = requests.get(f'{API}/operator/ai-build/history', headers=op_headers, timeout=10)
        assert r.status_code == 200, r.text
