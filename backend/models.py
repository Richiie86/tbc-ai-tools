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


# ===== CHAT =====
class ChatSendRequest(BaseModel):
    session_id: Optional[str] = None
    message: str
    model: Optional[str] = 'gpt-5.4'


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
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class CreateSessionRequest(BaseModel):
    title: Optional[str] = 'New Chat'
    model: Optional[str] = 'gpt-5.4'


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
