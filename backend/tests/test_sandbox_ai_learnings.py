"""Backend tests for the new Sandbox-AI + AI Learnings features (iter_14)."""
import os
import uuid
import requests
import pytest

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://tbc-self-copy.preview.emergentagent.com').rstrip('/')
OPERATOR_EMAIL = 'rac.investments.swe@gmail.com'
OPERATOR_PASSWORD = '123Admin@98'


@pytest.fixture(scope='session')
def op_session():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={'email': OPERATOR_EMAIL, 'password': OPERATOR_PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data.get('token')
    if token:
        s.headers.update({'Authorization': f'Bearer {token}'})
    # pending_2fa = data.get('pending_2fa')  # operator currently boots w/o TOTP
    return s


# ------------- Sandbox AI: /models ---------------------------------
class TestSandboxAIModels:
    def test_models_unauth_401(self):
        r = requests.get(f"{BASE_URL}/api/operator/sandbox/ai/models")
        assert r.status_code in (401, 403), f"expected 401/403 got {r.status_code}: {r.text[:200]}"

    def test_models_ok(self, op_session):
        r = op_session.get(f"{BASE_URL}/api/operator/sandbox/ai/models")
        assert r.status_code == 200, r.text
        d = r.json()
        assert 'default' in d and isinstance(d['default'], str) and d['default']
        assert isinstance(d.get('models'), list) and len(d['models']) > 0
        # validate shape
        m0 = d['models'][0]
        assert 'id' in m0 and 'provider' in m0 and 'display' in m0


# ------------- Sandbox AI: /propose validation --------------------
class TestProposeValidation:
    def test_zero_files_400(self, op_session):
        r = op_session.post(f"{BASE_URL}/api/operator/sandbox/ai/propose",
                            json={'instruction': 'do something', 'files': [],
                                  'model': 'claude-sonnet-4-6'})
        assert r.status_code == 400, r.text

    def test_single_mode_multiple_files_400(self, op_session):
        r = op_session.post(f"{BASE_URL}/api/operator/sandbox/ai/propose",
                            json={'instruction': 'tweak both',
                                  'files': [
                                      {'path': 'a.js', 'content': '// a'},
                                      {'path': 'b.js', 'content': '// b'},
                                  ],
                                  'model': 'claude-sonnet-4-6',
                                  'edit_mode': 'single'})
        assert r.status_code == 400, r.text

    def test_bad_model_400(self, op_session):
        r = op_session.post(f"{BASE_URL}/api/operator/sandbox/ai/propose",
                            json={'instruction': 'noop',
                                  'files': [{'path': 'a.js', 'content': '// a'}],
                                  'model': 'not-a-real-model'})
        assert r.status_code == 400, r.text


# ------------- Sandbox AI: /propose happy path + /sessions --------
class TestProposeAndSessions:
    def test_propose_and_session_persisted(self, op_session):
        body = {
            'instruction': "Add a one-line comment at the very top that says: // TEST_SANDBOX_AI_MARKER",
            'files': [{
                'path': 'TEST_sandbox_marker.js',
                'content': "function hello(){ return 'hi'; }\n",
            }],
            'model': 'claude-sonnet-4-6',
            'edit_mode': 'single',
        }
        r = op_session.post(f"{BASE_URL}/api/operator/sandbox/ai/propose", json=body, timeout=90)
        if r.status_code == 503:
            pytest.skip(f"LLM key not configured: {r.text}")
        if r.status_code == 502:
            pytest.skip(f"LLM flaked (non-JSON): {r.text[:200]}")
        assert r.status_code == 200, r.text
        d = r.json()
        # envelope shape
        for k in ('files', 'notes', 'model', 'session_id'):
            assert k in d, f"missing {k} in {d.keys()}"
        assert d['model'] == 'claude-sonnet-4-6'
        assert isinstance(d['files'], list)
        # if AI returned a file edit it must be in the requested scope
        for f in d['files']:
            assert f.get('path') == 'TEST_sandbox_marker.js'
            assert isinstance(f.get('new_content'), str)

        # /sessions includes this session_id
        r2 = op_session.get(f"{BASE_URL}/api/operator/sandbox/ai/sessions?limit=10")
        assert r2.status_code == 200, r2.text
        sessions = r2.json()
        assert isinstance(sessions, list) and len(sessions) > 0
        sids = [s.get('session_id') for s in sessions]
        assert d['session_id'] in sids, f"session {d['session_id']} not found in {sids[:5]}"


# ------------- AI edit mode persistence ---------------------------
class TestEditModePersistence:
    def test_bogus_project_404(self, op_session):
        r = op_session.patch(f"{BASE_URL}/api/operator/deploy/__bogus_id__/ai-edit-mode",
                             json={'ai_edit_mode': 'multi'})
        assert r.status_code == 404, r.text

    def test_real_project_persists(self, op_session):
        # find a real project (operator deploy projects)
        pr = op_session.get(f"{BASE_URL}/api/operator/deploy/projects")
        assert pr.status_code == 200, pr.text
        projects = pr.json()
        if isinstance(projects, dict):
            projects = projects.get('projects') or projects.get('items') or []
        if not projects:
            pytest.skip("no operator projects available to test edit-mode")
        pid = projects[0].get('id') or projects[0].get('projectId') or projects[0].get('_id')
        assert pid, f"no id field on project: {projects[0].keys()}"
        # set to multi
        r1 = op_session.patch(f"{BASE_URL}/api/operator/deploy/{pid}/ai-edit-mode",
                              json={'ai_edit_mode': 'multi'})
        assert r1.status_code == 200, r1.text
        assert r1.json().get('ai_edit_mode') == 'multi'
        # set back to single (round-trip)
        r2 = op_session.patch(f"{BASE_URL}/api/operator/deploy/{pid}/ai-edit-mode",
                              json={'ai_edit_mode': 'single'})
        assert r2.status_code == 200, r2.text
        assert r2.json().get('ai_edit_mode') == 'single'


# ------------- AI Learnings CRUD ----------------------------------
class TestAILearningsCRUD:
    created_id: str = ''

    def test_create_and_list(self, op_session):
        text = f"TEST_LEARNING_{uuid.uuid4().hex[:8]} — always be concise"
        r = op_session.post(f"{BASE_URL}/api/operator/ai-learnings",
                            json={'text': text, 'enabled': True})
        assert r.status_code == 201, r.text
        d = r.json()
        assert d['text'] == text
        assert d['enabled'] is True
        assert 'id' in d
        TestAILearningsCRUD.created_id = d['id']

        # list shows it
        lr = op_session.get(f"{BASE_URL}/api/operator/ai-learnings")
        assert lr.status_code == 200
        ids = [x['id'] for x in lr.json()]
        assert d['id'] in ids

    def test_patch_disable_and_text(self, op_session):
        lid = TestAILearningsCRUD.created_id
        assert lid, "no created learning to patch"
        # disable
        r = op_session.patch(f"{BASE_URL}/api/operator/ai-learnings/{lid}",
                             json={'enabled': False})
        assert r.status_code == 200, r.text
        assert r.json()['enabled'] is False
        # edit text
        new_txt = "TEST_LEARNING_updated text body"
        r2 = op_session.patch(f"{BASE_URL}/api/operator/ai-learnings/{lid}",
                              json={'text': new_txt, 'enabled': True})
        assert r2.status_code == 200, r2.text
        d = r2.json()
        assert d['text'] == new_txt
        assert d['enabled'] is True

    def test_delete(self, op_session):
        lid = TestAILearningsCRUD.created_id
        r = op_session.delete(f"{BASE_URL}/api/operator/ai-learnings/{lid}")
        assert r.status_code == 200, r.text
        # second delete -> 404
        r2 = op_session.delete(f"{BASE_URL}/api/operator/ai-learnings/{lid}")
        assert r2.status_code == 404


# ------------- Chat stream still works with an active learning ---
class TestChatStreamWithLearning:
    def test_chat_succeeds_with_marker_learning(self, op_session):
        # create active learning with the marker
        text = "TESTONLY_MARKER_XYZ — keep answers short."
        cr = op_session.post(f"{BASE_URL}/api/operator/ai-learnings",
                             json={'text': text, 'enabled': True})
        assert cr.status_code == 201, cr.text
        lid = cr.json()['id']
        try:
            payload = {
                'message': 'Say hi in 3 words.',
                'model': 'claude-sonnet-4-6',
                'session_id': f'TEST_session_{uuid.uuid4().hex[:8]}',
            }
            r = op_session.post(f"{BASE_URL}/api/chat/stream", json=payload, timeout=60, stream=True)
            # Accept either streaming 200 or non-streaming 200; we only require
            # not 5xx so the learnings injection doesn't break the prompt.
            assert r.status_code < 500, f"chat stream broke with active learning: {r.status_code} {r.text[:300]}"
            # Drain a tiny portion if streaming so the connection closes cleanly.
            if r.status_code == 200:
                read = 0
                for chunk in r.iter_content(chunk_size=512):
                    read += len(chunk or b'')
                    if read > 1024:
                        break
                r.close()
        finally:
            op_session.delete(f"{BASE_URL}/api/operator/ai-learnings/{lid}")
