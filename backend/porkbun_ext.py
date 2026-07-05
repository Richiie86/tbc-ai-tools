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
import time
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


# --- Availability speed-ups -------------------------------------------------
# Porkbun's /domain/checkDomain endpoint is heavily rate-limited (~1 call every
# ~10s per account) — that is exactly why the availability check felt slow. Two
# caches make repeat checks instant and let us skip the slow call entirely for
# domains the operator already owns.
_CHECK_TTL = 600.0   # trust a checkDomain result for 10 minutes
_OWNED_TTL = 120.0   # trust the cached account domain list for 2 minutes
_check_cache: dict[str, tuple[float, dict]] = {}
_owned_cache: dict[str, tuple[float, set]] = {}


async def _owned_roots(apikey: str, secret: str) -> set:
    """Root domains in the connected account, cached briefly. Best-effort:
    a listing hiccup returns the last known set (or empty) rather than raising,
    so it can never break an availability check."""
    ck = apikey[:12]  # per-account cache key without exposing the full secret
    now = time.time()
    hit = _owned_cache.get(ck)
    if hit and now - hit[0] < _OWNED_TTL:
        return hit[1]
    try:
        data = await _call('/domain/listAll', apikey, secret)
    except HTTPException:
        return hit[1] if hit else set()
    roots = {
        (d.get('domain') or '').strip().lower()
        for d in (data.get('domains') or [])
        if (d.get('domain') or '').strip()
    }
    _owned_cache[ck] = (now, roots)
    return roots


# Vercel's published DNS targets for pointing an external domain at a Vercel
# deployment: apex → A record 76.76.21.21, any sub-domain → CNAME
# cname.vercel-dns.com. (https://vercel.com/docs/projects/domains)
_VERCEL_APEX_A = '76.76.21.21'
_VERCEL_CNAME = 'cname.vercel-dns.com'


def _split_domain(host: str) -> tuple[str, str]:
    """Return (root_domain, subdomain) for a bare host.

    `app.example.com`  -> ('example.com', 'app')
    `example.com`      -> ('example.com', '')
    `a.b.example.co.uk`-> best-effort ('example.co.uk', 'a.b')  (two-label TLD)
    """
    host = (host or '').strip().rstrip('.').lower()
    parts = host.split('.')
    if len(parts) <= 2:
        return host, ''
    # Handle common two-label public suffixes (co.uk, com.au, ...).
    two_label = {'co.uk', 'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp'}
    if '.'.join(parts[-2:]) in two_label and len(parts) >= 3:
        root = '.'.join(parts[-3:])
        sub = '.'.join(parts[:-3])
    else:
        root = '.'.join(parts[-2:])
        sub = '.'.join(parts[:-2])
    return root, sub


# Porkbun serves its "A Brand New Domain!" parking page through default records
# it auto-creates on every domain: an ALIAS at the apex + wildcard/www CNAMEs,
# all pointing at a Porkbun-owned parking host. The exact host VARIES per domain
# (`pixie.porkbun.com`, `uixie.porkbun.com`, …), so we must match ANY
# *.porkbun.com target rather than one hard-coded host. Optional URL forwarding
# does the same thing at the HTTP layer. Unless these are removed, the domain
# keeps showing the parking page — AND Porkbun blocks adding an apex A record
# with "Conflict: a conflicting record already exists" because the ALIAS sits on
# the same host. This is the #1 "why isn't my site live / why can't I add the A
# record?" cause.
_PORKBUN_PARK_SUFFIX = '.porkbun.com'


def _is_parking_target(content: str) -> bool:
    """True if a DNS record's content points at a Porkbun parking host."""
    c = (content or '').strip().lower().rstrip('.')
    return c == 'porkbun.com' or c.endswith(_PORKBUN_PARK_SUFFIX)


