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
from fastapi import HTTPException, Depends, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

JWT_SECRET = os.environ.get('JWT_SECRET', 'change-me')
JWT_ALG = 'HS256'
JWT_EXP_HOURS = 24 * 7  # 7 days

# Cookie name used by the httpOnly session cookie. Must match the value used
# when calling `response.set_cookie` from the login/register endpoints.
SESSION_COOKIE = 'tbc_session'

security = HTTPBearer(auto_error=False)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


def validate_password_strength(password: str) -> Optional[str]:
    """Return None if password is strong enough, otherwise an error message.

    Rules: min 10 chars + at least 3 of {upper, lower, digit, symbol}.
    """
    if not password or len(password) < 10:
        return 'Password must be at least 10 characters long.'
    if len(password) > 128:
        return 'Password is too long (max 128 characters).'
    classes = 0
    if any(c.islower() for c in password):
        classes += 1
    if any(c.isupper() for c in password):
        classes += 1
    if any(c.isdigit() for c in password):
        classes += 1
    if any(not c.isalnum() for c in password):
        classes += 1
    if classes < 3:
        return 'Password must include at least 3 of: lowercase, uppercase, digit, symbol.'
    return None


def create_password_reset_token(user_id: str, email: str) -> str:
    """30-minute single-use reset token. The `prt` claim distinguishes it from login tokens."""
    payload = {
        'sub': user_id,
        'email': email,
        'prt': True,  # password-reset token marker
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(minutes=30),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_password_reset_token(token: str) -> dict:
    """Validates a password-reset token. Raises 400 with a friendly message."""
    payload: dict = {}  # initialised before the try block so static analysers
                        # don't flag a possible unbound-name on the return.
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail='Reset link has expired. Please request a new one.')
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail='Invalid reset link.')
    if not payload.get('prt'):
        raise HTTPException(status_code=400, detail='Invalid reset link.')
    return payload


def create_jwt(user_id: str, email: str, role: str, pending_2fa: bool = False, token_version: int = 0) -> str:
    payload = {
        'sub': user_id,
        'email': email,
        'role': role,
        'pending_2fa': pending_2fa,
        'tv': int(token_version),  # bumped by "Sign out everywhere" → forces re-login on decode
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


async def get_current_user(
    request: Request,
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    """Resolve the authenticated user.

    Reads the JWT from the `tbc_session` httpOnly cookie first (browser flow),
    then falls back to the `Authorization: Bearer ...` header (curl / mobile /
    scripts). This dual support lets the browser stop touching the token while
    keeping every existing API caller working.

    Also rejects tokens whose `tv` claim is stale — used by "Sign out everywhere"
    to invalidate every existing session for a single user atomically.
    """
    token = request.cookies.get(SESSION_COOKIE)
    if not token and creds:
        token = creds.credentials
    if not token:
        raise HTTPException(status_code=401, detail='Not authenticated')
    payload = decode_jwt(token)
    if payload.get('pending_2fa'):
        raise HTTPException(status_code=401, detail='2FA verification required')

    # token-version check. Single small projection — keeps this guard cheap.
    from db import db  # local import avoids circular at module load
    stored = await db.users.find_one({'id': payload['sub']}, {'token_version': 1, 'deleted_at': 1, 'status': 1})
    if not stored:
        raise HTTPException(status_code=401, detail='User no longer exists')
    if stored.get('deleted_at') or stored.get('status') == 'deleted':
        raise HTTPException(status_code=401, detail='Account deactivated')
    stored_tv = int(stored.get('token_version') or 0)
    token_tv = int(payload.get('tv') or 0)
    if token_tv < stored_tv:
        raise HTTPException(status_code=401, detail='Session ended on another device. Please sign in again.')
    return payload


async def get_current_operator(user: dict = Depends(get_current_user)) -> dict:
    if user.get('role') != 'operator':
        raise HTTPException(status_code=403, detail='Operator access required')
    return user


# TOTP utilities

def generate_totp_secret() -> str:
    return pyotp.random_base32()


def get_totp_uri(secret: str, email: str, issuer: str = 'TBC AI Tools') -> str:
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


def set_session_cookie(response, token: str, pending_2fa: bool = False) -> None:
    """Attach the JWT to the response as a hardened httpOnly cookie.

    Pending-2FA tokens get a short 1h lifetime so a half-logged-in user can't
    keep the cookie around indefinitely.
    """
    max_age = 3600 if pending_2fa else JWT_EXP_HOURS * 3600
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=True,           # Both preview and prod are HTTPS-only.
        samesite='lax',        # First-party site → Lax is safe and lets normal nav carry the cookie.
        max_age=max_age,
        path='/',
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(key=SESSION_COOKIE, path='/')
