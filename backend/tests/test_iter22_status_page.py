"""Tests for /api/status public status page (iter22)."""
import os
import requests
import pytest

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'http://localhost:8000').rstrip('/')
STATUS_URL = f"{BASE_URL}/api/status"

VALID_OVERALL = {'operational', 'degraded', 'outage'}
VALID_COMPONENT = {'operational', 'degraded', 'outage', 'unknown'}


@pytest.fixture(scope='module')
def status_resp():
    r = requests.get(STATUS_URL, timeout=15)
    return r


def test_status_endpoint_returns_200(status_resp):
    assert status_resp.status_code == 200, f"Got {status_resp.status_code}: {status_resp.text[:300]}"


def test_status_no_auth_required():
    # Use a fresh session with no cookies/auth
    s = requests.Session()
    r = s.get(STATUS_URL, timeout=15)
    assert r.status_code == 200


def test_status_cache_control_header(status_resp):
    cc = status_resp.headers.get('Cache-Control', '')
    assert 'public' in cc and 'max-age=30' in cc, f"Cache-Control header is: {cc}"


def test_status_top_level_shape(status_resp):
    data = status_resp.json()
    for key in ('overall', 'checked_at', 'components', 'models', 'critical_errors_24h', 'incidents'):
        assert key in data, f"Missing key: {key}. Keys: {list(data.keys())}"


def test_status_overall_value(status_resp):
    data = status_resp.json()
    assert data['overall'] in VALID_OVERALL, f"overall={data['overall']}"


def test_status_components_shape(status_resp):
    data = status_resp.json()
    comps = data['components']
    assert 'database' in comps and 'ai_models' in comps
    assert comps['database'] in VALID_COMPONENT
    assert comps['ai_models'] in VALID_COMPONENT


def test_status_models_shape(status_resp):
    data = status_resp.json()
    assert isinstance(data['models'], list)
    for m in data['models']:
        assert 'model' in m
        assert 'pass' in m and isinstance(m['pass'], bool)
        assert 'avg_latency_ms' in m and isinstance(m['avg_latency_ms'], int)
        assert 'checked_at' in m
        assert 'probes_failed' in m and isinstance(m['probes_failed'], list)


def test_status_critical_count_is_int(status_resp):
    data = status_resp.json()
    assert isinstance(data['critical_errors_24h'], int)
    assert data['critical_errors_24h'] >= 0


def test_status_incidents_shape(status_resp):
    data = status_resp.json()
    assert isinstance(data['incidents'], list)
    for inc in data['incidents']:
        for k in ('signature', 'message', 'source', 'count', 'first_seen', 'last_seen'):
            assert k in inc, f"missing {k} in incident: {inc}"
        assert isinstance(inc['count'], int)
        assert len(inc['message']) <= 280


def test_status_database_consistent_with_overall(status_resp):
    data = status_resp.json()
    # If DB is up, overall should not be 'outage' unless many crit errors
    if data['components']['database'] == 'operational' and data['critical_errors_24h'] < 5:
        assert data['overall'] in {'operational', 'degraded'}
