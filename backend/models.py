"""Pydantic models for TBC AI Tools."""
from pydantic import BaseModel, Field, EmailStr
from typing import Optional, List, Literal
from datetime import datetime, timezone
import uuid


def _now():
    return datetime.now(timezone.utc)


def _uid():
    return str(uuid.uuid4())


# ===== AUTH =====
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    name: Optional[str] = None
    referral_code: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class Verify2FARequest(BaseModel):
    code: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=10, max_length=128)


class Setup2FAResponse(BaseModel):
    secret: str
    qr_data_url: str
    otpauth_uri: str


class AuthResponse(BaseModel):
    token: str
    pending_2fa: bool = False
    requires_2fa_setup: bool = False
    user: Optional[dict] = None


class User(BaseModel):
    id: str = Field(default_factory=_uid)
    email: str
    password_hash: str
    name: Optional[str] = None
    role: Literal['operator', 'user'] = 'user'
    totp_secret: Optional[str] = None
    totp_enabled: bool = False
    plan: str = 'free'  # any plan id (free, starter, pro, enterprise, custom trial plans, ...)
    credits: int = 50  # free tier messages
    referral_code: Optional[str] = None
    referred_by_code: Optional[str] = None
    # Trial / time-limited plan tracking. None on plan = permanent (no expiry).
    plan_started_at: Optional[datetime] = None
    plan_expires_at: Optional[datetime] = None
    # Bumped by `Sign out everywhere` — every JWT carries the version it was
    # issued with; mismatch on decode = forced re-login on this device.
    token_version: int = 0
    created_at: datetime = Field(default_factory=_now)


class Attachment(BaseModel):
    type: Literal['image', 'text']
    name: str
    mime: str
    content: str  # base64 for image, raw text for text files


# ===== CHAT =====
class ChatSendRequest(BaseModel):
    session_id: Optional[str] = None
    message: str
    model: Optional[str] = 'gpt-5.4'
    variant: Optional[Literal['tbc1', 'tbc2']] = 'tbc1'
    attachments: Optional[List[Attachment]] = None


class ChatMessage(BaseModel):
    id: str = Field(default_factory=_uid)
    session_id: str
    user_id: str
    role: Literal['user', 'assistant', 'system']
    content: str
    created_at: datetime = Field(default_factory=_now)


class ChatSession(BaseModel):
    id: str = Field(default_factory=_uid)
    user_id: str
    title: str = 'New Chat'
    model: str = 'gpt-5.4'
    variant: Literal['tbc1', 'tbc2'] = 'tbc1'
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class CreateSessionRequest(BaseModel):
    title: Optional[str] = 'New Chat'
    model: Optional[str] = 'gpt-5.4'
    variant: Optional[Literal['tbc1', 'tbc2']] = 'tbc1'


class RenameSessionRequest(BaseModel):
    title: str


# ===== PAYMENTS =====
class CheckoutRequest(BaseModel):
    plan_id: Literal['starter', 'pro', 'enterprise']
    origin_url: str


class PaymentTransaction(BaseModel):
    id: str = Field(default_factory=_uid)
    session_id: str
    user_id: str
    user_email: str
    plan_id: str
    amount: float
    currency: str = 'usd'
    status: str = 'initiated'  # initiated | paid | failed | expired
    payment_status: str = 'pending'
    metadata: dict = {}
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


# ===== CONTACT =====
class ContactRequest(BaseModel):
    name: str
    email: EmailStr
    subject: Optional[str] = None
    message: str


class ContactSubmission(BaseModel):
    id: str = Field(default_factory=_uid)
    name: str
    email: str
    subject: Optional[str] = None
    message: str
    created_at: datetime = Field(default_factory=_now)


# ===== PLANS (editable) =====
class PlanModel(BaseModel):
    id: str
    name: str
    price: float
    regular_price: Optional[float] = None
    credits: int
    intro: bool = False
    features: List[str] = []
    enabled: bool = True
    order: int = 0
    # If > 0, this plan auto-expires N days after activation. 0 = permanent.
    trial_days: int = 0