async def _clear_porkbun_parking(root: str, apikey: str, secret: str) -> list[str]:
    """Remove Porkbun's default parking records + URL forwarding for `root`.

    Best-effort and idempotent: deletes every DNS record whose content points at
    a *.porkbun.com parking host (ALIAS/CNAME/wildcard) and every URL-forwarding
    rule. Never raises — a cleanup hiccup must not block the Vercel record we're
    about to create. Returns a short list of what it removed (for logging)."""
    removed: list[str] = []

    # 1) Parking DNS records (ALIAS @, www/wildcard CNAME → *.porkbun.com).
    try:
        allrecs = await _call(f'/dns/retrieve/{root}', apikey, secret)
        for rec in (allrecs.get('records') or []):
            rid = rec.get('id')
            if rid and _is_parking_target(rec.get('content', '')):
                try:
                    await _call(f'/dns/delete/{root}/{rid}', apikey, secret)
                    removed.append(f"{rec.get('type')} {rec.get('name') or '@'} → {rec.get('content')}")
                except HTTPException:
                    pass  # best-effort
    except HTTPException:
        pass  # retrieve may fail transiently — ignore

    # 2) URL forwarding (a forward rule beats DNS entirely, so it must go too).
    try:
        fwds = await _call(f'/domain/getUrlForwarding/{root}', apikey, secret)
        for fwd in (fwds.get('forwards') or []):
            fid = fwd.get('id')
            if fid:
                try:
                    await _call(f'/domain/deleteUrlForward/{root}/{fid}', apikey, secret)
                    removed.append(f"url-forward → {fwd.get('location')}")
                except HTTPException:
                    pass  # best-effort
    except HTTPException:
        pass  # no forwarding configured — ignore

    if removed:
        logger.info('Cleared Porkbun parking for %s: %s', root, ', '.join(removed))
    return removed


async def configure_vercel_dns(domain: str) -> dict:
    """Best-effort: point `domain` at Vercel via the connected Porkbun account.

    Creates (or refreshes) the correct DNS record so the pasted domain serves
    the Vercel deployment directly — an apex gets an A record to Vercel's
    anycast IP, a sub-domain gets a CNAME to cname.vercel-dns.com.

    Crucially, it FIRST removes Porkbun's default parking records + URL
    forwarding (which point at a *.porkbun.com host and otherwise keep serving
    the "A Brand New Domain!" page and block the apex A record with a conflict).

    Returns a small status dict; never raises for "not connected" so the deploy
    flow can call it opportunistically. Raises only on hard Porkbun API errors
    the caller explicitly wants surfaced.
    """
    apikey, secret = await _creds()  # raises 400 if Porkbun not connected
    root, sub = _split_domain(domain)
    if not root:
        raise HTTPException(400, 'Could not parse a root domain to configure DNS')

    # Kill parking records / URL forwarding first — otherwise Porkbun keeps
    # serving its parking page and rejects the apex A record with a conflict.
    cleared = await _clear_porkbun_parking(root, apikey, secret)

    if sub:
        rtype, name, content = 'CNAME', sub, _VERCEL_CNAME
    else:
        rtype, name, content = 'A', '', _VERCEL_APEX_A

    # Idempotent: delete any existing record of the same type+host first so we
    # don't stack duplicates, then create the Vercel-pointing one.
    try:
        existing = await _call(f'/dns/retrieveByNameType/{root}/{rtype}/{name}', apikey, secret)
        for rec in (existing.get('records') or []):
            rid = rec.get('id')
            if rid:
                try:
                    await _call(f'/dns/delete/{root}/{rid}', apikey, secret)
                except HTTPException:
                    pass  # best-effort cleanup
    except HTTPException:
        pass  # retrieve may 400 if none exist — ignore

    await _call('/dns/create', apikey, secret, {
        'type': rtype,
        'name': name,
        'content': content,
        'ttl': '600',
    })
    return {
        'ok': True,
        'root': root,
        'record': f'{rtype} {name or "@"} → {content}',
        'parking_cleared': cleared,
    }


