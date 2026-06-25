"""Iter32 backend tests — Redis TCP rate-limit, S3 mirror gating, restore-preview diff,
trusted-proxies XFF default behaviour, and iter30/31 regression smoke."""
import os
import time
import uuid

import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://tbc-self-copy.preview.emergentagent.com').rstrip('/')
API = f'{BASE_URL}/api'

OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')


@pytest.fixture(scope='module')
def op_token():
    s = requests.Session()
    r = s.post(f'{API}/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD}, timeout=20)
    assert r.status_code == 200, f'operator login failed: {r.status_code} {r.text[:200]}'
    tok = r.json().get('token')
    assert tok, 'no token in login response'
    return tok


@pytest.fixture(scope='module')
def op_headers(op_token):
    return {'Authorization': f'Bearer {op_token}'}


# ── REDIS LIVE: ingest with XFF persists ip from header (default trust-first-hop) ──
class TestRuntimeErrorsRedisAndXFF:

    def test_ingest_xff_first_hop_default(self):
        unique_ip = f'192.168.{int(time.time()) % 250}.{(int(time.time()*7)) % 250}'
        r = requests.post(
            f'{API}/runtime-errors',
            json={'message': f'iter32 xff probe {uuid.uuid4()}', 'source': 'frontend'},
            headers={'X-Forwarded-For': unique_ip},
            timeout=10,
        )
        assert r.status_code == 202, r.text
        data = r.json()
        assert data.get('accepted') is True, data
        # status only; the ip persistence is verified via subsequent rate-limit test

    def test_rate_limit_triggers_after_30(self):
        """Send 35 rapid POSTs from the SAME spoofed XFF — expect at least
        one rate_limited:true response (Redis-backed limiter ≥30/min)."""
        ip = f'203.0.113.{(int(time.time()) % 200) + 1}'
        accepted = 0
        rate_limited = 0
        for i in range(35):
            r = requests.post(
                f'{API}/runtime-errors',
                json={'message': f'iter32 rate probe {i}', 'source': 'frontend'},
                headers={'X-Forwarded-For': ip},
                timeout=10,
            )
            assert r.status_code == 202, f'#{i}: {r.status_code} {r.text[:200]}'
            d = r.json()
            if d.get('accepted'):
                accepted += 1
            elif d.get('reason') == 'rate_limited':
                rate_limited += 1
        print(f'accepted={accepted} rate_limited={rate_limited}')
        # Redis-cross-pod limiter: ≥30 accepted then ≥1 rate_limited
        assert rate_limited >= 1, f'no rate_limited responses (acc={accepted} rl={rate_limited}) — limiter not enforced'
        # Should not silently allow all 35 (would mean broken limiter)
        assert accepted <= 31, f'too many accepted ({accepted}) — limiter not enforced'


# ── S3 mirror disabled by default ──
class TestS3MirrorGated:

    def test_snapshots_list_s3_flags(self, op_headers):
        r = requests.get(f'{API}/operator/backup/snapshots', headers=op_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert 's3_enabled' in d and 's3_bucket' in d and 's3_prefix' in d
        # S3_BACKUP_BUCKET unset → both must be falsy
        assert d['s3_enabled'] is False, d
        assert d['s3_bucket'] in (None, ''), d

    def test_create_snapshot_reports_s3_mirrored_false(self, op_headers):
        r = requests.post(f'{API}/operator/backup/snapshots', headers=op_headers, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get('s3_enabled') is False
        assert d.get('s3_mirrored') is False
        assert d.get('id', '').startswith('snapshot-')


# ── Restore-preview diff ──
class TestRestorePreviewDiff:

    def test_diff_returns_all_five_collections(self, op_headers):
        # Ensure at least one snapshot exists
        snaps_r = requests.get(f'{API}/operator/backup/snapshots', headers=op_headers, timeout=15)
        snaps = snaps_r.json().get('snapshots') or []
        if not snaps:
            cr = requests.post(f'{API}/operator/backup/snapshots', headers=op_headers, timeout=30)
            assert cr.status_code == 200
            snap_id = cr.json()['id']
        else:
            snap_id = snaps[0]['id']

        r = requests.get(f'{API}/operator/backup/snapshots/{snap_id}/diff', headers=op_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d['snapshot_id'] == snap_id
        assert 'snapshot_exported_at' in d
        assert 'snapshot_exported_by' in d
        rows = d.get('rows') or []
        names = {row['collection'] for row in rows}
        assert names == {
            'deploy_projects', 'promo_codes', 'kyc_bypass_emails',
            'vanished_emails', 'app_settings',
        }, names
        for row in rows:
            for k in ('snapshot_count', 'current_count', 'merge_delta_max', 'replace_delta'):
                assert k in row and isinstance(row[k], int), row

    def test_diff_blocks_path_traversal(self, op_headers):
        # encoded traversal
        r = requests.get(
            f'{API}/operator/backup/snapshots/..%2F..%2Fetc%2Fpasswd/diff',
            headers=op_headers, timeout=15,
        )
        assert r.status_code in (400, 404), f'traversal not blocked: {r.status_code} {r.text[:200]}'
        # raw .. (after sanitize → empty stem → file missing → 404)
        r2 = requests.get(
            f'{API}/operator/backup/snapshots/nonexistent-xyz/diff',
            headers=op_headers, timeout=15,
        )
        assert r2.status_code == 404

    def test_diff_requires_operator(self):
        r = requests.get(f'{API}/operator/backup/snapshots/whatever/diff', timeout=10)
        assert r.status_code in (401, 403)


# ── Regression: iter30/31 endpoints still working ──
class TestRegressionIter30And31:

    def test_operator_login_ok(self):
        r = requests.post(f'{API}/auth/login', json={'email': OP_EMAIL, 'password': OP_PASSWORD}, timeout=20)
        assert r.status_code == 200
        assert r.json().get('token')

    def test_deploy_projects_loads(self, op_headers):
        r = requests.get(f'{API}/operator/deploy/projects', headers=op_headers, timeout=20)
        # Must not 503 on missing github_token; either 200 with list or empty
        assert r.status_code == 200, f'{r.status_code} {r.text[:200]}'
        data = r.json()
        assert isinstance(data, (list, dict))

    def test_backup_export_works(self, op_headers):
        r = requests.get(f'{API}/operator/backup/export', headers=op_headers, timeout=20)
        assert r.status_code == 200
        d = r.json()
        for k in ('version', 'counts', 'deploy_projects', 'promo_codes',
                  'kyc_bypass_emails', 'vanished_emails', 'app_settings'):
            assert k in d, f'missing key {k}'