class PlanUpsertRequest(BaseModel):
    id: Optional[str] = None
    name: str
    price: float
    regular_price: Optional[float] = None
    credits: int
    intro: bool = False
    features: List[str] = []
    enabled: bool = True
    order: int = 0
    trial_days: int = 0


# ===== TREASURY =====
class TreasuryDestination(BaseModel):
    id: str = Field(default_factory=_uid)
    label: str
    type: Literal['bank', 'crypto'] = 'bank'
    is_active: bool = False
    # Bank fields
    holder_name: Optional[str] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    bank_name: Optional[str] = None
    bank_address: Optional[str] = None
    reference: Optional[str] = None
    # Crypto fields
    network: Optional[str] = None  # BTC, ETH, SOL, TRC20-USDT, ERC20-USDT, POLYGON
    wallet_address: Optional[str] = None
    memo: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class TreasuryUpsertRequest(BaseModel):
    id: Optional[str] = None
    label: str
    type: Literal['bank', 'crypto']
    holder_name: Optional[str] = None
    iban: Optional[str] = None
    bic: Optional[str] = None
    bank_name: Optional[str] = None
    bank_address: Optional[str] = None
    reference: Optional[str] = None
    network: Optional[str] = None
    wallet_address: Optional[str] = None
    memo: Optional[str] = None
    notes: Optional[str] = None


# ===== SETTINGS (payment provider keys) =====
class PaymentSettings(BaseModel):
    stripe_secret_key: Optional[str] = None
    stripe_mode: Literal['test', 'live'] = 'test'
    nowpayments_api_key: Optional[str] = None
    nowpayments_ipn_secret: Optional[str] = None
    paypal_client_id: Optional[str] = None
    paypal_client_secret: Optional[str] = None
    paypal_mode: Literal['sandbox', 'live'] = 'sandbox'
    enable_card: bool = True
    enable_paypal: bool = False
    enable_crypto_auto: bool = False
    enable_crypto_manual: bool = True
    enable_bank: bool = True
    # Vercel deploy integration — operator pastes a Vercel Personal Access Token
    # and (optionally) a Team ID; the platform uses these for Deploy/Redeploy/
    # Preview buttons and the programmatic /api/projects API.
    vercel_token: Optional[str] = None
    vercel_team_id: Optional[str] = None
    # Bearer token external AI programs use to POST projects to
    # `/api/projects`. Generate-once, store-once, never exposed back to UI.
    ai_api_key: Optional[str] = None


class CheckoutMethod(str):
    pass


# Manual payment submission (crypto tx hash or bank reference)
class ManualPaymentRequest(BaseModel):
    plan_id: str
    method: Literal['crypto_manual', 'bank']
    treasury_id: str
    proof: str  # tx hash or bank reference
    note: Optional[str] = None


# ===== LICENSES (royalty system) =====
class License(BaseModel):
    id: str = Field(default_factory=_uid)
    key: str                      # opaque token (also unique)
    holder_name: str
    holder_email: str
    company: Optional[str] = None
    royalty_pct: float = 10.0     # default 10%
    notes: Optional[str] = None
    status: Literal['active', 'revoked'] = 'active'
    created_at: datetime = Field(default_factory=_now)
    last_report_at: Optional[datetime] = None


class LicenseUpsertRequest(BaseModel):
    holder_name: str
    holder_email: str
    company: Optional[str] = None
    royalty_pct: float = 10.0
    notes: Optional[str] = None


class EarningsReportRequest(BaseModel):
    license_key: str
    child_transaction_id: str
    child_user_email: Optional[str] = None
    plan_id: Optional[str] = None
    amount: float
    currency: str = 'usd'
    payment_method: Optional[str] = None
    occurred_at: Optional[str] = None  # ISO


