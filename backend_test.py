#!/usr/bin/env python3
"""
Comprehensive backend test for TBC AI Control - NEW payment endpoints.
Tests: plans, treasury, settings, manual payments, PDF receipts, licenses, royalties.
"""
import os
import sys
import requests
import pyotp
import time
import json
from datetime import datetime

# Backend URL — override with TEST_BASE_URL when running elsewhere.
BASE_URL = os.environ.get("TEST_BASE_URL", "https://tbctools.org/api")

# Operator credentials come EXCLUSIVELY from environment variables so no secret
# is ever committed to the repo. Set these before running:
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

# Test results
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
    
    # Step 1: Login
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
    if data.get("requires_2fa_setup"):
        # Token is usable directly (2FA not enabled yet)
        log_test("Operator login (no 2FA)", True, "Token usable directly")
        return token
    
    if data.get("pending_2fa"):
        # Need to compute TOTP and verify
        print("  2FA required, computing TOTP...")
        
        # Get user info to retrieve TOTP secret
        headers = {"Authorization": f"Bearer {token}"}
        me_resp = requests.get(f"{BASE_URL}/auth/me", headers=headers)
        
        # We need the TOTP secret - try to get it from setup endpoint
        # Actually, we need to use the pending token to verify
        # Let's assume operator has already set up 2FA, we need to get the secret
        # For testing, we'll try to verify with a code
        
        # Since we can't get the secret directly, we'll need to handle this differently
        # Let's check if we can bypass by using the token directly
        log_test("Operator login (pending 2FA)", False, "Cannot proceed without TOTP secret")
        return None
    
    log_test("Operator login", True, "Full token received")
    return token

def create_test_user():
    """Create a fresh test user for manual payment testing."""
    print("\n=== CREATE TEST USER ===")
    
    timestamp = int(time.time())
    email = f"test_payment_{timestamp}@example.com"
    password = "TestPass123!"
    
    resp = requests.post(f"{BASE_URL}/auth/register", json={
        "email": email,
        "password": password,
        "name": "Test Payment User"
    })
    
    if resp.status_code != 200:
        log_test("Create test user", False, f"Status {resp.status_code}: {resp.text}")
        return None, None
    
    data = resp.json()
    token = data.get("token")
    
    log_test("Create test user", True, f"User: {email}")
    return token, email

def test_public_plans():
    """Test 1: Public plans (DB-backed)."""
    print("\n=== TEST 1: PUBLIC PLANS ===")
    
    resp = requests.get(f"{BASE_URL}/payments/plans")
    
    if resp.status_code != 200:
        log_test("GET /api/payments/plans", False, f"Status {resp.status_code}")
        return
    
    plans = resp.json()
    
    # Should return at least 3 default plans
    if len(plans) < 3:
        log_test("GET /api/payments/plans", False, f"Expected at least 3 plans, got {len(plans)}")
        return
    
    # Check for required fields
    required_fields = ["id", "name", "price", "regular_price", "credits", "intro", "features"]
    for plan in plans:
        for field in required_fields:
            if field not in plan:
                log_test("GET /api/payments/plans", False, f"Missing field '{field}' in plan")
                return
    
    # Check for default plans
    plan_ids = [p["id"] for p in plans]
    expected_ids = ["starter", "pro", "enterprise"]
    for expected_id in expected_ids:
        if expected_id not in plan_ids:
            log_test("GET /api/payments/plans", False, f"Missing default plan '{expected_id}'")
            return
    
    # Verify specific plan details
    starter = next((p for p in plans if p["id"] == "starter"), None)
    if starter:
        if starter["price"] != 9.0:
            log_test("GET /api/payments/plans", False, f"Starter price should be 9.0, got {starter['price']}")
            return
    
    log_test("GET /api/payments/plans", True, f"Found {len(plans)} plans with correct structure")

def test_payment_methods():
    """Test 2: Payment methods."""
    print("\n=== TEST 2: PAYMENT METHODS ===")
    
    resp = requests.get(f"{BASE_URL}/payments/methods")
    
    if resp.status_code != 200:
        log_test("GET /api/payments/methods", False, f"Status {resp.status_code}")
        return
    
    methods = resp.json()
    
    # Should return at least card, crypto_manual, bank
    method_ids = [m["id"] for m in methods]
    expected = ["card", "crypto_manual", "bank"]
    
    for exp in expected:
        if exp not in method_ids:
            log_test("GET /api/payments/methods", False, f"Missing method '{exp}'")
            return
    
    log_test("GET /api/payments/methods", True, f"Found methods: {', '.join(method_ids)}")

