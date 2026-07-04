"""Operator Domains tab — Porkbun registrar integration.

The operator saves a Porkbun **API key** (`pk1_…`) and **secret key** (`sk1_…`)
in My Keys. Those two credentials live in the shared settings doc
(`_id='payment_settings'`) and are encrypted at rest by secret_crypto.

This module never stores its own copy of the keys — it reads them from
settings (single source of truth, same pattern as deploy_ext.py's Render key)
and talks to the Porkbun JSON API v3 on the operator's behalf:

  • POST /ping                     -> verify the key pair is valid
  • POST /domain/listAll           -> every domain in the account
  • POST /domain/checkDomain/{d}   -> availability + price for one domain

All endpoints are operator-only. Keys are sent in the JSON body exactly as
Porkbun requires and are never logged or echoed back to the client.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger('tbc.porkbun')

router = APIRouter(prefix='/api/operator/porkbun', tags=['domains'])

_SETTINGS_ID = 'payment_settings'
_PORKBUN_API = 'https://api.porkbun.com/api/json/v3'


async def _creds() -> tuple[str, str]:
    """Read the Porkbun key pair the operator saved in My Keys.

    Raises 400 (not 500) when either key is missing so the Domains tab can
    render a friendly "connect Porkbun" empty state instead of an error.
    """
    try:
        doc = await db.settings.find_one({'_id': _SETTINGS_ID}) or {}
    except Exception as e:  # pragma: no cover - db degraded
        logger.warning('Could not read Porkbun keys from settings: %s', e)
        raise HTTPException(503, 'Settings unavailable')
    apikey = (doc.get('porkbun_api_key') or '').strip()
    secret = (doc.get('porkbun_secret_key') or '').strip()
    if not apikey or not secret:
        raise HTTPException(
            400,
            'Porkbun is not connected. Add both your Porkbun API key and secret '
            'key in the My Keys tab first.',
        )
    return apikey, secret


async def _call(path: str, apikey: str, secret: str, extra: Optional[dict] = None) -> dict:
    """POST to a Porkbun endpoint with the credentials in the body."""
    body = {'apikey': apikey, 'secretapikey': secret, **(extra or {})}
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.post(f'{_PORKBUN_API}{path}', json=body,
                                  headers={'Content-Type': 'application/json'})
        except httpx.HTTPError as e:
            raise HTTPException(502, f'Could not reach Porkbun: {e}')
    try:
        data = r.json()
    except Exception:
        raise HTTPException(502, f'Porkbun returned a non-JSON response ({r.status_code}).')
    if data.get('status') != 'SUCCESS':
        # Porkbun puts the human-readable reason in `message`.
        raise HTTPException(400, data.get('message') or f'Porkbun error ({r.status_code}).')
    return data


@router.get('/status')
async def porkbun_status(_: dict = Depends(get_current_operator)):
    """Lightweight connection check used to render the Domains tab header.

    Returns {connected: bool} without pinging Porkbun (cheap, no rate-limit
    hit). Use POST /ping for a live credential verification.
    """
    doc = await db.settings.find_one({'_id': _SETTINGS_ID}) or {}
    connected = bool((doc.get('porkbun_api_key') or '').strip()
                     and (doc.get('porkbun_secret_key') or '').strip())
    return {'connected': connected}


@router.post('/ping')
async def porkbun_ping(_: dict = Depends(get_current_operator)):
    """Live-verify the saved key pair against Porkbun's /ping endpoint."""
    apikey, secret = await _creds()
    data = await _call('/ping', apikey, secret)
    # /ping echoes back the caller's public IP on success.
    return {'ok': True, 'your_ip': data.get('yourIp'), 'message': 'Porkbun keys valid'}


@router.get('/domains')
async def porkbun_domains(_: dict = Depends(get_current_operator)):
    """List every domain in the connected Porkbun account."""
    apikey, secret = await _creds()
    data = await _call('/domain/listAll', apikey, secret)
    domains = []
    for d in (data.get('domains') or []):
        domains.append({
            'domain': d.get('domain'),
            'status': d.get('status'),
            'tld': d.get('tld'),
            'create_date': d.get('createDate'),
            'expire_date': d.get('expireDate'),
            'auto_renew': str(d.get('autoRenew')) in ('1', 'true', 'True'),
            'whois_privacy': str(d.get('whoisPrivacy')) in ('1', 'true', 'True'),
        })
    domains.sort(key=lambda x: (x.get('domain') or ''))
    return {'domains': domains, 'count': len(domains)}


@router.get('/check')
async def porkbun_check(
    domain: str = Query(..., min_length=3),
    _: dict = Depends(get_current_operator),
):
    """Check availability + registration price for a single domain."""
    apikey, secret = await _creds()
    d = (domain or '').strip().lower()
    if '.' not in d or ' ' in d:
        raise HTTPException(400, 'Enter a full domain, e.g. example.com')
    data = await _call(f'/domain/checkDomain/{d}', apikey, secret)
    resp = data.get('response') or {}
    return {
        'domain': d,
        'available': str(resp.get('avail')).lower() in ('yes', 'true', '1'),
        'price': resp.get('price'),
        'first_year_promo': resp.get('firstYearPromo'),
        'regular_price': resp.get('regularPrice'),
        'premium': str(resp.get('premium')).lower() in ('yes', 'true', '1'),
    }
