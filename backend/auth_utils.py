"""Authentication utilities: password hashing, JWT, TOTP 2FA."""
import os
import jwt
import bcrypt
import pyotp
import qrcode
import io
import base64
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

JWT_SECRET = os.environ.get('JWT_SECRET', 'change-me')
JWT_ALG = 'HS256'
JWT_EXP_HOURS = 24 * 7  # 7 days

security = HTTPBearer(auto_error=False)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


def create_jwt(user_id: str, email: str, role: str, pending_2fa: bool = False) -> str:
    payload = {
        'sub': user_id,
        'email': email,
        'role': role,
        'pending_2fa': pending_2fa,
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(hours=JWT_EXP_HOURS if not pending_2fa else 1),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_jwt(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail='Token expired')
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail='Invalid token')


async def get_current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail='Not authenticated')
    payload = decode_jwt(creds.credentials)
    if payload.get('pending_2fa'):
        raise HTTPException(status_code=401, detail='2FA verification required')
    return payload


async def get_current_operator(user: dict = Depends(get_current_user)) -> dict:
    if user.get('role') != 'operator':
        raise HTTPException(status_code=403, detail='Operator access required')
    return user


# TOTP utilities

def generate_totp_secret() -> str:
    return pyotp.random_base32()


def get_totp_uri(secret: str, email: str, issuer: str = 'TBC AI Control') -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)


def generate_qr_data_url(uri: str) -> str:
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return f'data:image/png;base64,{b64}'


def verify_totp(secret: str, code: str) -> bool:
    if not secret or not code:
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)
    except Exception:
        return False
