"""API Keys management extension — save, test, retrieve encrypted third-party API keys."""
import os
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from cryptography.fernet import Fernet
import httpx

from auth_utils import get_current_user, get_current_operator
from db import db

router = APIRouter(prefix='/api/keys', tags=['api-keys'])

# Encryption key from env or generate a default (in production, MUST be set in env)
ENCRYPTION_KEY = os.environ.get('API_KEY_ENCRYPTION_KEY', Fernet.generate_key().decode())
cipher = Fernet(ENCRYPTION_KEY.encode())


class SaveKeyRequest(BaseModel):
    key: str
    project_id: str | None = None


class TestKeyRequest(BaseModel):
    key: str


def encrypt_secret(plaintext: str) -> str:
    """Encrypt a plaintext secret."""
    return cipher.encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    """Decrypt a ciphertext secret."""
    return cipher.decrypt(ciphertext.encode()).decode()


@router.post('/openai')
async def save_openai_key(payload: SaveKeyRequest, user=Depends(get_current_operator)):
    """Save OpenAI API key (encrypted)."""
    key = payload.key.strip()
    if not key.startswith('sk-'):
        raise HTTPException(400, 'Invalid OpenAI key format (must start with sk-)')
    encrypted = encrypt_secret(key)
    await db.api_keys.update_one(
        {'user_id': user['_id'], 'provider': 'openai', 'project_id': payload.project_id},
        {'$set': {'key_encrypted': encrypted, 'updated_at': datetime.utcnow()}},
        upsert=True
    )
    return {'ok': True, 'provider': 'openai'}


@router.post('/openai/test')
async def test_openai_key(payload: TestKeyRequest, user=Depends(get_current_operator)):
    """Test OpenAI API key by calling /v1/models."""
    key = payload.key.strip()
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                'https://api.openai.com/v1/models',
                headers={'Authorization': f'Bearer {key}'},
                timeout=10.0
            )
            if resp.status_code == 200:
                return {'ok': True, 'provider': 'openai'}
            raise HTTPException(400, f'OpenAI API returned {resp.status_code}')
        except httpx.RequestError as e:
            raise HTTPException(400, f'OpenAI API request failed: {str(e)}')


@router.post('/anthropic')
async def save_anthropic_key(payload: SaveKeyRequest, user=Depends(get_current_operator)):
    """Save Anthropic API key (encrypted)."""
    key = payload.key.strip()
    if not key.startswith('sk-ant-'):
        raise HTTPException(400, 'Invalid Anthropic key format (must start with sk-ant-)')
    encrypted = encrypt_secret(key)
    await db.api_keys.update_one(
        {'user_id': user['_id'], 'provider': 'anthropic', 'project_id': payload.project_id},
        {'$set': {'key_encrypted': encrypted, 'updated_at': datetime.utcnow()}},
        upsert=True
    )
    return {'ok': True, 'provider': 'anthropic'}


@router.post('/anthropic/test')
async def test_anthropic_key(payload: TestKeyRequest, user=Depends(get_current_operator)):
    """Test Anthropic API key by calling /v1/messages with a minimal request."""
    key = payload.key.strip()
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                'https://api.anthropic.com/v1/messages',
                headers={
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                json={
                    'model': 'claude-3-haiku-20240307',
                    'max_tokens': 1,
                    'messages': [{'role': 'user', 'content': 'Hi'}]
                },
                timeout=10.0
            )
            if resp.status_code in (200, 400):  # 400 is OK for validation
                return {'ok': True, 'provider': 'anthropic'}
            raise HTTPException(400, f'Anthropic API returned {resp.status_code}')
        except httpx.RequestError as e:
            raise HTTPException(400, f'Anthropic API request failed: {str(e)}')


@router.post('/gemini')
async def save_gemini_key(payload: SaveKeyRequest, user=Depends(get_current_operator)):
    """Save Google Gemini API key (encrypted)."""
    key = payload.key.strip()
    if not key.startswith('AIza'):
        raise HTTPException(400, 'Invalid Gemini key format (must start with AIza)')
    encrypted = encrypt_secret(key)
    await db.api_keys.update_one(
        {'user_id': user['_id'], 'provider': 'gemini', 'project_id': payload.project_id},
        {'$set': {'key_encrypted': encrypted, 'updated_at': datetime.utcnow()}},
        upsert=True
    )
    return {'ok': True, 'provider': 'gemini'}


@router.post('/gemini/test')
async def test_gemini_key(payload: TestKeyRequest, user=Depends(get_current_operator)):
    """Test Gemini API key by calling the models endpoint."""
    key = payload.key.strip()
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f'https://generativelanguage.googleapis.com/v1beta/models?key={key}',
                timeout=10.0
            )
            if resp.status_code == 200:
                return {'ok': True, 'provider': 'gemini'}
            raise HTTPException(400, f'Gemini API returned {resp.status_code}')
        except httpx.RequestError as e:
            raise HTTPException(400, f'Gemini API request failed: {str(e)}')


@router.post('/groq')
async def save_groq_key(payload: SaveKeyRequest, user=Depends(get_current_operator)):
    """Save Groq Cloud AI API key (encrypted)."""
    key = payload.key.strip()
    if not key.startswith('gsk_'):
        raise HTTPException(400, 'Invalid Groq key format (must start with gsk_)')
    encrypted = encrypt_secret(key)
    await db.api_keys.update_one(
        {'user_id': user['_id'], 'provider': 'groq', 'project_id': payload.project_id},
        {'$set': {'key_encrypted': encrypted, 'updated_at': datetime.utcnow()}},
        upsert=True
    )
    return {'ok': True, 'provider': 'groq'}


@router.post('/groq/test')
async def test_groq_key(payload: TestKeyRequest, user=Depends(get_current_operator)):
    """Test Groq API key by calling /openai/v1/models."""
    key = payload.key.strip()
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                'https://api.groq.com/openai/v1/models',
                headers={'Authorization': f'Bearer {key}'},
                timeout=10.0
            )
            if resp.status_code == 200:
                return {'ok': True, 'provider': 'groq'}
            raise HTTPException(400, f'Groq API returned {resp.status_code}')
        except httpx.RequestError as e:
            raise HTTPException(400, f'Groq API request failed: {str(e)}')


@router.get('/{provider}')
async def get_key(provider: str, project_id: str | None = None, user=Depends(get_current_user)):
    """Retrieve a decrypted API key for the given provider."""
    doc = await db.api_keys.find_one({
        'user_id': user['_id'],
        'provider': provider,
        'project_id': project_id
    })
    if not doc:
        raise HTTPException(404, f'No key found for provider {provider}')
    return {'provider': provider, 'key': decrypt_secret(doc['key_encrypted'])}