class RoyaltyRecord(BaseModel):
    id: str = Field(default_factory=_uid)
    license_id: str
    license_key: str
    child_transaction_id: str
    child_user_email: Optional[str] = None
    plan_id: Optional[str] = None
    gross_amount: float
    royalty_amount: float
    currency: str = 'usd'
    payment_method: Optional[str] = None
    status: Literal['owed', 'remitted', 'disputed'] = 'owed'
    remittance_id: Optional[str] = None
    occurred_at: datetime = Field(default_factory=_now)
    created_at: datetime = Field(default_factory=_now)


class RemittanceRequest(BaseModel):
    license_id: str
    amount: float
    currency: str = 'usd'
    method: Literal['stripe', 'crypto_manual', 'bank', 'paypal', 'other'] = 'other'
    treasury_id: Optional[str] = None
    reference: Optional[str] = None
    note: Optional[str] = None
    royalty_ids: List[str] = []


# ===== REFERRALS =====
class ReferralCode(BaseModel):
    id: str = Field(default_factory=_uid)
    user_id: str
    code: str          # short slug e.g. operator-username or random
    created_at: datetime = Field(default_factory=_now)


class ReferralClick(BaseModel):
    id: str = Field(default_factory=_uid)
    code: str
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    referrer: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class ReferralEarning(BaseModel):
    id: str = Field(default_factory=_uid)
    referrer_user_id: str
    referred_user_id: str
    referred_user_email: str
    transaction_id: str
    plan_id: str
    gross_amount: float
    commission_pct: float = 10.0
    commission_amount: float
    currency: str = 'usd'
    status: Literal['accrued', 'paid'] = 'accrued'
    created_at: datetime = Field(default_factory=_now)


class TrackClickRequest(BaseModel):
    code: str
    referrer: Optional[str] = None


# ===== PROJECTS (operator) =====
class Project(BaseModel):
    id: str = Field(default_factory=_uid)
    owner_id: str
    title: str
    description: Optional[str] = None
    status: Literal['expand', 'idea', 'dev', 'launched', 'running'] = 'idea'
    tags: List[str] = []
    link_url: Optional[str] = None
    chat_session_id: Optional[str] = None
    # --- Marketplace fields (v1: operator-supplied asset URL) ---
    is_for_sale: bool = False
    price_usd: float = 0.0  # 10.00 - 100.00 when is_for_sale=True
    asset_url: Optional[str] = None  # External download link (Drive/Dropbox/S3) — emailed after purchase
    summary: Optional[str] = None  # Short marketplace tagline (160 chars)
    cover_emoji: Optional[str] = None  # Single emoji shown on marketplace card
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ProjectUpsertRequest(BaseModel):
    title: str
    description: Optional[str] = None
    status: Literal['expand', 'idea', 'dev', 'launched', 'running'] = 'idea'
    tags: List[str] = []
    link_url: Optional[str] = None
    chat_session_id: Optional[str] = None
    is_for_sale: bool = False
    price_usd: float = 0.0
    asset_url: Optional[str] = None
    summary: Optional[str] = None
    cover_emoji: Optional[str] = None


class MarketplacePurchase(BaseModel):
    id: str = Field(default_factory=_uid)
    project_id: str
    buyer_email: str
    buyer_user_id: Optional[str] = None
    price_paid_usd: float
    stripe_session_id: Optional[str] = None
    paid: bool = False
    delivered: bool = False  # asset email sent
    created_at: datetime = Field(default_factory=_now)
    paid_at: Optional[datetime] = None


# ===== BRAND SETTINGS (share URLs etc) =====
class BrandSettings(BaseModel):
    share_base_url: str = 'https://www.tbctools.org'
    referral_base_url_org: str = 'https://www.tbctools.org/referral'
    referral_base_url_com: str = 'https://www.tbctools.com/referral'
    referral_pct: float = 10.0
