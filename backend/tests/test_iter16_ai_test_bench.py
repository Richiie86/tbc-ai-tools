"""Iter 16 — AI Test Bench backend coverage.

Covers:
  - GET  /api/operator/ai-tests/models        — 8 entries with last_test key
  - POST /api/operator/ai-tests/run/gpt-4.1   — probe shape + arithmetic PASS
  - persistence in `ai_model_tests` MongoDB collection
  - GET  /api/operator/ai-tests/history       — newest-first, includes prior run
  - POST /api/operator/ai-tests/run/not-a-real-model — 400 bad request
  - POST /api/operator/ai-tests/run-all       — parallel fan-out under 60s,
    returns 8 entries each with last_test populated.
"""
import os
import time
import pytest
import requests

from tests._creds import OPERATOR_EMAIL, OPERATOR_PASSWORD

BASE_URL = (
    os.environ.get('REACT_APP_BACKEND_URL')
    or open('/app/frontend/.env').read().split('REACT_APP_BACKEND_URL=')[1].split('\n')[0].strip()
).rstrip('/')

EXPECTED_MODELS = {
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-4.1',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
}


# ---------- fixtures ---------- #

@pytest.fixture(scope='module')
def op_session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    r = s.post(
        f'{BASE_URL}/api/auth/login',
        json={'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD},
    )
    assert r.status_code == 200, f'operator login failed: {r.status_code} {r.text[:200]}'
    token = r.json().get('token')
    if not token:
        pytest.skip('operator login returned no token')
    s.headers.update({'Authorization': f'Bearer {token}'})
    return s


# ---------- /models — initial state ---------- #

class TestModelsEndpoint:
    def test_list_models_returns_eight_curated_entries(self, op_session):
        r = op_session.get(f'{BASE_URL}/api/operator/ai-tests/models')
        assert r.status_code == 200, f'{r.status_code} {r.text[:200]}'
        data = r.json()
        assert 'models' in data and isinstance(data['models'], list)
        assert len(data['models']) == 8

        ids = {m['id'] for m in data['models']}
        assert ids == EXPECTED_MODELS, f'unexpected model ids: {ids ^ EXPECTED_MODELS}'

        for m in data['models']:
            assert 'id' in m and 'display' in m and 'provider' in m
            assert 'last_test' in m  # may be None OR a result object
            assert m['provider'] in {'anthropic', 'openai', 'gemini'}


# ---------- /run/{model} — happy path on a fast OpenAI model ---------- #

class TestRunSingleModel:
    def test_run_gpt_41_returns_correct_shape(self, op_session):
        r = op_session.post(f'{BASE_URL}/api/operator/ai-tests/run/gpt-4.1', timeout=120)
        assert r.status_code == 200, f'{r.status_code} {r.text[:300]}'
        doc = r.json()

        # Top-level shape
        assert isinstance(doc.get('id'), str) and len(doc['id']) > 0
        assert doc.get('model') == 'gpt-4.1'
        assert isinstance(doc.get('created_at'), str) and 'T' in doc['created_at']  # ISO
        assert isinstance(doc.get('pass'), bool)
        assert isinstance(doc.get('avg_latency_ms'), int) and doc['avg_latency_ms'] >= 0

        # Probes
        assert isinstance(doc.get('probes'), list) and len(doc['probes']) >= 2
        names = {p['name'] for p in doc['probes']}
        assert 'health' in names and 'arithmetic' in names

        for p in doc['probes']:
            assert 'name' in p
            assert 'pass' in p and isinstance(p['pass'], bool)
            assert 'latency_ms' in p and isinstance(p['latency_ms'], int)
            assert 'error' in p  # may be None
            assert 'response' in p  # may be ''

        # Arithmetic MUST pass (deterministic 17+25=42)
        arithmetic = next(p for p in doc['probes'] if p['name'] == 'arithmetic')
        assert arithmetic['pass'] is True, f'arithmetic probe failed: {arithmetic}'

        # Health should normally pass
        health = next(p for p in doc['probes'] if p['name'] == 'health')
        assert health['pass'] is True, f'health probe failed: {health}'

        # Stash for the next test
        pytest._last_gpt41_run_id = doc['id']

    def test_run_persists_and_surfaces_via_models(self, op_session):
        run_id = getattr(pytest, '_last_gpt41_run_id', None)
        assert run_id, 'previous test must have set _last_gpt41_run_id'

        r = op_session.get(f'{BASE_URL}/api/operator/ai-tests/models')
        assert r.status_code == 200
        gpt = next(m for m in r.json()['models'] if m['id'] == 'gpt-4.1')
        assert gpt['last_test'] is not None
        assert gpt['last_test'].get('id') == run_id
        assert gpt['last_test'].get('model') == 'gpt-4.1'


# ---------- /run/{model} — invalid model 400 ---------- #

class TestInvalidModel:
    def test_unknown_model_returns_400(self, op_session):
        r = op_session.post(f'{BASE_URL}/api/operator/ai-tests/run/not-a-real-model')
        assert r.status_code == 400, f'expected 400 got {r.status_code}: {r.text[:200]}'


# ---------- /history ---------- #

class TestHistory:
    def test_history_returns_newest_first_and_includes_prior_run(self, op_session):
        r = op_session.get(
            f'{BASE_URL}/api/operator/ai-tests/history',
            params={'model': 'gpt-4.1', 'days': 7},
        )
        assert r.status_code == 200, f'{r.status_code} {r.text[:200]}'
        data = r.json()
        assert 'history' in data and isinstance(data['history'], list)
        assert len(data['history']) >= 1

        # Newest-first ordering
        timestamps = [h['created_at'] for h in data['history']]
        assert timestamps == sorted(timestamps, reverse=True), 'history not newest-first'

        # All entries are for the requested model
        for h in data['history']:
            assert h['model'] == 'gpt-4.1'

        # Most recent run should match the run we just persisted
        run_id = getattr(pytest, '_last_gpt41_run_id', None)
        if run_id:
            assert data['history'][0]['id'] == run_id


# ---------- /run-all — parallel fan-out ---------- #

class TestRunAll:
    def test_run_all_fans_out_under_60s(self, op_session):
        t0 = time.perf_counter()
        r = op_session.post(f'{BASE_URL}/api/operator/ai-tests/run-all', timeout=90)
        elapsed = time.perf_counter() - t0
        assert r.status_code == 200, f'{r.status_code} {r.text[:300]}'
        assert elapsed < 60, f'/run-all took {elapsed:.1f}s — parallelisation broken?'

        data = r.json()
        assert 'models' in data and len(data['models']) == 8
        ids = {m['id'] for m in data['models']}
        assert ids == EXPECTED_MODELS

        # Every model should have a last_test populated after run-all
        for m in data['models']:
            assert m.get('last_test') is not None, f"{m['id']} missing last_test"
            lt = m['last_test']
            # tolerate the exception-wrapped shape (no probes key)
            assert 'pass' in lt
            assert 'avg_latency_ms' in lt or 'error' in lt
