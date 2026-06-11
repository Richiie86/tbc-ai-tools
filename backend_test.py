"""
Comprehensive backend API test for TBC AI Control.
Tests all 25 flows as specified in the review request.
"""
import requests
import pyotp
import json
import time
from datetime import datetime

# Backend URL from frontend/.env
BASE_URL = "https://tbc-self-copy.preview.emergentagent.com/api"

# Operator credentials (pre-seeded)
OPERATOR_EMAIL = "rac.invetments.swe@gmail.com"
OPERATOR_PASSWORD = "TBC@2025!Admin"

# Test results tracking
test_results = []
test_user_token = None
test_user_email = None
test_user_id = None
test_user_2fa_secret = None
operator_token = None
test_session_id = None
test_checkout_session_id = None


def log_test(test_num, name, passed, details=""):
    """Log test result."""
    status = "✅ PASS" if passed else "❌ FAIL"
    result = {
        "test": test_num,
        "name": name,
        "status": status,
        "passed": passed,
        "details": details
    }
    test_results.append(result)
    print(f"\n{status} Test #{test_num}: {name}")
    if details:
        print(f"   Details: {details}")


def test_1_health_check():
    """Test 1: Health check endpoint."""
    try:
        resp = requests.get(f"{BASE_URL}/", timeout=10)
        data = resp.json()
        passed = (
            resp.status_code == 200 and
            "service" in data and
            "status" in data
        )
        log_test(1, "Health check GET /api/", passed, 
                f"Response: {data}" if passed else f"Status: {resp.status_code}, Body: {resp.text}")
        return passed
    except Exception as e:
        log_test(1, "Health check GET /api/", False, f"Exception: {str(e)}")
        return False


