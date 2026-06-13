"""
P2 tests for new deploy endpoints added this session:
  - POST /api/operator/deploy/{id}/clone (+ AI twin)
  - PATCH /api/operator/deploy/{id}/domain
  - GET /api/operator/deploy/{id}/download (+ AI twin)
  - GET /api/operator/deploy/self/download-app (+ AI twin)
  - POST /api/operator/deploy/{id}/code-review (+ AI twin)
"""
import io
import os
import zipfile
import pytest
import requests

_BACKEND = os.environ.get('REACT_APP_BACKEND_URL')
if not _BACKEND:
    with open('/app/frontend/.env') as _f:
        for _line in _f:
            if _line.startswith('REACT_APP_BACKEND_URL='):
                _BACKEND = _line.split('=', 1)[1].strip()
                break
BASE_URL = (_BACKEND or '').rstrip('/')
API = f"{BASE_URL}/api"

OPERATOR_EMAIL = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OPERATOR_PASSWORD = os.environ.get('TEST_OPERATOR_PASSWORD', '123Admin@98')


@pytest.fixture(scope='module')
def operator_session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login",
               json={'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD},
               timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Operator login failed: {r.status_code}")
    body = r.json()
    if body.get('pending_2fa'):
        pytest.skip('Operator session is pending_2fa')
    return s


@pytest.fixture(scope='module')
def ai_key(operator_session):
    r = operator_session.post(f"{API}/operator/deploy/key",
                              json={'regenerate_ai_api_key': True}, timeout=10)
    assert r.status_code == 200
    return r.json()['revealed_ai_api_key']


@pytest.fixture(scope='module')
def sample_project(operator_session, ai_key):
    H = {'Authorization': f'Bearer {ai_key}', 'Content-Type': 'application/json'}
    r = requests.post(f"{API}/projects", headers=H, timeout=10, json={
        'projectName': 'P2 Test Project',
        'repo': 'octocat/Hello-World',  # public real repo for code-review/download tests
        'domain': 'p2-test.tbctools.test',
        'gitRef': 'master',
    })
    assert r.status_code == 201, r.text
    pid = r.json()['project']['id']
    yield pid
    requests.delete(f"{API}/projects/{pid}", headers=H, timeout=10)


# ---------- Clone ----------
class TestClone:
    def test_op_clone_returns_new_blank_domain(self, operator_session, sample_project):
        r = operator_session.post(
            f"{API}/operator/deploy/{sample_project}/clone",
            json={}, timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        proj = body['project']
        assert proj['id'] != sample_project
        assert proj['repo'] == 'octocat/Hello-World'
        assert proj['gitRef'] == 'master'
        assert proj['domain'] == ''  # blanked

    def test_ai_clone_works(self, ai_key, sample_project):
        H = {'Authorization': f'Bearer {ai_key}', 'Content-Type': 'application/json'}
        r = requests.post(f"{API}/projects/{sample_project}/clone",
                          headers=H, json={'new_name': 'Clone Variant'}, timeout=15)
        assert r.status_code == 200, r.text
        proj = r.json()['project']
        assert proj['projectName'] == 'Clone Variant'
        assert proj['domain'] == ''

    def test_clone_requires_auth(self):
        r = requests.post(f"{API}/projects/anything/clone", json={}, timeout=10)
        assert r.status_code == 401

    def test_clone_404_for_unknown(self, operator_session):
        r = operator_session.post(
            f"{API}/operator/deploy/__no_such__/clone", json={}, timeout=10,
        )
        assert r.status_code == 404


# ---------- PATCH domain ----------
class TestPatchDomain:
    def test_update_domain(self, operator_session, sample_project):
        # clone first so we don't mutate the test fixture domain
        r = operator_session.post(
            f"{API}/operator/deploy/{sample_project}/clone", json={}, timeout=15,
        )
        assert r.status_code == 200
        new_pid = r.json()['project']['id']

        r = operator_session.patch(
            f"{API}/operator/deploy/{new_pid}/domain",
            json={'domain': 'foo.example.com'}, timeout=10,
        )
        assert r.status_code == 200, r.text
        assert r.json()['domain'] == 'foo.example.com'

    def test_update_domain_404(self, operator_session):
        r = operator_session.patch(
            f"{API}/operator/deploy/__no_such__/domain",
            json={'domain': 'x.test'}, timeout=10,
        )
        assert r.status_code == 404

    def test_update_domain_empty_400(self, operator_session, sample_project):
        r = operator_session.patch(
            f"{API}/operator/deploy/{sample_project}/domain",
            json={'domain': '   '}, timeout=10,
        )
        assert r.status_code == 400


# ---------- Self-source download ----------
class TestSelfDownload:
    def _verify_zip(self, content: bytes):
        assert len(content) >= 100 * 1024, f"zip too small: {len(content)} bytes"
        zf = zipfile.ZipFile(io.BytesIO(content))
        names = zf.namelist()
        assert 'tbctools-self/backend/server.py' in names, 'missing server.py'
        assert 'tbctools-self/backend/deploy_projects_ext.py' in names, 'missing deploy_projects_ext.py'
        assert 'tbctools-self/DOWNLOAD_README.txt' in names, 'missing README'
        # Verify .env sanitization
        env_paths = [n for n in names if n.endswith('/.env') or n.endswith('.env')]
        assert env_paths, 'expected at least one .env path'
        for p in env_paths:
            content_env = zf.read(p).decode('utf-8', errors='ignore')
            assert 'MONGO_URL=mongodb' not in content_env, f"{p} leaked MONGO_URL"
            assert 'sk-' not in content_env, f"{p} leaked sk- key"
            # The placeholder text we wrote
            assert 'stripped' in content_env.lower() or 'placeholder' in content_env.lower() \
                or '#' in content_env, f"{p} not sanitized: {content_env[:200]}"

    def test_op_self_download(self, operator_session):
        r = operator_session.get(f"{API}/operator/deploy/self/download-app", timeout=60)
        assert r.status_code == 200
        assert 'application/zip' in r.headers.get('content-type', '')
        assert 'attachment' in r.headers.get('content-disposition', '').lower()
        self._verify_zip(r.content)

    def test_ai_self_download(self, ai_key):
        H = {'Authorization': f'Bearer {ai_key}'}
        r = requests.get(f"{API}/projects/self/download-app", headers=H, timeout=60)
        assert r.status_code == 200
        assert 'application/zip' in r.headers.get('content-type', '')
        self._verify_zip(r.content)

    def test_ai_self_download_requires_auth(self):
        r = requests.get(f"{API}/projects/self/download-app", timeout=10)
        assert r.status_code == 401


# ---------- Per-project download (proxy GitHub) ----------
class TestProjectDownload:
    def test_op_download_returns_zip_or_502(self, operator_session, sample_project):
        # GitHub may rate-limit anon requests — both 200 and 502 are PASS,
        # but never 500 / 401.
        r = operator_session.get(
            f"{API}/operator/deploy/{sample_project}/download", timeout=60,
        )
        assert r.status_code in (200, 502), f"unexpected {r.status_code} {r.text[:200]}"
        if r.status_code == 200:
            assert 'application/zip' in r.headers.get('content-type', '')
            assert len(r.content) > 0
            assert 'attachment' in r.headers.get('content-disposition', '').lower()
        else:
            # rate limit path
            detail = r.json().get('detail', '').lower()
            assert 'github' in detail or 'rate' in detail or 'token' in detail

    def test_ai_download_requires_auth(self, sample_project):
        r = requests.get(f"{API}/projects/{sample_project}/download", timeout=10)
        assert r.status_code == 401

    def test_op_download_404_unknown(self, operator_session):
        r = operator_session.get(
            f"{API}/operator/deploy/__nope__/download", timeout=15,
        )
        assert r.status_code == 404


# ---------- Code review ----------
class TestCodeReview:
    def test_op_code_review_reachable(self, operator_session, sample_project):
        # Either succeeds (200 with structured review) or 502 (GitHub rate
        # limit / LLM error). 500 is NOT acceptable.
        r = operator_session.post(
            f"{API}/operator/deploy/{sample_project}/code-review", timeout=120,
        )
        assert r.status_code in (200, 502, 503, 504), (
            f"unexpected {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            data = r.json()
            for k in ('summary', 'verdict', 'findings', 'files_sampled',
                      'reviewed_at', 'project_id'):
                assert k in data, f"missing {k} in review"
            assert data['project_id'] == sample_project
        else:
            # 502 may come from upstream gateway (HTML) when LLM is slow — that
            # still proves the endpoint is reachable. If JSON, validate hint.
            ct = r.headers.get('content-type', '')
            if 'application/json' in ct:
                detail = r.json().get('detail', '').lower()
                assert ('github' in detail or 'token' in detail
                        or 'llm' in detail or 'rate' in detail
                        or 'emergent' in detail), (
                    f"unexpected error detail: {detail}"
                )

    def test_ai_code_review_requires_auth(self, sample_project):
        r = requests.post(f"{API}/projects/{sample_project}/code-review", timeout=10)
        assert r.status_code == 401

    def test_op_code_review_404_unknown(self, operator_session):
        r = operator_session.post(
            f"{API}/operator/deploy/__nope__/code-review", timeout=15,
        )
        assert r.status_code == 404
