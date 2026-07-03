#!/usr/bin/env python3
"""
Test NEW endpoints: referrals + projects + brand settings.
"""
import os
import sys
import requests
import pyotp
import time
import json

BASE_URL = os.environ.get("TEST_BASE_URL", "https://tbctools.org/api")

# Credentials from environment only — nothing sensitive is committed.
#   export TEST_OPERATOR_EMAIL="operator@example.com"
#   export TEST_OPERATOR_PASSWORD="your-password"
OPERATOR_EMAIL = os.environ.get("TEST_OPERATOR_EMAIL", "")
OPERATOR_PASSWORD = os.environ.get("TEST_OPERATOR_PASSWORD", "")

if not OPERATOR_EMAIL or not OPERATOR_PASSWORD:
    print(
        "SKIP: set TEST_OPERATOR_EMAIL and TEST_OPERATOR_PASSWORD env vars to run "
        "this integration test (no credentials are hardcoded)."
    )
    sys.exit(0)

results = {
    "passed": 0,
    "failed": 0,
    "tests": []
}

def log_test(name, passed, details=""):
    """Log test result."""
    status = "✅ PASS" if passed else "❌ FAIL"
    results["tests"].append({"name": name, "passed": passed, "details": details})
    if passed:
        results["passed"] += 1
    else:
        results["failed"] += 1
    print(f"{status} - {name}")
    if details:
        print(f"  {details}")

def login_operator():
    """Login as operator and handle 2FA if needed."""
    print("\n=== OPERATOR LOGIN ===")
    
    resp = requests.post(f"{BASE_URL}/auth/login", json={
        "email": OPERATOR_EMAIL,
        "password": OPERATOR_PASSWORD
    })
    
    if resp.status_code != 200:
        log_test("Operator login", False, f"Status {resp.status_code}: {resp.text}")
        return None
    
    data = resp.json()
    token = data.get("token")
    
    # Check if 2FA is required
    if data.get("pending_2fa"):
        print("  2FA required, computing TOTP...")
        
        # Get user info to retrieve TOTP secret
        headers = {"Authorization": f"Bearer {token}"}
        
        # Try to get the operator user to extract TOTP secret
        # Since we can't get the secret directly, we need to use pyotp with a known secret
        # For testing, let's try to use the pending token to verify
        
        # We need the TOTP secret - let's try to get it from the database or use a known one
        # For now, let's assume we need to handle this differently
        
        # Try to get the secret from the user document (this won't work via API)
        # We'll need to compute the TOTP code
        
        # Let's try a different approach - use the operator's existing TOTP secret
        # Since we don't have it, we'll need to fail gracefully
        
        log_test("Operator login (pending 2FA)", False, "Cannot proceed without TOTP secret - need to use pyotp with operator's secret")
        return None
    
    log_test("Operator login", True, "Token received")
    return token

def create_test_user(referral_code=None):
    """Create a fresh test user."""
    timestamp = int(time.time())
    email = f"test_ref_{timestamp}@example.com"
    password = "TestPass123!"
    
    payload = {
        "email": email,
        "password": password,
        "name": f"Test User {timestamp}"
    }
    
    if referral_code:
        payload["referral_code"] = referral_code
    
    resp = requests.post(f"{BASE_URL}/auth/register", json=payload)
    
    if resp.status_code != 200:
        log_test(f"Create test user{' with referral' if referral_code else ''}", False, f"Status {resp.status_code}: {resp.text}")
        return None, None
    
    data = resp.json()
    token = data.get("token")
    
    log_test(f"Create test user{' with referral' if referral_code else ''}", True, f"User: {email}")
    return token, email

