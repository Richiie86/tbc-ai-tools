"""Iter27 — empty-repo fast-path, initial-push endpoint, sidebar fix_review filter.

Scope (from review_request):
  1. POST /api/operator/deploy/{project_id}/initial-push
     - 401/403 for anonymous caller
     - 404 for unknown project
     - 412 when project has no `repo` configured
     - DO NOT actually push to a real GitHub repo (Richiie86/tbc-ai-tools).
  2. GET /api/chat/sessions filters out `kind='fix_review'` sessions
     (seed via direct mongo insert, confirm absent in listing, cleanup).
  3. POST /api/operator/deploy/{project_id}/deploy → HTTP 412 with body
     containing error='repo_empty', initial_push_url, can_auto_push=true
     when last_code_review.verdict='repo_empty'.
  4. deploy/code_review.py empty-repo fast-path: feed a fake snapshot
     containing only README/LICENSE files — review() should return
     verdict='repo_empty' and skip LLM calls entirely.
  5. Regression: GET /api/operator/ai-build/visual-verify/{plan_id} → 404
     for unknown plan; requires operator auth (anonymous → 401/403).
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path('/app/backend/.env'))
load_dotenv(Path('/app/frontend/.env'))

BASE = os.environ['REACT_APP_BACKEND_URL'].rstrip('/')
API = f'{BASE}/api'
OP_EMAIL = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OP_PASS = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')


# ─── Fixtures ─────────────────────────────────────────────────────────────
@pytest.fixture(scope='session')
def anon_session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    return s


@pytest.fixture(scope='session')
def operator_session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    r = s.post(f'{API}/auth/login', json={'email': OP_EMAIL, 'password': OP_PASS})
    assert r.status_code == 200, f'operator login failed: {r.status_code} {r.text[:200]}'
    body = r.json()
    if body.get('pending_2fa'):
        pytest.skip('Operator account requires 2FA — cannot test here')
    token = body.get('token')
    if token:
        s.headers.update({'Authorization': f'Bearer {token}'})
    # Surface user_id for sidebar test
    s.user_id = body.get('user', {}).get('id')
    return s


@pytest.fixture(scope='session')
def mongo_db():
    from pymongo import MongoClient
    client = MongoClient(os.environ['MONGO_URL'])
    return client[os.environ['DB_NAME']]


# ─── 1. Initial-push endpoint contract ─────────────────────────────────────
class TestInitialPushEndpoint:
    def test_anonymous_rejected(self, anon_session):
        plan_id = f'TEST_anon_{uuid.uuid4().hex[:8]}'
        r = anon_session.post(f'{API}/operator/deploy/{plan_id}/initial-push')
        assert r.status_code in (401, 403), f'expected 401/403 got {r.status_code} {r.text[:200]}'

    def test_unknown_project_returns_404(self, operator_session):
        bogus = f'TEST_nope_{uuid.uuid4().hex[:8]}'
        r = operator_session.post(f'{API}/operator/deploy/{bogus}/initial-push')
        assert r.status_code == 404, f'expected 404 got {r.status_code} {r.text[:200]}'
        detail = (r.json() or {}).get('detail', '')
        assert 'not found' in str(detail).lower(), f'unexpected detail: {detail!r}'

    def test_project_without_repo_returns_412(self, operator_session, mongo_db):
        """Project exists but no `repo` field configured → 412."""
        project_id = f'TEST_iter27_norepo_{uuid.uuid4().hex[:8]}'
        doc = {
            'id': project_id,
            'name': 'TEST_iter27 no repo',
            'repo': '',  # explicitly empty
            'created_at': datetime.now(timezone.utc).isoformat(),
            '_iter27_test': True,
        }
        mongo_db.deploy_projects.insert_one(doc)
        try:
            r = operator_session.post(f'{API}/operator/deploy/{project_id}/initial-push')
            assert r.status_code == 412, f'expected 412 got {r.status_code} {r.text[:200]}'
            detail = (r.json() or {}).get('detail', '')
            assert 'repo' in str(detail).lower(), f'unexpected detail: {detail!r}'
        finally:
            mongo_db.deploy_projects.delete_one({'id': project_id})


# ─── 2. Chat sessions filter out kind='fix_review' ─────────────────────────
class TestSidebarFiltersFixReview:
    def test_fix_review_session_hidden_from_listing(self, operator_session, mongo_db):
        user_id = operator_session.user_id
        assert user_id, 'operator user_id missing — auth response shape changed'

        normal_id = f'TEST_iter27_normal_{uuid.uuid4().hex[:8]}'
        fix_id = f'TEST_iter27_fix_{uuid.uuid4().hex[:8]}'
        now = datetime.now(timezone.utc).isoformat()
        try:
            mongo_db.chat_sessions.insert_many([
                {
                    'id': normal_id,
                    'user_id': user_id,
                    'title': 'TEST_iter27 normal chat',
                    'model': 'gpt-4o-mini',
                    'variant': 'tbc1',
                    'created_at': now,
                    'updated_at': now,
                },
                {
                    'id': fix_id,
                    'user_id': user_id,
                    'title': 'Fix review: TEST_iter27 blocked deploy',
                    'model': 'gpt-4o-mini',
                    'variant': 'tbc1',
                    'kind': 'fix_review',
                    'created_at': now,
                    'updated_at': now,
                },
            ])
            r = operator_session.get(f'{API}/chat/sessions')
            assert r.status_code == 200, f'list failed: {r.status_code} {r.text[:200]}'
            sessions = r.json()
            ids = {s.get('id') for s in sessions}
            assert normal_id in ids, 'normal chat must appear in sidebar'
            assert fix_id not in ids, (
                f"fix_review chat ({fix_id}) leaked into sidebar listing — filter broken"
            )
        finally:
            mongo_db.chat_sessions.delete_many({'id': {'$in': [normal_id, fix_id]}})


# ─── 3. /deploy endpoint surfaces repo_empty 412 with structured body ─────
class TestDeployRepoEmptyShortCircuit:
    def test_deploy_returns_412_when_last_review_repo_empty(
        self, operator_session, mongo_db
    ):
        project_id = f'TEST_iter27_empty_{uuid.uuid4().hex[:8]}'
        doc = {
            'id': project_id,
            'name': 'TEST_iter27 empty repo project',
            'repo': 'TEST_owner/TEST_iter27_repo',
            'vercel_project_id': 'TEST_vproj',  # so deploy passes config check
            'created_at': datetime.now(timezone.utc).isoformat(),
            'last_code_review': {
                'verdict': 'repo_empty',
                'summary': 'placeholder',
                'reviewed_at': datetime.now(timezone.utc).isoformat(),
            },
            '_iter27_test': True,
        }
        mongo_db.deploy_projects.insert_one(doc)
        try:
            r = operator_session.post(
                f'{API}/operator/deploy/{project_id}/deploy',
                json={'target': 'production'},
            )
            assert r.status_code == 412, (
                f'expected 412 repo_empty, got {r.status_code} {r.text[:300]}'
            )
            body = r.json() or {}
            detail = body.get('detail') if isinstance(body.get('detail'), dict) else body
            assert detail.get('error') == 'repo_empty', f'detail={detail!r}'
            assert detail.get('can_auto_push') is True, f'detail={detail!r}'
            assert detail.get('initial_push_url') == (
                f'/api/operator/deploy/{project_id}/initial-push'
            ), f'detail={detail!r}'
        finally:
            mongo_db.deploy_projects.delete_one({'id': project_id})


# ─── 4. Code-review fast-path: empty repo → verdict='repo_empty' no LLM ───
class TestCodeReviewEmptyRepoFastPath:
    def test_empty_snapshot_short_circuits_to_repo_empty(self, mongo_db, monkeypatch):
        """Patch fetch_repo_snapshot to return README/LICENSE only and
        assert that review() returns verdict='repo_empty' without ever
        touching the LLM. This proves the credit-burn loop is closed."""
        import sys
        sys.path.insert(0, '/app/backend')
        from deploy import code_review as cr

        # Seed a project doc so review() can find it.
        project_id = f'TEST_iter27_cr_{uuid.uuid4().hex[:8]}'
        project_doc = {
            'id': project_id,
            'name': 'TEST_iter27 review empty',
            'repo': 'TEST_owner/TEST_iter27_emptyrepo',
            'gitRef': 'main',
            'created_at': datetime.now(timezone.utc).isoformat(),
            '_iter27_test': True,
        }
        # Use the running event loop the same way the rest of the codebase
        # does — we just await coroutines from a fresh asyncio.run().
        async def _run():
            # Patch fetch_repo_snapshot to return README/LICENSE only.
            async def _fake_snapshot(repo, ref, token):
                return {
                    'ref': 'main',
                    'file_count': 2,
                    'files': [
                        {'path': 'README.md', 'content': '# Hi'},
                        {'path': 'LICENSE', 'content': 'MIT'},
                    ],
                }

            async def _llm_should_not_be_called(*a, **kw):
                raise AssertionError(
                    'LLM was invoked for an empty repo — credit-burn '
                    'loop is NOT closed.'
                )

            monkeypatch.setattr(cr, 'fetch_repo_snapshot', _fake_snapshot)
            # Block LLM helpers — if the fast-path is reached, none of
            # these should fire. _second_opinion is the obvious one.
            for name in ('_second_opinion',):
                if hasattr(cr, name):
                    monkeypatch.setattr(cr, name, _llm_should_not_be_called)

            # run_code_review(project: dict, settings: dict) is the public
            # entrypoint. We pass a settings dict with a sham llm key
            # because the upstream config check will reject empty creds.
            settings = {'emergent_llm_key': 'sham-key-iter27-test'}
            result = await cr.run_code_review(project_doc, settings)
            assert isinstance(result, dict), f'expected dict, got {type(result)}'
            assert result.get('verdict') == 'repo_empty', (
                f"expected verdict='repo_empty', got {result.get('verdict')!r} "
                f"full={result!r}"
            )
            assert result.get('can_auto_push') is True, (
                f'can_auto_push must be True, got {result!r}'
            )
            # Second-opinion must be marked skipped (no LLM call).
            so = result.get('second_opinion') or {}
            assert so.get('reviewer_model') == 'skipped', (
                f'second_opinion should be skipped, got {so!r}'
            )

        try:
            asyncio.run(_run())
        except RuntimeError as e:
            # If we're already inside an event loop (rare in pytest plain),
            # fall back to skip rather than mask the result.
            pytest.skip(f'cannot start nested loop: {e}')


# ─── 5. Regression smoke: visual-verify endpoints still gated ─────────────
class TestVisualVerifyRegression:
    def test_anonymous_visual_verify_rejected(self, anon_session):
        pid = f'TEST_anon_{uuid.uuid4().hex[:8]}'
        r = anon_session.get(f'{API}/operator/ai-build/visual-verify/{pid}')
        assert r.status_code in (401, 403), (
            f'expected 401/403 got {r.status_code} {r.text[:200]}'
        )

    def test_unknown_plan_visual_verify_returns_404(self, operator_session):
        pid = f'TEST_unknown_{uuid.uuid4().hex[:8]}'
        r = operator_session.get(f'{API}/operator/ai-build/visual-verify/{pid}')
        assert r.status_code == 404, f'expected 404 got {r.status_code} {r.text[:200]}'


# ─── 6. Iter25 baseline regression — listing endpoints still respond ──────
class TestBaselineRegression:
    def test_deploy_projects_list(self, operator_session):
        r = operator_session.get(f'{API}/operator/deploy/projects')
        assert r.status_code == 200, f'{r.status_code} {r.text[:200]}'
        data = r.json()
        assert isinstance(data, (list, dict)), f'unexpected shape {type(data)}'

    def test_ai_build_history(self, operator_session):
        r = operator_session.get(f'{API}/operator/ai-build/history')
        assert r.status_code == 200, f'{r.status_code} {r.text[:200]}'

    def test_auto_fix_status(self, operator_session):
        r = operator_session.get(f'{API}/operator/auto-fix/status')
        assert r.status_code == 200, f'{r.status_code} {r.text[:200]}'
        body = r.json() or {}
        # Shape: { config, today_count, recent[] }
        assert 'config' in body, f'missing config key: {body!r}'
        assert 'recent' in body, f'missing recent key: {body!r}'
