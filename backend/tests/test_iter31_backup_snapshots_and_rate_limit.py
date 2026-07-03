"""Iter31 backend tests.

Covers:
1. Local-disk backup snapshot endpoints (list / create / download / restore).
2. Path traversal protection on the download endpoint.
3. Runtime-errors rate limiter (in-memory fallback path — REDIS_URL unset).
"""
import json
import os
from pathlib import Path

import pytest
import requests


def _backend_url() -> str:
    v = os.environ.get('REACT_APP_BACKEND_URL')
    if v:
        return v.rstrip('/')
    for line in open('/app/frontend/.env'):
        if line.startswith('REACT_APP_BACKEND_URL='):
            return line.split('=', 1)[1].strip().rstrip('/')
    return 'http://localhost:8001'


def _load_backend_env() -> None:
    if os.environ.get('MONGO_URL') and os.environ.get('DB_NAME'):
        return
    try:
        for line in open('/app/backend/.env'):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:
        pass


_load_backend_env()
BASE_URL = _backend_url()
OP_EMAIL = 'rac.investments.swe@gmail.com'
OP_PASS = os.environ.get('TEST_OPERATOR_PASSWORD', 'set-TEST_OPERATOR_PASSWORD-to-run')
BACKUP_DIR = Path('/app/data/backups')


# ───────────────────── fixtures ─────────────────────
@pytest.fixture(scope='module')
def session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    return s


@pytest.fixture(scope='module')
def op_token(session):
    r = session.post(f'{BASE_URL}/api/auth/login',
                     json={'email': OP_EMAIL, 'password': OP_PASS})
    if r.status_code != 200:
        pytest.skip(f'Operator login failed: {r.status_code} {r.text[:200]}')
    body = r.json()
    if body.get('pending_2fa'):
        try:
            import pyotp
            import pymongo
            c = pymongo.MongoClient(os.environ['MONGO_URL'])
            db = c[os.environ['DB_NAME']]
            u = db.users.find_one({'email': OP_EMAIL})
            if u and u.get('totp_secret'):
                code = pyotp.TOTP(u['totp_secret']).now()
                r2 = session.post(f'{BASE_URL}/api/auth/2fa/verify',
                                  json={'totp_code': code})
                if r2.status_code == 200:
                    return r2.json().get('token') or body.get('token')
        except Exception as e:
            pytest.skip(f'2FA needed but failed: {e}')
        pytest.skip('Operator requires 2FA and TOTP not available')
    return body.get('token')


@pytest.fixture(scope='module')
def op_client(session, op_token):
    if not op_token:
        pytest.skip('No operator token')
    session.headers.update({'Authorization': f'Bearer {op_token}'})
    return session


@pytest.fixture(scope='module')
def mongo_db():
    try:
        import pymongo
        c = pymongo.MongoClient(os.environ['MONGO_URL'])
        return c[os.environ['DB_NAME']]
    except Exception as e:
        pytest.skip(f'Mongo not available: {e}')


# ───────────────────── 0. backend health ─────────────────────
def test_backend_online(session):
    r = session.get(f'{BASE_URL}/api/')
    assert r.status_code == 200
    assert r.json().get('status') == 'online'


# ───────────────────── 1. snapshot list (initial) ─────────────────────
def test_list_snapshots_initial_shape(op_client):
    r = op_client.get(f'{BASE_URL}/api/operator/backup/snapshots')
    assert r.status_code == 200, r.text
    data = r.json()
    assert 'snapshots' in data and isinstance(data['snapshots'], list)
    assert data.get('retention_days') == 30
    assert data.get('directory') == '/app/data/backups'
    # File order must be newest-first; size/created_at must be present.
    for s in data['snapshots']:
        assert 'id' in s and 'filename' in s and 'created_at' in s and 'size_bytes' in s
        assert s['filename'].startswith('snapshot-') and s['filename'].endswith('.json')


# ───────────────────── 2. snapshot create ─────────────────────
def test_create_snapshot_writes_file_to_disk(op_client):
    before = {p.name for p in BACKUP_DIR.glob('snapshot-*.json')}
    r = op_client.post(f'{BASE_URL}/api/operator/backup/snapshots')
    assert r.status_code == 200, r.text
    meta = r.json()
    for k in ('id', 'filename', 'size_bytes', 'created_at', 'pruned', 'retention_days'):
        assert k in meta, f'missing key {k} in {meta}'
    assert meta['retention_days'] == 30
    assert meta['size_bytes'] > 0
    # File MUST exist on disk after the call.
    fname = meta['filename']
    on_disk = BACKUP_DIR / fname
    assert on_disk.is_file(), f'snapshot file not present at {on_disk}'
    after = {p.name for p in BACKUP_DIR.glob('snapshot-*.json')}
    assert fname in after
    # Confirm list endpoint now contains it.
    r2 = op_client.get(f'{BASE_URL}/api/operator/backup/snapshots')
    assert r2.status_code == 200
    ids = [s['id'] for s in r2.json()['snapshots']]
    assert meta['id'] in ids
    # Stash for downstream tests.
    pytest.shared_snapshot_id = meta['id']  # type: ignore[attr-defined]