def test_1_brand_settings():
    """Test 1: GET /api/brand/settings (public)."""
    print("\n=== TEST 1: PUBLIC BRAND SETTINGS ===")
    
    resp = requests.get(f"{BASE_URL}/brand/settings")
    
    if resp.status_code != 200:
        log_test("GET /api/brand/settings", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    
    # Check required fields
    required = ["share_base_url", "referral_base_url_org", "referral_base_url_com", "referral_pct"]
    for field in required:
        if field not in data:
            log_test("GET /api/brand/settings", False, f"Missing field '{field}'")
            return
    
    # Check specific values
    if data.get("referral_base_url_org") != "https://www.tbctools.org/referral":
        log_test("GET /api/brand/settings", False, f"Expected referral_base_url_org='https://www.tbctools.org/referral', got {data.get('referral_base_url_org')}")
        return
    
    if data.get("referral_base_url_com") != "https://www.tbctools.com/referral":
        log_test("GET /api/brand/settings", False, f"Expected referral_base_url_com='https://www.tbctools.com/referral', got {data.get('referral_base_url_com')}")
        return
    
    if data.get("referral_pct") != 10.0:
        log_test("GET /api/brand/settings", False, f"Expected referral_pct=10.0, got {data.get('referral_pct')}")
        return
    
    log_test("GET /api/brand/settings", True, f"Got all required fields with correct values")

def test_2_register_and_get_referral():
    """Test 2: Register user and GET /api/referral/me."""
    print("\n=== TEST 2: REGISTER USER & GET REFERRAL ===")
    
    user_token, user_email = create_test_user()
    if not user_token:
        return None, None
    
    headers = {"Authorization": f"Bearer {user_token}"}
    
    resp = requests.get(f"{BASE_URL}/referral/me", headers=headers)
    
    if resp.status_code != 200:
        log_test("GET /api/referral/me", False, f"Status {resp.status_code}: {resp.text}")
        return None, None
    
    data = resp.json()
    
    # Check required fields
    required = ["code", "share_url_org", "share_url_com", "commission_pct", "stats"]
    for field in required:
        if field not in data:
            log_test("GET /api/referral/me", False, f"Missing field '{field}'")
            return None, None
    
    code = data.get("code")
    if not code:
        log_test("GET /api/referral/me", False, "No referral code returned")
        return None, None
    
    # Check stats structure
    stats = data.get("stats", {})
    required_stats = ["clicks", "signups", "accrued_usd", "paid_usd", "accrued_count", "paid_count"]
    for field in required_stats:
        if field not in stats:
            log_test("GET /api/referral/me", False, f"Missing stats field '{field}'")
            return None, None
    
    # Check commission_pct
    if data.get("commission_pct") != 10.0:
        log_test("GET /api/referral/me", False, f"Expected commission_pct=10.0, got {data.get('commission_pct')}")
        return None, None
    
    log_test("GET /api/referral/me", True, f"Got referral code '{code}' with all required fields")
    
    return user_token, code

def test_3_track_clicks(code):
    """Test 3: POST /api/referral/track."""
    print("\n=== TEST 3: TRACK REFERRAL CLICKS ===")
    
    # Track first click
    resp = requests.post(f"{BASE_URL}/referral/track", json={
        "code": code,
        "referrer": "https://example.com/page1"
    })
    
    if resp.status_code != 200:
        log_test("POST /api/referral/track (1st)", False, f"Status {resp.status_code}: {resp.text}")
        return False
    
    data = resp.json()
    if not data.get("ok"):
        log_test("POST /api/referral/track (1st)", False, f"Expected ok=true, got {data}")
        return False
    
    log_test("POST /api/referral/track (1st)", True, "Tracked first click")
    
    # Track second click
    resp = requests.post(f"{BASE_URL}/referral/track", json={
        "code": code,
        "referrer": "https://example.com/page2"
    })
    
    if resp.status_code != 200:
        log_test("POST /api/referral/track (2nd)", False, f"Status {resp.status_code}: {resp.text}")
        return False
    
    data = resp.json()
    if not data.get("ok"):
        log_test("POST /api/referral/track (2nd)", False, f"Expected ok=true, got {data}")
        return False
    
    log_test("POST /api/referral/track (2nd)", True, "Tracked second click")
    
    return True

def test_4_verify_clicks(user_token):
    """Test 4: Verify clicks in GET /api/referral/me."""
    print("\n=== TEST 4: VERIFY CLICKS ===")
    
    headers = {"Authorization": f"Bearer {user_token}"}
    
    resp = requests.get(f"{BASE_URL}/referral/me", headers=headers)
    
    if resp.status_code != 200:
        log_test("GET /api/referral/me (verify clicks)", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    stats = data.get("stats", {})
    clicks = stats.get("clicks", 0)
    
    if clicks < 2:
        log_test("GET /api/referral/me (verify clicks)", False, f"Expected clicks >= 2, got {clicks}")
        return
    
    log_test("GET /api/referral/me (verify clicks)", True, f"Clicks count: {clicks}")

def test_5_register_with_referral(referral_code):
    """Test 5: Register second user with referral code."""
    print("\n=== TEST 5: REGISTER WITH REFERRAL CODE ===")
    
    user2_token, user2_email = create_test_user(referral_code=referral_code)
    if not user2_token:
        return False
    
    log_test("Register with referral code", True, f"User created: {user2_email}")
    return True

def test_6_verify_signups(user_token):
    """Test 6: Verify signups in GET /api/referral/me."""
    print("\n=== TEST 6: VERIFY SIGNUPS ===")
    
    headers = {"Authorization": f"Bearer {user_token}"}
    
    resp = requests.get(f"{BASE_URL}/referral/me", headers=headers)
    
    if resp.status_code != 200:
        log_test("GET /api/referral/me (verify signups)", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    stats = data.get("stats", {})
    signups = stats.get("signups", 0)
    
    if signups < 1:
        log_test("GET /api/referral/me (verify signups)", False, f"Expected signups >= 1, got {signups}")
        return
    
    log_test("GET /api/referral/me (verify signups)", True, f"Signups count: {signups}")

def test_7_operator_referrals(op_token):
    """Test 7: GET /api/operator/referrals."""
    print("\n=== TEST 7: OPERATOR REFERRALS ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    resp = requests.get(f"{BASE_URL}/operator/referrals", headers=headers)
    
    if resp.status_code != 200:
        log_test("GET /api/operator/referrals", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    
    if not isinstance(data, list):
        log_test("GET /api/operator/referrals", False, "Expected list response")
        return
    
    # Check structure of first item if available
    if len(data) > 0:
        item = data[0]
        required = ["code", "user_email", "clicks", "signups"]
        for field in required:
            if field not in item:
                log_test("GET /api/operator/referrals", False, f"Missing field '{field}' in referral item")
                return
    
    log_test("GET /api/operator/referrals", True, f"Got {len(data)} referral codes with stats")

def test_8_operator_brand_settings(op_token):
    """Test 8: GET /api/operator/brand-settings."""
    print("\n=== TEST 8: OPERATOR BRAND SETTINGS ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    resp = requests.get(f"{BASE_URL}/operator/brand-settings", headers=headers)
    
    if resp.status_code != 200:
        log_test("GET /api/operator/brand-settings", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    
    # Check required fields
    required = ["share_base_url", "referral_base_url_org", "referral_base_url_com", "referral_pct"]
    for field in required:
        if field not in data:
            log_test("GET /api/operator/brand-settings", False, f"Missing field '{field}'")
            return
    
    log_test("GET /api/operator/brand-settings", True, f"Got current settings")

def test_9_update_brand_settings(op_token):
    """Test 9: PUT /api/operator/brand-settings."""
    print("\n=== TEST 9: UPDATE BRAND SETTINGS ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # Update to 15%
    resp = requests.put(f"{BASE_URL}/operator/brand-settings", headers=headers, json={
        "referral_pct": 15.0
    })
    
    if resp.status_code != 200:
        log_test("PUT /api/operator/brand-settings (15%)", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    log_test("PUT /api/operator/brand-settings (15%)", True, "Updated to 15%")
    
    # Verify public endpoint shows 15%
    resp = requests.get(f"{BASE_URL}/brand/settings")
    
    if resp.status_code != 200:
        log_test("GET /api/brand/settings (verify 15%)", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    if data.get("referral_pct") != 15.0:
        log_test("GET /api/brand/settings (verify 15%)", False, f"Expected referral_pct=15.0, got {data.get('referral_pct')}")
        return
    
    log_test("GET /api/brand/settings (verify 15%)", True, "Public endpoint shows 15%")
    
    # Update back to 10%
    resp = requests.put(f"{BASE_URL}/operator/brand-settings", headers=headers, json={
        "referral_pct": 10.0
    })
    
    if resp.status_code != 200:
        log_test("PUT /api/operator/brand-settings (10%)", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    log_test("PUT /api/operator/brand-settings (10%)", True, "Updated back to 10%")
    
    # Verify public endpoint shows 10%
    resp = requests.get(f"{BASE_URL}/brand/settings")
    
    if resp.status_code != 200:
        log_test("GET /api/brand/settings (verify 10%)", False, f"Status {resp.status_code}")
        return
    
    data = resp.json()
    if data.get("referral_pct") != 10.0:
        log_test("GET /api/brand/settings (verify 10%)", False, f"Expected referral_pct=10.0, got {data.get('referral_pct')}")
        return
    
    log_test("GET /api/brand/settings (verify 10%)", True, "Public endpoint shows 10%")

def test_10_projects_crud(op_token):
    """Test 10: Projects CRUD."""
    print("\n=== TEST 10: PROJECTS CRUD ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # GET projects (should be empty or have existing)
    resp = requests.get(f"{BASE_URL}/operator/projects", headers=headers)
    
    if resp.status_code != 200:
        log_test("GET /api/operator/projects", False, f"Status {resp.status_code}")
        return None
    
    projects = resp.json()
    log_test("GET /api/operator/projects", True, f"Got {len(projects)} projects")
    
    # POST create project
    resp = requests.post(f"{BASE_URL}/operator/projects", headers=headers, json={
        "title": "My SaaS",
        "description": "Test",
        "status": "active",
        "tags": ["mvp"]
    })
    
    if resp.status_code != 200:
        log_test("POST /api/operator/projects", False, f"Status {resp.status_code}: {resp.text}")
        return None
    
    project = resp.json()
    project_id = project.get("id")
    
    if not project_id:
        log_test("POST /api/operator/projects", False, "No id returned")
        return None
    
    if project.get("title") != "My SaaS":
        log_test("POST /api/operator/projects", False, f"Expected title='My SaaS', got {project.get('title')}")
        return None
    
    log_test("POST /api/operator/projects", True, f"Created project {project_id}")
    
    # PUT update project
    resp = requests.put(f"{BASE_URL}/operator/projects/{project_id}", headers=headers, json={
        "title": "My SaaS",
        "description": "Test",
        "status": "done",
        "tags": ["mvp"]
    })
    
    if resp.status_code != 200:
        log_test("PUT /api/operator/projects/{id}", False, f"Status {resp.status_code}: {resp.text}")
        return project_id
    
    updated = resp.json()
    if updated.get("status") != "done":
        log_test("PUT /api/operator/projects/{id}", False, f"Expected status='done', got {updated.get('status')}")
        return project_id
    
    log_test("PUT /api/operator/projects/{id}", True, "Updated status to 'done'")
    
    # DELETE project
    resp = requests.delete(f"{BASE_URL}/operator/projects/{project_id}", headers=headers)
    
    if resp.status_code != 200:
        log_test("DELETE /api/operator/projects/{id}", False, f"Status {resp.status_code}")
        return project_id
    
    log_test("DELETE /api/operator/projects/{id}", True, "Deleted project")
    
    return project_id

def test_11_authorization():
    """Test 11: Authorization - regular user calling operator endpoint."""
    print("\n=== TEST 11: AUTHORIZATION ===")
    
    # Create regular user
    user_token, _ = create_test_user()
    if not user_token:
        return
    
    headers = {"Authorization": f"Bearer {user_token}"}
    
    # Try to access operator projects endpoint
    resp = requests.get(f"{BASE_URL}/operator/projects", headers=headers)
    
    if resp.status_code != 403:
        log_test("GET /api/operator/projects (user token)", False, f"Expected 403, got {resp.status_code}")
        return
    
    log_test("GET /api/operator/projects (user token)", True, "Got 403 for regular user")

def main():
    """Run all tests."""
    print("=" * 60)
    print("TBC AI CONTROL - NEW ENDPOINTS TEST")
    print("Testing: referrals + projects + brand settings")
    print("=" * 60)
    
    # Login as operator
    op_token = login_operator()
    if not op_token:
        print("\n⚠️  WARNING: Cannot login as operator (2FA required)")
        print("Proceeding with tests that don't require operator token...")
    
    # Test 1: Public brand settings
    test_1_brand_settings()
    
    # Test 2-6: Referral flow
    user_token, referral_code = test_2_register_and_get_referral()
    if user_token and referral_code:
        if test_3_track_clicks(referral_code):
            test_4_verify_clicks(user_token)
        
        if test_5_register_with_referral(referral_code):
            test_6_verify_signups(user_token)
    
    # Test 7-10: Operator endpoints
    if op_token:
        test_7_operator_referrals(op_token)
        test_8_operator_brand_settings(op_token)
        test_9_update_brand_settings(op_token)
        test_10_projects_crud(op_token)
    else:
        print("\n⚠️  Skipping operator tests (no token)")
    
    # Test 11: Authorization
    test_11_authorization()
    
    # Print summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    print(f"✅ PASSED: {results['passed']}")
    print(f"❌ FAILED: {results['failed']}")
    print(f"TOTAL: {results['passed'] + results['failed']}")
    
    if results['failed'] > 0:
        print("\nFAILED TESTS:")
        for test in results['tests']:
            if not test['passed']:
                print(f"  ❌ {test['name']}")
                if test['details']:
                    print(f"     {test['details']}")
    
    print("=" * 60)

if __name__ == "__main__":
    main()