def test_2_register_new_user():
    """Test 2: Register a new test user."""
    global test_user_token, test_user_email, test_user_id
    try:
        timestamp = int(time.time())
        test_user_email = f"test_{timestamp}@example.com"
        payload = {
            "email": test_user_email,
            "password": "TestPass123!",
            "name": "Test User"
        }
        resp = requests.post(f"{BASE_URL}/auth/register", json=payload, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "token" in data and
            data.get("requires_2fa_setup") == True and
            "user" in data
        )
        
        if passed:
            test_user_token = data["token"]
            test_user_id = data["user"]["id"]
            log_test(2, "Register new test user", True, 
                    f"Email: {test_user_email}, Token received, requires_2fa_setup=true")
        else:
            log_test(2, "Register new test user", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(2, "Register new test user", False, f"Exception: {str(e)}")
        return False


def test_3_get_auth_me():
    """Test 3: GET /api/auth/me with user token."""
    global test_user_token
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.get(f"{BASE_URL}/auth/me", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            data.get("email") == test_user_email and
            data.get("role") == "user" and
            data.get("plan") == "free" and
            data.get("credits") == 50
        )
        
        log_test(3, "GET /api/auth/me", passed, 
                f"User info: {data}" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(3, "GET /api/auth/me", False, f"Exception: {str(e)}")
        return False


def test_4_2fa_setup():
    """Test 4: POST /api/auth/2fa/setup."""
    global test_user_token, test_user_2fa_secret
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.post(f"{BASE_URL}/auth/2fa/setup", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "secret" in data and
            "qr_data_url" in data and
            "otpauth_uri" in data and
            data["qr_data_url"].startswith("data:image/png;base64,")
        )
        
        if passed:
            test_user_2fa_secret = data["secret"]
            log_test(4, "2FA setup", True, 
                    f"Secret received, QR code generated")
        else:
            log_test(4, "2FA setup", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(4, "2FA setup", False, f"Exception: {str(e)}")
        return False


def test_5_2fa_enable():
    """Test 5: POST /api/auth/2fa/enable with TOTP code."""
    global test_user_token, test_user_2fa_secret
    try:
        # Generate current TOTP code
        totp = pyotp.TOTP(test_user_2fa_secret)
        code = totp.now()
        
        headers = {"Authorization": f"Bearer {test_user_token}"}
        payload = {"code": code}
        resp = requests.post(f"{BASE_URL}/auth/2fa/enable", json=payload, headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            data.get("success") == True
        )
        
        log_test(5, "2FA enable", passed, 
                f"2FA enabled successfully" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(5, "2FA enable", False, f"Exception: {str(e)}")
        return False


def test_6_login_with_2fa():
    """Test 6: Login with 2FA - should return pending_2fa=true."""
    global test_user_email, test_user_token
    try:
        payload = {
            "email": test_user_email,
            "password": "TestPass123!"
        }
        resp = requests.post(f"{BASE_URL}/auth/login", json=payload, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            data.get("pending_2fa") == True and
            "token" in data
        )
        
        if passed:
            test_user_token = data["token"]  # Save pending token
            log_test(6, "Login with 2FA", True, 
                    f"pending_2fa=true, pending token received")
        else:
            log_test(6, "Login with 2FA", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(6, "Login with 2FA", False, f"Exception: {str(e)}")
        return False


def test_7_verify_2fa():
    """Test 7: POST /api/auth/2fa/verify with pending token."""
    global test_user_token, test_user_2fa_secret
    try:
        # Generate current TOTP code
        totp = pyotp.TOTP(test_user_2fa_secret)
        code = totp.now()
        
        headers = {"Authorization": f"Bearer {test_user_token}"}
        payload = {"code": code}
        resp = requests.post(f"{BASE_URL}/auth/2fa/verify", json=payload, headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "token" in data and
            data.get("pending_2fa") == False
        )
        
        if passed:
            test_user_token = data["token"]  # Save full token
            log_test(7, "Verify 2FA", True, 
                    f"Full token received, pending_2fa=false")
        else:
            log_test(7, "Verify 2FA", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(7, "Verify 2FA", False, f"Exception: {str(e)}")
        return False


def test_8_operator_login():
    """Test 8: Operator login (no 2FA enabled yet)."""
    global operator_token
    try:
        payload = {
            "email": OPERATOR_EMAIL,
            "password": OPERATOR_PASSWORD
        }
        resp = requests.post(f"{BASE_URL}/auth/login", json=payload, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            data.get("pending_2fa") == False and
            data.get("requires_2fa_setup") == True and
            "token" in data
        )
        
        if passed:
            operator_token = data["token"]
            log_test(8, "Operator login", True, 
                    f"Operator token received, pending_2fa=false, requires_2fa_setup=true")
        else:
            log_test(8, "Operator login", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(8, "Operator login", False, f"Exception: {str(e)}")
        return False


def test_9_list_models():
    """Test 9: GET /api/chat/models."""
    try:
        resp = requests.get(f"{BASE_URL}/chat/models", timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "providers" in data and
            "OpenAI" in data["providers"] and
            "Anthropic" in data["providers"] and
            "Gemini" in data["providers"]
        )
        
        log_test(9, "List models", passed, 
                f"Providers: OpenAI, Anthropic, Gemini" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(9, "List models", False, f"Exception: {str(e)}")
        return False


def test_10_create_chat_session():
    """Test 10: POST /api/chat/sessions."""
    global test_user_token, test_session_id
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        payload = {
            "title": "Test Session",
            "model": "gpt-5.4"
        }
        resp = requests.post(f"{BASE_URL}/chat/sessions", json=payload, headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "id" in data and
            data.get("title") == "Test Session"
        )
        
        if passed:
            test_session_id = data["id"]
            log_test(10, "Create chat session", True, 
                    f"Session created: {test_session_id}")
        else:
            log_test(10, "Create chat session", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(10, "Create chat session", False, f"Exception: {str(e)}")
        return False


def test_11_list_sessions():
    """Test 11: GET /api/chat/sessions."""
    global test_user_token, test_session_id
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.get(f"{BASE_URL}/chat/sessions", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            isinstance(data, list) and
            any(s.get("id") == test_session_id for s in data)
        )
        
        log_test(11, "List sessions", passed, 
                f"Found {len(data)} sessions, test session present" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(11, "List sessions", False, f"Exception: {str(e)}")
        return False


def test_12_get_session_messages():
    """Test 12: GET /api/chat/sessions/{id}/messages."""
    global test_user_token, test_session_id
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.get(f"{BASE_URL}/chat/sessions/{test_session_id}/messages", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "messages" in data and
            isinstance(data["messages"], list) and
            len(data["messages"]) == 0  # Should be empty initially
        )
        
        log_test(12, "Get session messages", passed, 
                f"Messages: {len(data.get('messages', []))}" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(12, "Get session messages", False, f"Exception: {str(e)}")
        return False


def test_13_stream_chat():
    """Test 13: POST /api/chat/stream - CRITICAL SSE test."""
    global test_user_token, test_session_id
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        payload = {
            "session_id": test_session_id,
            "message": "Say hello in exactly three words",
            "model": "gpt-5.4"
        }
        
        # Stream SSE response
        resp = requests.post(f"{BASE_URL}/chat/stream", json=payload, headers=headers, stream=True, timeout=60)
        
        if resp.status_code != 200:
            log_test(13, "Stream chat (gpt-5.4)", False, 
                    f"Status: {resp.status_code}, Response: {resp.text}")
            return False
        
        # Parse SSE events
        delta_events = []
        done_event = False
        error_event = None
        
        for line in resp.iter_lines():
            if line:
                line_str = line.decode('utf-8')
                if line_str.startswith('data: '):
                    data_str = line_str[6:]  # Remove 'data: ' prefix
                    try:
                        event = json.loads(data_str)
                        if event.get("type") == "delta":
                            delta_events.append(event)
                        elif event.get("type") == "done":
                            done_event = True
                        elif event.get("type") == "error":
                            error_event = event
                    except json.JSONDecodeError:
                        pass
        
        # Verify we got delta events and done event
        passed = (
            len(delta_events) > 0 and
            done_event and
            error_event is None
        )
        
        if passed:
            # Now verify messages were saved
            headers = {"Authorization": f"Bearer {test_user_token}"}
            msg_resp = requests.get(f"{BASE_URL}/chat/sessions/{test_session_id}/messages", headers=headers, timeout=10)
            msg_data = msg_resp.json()
            
            messages_saved = (
                msg_resp.status_code == 200 and
                len(msg_data.get("messages", [])) == 2  # user + assistant
            )
            
            if messages_saved:
                log_test(13, "Stream chat (gpt-5.4)", True, 
                        f"Received {len(delta_events)} delta events, done event, 2 messages saved")
            else:
                log_test(13, "Stream chat (gpt-5.4)", False, 
                        f"Streaming worked but messages not saved correctly: {msg_data}")
                passed = False
        else:
            log_test(13, "Stream chat (gpt-5.4)", False, 
                    f"Delta events: {len(delta_events)}, Done: {done_event}, Error: {error_event}")
        
        return passed
    except Exception as e:
        log_test(13, "Stream chat (gpt-5.4)", False, f"Exception: {str(e)}")
        return False


def test_14_additional_providers():
    """Test 14: Test Claude and Gemini providers."""
    global test_user_token
    
    # Test Claude
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        
        # Create new session for Claude
        session_payload = {"title": "Claude Test", "model": "claude-sonnet-4-6"}
        session_resp = requests.post(f"{BASE_URL}/chat/sessions", json=session_payload, headers=headers, timeout=10)
        claude_session_id = session_resp.json().get("id")
        
        payload = {
            "session_id": claude_session_id,
            "message": "Say hello in exactly three words",
            "model": "claude-sonnet-4-6"
        }
        
        resp = requests.post(f"{BASE_URL}/chat/stream", json=payload, headers=headers, stream=True, timeout=60)
        
        claude_passed = resp.status_code == 200
        
        if claude_passed:
            # Check for at least some streaming data
            has_data = False
            for line in resp.iter_lines():
                if line and line.decode('utf-8').startswith('data: '):
                    has_data = True
                    break
            claude_passed = has_data
        
        log_test(14, "Stream chat (claude-sonnet-4-6)", claude_passed, 
                f"Streaming works" if claude_passed else f"Status: {resp.status_code}")
    except Exception as e:
        log_test(14, "Stream chat (claude-sonnet-4-6)", False, f"Exception: {str(e)}")
        claude_passed = False
    
    # Test Gemini
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        
        # Create new session for Gemini
        session_payload = {"title": "Gemini Test", "model": "gemini-3-flash-preview"}
        session_resp = requests.post(f"{BASE_URL}/chat/sessions", json=session_payload, headers=headers, timeout=10)
        gemini_session_id = session_resp.json().get("id")
        
        payload = {
            "session_id": gemini_session_id,
            "message": "Say hello in exactly three words",
            "model": "gemini-3-flash-preview"
        }
        
        resp = requests.post(f"{BASE_URL}/chat/stream", json=payload, headers=headers, stream=True, timeout=60)
        
        gemini_passed = resp.status_code == 200
        
        if gemini_passed:
            # Check for at least some streaming data
            has_data = False
            for line in resp.iter_lines():
                if line and line.decode('utf-8').startswith('data: '):
                    has_data = True
                    break
            gemini_passed = has_data
        
        log_test(14, "Stream chat (gemini-3-flash-preview)", gemini_passed, 
                f"Streaming works" if gemini_passed else f"Status: {resp.status_code}")
    except Exception as e:
        log_test(14, "Stream chat (gemini-3-flash-preview)", False, f"Exception: {str(e)}")
        gemini_passed = False
    
    return claude_passed and gemini_passed


def test_15_rename_delete_session():
    """Test 15: PATCH and DELETE session."""
    global test_user_token, test_session_id
    
    # Rename
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        payload = {"title": "Renamed Session"}
        resp = requests.patch(f"{BASE_URL}/chat/sessions/{test_session_id}", json=payload, headers=headers, timeout=10)
        data = resp.json()
        
        rename_passed = (
            resp.status_code == 200 and
            data.get("success") == True
        )
        
        log_test(15, "Rename session", rename_passed, 
                f"Session renamed" if rename_passed else f"Status: {resp.status_code}, Response: {data}")
    except Exception as e:
        log_test(15, "Rename session", False, f"Exception: {str(e)}")
        rename_passed = False
    
    # Delete
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.delete(f"{BASE_URL}/chat/sessions/{test_session_id}", headers=headers, timeout=10)
        data = resp.json()
        
        delete_passed = (
            resp.status_code == 200 and
            data.get("success") == True
        )
        
        if delete_passed:
            # Verify session no longer in list
            list_resp = requests.get(f"{BASE_URL}/chat/sessions", headers=headers, timeout=10)
            list_data = list_resp.json()
            not_in_list = not any(s.get("id") == test_session_id for s in list_data)
            delete_passed = not_in_list
        
        log_test(15, "Delete session", delete_passed, 
                f"Session deleted and not in list" if delete_passed else f"Status: {resp.status_code}, Response: {data}")
    except Exception as e:
        log_test(15, "Delete session", False, f"Exception: {str(e)}")
        delete_passed = False
    
    return rename_passed and delete_passed


def test_16_get_plans():
    """Test 16: GET /api/payments/plans."""
    try:
        resp = requests.get(f"{BASE_URL}/payments/plans", timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            isinstance(data, list) and
            len(data) == 3 and
            any(p.get("id") == "starter" for p in data) and
            any(p.get("id") == "pro" for p in data) and
            any(p.get("id") == "enterprise" for p in data)
        )
        
        if passed:
            # Verify each plan has required fields
            for plan in data:
                if not all(k in plan for k in ["id", "name", "price", "credits", "features"]):
                    passed = False
                    break
        
        log_test(16, "Get plans", passed, 
                f"3 plans: starter, pro, enterprise" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(16, "Get plans", False, f"Exception: {str(e)}")
        return False


def test_17_create_checkout():
    """Test 17: POST /api/payments/checkout."""
    global test_user_token, test_checkout_session_id
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        payload = {
            "plan_id": "starter",
            "origin_url": "https://tbc-self-copy.preview.emergentagent.com"
        }
        resp = requests.post(f"{BASE_URL}/payments/checkout", json=payload, headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "url" in data and
            "session_id" in data and
            data["url"].startswith("http")
        )
        
        if passed:
            test_checkout_session_id = data["session_id"]
            log_test(17, "Create checkout", True, 
                    f"Checkout URL: {data['url'][:50]}..., Session ID: {test_checkout_session_id}")
        else:
            log_test(17, "Create checkout", False, 
                    f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(17, "Create checkout", False, f"Exception: {str(e)}")
        return False


def test_18_check_payment_status():
    """Test 18: GET /api/payments/status/{session_id}."""
    global test_user_token, test_checkout_session_id
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.get(f"{BASE_URL}/payments/status/{test_checkout_session_id}", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "status" in data and
            "payment_status" in data and
            data.get("payment_status") in ["pending", "unpaid", "paid"]
        )
        
        log_test(18, "Check payment status", passed, 
                f"Status: {data.get('status')}, Payment: {data.get('payment_status')}" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(18, "Check payment status", False, f"Exception: {str(e)}")
        return False


def test_19_contact_form():
    """Test 19: POST /api/contact."""
    try:
        payload = {
            "name": "Test Contact",
            "email": "testcontact@example.com",
            "subject": "Test Subject",
            "message": "This is a test contact message."
        }
        resp = requests.post(f"{BASE_URL}/contact", json=payload, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            data.get("success") == True and
            "id" in data
        )
        
        log_test(19, "Contact form", passed, 
                f"Contact submitted: {data.get('id')}" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(19, "Contact form", False, f"Exception: {str(e)}")
        return False


def test_20_operator_stats():
    """Test 20: GET /api/operator/stats."""
    global operator_token
    try:
        headers = {"Authorization": f"Bearer {operator_token}"}
        resp = requests.get(f"{BASE_URL}/operator/stats", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            "total_users" in data and
            "paid_users" in data and
            "total_messages" in data and
            "revenue_usd" in data
        )
        
        log_test(20, "Operator stats", passed, 
                f"Stats: {data}" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(20, "Operator stats", False, f"Exception: {str(e)}")
        return False


def test_21_operator_users():
    """Test 21: GET /api/operator/users."""
    global operator_token, test_user_email
    try:
        headers = {"Authorization": f"Bearer {operator_token}"}
        resp = requests.get(f"{BASE_URL}/operator/users", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            isinstance(data, list) and
            any(u.get("email") == test_user_email for u in data)
        )
        
        log_test(21, "Operator users", passed, 
                f"Found {len(data)} users, test user present" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(21, "Operator users", False, f"Exception: {str(e)}")
        return False


def test_22_operator_transactions():
    """Test 22: GET /api/operator/transactions."""
    global operator_token, test_checkout_session_id
    try:
        headers = {"Authorization": f"Bearer {operator_token}"}
        resp = requests.get(f"{BASE_URL}/operator/transactions", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            isinstance(data, list) and
            any(t.get("session_id") == test_checkout_session_id for t in data)
        )
        
        log_test(22, "Operator transactions", passed, 
                f"Found {len(data)} transactions, test checkout present" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(22, "Operator transactions", False, f"Exception: {str(e)}")
        return False


def test_23_operator_contacts():
    """Test 23: GET /api/operator/contacts."""
    global operator_token
    try:
        headers = {"Authorization": f"Bearer {operator_token}"}
        resp = requests.get(f"{BASE_URL}/operator/contacts", headers=headers, timeout=10)
        data = resp.json()
        
        passed = (
            resp.status_code == 200 and
            isinstance(data, list) and
            len(data) > 0  # Should have at least the contact we submitted
        )
        
        log_test(23, "Operator contacts", passed, 
                f"Found {len(data)} contacts" if passed else f"Status: {resp.status_code}, Response: {data}")
        return passed
    except Exception as e:
        log_test(23, "Operator contacts", False, f"Exception: {str(e)}")
        return False


def test_24_operator_grant_credits():
    """Test 24: POST /api/operator/users/{user_id}/credits."""
    global operator_token, test_user_id, test_user_token
    try:
        headers = {"Authorization": f"Bearer {operator_token}"}
        resp = requests.post(f"{BASE_URL}/operator/users/{test_user_id}/credits?amount=100", headers=headers, timeout=10)
        data = resp.json()
        
        grant_passed = (
            resp.status_code == 200 and
            data.get("success") == True
        )
        
        if grant_passed:
            # Verify credits increased
            user_headers = {"Authorization": f"Bearer {test_user_token}"}
            me_resp = requests.get(f"{BASE_URL}/auth/me", headers=user_headers, timeout=10)
            me_data = me_resp.json()
            
            # User should have more credits now (started with 50, used some for chat, then granted 100)
            credits_increased = me_data.get("credits", 0) > 50
            grant_passed = credits_increased
        
        log_test(24, "Operator grant credits", grant_passed, 
                f"Credits granted and verified" if grant_passed else f"Status: {resp.status_code}, Response: {data}")
        return grant_passed
    except Exception as e:
        log_test(24, "Operator grant credits", False, f"Exception: {str(e)}")
        return False


def test_25_authorization_checks():
    """Test 25: Verify regular user cannot access operator routes."""
    global test_user_token
    try:
        headers = {"Authorization": f"Bearer {test_user_token}"}
        resp = requests.get(f"{BASE_URL}/operator/stats", headers=headers, timeout=10)
        
        passed = resp.status_code == 403
        
        log_test(25, "Authorization checks", passed, 
                f"Regular user correctly denied access (403)" if passed else f"Status: {resp.status_code}, Expected 403")
        return passed
    except Exception as e:
        log_test(25, "Authorization checks", False, f"Exception: {str(e)}")
        return False


def run_all_tests():
    """Run all 25 tests in order."""
    print("=" * 80)
    print("TBC AI Control Backend API Test Suite")
    print("=" * 80)
    
    # Run tests in order
    test_1_health_check()
    test_2_register_new_user()
    test_3_get_auth_me()
    test_4_2fa_setup()
    test_5_2fa_enable()
    test_6_login_with_2fa()
    test_7_verify_2fa()
    test_8_operator_login()
    test_9_list_models()
    test_10_create_chat_session()
    test_11_list_sessions()
    test_12_get_session_messages()
    test_13_stream_chat()
    test_14_additional_providers()
    test_15_rename_delete_session()
    test_16_get_plans()
    test_17_create_checkout()
    test_18_check_payment_status()
    test_19_contact_form()
    test_20_operator_stats()
    test_21_operator_users()
    test_22_operator_transactions()
    test_23_operator_contacts()
    test_24_operator_grant_credits()
    test_25_authorization_checks()
    
    # Summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    
    passed_count = sum(1 for r in test_results if r["passed"])
    failed_count = len(test_results) - passed_count
    
    print(f"\nTotal Tests: {len(test_results)}")
    print(f"✅ Passed: {passed_count}")
    print(f"❌ Failed: {failed_count}")
    
    if failed_count > 0:
        print("\n" + "=" * 80)
        print("FAILED TESTS:")
        print("=" * 80)
        for r in test_results:
            if not r["passed"]:
                print(f"\n❌ Test #{r['test']}: {r['name']}")
                print(f"   {r['details']}")
    
    print("\n" + "=" * 80)
    
    return passed_count, failed_count


if __name__ == "__main__":
    passed, failed = run_all_tests()
    exit(0 if failed == 0 else 1)