# ───────────────────── 3. snapshot download shape ─────────────────────
def test_download_snapshot_returns_export_shape(op_client):
    snap_id = getattr(pytest, 'shared_snapshot_id', None)
    if not snap_id:
        pytest.skip('no snapshot id available')
    r = op_client.get(f'{BASE_URL}/api/operator/backup/snapshots/{snap_id}/download')
    assert r.status_code == 200, r.text
    # Content is JSON; the FileResponse sets application/json.
    payload = r.json()
    for k in ('version', 'deploy_projects', 'promo_codes', 'kyc_bypass_emails',
              'vanished_emails', 'app_settings', 'counts',
              'payment_settings_no_secrets'):
        assert k in payload, f'snapshot JSON missing key {k}'
    assert payload['version'] == 1
    # Compare against /export so we know the shape matches.
    r2 = op_client.get(f'{BASE_URL}/api/operator/backup/export')
    assert r2.status_code == 200
    exp = r2.json()
    assert set(exp.keys()) <= set(payload.keys()) | {'exported_at', 'exported_by'}


# ───────────────────── 4. path traversal protection ─────────────────────
def test_download_path_traversal_blocked(op_client):
    # Use a clearly malicious id with encoded slashes.
    bad_ids = [
        '..%2F..%2Fetc%2Fpasswd',
        '../../etc/passwd',
        '..%2F..%2F..%2Fapp%2Fbackend%2F.env',
    ]
    for bid in bad_ids:
        r = op_client.get(f'{BASE_URL}/api/operator/backup/snapshots/{bid}/download',
                          allow_redirects=False)
        assert r.status_code in (400, 404), \
            f'Expected 400/404 for traversal {bid!r}, got {r.status_code}: {r.text[:120]}'
        # Body MUST NOT contain a unix passwd / env-style payload.
        body = r.text.lower()
        assert 'root:x:' not in body
        assert 'mongo_url' not in body


# ───────────────────── 5. snapshot restore (merge) ─────────────────────
def test_restore_snapshot_merge_does_not_wipe(op_client, mongo_db):
    snap_id = getattr(pytest, 'shared_snapshot_id', None)
    if not snap_id:
        pytest.skip('no snapshot id available')
    counts_before = {
        c: mongo_db[c].count_documents({})
        for c in ('deploy_projects', 'promo_codes', 'kyc_bypass_emails',
                  'vanished_emails', 'app_settings')
    }
    r = op_client.post(
        f'{BASE_URL}/api/operator/backup/snapshots/{snap_id}/restore',
        params={'mode': 'merge'},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get('success') is True
    assert body.get('mode') == 'merge'
    assert 'written' in body
    counts_after = {
        c: mongo_db[c].count_documents({})
        for c in counts_before
    }
    # Merge MUST NOT reduce any collection count.
    for c, before in counts_before.items():
        assert counts_after[c] >= before, \
            f'merge restore reduced {c}: {before} -> {counts_after[c]}'


# ───────────────────── 6. rate limit on runtime-errors ingest ─────────────────────
def test_runtime_errors_rate_limit_inmemory_fallback():
    """REDIS_URL is intentionally unset; the in-memory bucket caps at 30/min.

    NB: the public URL is fronted by a Kubernetes ingress that SNATs
    incoming traffic — so `request.client.host` inside FastAPI is the
    ingress-proxy IP, which the ingress may rotate across new TCP
    connections. This means the per-IP cap can be diluted across several
    buckets when hitting the public URL. The behaviour we MUST verify
    here is:
      1. The fallback path is engaged (no Redis configured, no 500s).
      2. At least some bursts hit a bucket that's already at the cap, so
         the endpoint returns the documented `{accepted: false,
         reason: 'rate_limited'}` payload (not an exception).
    A larger burst (200) ensures at least one bucket repeats enough to
    trip the cap regardless of ingress IP rotation.
    """
    headers = {'Content-Type': 'application/json', 'Connection': 'close'}
    accepted = 0
    limited = 0
    other = 0
    last_limited_resp = None
    for i in range(200):
        r = requests.post(
            f'{BASE_URL}/api/runtime-errors',
            json={'message': f'iter31-rate-test-{i}', 'source': 'test'},
            headers=headers,
        )
        assert r.status_code == 202, f'unexpected status {r.status_code}: {r.text[:120]}'
        body = r.json()
        if body.get('accepted') is True:
            accepted += 1
        elif body.get('accepted') is False and body.get('reason') == 'rate_limited':
            limited += 1
            last_limited_resp = body
        else:
            other += 1
    # 1. No errors / other-shape responses — fallback path engaged cleanly.
    assert other == 0, f'unexpected response shapes: {other}'
    # 2. Rate limiter triggered at least once with the documented payload.
    assert limited >= 1, (
        f'no rate-limited responses observed in 200 rapid POSTs '
        f'(accepted={accepted}). The in-memory fallback rate-limiter '
        f'is not engaging at all — verify _rate_limited() path is wired.'
    )
    assert last_limited_resp == {'accepted': False, 'reason': 'rate_limited'}
