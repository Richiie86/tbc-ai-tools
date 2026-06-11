"""Pydantic models for TBC AI Control."""
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
    password: str = Field(min_length=8)
    name: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class Verify2FARequest(BaseModel):
    code: str


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
    plan: Literal['free', 'starter', 'pro', 'enterprise'] = 'free'
    credits: int = 50  # free tier messages
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


class CheckoutMethod(str):
    pass


# Manual payment submission (crypto tx hash or bank reference)
class ManualPaymentRequest(BaseModel):
    plan_id: str
    method: Literal['crypto_manual', 'bank']
    treasury_id: str
    proof: str  # tx hash or bank reference
    note: Optional[str] = None