# Nameserver-swap option (Vercel takes over DNS entirely) — the simplest
# path for a domain bought at another registrar.
VERCEL_NAMESERVERS = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']


def manual_dns_records(domain: str) -> dict:
    """Deterministic DNS the user must paste at THEIR registrar when we don't
    hold API keys for it (i.e. it isn't a Porkbun domain). Covers both the
    apex + www hosts (for a root launch) and offers the nameserver-swap
    alternative. Vercel still hosts the site — this just points the name at us.
    """
    root, sub = _split_domain(domain)
    hosts = [root, f'www.{root}'] if sub in ('', 'www') else [domain]
    records = []
    for host in hosts:
        _, s = _split_domain(host)
        if s:
            records.append({'type': 'CNAME', 'host': s, 'name': host, 'value': _VERCEL_CNAME})
        else:
            records.append({'type': 'A', 'host': '@', 'name': host, 'value': _VERCEL_APEX_A})
    return {'records': records, 'nameservers': VERCEL_NAMESERVERS, 'root': root}


async def domain_in_porkbun(root: str) -> bool:
    """True when `root` is a domain inside the connected Porkbun account, i.e.
    we can auto-configure its DNS. Any credential/API failure returns False so
    the caller falls back to manual instructions instead of hard-erroring.
    """
    try:
        apikey, secret = await _creds()
        data = await _call('/domain/listAll', apikey, secret)
    except HTTPException:
        return False
    except Exception:  # pragma: no cover - network
        return False
    target = (root or '').lower()
    for d in (data.get('domains') or []):
        if (d.get('domain') or '').lower() == target:
            return True
    return False


@router.post('/point-to-vercel')
async def porkbun_point_to_vercel(
    domain: str = Query(..., min_length=3),
    _: dict = Depends(get_current_operator),
):
    """Manually (re)point a Porkbun domain at Vercel from the Domains tab."""
    d = (domain or '').strip().lower()
    if '.' not in d or ' ' in d:
        raise HTTPException(400, 'Enter a full domain, e.g. app.example.com')
    return await configure_vercel_dns(d)


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
    """Check availability + registration price for a single domain.

    Fast paths avoid Porkbun's slow, rate-limited checkDomain call:
      1. the domain is already in the operator's account -> instant, owned=True
      2. a fresh cached result exists                     -> instant
      3. otherwise fall back to the live (slower) lookup and cache it
    """
    apikey, secret = await _creds()
    d = (domain or '').strip().lower()
    if '.' not in d or ' ' in d:
        raise HTTPException(400, 'Enter a full domain, e.g. example.com')

    root, _sub = _split_domain(d)

    # 1) Already owned in this Porkbun account? Answer instantly, no API call.
    owned = await _owned_roots(apikey, secret)
    if d in owned or root in owned:
        return {
            'domain': d, 'available': False, 'owned': True,
            'price': None, 'first_year_promo': None,
            'regular_price': None, 'premium': False, 'cached': True,
        }

    # 2) Fresh cached availability result?
    now = time.time()
    hit = _check_cache.get(d)
    if hit and now - hit[0] < _CHECK_TTL:
        return {**hit[1], 'cached': True}

    # 3) Slow path: ask Porkbun (rate-limited to ~1 call / 10s).
    data = await _call(f'/domain/checkDomain/{d}', apikey, secret)
    resp = data.get('response') or {}
    result = {
        'domain': d,
        'available': str(resp.get('avail')).lower() in ('yes', 'true', '1'),
        'owned': False,
        'price': resp.get('price'),
        'first_year_promo': resp.get('firstYearPromo'),
        'regular_price': resp.get('regularPrice'),
        'premium': str(resp.get('premium')).lower() in ('yes', 'true', '1'),
    }
    _check_cache[d] = (now, result)
    return {**result, 'cached': False}