def test_treasury_404():
    """Test 3: Treasury active (404 case)."""
    print("\n=== TEST 3: TREASURY ACTIVE (404) ===")
    
    resp = requests.get(f"{BASE_URL}/payments/treasury/active?method=crypto_manual")
    
    if resp.status_code != 404:
        log_test("GET /api/payments/treasury/active (404)", False, f"Expected 404, got {resp.status_code}")
        return
    
    data = resp.json()
    if "detail" not in data:
        log_test("GET /api/payments/treasury/active (404)", False, "Missing 'detail' in error response")
        return
    
    log_test("GET /api/payments/treasury/active (404)", True, f"Got 404 with detail: {data['detail']}")

def test_operator_plans_crud(op_token):
    """Test 4: Operator Plans CRUD."""
    print("\n=== TEST 4: OPERATOR PLANS CRUD ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # GET existing plans
    resp = requests.get(f"{BASE_URL}/operator/plans", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/plans", False, f"Status {resp.status_code}")
        return
    
    plans = resp.json()
    log_test("GET /api/operator/plans", True, f"Found {len(plans)} plans")
    
    # POST new plan
    new_plan = {
        "id": "test_plan",
        "name": "Test Plan",
        "price": 5.0,
        "credits": 100,
        "features": ["X"],
        "enabled": True,
        "order": 99
    }
    
    resp = requests.post(f"{BASE_URL}/operator/plans", headers=headers, json=new_plan)
    if resp.status_code != 200:
        log_test("POST /api/operator/plans", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    created = resp.json()
    if created.get("id") != "test_plan":
        log_test("POST /api/operator/plans", False, f"Expected id 'test_plan', got {created.get('id')}")
        return
    
    log_test("POST /api/operator/plans", True, "Created test_plan")
    
    # PUT update plan
    update = {
        "name": "Renamed Test Plan",
        "price": 7.0,
        "credits": 100,
        "features": ["X"],
        "enabled": True,
        "order": 99
    }
    
    resp = requests.put(f"{BASE_URL}/operator/plans/test_plan", headers=headers, json=update)
    if resp.status_code != 200:
        log_test("PUT /api/operator/plans/test_plan", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    updated = resp.json()
    if updated.get("name") != "Renamed Test Plan" or updated.get("price") != 7.0:
        log_test("PUT /api/operator/plans/test_plan", False, "Update didn't apply correctly")
        return
    
    log_test("PUT /api/operator/plans/test_plan", True, "Updated name and price")
    
    # DELETE plan
    resp = requests.delete(f"{BASE_URL}/operator/plans/test_plan", headers=headers)
    if resp.status_code != 200:
        log_test("DELETE /api/operator/plans/test_plan", False, f"Status {resp.status_code}")
        return
    
    log_test("DELETE /api/operator/plans/test_plan", True, "Deleted test_plan")

def test_operator_treasury_crud(op_token):
    """Test 5: Operator Treasury CRUD."""
    print("\n=== TEST 5: OPERATOR TREASURY CRUD ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # POST crypto treasury
    crypto_dest = {
        "type": "crypto",
        "label": "USDT Tron Test",
        "network": "TRC20-USDT",
        "wallet_address": "TXyZ12345TestWalletAddress"
    }
    
    resp = requests.post(f"{BASE_URL}/operator/treasury", headers=headers, json=crypto_dest)
    if resp.status_code != 200:
        log_test("POST /api/operator/treasury (crypto)", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    crypto = resp.json()
    crypto_id = crypto.get("id")
    log_test("POST /api/operator/treasury (crypto)", True, f"Created crypto destination: {crypto_id}")
    
    # POST bank treasury
    bank_dest = {
        "type": "bank",
        "label": "Main Bank Test",
        "holder_name": "Test Holder",
        "iban": "DE89370400440532013000",
        "bic": "COBADEFFXXX",
        "bank_name": "Test Bank"
    }
    
    resp = requests.post(f"{BASE_URL}/operator/treasury", headers=headers, json=bank_dest)
    if resp.status_code != 200:
        log_test("POST /api/operator/treasury (bank)", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    bank = resp.json()
    bank_id = bank.get("id")
    log_test("POST /api/operator/treasury (bank)", True, f"Created bank destination: {bank_id}")
    
    # GET treasury list
    resp = requests.get(f"{BASE_URL}/operator/treasury", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/treasury", False, f"Status {resp.status_code}")
        return
    
    treasury_list = resp.json()
    if len(treasury_list) < 2:
        log_test("GET /api/operator/treasury", False, f"Expected at least 2 items, got {len(treasury_list)}")
        return
    
    log_test("GET /api/operator/treasury", True, f"Found {len(treasury_list)} treasury destinations")
    
    # POST activate crypto
    resp = requests.post(f"{BASE_URL}/operator/treasury/{crypto_id}/activate", headers=headers)
    if resp.status_code != 200:
        log_test("POST /api/operator/treasury/{crypto_id}/activate", False, f"Status {resp.status_code}")
        return
    
    log_test("POST /api/operator/treasury/{crypto_id}/activate", True, "Activated crypto destination")
    
    # GET active crypto treasury (public endpoint)
    resp = requests.get(f"{BASE_URL}/payments/treasury/active?method=crypto_manual")
    if resp.status_code != 200:
        log_test("GET /api/payments/treasury/active (crypto)", False, f"Status {resp.status_code}")
        return
    
    active_crypto = resp.json()
    if not active_crypto.get("qr_data_url"):
        log_test("GET /api/payments/treasury/active (crypto)", False, "Missing qr_data_url")
        return
    
    if not active_crypto["qr_data_url"].startswith("data:image/png;base64,"):
        log_test("GET /api/payments/treasury/active (crypto)", False, "Invalid qr_data_url format")
        return
    
    log_test("GET /api/payments/treasury/active (crypto)", True, "Got active crypto with QR code")
    
    # POST activate bank
    resp = requests.post(f"{BASE_URL}/operator/treasury/{bank_id}/activate", headers=headers)
    if resp.status_code != 200:
        log_test("POST /api/operator/treasury/{bank_id}/activate", False, f"Status {resp.status_code}")
        return
    
    log_test("POST /api/operator/treasury/{bank_id}/activate", True, "Activated bank destination")
    
    # GET active bank treasury
    resp = requests.get(f"{BASE_URL}/payments/treasury/active?method=bank")
    if resp.status_code != 200:
        log_test("GET /api/payments/treasury/active (bank)", False, f"Status {resp.status_code}")
        return
    
    active_bank = resp.json()
    log_test("GET /api/payments/treasury/active (bank)", True, "Got active bank destination")
    
    # PUT update bank
    update = {
        "type": "bank",
        "label": "Main Bank Updated",
        "holder_name": "Test Holder 2",
        "iban": "DE89370400440532013000",
        "bic": "COBADEFFXXX",
        "bank_name": "Test Bank"
    }
    
    resp = requests.put(f"{BASE_URL}/operator/treasury/{bank_id}", headers=headers, json=update)
    if resp.status_code != 200:
        log_test("PUT /api/operator/treasury/{bank_id}", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    updated_bank = resp.json()
    if updated_bank.get("label") != "Main Bank Updated":
        log_test("PUT /api/operator/treasury/{bank_id}", False, "Update didn't apply")
        return
    
    log_test("PUT /api/operator/treasury/{bank_id}", True, "Updated bank destination")
    
    # DELETE both
    resp = requests.delete(f"{BASE_URL}/operator/treasury/{crypto_id}", headers=headers)
    if resp.status_code != 200:
        log_test("DELETE /api/operator/treasury/{crypto_id}", False, f"Status {resp.status_code}")
        return
    
    log_test("DELETE /api/operator/treasury/{crypto_id}", True, "Deleted crypto destination")
    
    resp = requests.delete(f"{BASE_URL}/operator/treasury/{bank_id}", headers=headers)
    if resp.status_code != 200:
        log_test("DELETE /api/operator/treasury/{bank_id}", False, f"Status {resp.status_code}")
        return
    
    log_test("DELETE /api/operator/treasury/{bank_id}", True, "Deleted bank destination")

def test_operator_settings(op_token):
    """Test 6: Operator Settings."""
    print("\n=== TEST 6: OPERATOR SETTINGS ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # GET settings
    resp = requests.get(f"{BASE_URL}/operator/settings", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/settings", False, f"Status {resp.status_code}")
        return
    
    settings = resp.json()
    
    # Check for required fields
    required = ["enable_card", "enable_crypto_manual", "enable_bank"]
    for field in required:
        if field not in settings:
            log_test("GET /api/operator/settings", False, f"Missing field '{field}'")
            return
    
    log_test("GET /api/operator/settings", True, "Got settings with masked keys")
    
    # PUT update settings
    update = {
        "nowpayments_api_key": "test-key-1234",
        "enable_crypto_auto": True
    }
    
    resp = requests.put(f"{BASE_URL}/operator/settings", headers=headers, json=update)
    if resp.status_code != 200:
        log_test("PUT /api/operator/settings", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    log_test("PUT /api/operator/settings", True, "Updated settings")
    
    # GET settings again to verify
    resp = requests.get(f"{BASE_URL}/operator/settings", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/settings (verify)", False, f"Status {resp.status_code}")
        return
    
    settings = resp.json()
    if not settings.get("nowpayments_api_key_set"):
        log_test("GET /api/operator/settings (verify)", False, "nowpayments_api_key not set")
        return
    
    if not settings.get("enable_crypto_auto"):
        log_test("GET /api/operator/settings (verify)", False, "enable_crypto_auto not enabled")
        return
    
    log_test("GET /api/operator/settings (verify)", True, "Settings updated correctly")
    
    # GET payment methods to verify crypto_auto is now available
    resp = requests.get(f"{BASE_URL}/payments/methods")
    if resp.status_code != 200:
        log_test("GET /api/payments/methods (crypto_auto)", False, f"Status {resp.status_code}")
        return
    
    methods = resp.json()
    method_ids = [m["id"] for m in methods]
    
    if "crypto_auto" not in method_ids:
        log_test("GET /api/payments/methods (crypto_auto)", False, "crypto_auto not in methods")
        return
    
    log_test("GET /api/payments/methods (crypto_auto)", True, "crypto_auto now available")
    
    # POST clear key
    resp = requests.post(f"{BASE_URL}/operator/settings/clear?key=nowpayments_api_key", headers=headers)
    if resp.status_code != 200:
        log_test("POST /api/operator/settings/clear", False, f"Status {resp.status_code}")
        return
    
    log_test("POST /api/operator/settings/clear", True, "Cleared nowpayments_api_key")
    
    # Verify it's cleared
    resp = requests.get(f"{BASE_URL}/operator/settings", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/settings (verify clear)", False, f"Status {resp.status_code}")
        return
    
    settings = resp.json()
    if settings.get("nowpayments_api_key_set"):
        log_test("GET /api/operator/settings (verify clear)", False, "Key not cleared")
        return
    
    log_test("GET /api/operator/settings (verify clear)", True, "Key cleared successfully")

def test_manual_payment_flow(op_token):
    """Test 7: Manual payment flow."""
    print("\n=== TEST 7: MANUAL PAYMENT FLOW ===")
    
    op_headers = {"Authorization": f"Bearer {op_token}"}
    
    # Create test user
    user_token, user_email = create_test_user()
    if not user_token:
        return
    
    user_headers = {"Authorization": f"Bearer {user_token}"}
    
    # Create and activate crypto treasury
    crypto_dest = {
        "type": "crypto",
        "label": "Test Crypto for Manual Payment",
        "network": "TRC20-USDT",
        "wallet_address": "TTestWalletForManualPayment123"
    }
    
    resp = requests.post(f"{BASE_URL}/operator/treasury", headers=op_headers, json=crypto_dest)
    if resp.status_code != 200:
        log_test("Manual payment: Create treasury", False, f"Status {resp.status_code}")
        return
    
    crypto = resp.json()
    crypto_id = crypto.get("id")
    
    # Activate it
    resp = requests.post(f"{BASE_URL}/operator/treasury/{crypto_id}/activate", headers=op_headers)
    if resp.status_code != 200:
        log_test("Manual payment: Activate treasury", False, f"Status {resp.status_code}")
        return
    
    log_test("Manual payment: Setup treasury", True, f"Created and activated treasury {crypto_id}")
    
    # Submit manual payment as test user
    payment_req = {
        "plan_id": "starter",
        "method": "crypto_manual",
        "treasury_id": crypto_id,
        "proof": "0xabc123def456test"
    }
    
    resp = requests.post(f"{BASE_URL}/payments/manual", headers=user_headers, json=payment_req)
    if resp.status_code != 200:
        log_test("POST /api/payments/manual", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    payment = resp.json()
    tx_id = payment.get("transaction_id")
    
    if payment.get("status") != "pending_review":
        log_test("POST /api/payments/manual", False, f"Expected status 'pending_review', got {payment.get('status')}")
        return
    
    log_test("POST /api/payments/manual", True, f"Created transaction {tx_id} with status pending_review")
    
    # GET operator transactions to verify
    resp = requests.get(f"{BASE_URL}/operator/transactions", headers=op_headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/transactions (verify)", False, f"Status {resp.status_code}")
        return
    
    txs = resp.json()
    tx = next((t for t in txs if t.get("id") == tx_id), None)
    
    if not tx:
        log_test("GET /api/operator/transactions (verify)", False, "Transaction not found")
        return
    
    if tx.get("payment_status") != "pending":
        log_test("GET /api/operator/transactions (verify)", False, f"Expected payment_status 'pending', got {tx.get('payment_status')}")
        return
    
    metadata = tx.get("metadata", {})
    if metadata.get("method") != "crypto_manual":
        log_test("GET /api/operator/transactions (verify)", False, f"Expected method 'crypto_manual', got {metadata.get('method')}")
        return
    
    log_test("GET /api/operator/transactions (verify)", True, "Transaction appears with correct status and method")
    
    # Confirm transaction as operator
    resp = requests.post(f"{BASE_URL}/operator/transactions/{tx_id}/confirm", headers=op_headers)
    if resp.status_code != 200:
        log_test("POST /api/operator/transactions/{tx_id}/confirm", False, f"Status {resp.status_code}")
        return
    
    log_test("POST /api/operator/transactions/{tx_id}/confirm", True, "Confirmed transaction")
    
    # Verify user's plan upgraded and credits added
    resp = requests.get(f"{BASE_URL}/auth/me", headers=user_headers)
    if resp.status_code != 200:
        log_test("Verify user upgrade", False, f"Status {resp.status_code}")
        return
    
    user = resp.json()
    
    if user.get("plan") != "starter":
        log_test("Verify user upgrade", False, f"Expected plan 'starter', got {user.get('plan')}")
        return
    
    # User should have 50 (default) + 500 (starter) = 550 credits
    if user.get("credits") < 500:
        log_test("Verify user upgrade", False, f"Expected at least 500 credits, got {user.get('credits')}")
        return
    
    log_test("Verify user upgrade", True, f"User upgraded to starter with {user.get('credits')} credits")
    
    # Cleanup: delete treasury
    requests.delete(f"{BASE_URL}/operator/treasury/{crypto_id}", headers=op_headers)

def test_pdf_receipts(op_token):
    """Test 8: PDF receipts."""
    print("\n=== TEST 8: PDF RECEIPTS ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # Get a transaction ID from operator transactions
    resp = requests.get(f"{BASE_URL}/operator/transactions", headers=headers)
    if resp.status_code != 200:
        log_test("PDF: Get transactions", False, f"Status {resp.status_code}")
        return
    
    txs = resp.json()
    if not txs:
        log_test("PDF: Get transactions", False, "No transactions found")
        return
    
    tx_id = txs[0].get("id")
    log_test("PDF: Get transactions", True, f"Found transaction {tx_id}")
    
    # GET single receipt
    resp = requests.get(f"{BASE_URL}/operator/transactions/{tx_id}/receipt", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/transactions/{tx_id}/receipt", False, f"Status {resp.status_code}")
        return
    
    # Check Content-Type
    content_type = resp.headers.get("Content-Type")
    if content_type != "application/pdf":
        log_test("GET /api/operator/transactions/{tx_id}/receipt", False, f"Expected Content-Type 'application/pdf', got '{content_type}'")
        return
    
    # Check Content-Disposition
    content_disp = resp.headers.get("Content-Disposition")
    if not content_disp or "attachment" not in content_disp:
        log_test("GET /api/operator/transactions/{tx_id}/receipt", False, f"Expected Content-Disposition with 'attachment', got '{content_disp}'")
        return
    
    # Check PDF signature
    if not resp.content.startswith(b"%PDF"):
        log_test("GET /api/operator/transactions/{tx_id}/receipt", False, "Response doesn't start with %PDF")
        return
    
    log_test("GET /api/operator/transactions/{tx_id}/receipt", True, f"Got PDF receipt ({len(resp.content)} bytes)")
    
    # GET export (all paid transactions)
    resp = requests.get(f"{BASE_URL}/operator/transactions/export", headers=headers)
    
    # Could be 404 if no paid transactions, or 200 with PDF
    if resp.status_code == 404:
        log_test("GET /api/operator/transactions/export (no paid)", True, "Got 404 (no paid transactions)")
    elif resp.status_code == 200:
        if not resp.content.startswith(b"%PDF"):
            log_test("GET /api/operator/transactions/export", False, "Response doesn't start with %PDF")
            return
        log_test("GET /api/operator/transactions/export", True, f"Got export PDF ({len(resp.content)} bytes)")
    else:
        log_test("GET /api/operator/transactions/export", False, f"Unexpected status {resp.status_code}")
        return
    
    # GET export with date range
    resp = requests.get(f"{BASE_URL}/operator/transactions/export?from=2026-01-01&to=2030-01-01", headers=headers)
    
    if resp.status_code == 404:
        log_test("GET /api/operator/transactions/export (date range)", True, "Got 404 (no transactions in range)")
    elif resp.status_code == 200:
        if not resp.content.startswith(b"%PDF"):
            log_test("GET /api/operator/transactions/export (date range)", False, "Response doesn't start with %PDF")
            return
        log_test("GET /api/operator/transactions/export (date range)", True, f"Got export PDF with date range ({len(resp.content)} bytes)")
    else:
        log_test("GET /api/operator/transactions/export (date range)", False, f"Unexpected status {resp.status_code}")
        return
    
    # GET export with invalid date
    resp = requests.get(f"{BASE_URL}/operator/transactions/export?from=invalid", headers=headers)
    
    if resp.status_code != 400:
        log_test("GET /api/operator/transactions/export (invalid date)", False, f"Expected 400, got {resp.status_code}")
        return
    
    log_test("GET /api/operator/transactions/export (invalid date)", True, "Got 400 for invalid date")

def test_licenses_royalties(op_token):
    """Test 9: Licenses + Royalties."""
    print("\n=== TEST 9: LICENSES + ROYALTIES ===")
    
    headers = {"Authorization": f"Bearer {op_token}"}
    
    # POST create license
    license_req = {
        "holder_name": "Test Licensee",
        "holder_email": "lic@test.com",
        "company": "Test Company X",
        "royalty_pct": 10.0
    }
    
    resp = requests.post(f"{BASE_URL}/operator/licenses", headers=headers, json=license_req)
    if resp.status_code != 200:
        log_test("POST /api/operator/licenses", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    license_data = resp.json()
    lic_id = license_data.get("id")
    lic_key = license_data.get("key")
    
    if not lic_key or not lic_key.startswith("TBC-"):
        log_test("POST /api/operator/licenses", False, f"Invalid license key: {lic_key}")
        return
    
    log_test("POST /api/operator/licenses", True, f"Created license {lic_id} with key {lic_key}")
    
    # GET licenses
    resp = requests.get(f"{BASE_URL}/operator/licenses", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/licenses", False, f"Status {resp.status_code}")
        return
    
    licenses = resp.json()
    lic = next((l for l in licenses if l.get("id") == lic_id), None)
    
    if not lic:
        log_test("GET /api/operator/licenses", False, "License not found in list")
        return
    
    log_test("GET /api/operator/licenses", True, f"Found {len(licenses)} licenses")
    
    # PUT update license
    update = {
        "holder_name": "Test Licensee Updated",
        "holder_email": "lic@test.com",
        "company": "Test Company X",
        "royalty_pct": 10.0
    }
    
    resp = requests.put(f"{BASE_URL}/operator/licenses/{lic_id}", headers=headers, json=update)
    if resp.status_code != 200:
        log_test("PUT /api/operator/licenses/{lic_id}", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    updated = resp.json()
    if updated.get("holder_name") != "Test Licensee Updated":
        log_test("PUT /api/operator/licenses/{lic_id}", False, "Update didn't apply")
        return
    
    log_test("PUT /api/operator/licenses/{lic_id}", True, "Updated license")
    
    # POST report earnings (public endpoint)
    earnings_req = {
        "license_key": lic_key,
        "child_transaction_id": "tx_test_1",
        "amount": 100.0,
        "currency": "usd",
        "payment_method": "card"
    }
    
    resp = requests.post(f"{BASE_URL}/license/report-earnings", json=earnings_req)
    if resp.status_code != 200:
        log_test("POST /api/license/report-earnings", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    earnings = resp.json()
    royalty_amount = earnings.get("royalty_amount")
    
    if royalty_amount != 10.0:
        log_test("POST /api/license/report-earnings", False, f"Expected royalty_amount 10.0, got {royalty_amount}")
        return
    
    log_test("POST /api/license/report-earnings", True, f"Reported earnings, royalty_amount={royalty_amount}")
    
    # POST same request again (duplicate check)
    resp = requests.post(f"{BASE_URL}/license/report-earnings", json=earnings_req)
    if resp.status_code != 200:
        log_test("POST /api/license/report-earnings (duplicate)", False, f"Status {resp.status_code}")
        return
    
    dup = resp.json()
    if not dup.get("duplicate"):
        log_test("POST /api/license/report-earnings (duplicate)", False, "Expected duplicate=true")
        return
    
    log_test("POST /api/license/report-earnings (duplicate)", True, "Duplicate detected correctly")
    
    # POST with invalid key
    invalid_req = {
        "license_key": "TBC-FAKEKEY",
        "child_transaction_id": "tx_test_2",
        "amount": 100.0,
        "currency": "usd",
        "payment_method": "card"
    }
    
    resp = requests.post(f"{BASE_URL}/license/report-earnings", json=invalid_req)
    if resp.status_code != 401:
        log_test("POST /api/license/report-earnings (invalid key)", False, f"Expected 401, got {resp.status_code}")
        return
    
    log_test("POST /api/license/report-earnings (invalid key)", True, "Got 401 for invalid key")
    
    # GET royalties
    resp = requests.get(f"{BASE_URL}/operator/royalties", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/royalties", False, f"Status {resp.status_code}")
        return
    
    royalties = resp.json()
    roy = next((r for r in royalties if r.get("license_id") == lic_id), None)
    
    if not roy:
        log_test("GET /api/operator/royalties", False, "Royalty record not found")
        return
    
    log_test("GET /api/operator/royalties", True, f"Found {len(royalties)} royalty records")
    
    # GET royalties summary
    resp = requests.get(f"{BASE_URL}/operator/royalties/summary", headers=headers)
    if resp.status_code != 200:
        log_test("GET /api/operator/royalties/summary", False, f"Status {resp.status_code}")
        return
    
    summary = resp.json()
    
    if summary.get("owed_total") < 10.0:
        log_test("GET /api/operator/royalties/summary", False, f"Expected owed_total >= 10.0, got {summary.get('owed_total')}")
        return
    
    if summary.get("owed_count") < 1:
        log_test("GET /api/operator/royalties/summary", False, f"Expected owed_count >= 1, got {summary.get('owed_count')}")
        return
    
    log_test("GET /api/operator/royalties/summary", True, f"owed_total={summary.get('owed_total')}, owed_count={summary.get('owed_count')}")
    
    # POST remit royalties
    remit_req = {
        "license_id": lic_id,
        "amount": 10.0,
        "method": "bank",
        "royalty_ids": [roy.get("id")]
    }
    
    resp = requests.post(f"{BASE_URL}/operator/royalties/remit", headers=headers, json=remit_req)
    if resp.status_code != 200:
        log_test("POST /api/operator/royalties/remit", False, f"Status {resp.status_code}: {resp.text}")
        return
    
    remit = resp.json()
    if remit.get("modified") < 1:
        log_test("POST /api/operator/royalties/remit", False, f"Expected modified >= 1, got {remit.get('modified')}")
        return
    
    log_test("POST /api/operator/royalties/remit", True, f"Remitted {remit.get('modified')} royalty records")
    
    # Verify status changed to remitted
    resp = requests.get(f"{BASE_URL}/operator/royalties", headers=headers)
    if resp.status_code != 200:
        log_test("Verify royalty remitted", False, f"Status {resp.status_code}")
        return
    
    royalties = resp.json()
    roy = next((r for r in royalties if r.get("id") == roy.get("id")), None)
    
    if not roy or roy.get("status") != "remitted":
        log_test("Verify royalty remitted", False, f"Expected status 'remitted', got {roy.get('status') if roy else 'not found'}")
        return
    
    log_test("Verify royalty remitted", True, "Royalty status changed to remitted")
    
    # POST revoke license
    resp = requests.post(f"{BASE_URL}/operator/licenses/{lic_id}/revoke", headers=headers)
    if resp.status_code != 200:
        log_test("POST /api/operator/licenses/{lic_id}/revoke", False, f"Status {resp.status_code}")
        return
    
    log_test("POST /api/operator/licenses/{lic_id}/revoke", True, "Revoked license")
    
    # POST report earnings with revoked key
    resp = requests.post(f"{BASE_URL}/license/report-earnings", json=earnings_req)
    if resp.status_code != 401:
        log_test("POST /api/license/report-earnings (revoked)", False, f"Expected 401, got {resp.status_code}")
        return
    
    log_test("POST /api/license/report-earnings (revoked)", True, "Got 401 for revoked key")
    
    # POST activate license
    resp = requests.post(f"{BASE_URL}/operator/licenses/{lic_id}/activate", headers=headers)
    if resp.status_code != 200:
        log_test("POST /api/operator/licenses/{lic_id}/activate", False, f"Status {resp.status_code}")
        return
    
    log_test("POST /api/operator/licenses/{lic_id}/activate", True, "Activated license")
    
    # DELETE license
    resp = requests.delete(f"{BASE_URL}/operator/licenses/{lic_id}", headers=headers)
    if resp.status_code != 200:
        log_test("DELETE /api/operator/licenses/{lic_id}", False, f"Status {resp.status_code}")
        return
    
    log_test("DELETE /api/operator/licenses/{lic_id}", True, "Deleted license")

def test_license_agreement():
    """Test 10: License agreement."""
    print("\n=== TEST 10: LICENSE AGREEMENT ===")
    
    resp = requests.get(f"{BASE_URL}/license/agreement")
    
    if resp.status_code != 200:
        log_test("GET /api/license/agreement", False, f"Status {resp.status_code}")
        return
    
    agreement = resp.json()
    
    # Check required fields
    required = ["version", "title", "royalty_pct", "text"]
    for field in required:
        if field not in agreement:
            log_test("GET /api/license/agreement", False, f"Missing field '{field}'")
            return
    
    if agreement.get("royalty_pct") != 10.0:
        log_test("GET /api/license/agreement", False, f"Expected royalty_pct 10.0, got {agreement.get('royalty_pct')}")
        return
    
    log_test("GET /api/license/agreement", True, f"Got agreement with royalty_pct={agreement.get('royalty_pct')}")

def test_authorization(op_token):
    """Test 11: Authorization."""
    print("\n=== TEST 11: AUTHORIZATION ===")
    
    # Try operator endpoint without auth
    resp = requests.get(f"{BASE_URL}/operator/plans")
    
    if resp.status_code not in [401, 403]:
        log_test("GET /api/operator/plans (no auth)", False, f"Expected 401/403, got {resp.status_code}")
        return
    
    log_test("GET /api/operator/plans (no auth)", True, f"Got {resp.status_code} without auth")
    
    # Create normal user and try operator endpoint
    user_token, _ = create_test_user()
    if not user_token:
        return
    
    user_headers = {"Authorization": f"Bearer {user_token}"}
    resp = requests.get(f"{BASE_URL}/operator/plans", headers=user_headers)
    
    if resp.status_code != 403:
        log_test("GET /api/operator/plans (user token)", False, f"Expected 403, got {resp.status_code}")
        return
    
    log_test("GET /api/operator/plans (user token)", True, "Got 403 with normal user token")

def main():
    """Run all tests."""
    print("=" * 60)
    print("TBC AI CONTROL - BACKEND TEST SUITE")
    print("Testing NEW payment endpoints")
    print("=" * 60)
    
    # Login as operator
    op_token = login_operator()
    if not op_token:
        print("\n❌ CRITICAL: Cannot proceed without operator token")
        print("Please ensure operator has 2FA disabled or provide TOTP secret")
        return
    
    # Run tests
    test_public_plans()
    test_payment_methods()
    test_treasury_404()
    
    if op_token:
        test_operator_plans_crud(op_token)
        test_operator_treasury_crud(op_token)
        test_operator_settings(op_token)
        test_manual_payment_flow(op_token)
        test_pdf_receipts(op_token)
        test_licenses_royalties(op_token)
        test_license_agreement()
        test_authorization(op_token)
    
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
