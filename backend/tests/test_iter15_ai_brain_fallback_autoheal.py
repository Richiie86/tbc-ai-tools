"""Iter 15 — AI Brain endpoints + chat fallback wiring + per-project Self-healing toggle.

Covers:
  - GET /api/operator/ai-brain/maturity (200 + bucket schema)
  - GET /api/operator/ai-brain/timeline?weeks=4 (200 + 5 buckets)
  - GET /api/operator/ai-brain/skills (200 + bucket schema, deploy/voice keyword hits)
  - PATCH /api/operator/deploy/{project_id} with auto_heal true/false + combined toggle
  - Chat stream happy path emits delta → done frames (sanity that fallback wrapper didn't break it)
"""
import os
import json
import time
import uuid
import pytest
import requests

from tests._creds import OPERATOR_EMAIL, OPERATOR_PASSWORD

BASE_URL = (
    os.environ.get('REACT_APP_BACKEND_URL')
    or open('/app/frontend/.env').read().split('REACT_APP_BACKEND_URL=')[1].split('\n')[0].strip()
).rstrip('/')


# ---------- fixtures ---------- #

@pytest.fixture(scope='module')
def op_session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    r = s.post(f'{BASE_URL}/api/auth/login',
               json={'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD})
    assert r.status_code == 200, f'operator login failed: {r.status_code} {r.text[:200]}'
    body = r.json()
    token = body.get('token')
    if not token:
        pytest.skip('operator login returned no token field')
    s.headers.update({'Authorization': f'Bearer {token}'})
    return s


# ---------- AI Brain: maturity ---------- #

class TestAIBrainMaturity:
    def test_maturity_200_with_models(self, op_session):
        r = op_session.get(f'{BASE_URL}/api/operator/ai-brain/maturity')
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        assert 'models' in data and isinstance(data['models'], list)
        # Schema check on each row
        for row in data['models']:
            for k in ('model', 'total', 'pending', 'last_7d_added', 'auto_proposed_total'):
                assert k in row, f'missing {k} in {row}'
            assert isinstance(row['total'], int)
            assert isinstance(row['pending'], int)
        # 'all' bucket should be present (synth headline)
        keys = {m['model'] for m in data['models']}
        # If there are zero learnings the endpoint can legitimately return empty list,
        # but with current seed data we expect at least 'all' present.
        if data['models']:
            assert 'all' in keys, f'no all bucket: {keys}'


# ---------- AI Brain: timeline ---------- #

class TestAIBrainTimeline:
    def test_timeline_4w_returns_5_buckets(self, op_session):
        r = op_session.get(f'{BASE_URL}/api/operator/ai-brain/timeline?weeks=4')
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        assert 'weeks' in data
        # 4 weeks back + current week = 5
        assert len(data['weeks']) == 5, f'expected 5 buckets, got {len(data["weeks"])}: {[w["week"] for w in data["weeks"]]}'
        for w in data['weeks']:
            assert 'week' in w and 'counts' in w
            for k in ('claude', 'gpt', 'gemini', 'other', 'all'):
                assert k in w['counts'], f'missing {k} in counts {w}'
                assert isinstance(w['counts'][k], int)

    def test_timeline_no_tz_errors(self, op_session):
        # request larger window — would trip naive tz comparison if _as_aware regressed
        r = op_session.get(f'{BASE_URL}/api/operator/ai-brain/timeline?weeks=12')
        assert r.status_code == 200, r.text[:300]


# ---------- AI Brain: skills ---------- #

class TestAIBrainSkills:
    def test_skills_200_schema(self, op_session):
        r = op_session.get(f'{BASE_URL}/api/operator/ai-brain/skills')
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        assert 'buckets' in data
        assert isinstance(data['buckets'], list)
        for b in data['buckets']:
            assert 'bucket' in b and 'count' in b and 'items' in b
            assert isinstance(b['count'], int)
            assert b['count'] == len(b['items'])

    def test_skills_seed_keywords_classified(self, op_session):
        # Seed learning text that hits 'deploy' and 'voice' taxonomies via cheap keyword pass.
        # Use ai_learnings endpoint to insert; clean up after.
        created_ids = []
        try:
            for txt in ('TEST_iter15 deploy preview-url to prod', 'TEST_iter15 voice tone — short concise'):
                rc = op_session.post(f'{BASE_URL}/api/operator/ai-learnings',
                                     json={'text': txt, 'enabled': True})
                assert rc.status_code in (200, 201), rc.text[:200]
                created_ids.append(rc.json()['id'])
            r = op_session.get(f'{BASE_URL}/api/operator/ai-brain/skills')
            assert r.status_code == 200
            buckets = {b['bucket']: b for b in r.json()['buckets']}
            assert 'deploy' in buckets and buckets['deploy']['count'] >= 1, f'deploy not in {list(buckets)}'
            assert 'voice' in buckets and buckets['voice']['count'] >= 1, f'voice not in {list(buckets)}'
        finally:
            for lid in created_ids:
                op_session.delete(f'{BASE_URL}/api/operator/ai-learnings/{lid}')


# ---------- Self-healing PATCH ---------- #

class TestDeployAutoHealPatch:
    def _first_project_id(self, op_session):
        r = op_session.get(f'{BASE_URL}/api/operator/deploy/projects')
        assert r.status_code == 200, r.text[:200]
        body = r.json()
        projects = body.get('projects', body) if isinstance(body, dict) else body
        if not projects:
            pytest.skip('no deploy projects to test against')
        return projects[0]['id']

    def test_patch_auto_heal_true(self, op_session):
        pid = self._first_project_id(op_session)
        r = op_session.patch(f'{BASE_URL}/api/operator/deploy/{pid}',
                             json={'auto_heal': True})
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        # Response shape: either {project: {...}} or the project dict itself
        doc = body.get('project') or body
        assert doc.get('auto_heal') is True, f'auto_heal not true: {body}'

    def test_patch_auto_heal_false(self, op_session):
        pid = self._first_project_id(op_session)
        r = op_session.patch(f'{BASE_URL}/api/operator/deploy/{pid}',
                             json={'auto_heal': False})
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        doc = body.get('project') or body
        assert doc.get('auto_heal') is False, f'auto_heal not false: {body}'

    def test_patch_combined_auto_promote_and_auto_heal(self, op_session):
        pid = self._first_project_id(op_session)
        r = op_session.patch(f'{BASE_URL}/api/operator/deploy/{pid}',
                             json={'auto_promote': True, 'auto_heal': True})
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        doc = body.get('project') or body
        assert doc.get('auto_heal') is True
        assert doc.get('auto_promote') is True
        # cleanup → reset both
        op_session.patch(f'{BASE_URL}/api/operator/deploy/{pid}',
                         json={'auto_promote': False, 'auto_heal': False})


# ---------- Chat stream happy path (fallback wrapper sanity) ---------- #

class TestChatStreamHappy:
    def test_chat_stream_emits_delta_and_done(self, op_session):
        # Use SSE — read raw stream and look for delta + done frames.
        url = f'{BASE_URL}/api/chat/stream'
        payload = {
            'message': 'Reply with the single word: PING',
            'model': 'claude-sonnet-4-6',
        }
        with op_session.post(url, json=payload, stream=True, timeout=60) as r:
            assert r.status_code == 200, r.text[:300]
            saw_delta = False
            saw_done = False
            saw_fallback = False
            start = time.time()
            for raw in r.iter_lines(decode_unicode=True):
                if time.time() - start > 45:
                    break
                if not raw or not raw.startswith('data:'):
                    continue
                try:
                    ev = json.loads(raw[len('data:'):].strip())
                except Exception:
                    continue
                t = ev.get('type')
                if t == 'delta':
                    saw_delta = True
                elif t == 'fallback_used':
                    saw_fallback = True  # informational only
                elif t == 'done':
                    saw_done = True
                    break
                elif t == 'error':
                    pytest.fail(f'chat stream errored: {ev}')
            assert saw_delta, 'no delta frame received'
            assert saw_done, 'no done frame received'
            # fallback_used is OK to be either present or absent — happy path
            # may not need it. Just record.
            print(f'fallback_used observed = {saw_fallback}')

    def test_chat_stream_unknown_model_defaults_ok(self, op_session):
        """Per spec: an unrecognised model id should resolve to DEFAULT_MODEL
        and still succeed (no fallback needed since primary resolves cleanly)."""
        url = f'{BASE_URL}/api/chat/stream'
        payload = {
            'message': 'Say OK',
            'model': 'not-a-real-model-xyz',
        }
        with op_session.post(url, json=payload, stream=True, timeout=60) as r:
            assert r.status_code == 200, r.text[:300]
            saw_done = False
            start = time.time()
            for raw in r.iter_lines(decode_unicode=True):
                if time.time() - start > 45:
                    break
                if not raw or not raw.startswith('data:'):
                    continue
                try:
                    ev = json.loads(raw[len('data:'):].strip())
                except Exception:
                    continue
                if ev.get('type') == 'done':
                    saw_done = True
                    break
                if ev.get('type') == 'error':
                    pytest.fail(f'chat stream errored on unknown-model fallback: {ev}')
            assert saw_done, 'no done frame for unknown-model request'
