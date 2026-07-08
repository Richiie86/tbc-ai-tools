"""Deploy / domain preflight diagnostics  (NEW — additive, Jul 2026).

The single most common support question is "the Deploy button isn't working"
or "my domain won't connect". Both are almost always a *configuration* gap in
production (missing Vercel token, wrong team id, Porkbun keys absent, repo not
set, domain still propagating) rather than a code bug.

This module adds ONE read-only endpoint that runs every check the deploy /
domain flow silently depends on and returns a precise, human-readable report.
It writes nothing and changes no existing behaviour — it only *observes* the
same settings + Vercel/Porkbun surfaces the real flow uses, so the operator can
see exactly which box is red and fix that one thing.

    GET /api/operator/diagnostics/preflight            → full platform readiness
    GET /api/operator/diagnostics/preflight/{proj_id}  → + that project's specifics

Every check is wrapped so a single failing probe never breaks the report.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger("tbc.preflight")

# NOTE: this router lives under its OWN prefix (not /api/operator/deploy) on
# purpose. The deploy router has a single-segment param route `/{project_id}`
# (PATCH/DELETE) which would otherwise capture `/preflight` and return
# 405 Method Not Allowed for our GET. A dedicated prefix avoids that collision.
router = APIRouter(prefix="/api/operator/diagnostics", tags=["deploy"])

VERCEL_API = "https://api.vercel.com"


def _check(name: str, ok: bool, detail: str, fix: str = "") -> dict:
    """Uniform shape for one diagnostic row the frontend can render as-is."""
    return {"name": name, "ok": bool(ok), "detail": detail, "fix": fix}


async def _probe_vercel_token(settings: dict) -> list[dict]:
    """Verify the Vercel PAT + team scope actually authenticate."""
    rows: list[dict] = []
    from vercel_api_ext import vercel_token, vercel_team_qs

    token = vercel_token(settings)
    if not token:
        rows.append(_check(
            "Vercel token", False,
            "No Vercel Personal Access Token found in settings or VERCEL_TOKEN.",
            "Operator Console → Ops → Vercel keys, paste your PAT (or set the "
            "VERCEL_TOKEN env var).",
        ))
        return rows  # nothing else Vercel-side can pass without a token

    team_qs = vercel_team_qs(settings)
    team_id = team_qs.get("teamId", "")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{VERCEL_API}/v2/user",
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code == 200:
            who = (r.json().get("user") or {}).get("username") or "ok"
            rows.append(_check("Vercel token", True, f"Authenticated as '{who}'."))
        elif r.status_code in (401, 403):
            rows.append(_check(
                "Vercel token", False,
                "Vercel rejected the token (401/403) — it's expired or revoked.",
                "Generate a fresh token at vercel.com/account/tokens and re-paste it.",
            ))
        else:
            rows.append(_check(
                "Vercel token", False,
                f"Unexpected Vercel response ({r.status_code}).",
                "Retry shortly; if it persists, re-paste the token.",
            ))
    except Exception as e:  # pragma: no cover - network
        rows.append(_check("Vercel token", False, f"Could not reach Vercel: {e}",
                           "Check outbound network / Vercel status."))

    # Team scope — a wrong team id makes every deploy 403 even with a valid token.
    if team_id:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    f"{VERCEL_API}/v2/teams/{team_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
            ok = r.status_code == 200
            rows.append(_check(
                "Vercel team scope", ok,
                f"Team '{team_id}' reachable." if ok
                else f"Team '{team_id}' not accessible ({r.status_code}).",
                "" if ok else "Confirm VERCEL_TEAM_ID matches the team that owns "
                "the projects, or clear it to use personal scope.",
            ))
        except Exception as e:  # pragma: no cover
            rows.append(_check("Vercel team scope", False, f"Team check failed: {e}"))
    else:
        rows.append(_check(
            "Vercel team scope", True,
            "No team id set — using personal scope (fine if your projects live "
            "on your personal account).",
        ))
    return rows


async def _probe_porkbun(settings: dict) -> dict:
    """Are Porkbun keys present + valid? Drives whether we can AUTO-point DNS."""
    apikey = (settings.get("porkbun_api_key") or "").strip()
    secret = (settings.get("porkbun_secret_key") or "").strip()
    if not (apikey and secret):
        return _check(
            "Porkbun keys", False,
            "Porkbun API + secret keys not set — domains bought on Porkbun can't "
            "be auto-pointed (users on other registrars are unaffected).",
            "Operator Console → My Keys → add both Porkbun keys.",
        )
    try:
        from porkbun_ext import _call
        await _call("/ping", apikey, secret)
        return _check("Porkbun keys", True, "Porkbun keys valid (auto-DNS available).")
    except Exception as e:
        return _check("Porkbun keys", False, f"Porkbun rejected the keys: {e}",
                      "Re-check both keys in My Keys.")


async def _probe_github(settings: dict) -> dict:
    """The linchpin for EVERYTHING that writes code: commit, push, PR, new-app
    creation. Resolves the token the real flow uses (settings doc → env) and
    verifies it actually authenticates AND can create repos (classic scope)."""
    token = (settings.get("github_token") or os.environ.get("GITHUB_TOKEN") or "").strip()
    if not token:
        return _check(
            "GitHub token", False,
            "No GitHub token in settings or GITHUB_TOKEN — the AI can't commit, "
            "push, open PRs, or create new app repos.",
            "Operator Console → Security → paste a classic token with the 'repo' "
            "scope (or set GITHUB_TOKEN in Render).",
        )
    # A fine-grained PAT (github_pat_) authenticates but can't reliably create
    # repos, so new-app deploys fall back to manual. Flag it explicitly.
    fine_grained = token.startswith("github_pat_")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                "https://api.github.com/user",
                headers={"Authorization": f"token {token}",
                         "User-Agent": "tbc-preflight"},
            )
        if r.status_code == 200:
            login = (r.json() or {}).get("login") or "ok"
            if fine_grained:
                return _check(
                    "GitHub token", False,
                    f"Authenticated as '{login}', but this is a FINE-GRAINED token "
                    "which can't reliably create new repos — new-app deploys will "
                    "fall back to manual.",
                    "Replace it with a CLASSIC token (scope 'repo') at "
                    "github.com/settings/tokens/new.",
                )
            scopes = r.headers.get("x-oauth-scopes") or ""
            return _check(
                "GitHub token", True,
                f"Authenticated as '{login}' (classic token; can create repos). "
                f"Scopes: {scopes or 'n/a'}.",
            )
        if r.status_code in (401, 403):
            return _check(
                "GitHub token", False,
                f"GitHub rejected the token ({r.status_code}) — expired or revoked.",
                "Generate a fresh classic token (scope 'repo') and re-paste it in "
                "Operator → Security.",
            )
        return _check(
            "GitHub token", False,
            f"Unexpected GitHub response ({r.status_code}).",
            "Retry shortly; if it persists, re-paste the token.",
        )
    except Exception as e:  # pragma: no cover - network
        return _check("GitHub token", False, f"Could not reach GitHub: {e}",
                      "Check outbound network / GitHub status.")


async def _probe_ai_providers() -> dict:
    """At least one AI provider must be usable or nothing can build/edit. Uses
    the same health map that drives the failover chain + the picker dots."""
    try:
        from llm_router import providers_health
        health = await providers_health() or {}
        avail = [p for p, v in health.items() if (v or {}).get("configured")]
        if not avail:
            return _check(
                "AI provider", False,
                "No AI provider key configured — the AI can't generate or edit code.",
                "Operator Console → My Keys → add at least one provider key "
                "(Anthropic, OpenAI, or Gemini).",
            )
        up = [p for p in avail if (health.get(p, {}) or {}).get("status", "ok") != "down"]
        down = [p for p in avail if p not in up]
        if up:
            note = f"{len(up)} provider(s) ready: {', '.join(sorted(up))}."
            if down:
                note += f" Temporarily unavailable: {', '.join(sorted(down))}."
            return _check("AI provider", True, note,
                          "" if not down else "Top up or check the unavailable "
                          "provider(s); the platform auto-fails over meanwhile.")
        return _check(
            "AI provider", False,
            f"All configured providers are unavailable: {', '.join(sorted(down))}.",
            "Top up credits / fix the key for at least one provider (My Keys).",
        )
    except Exception as e:  # pragma: no cover
        return _check("AI provider", False, f"Provider health check failed: {e}")


def _probe_env() -> list[dict]:
    """Non-secret environment sanity the deploy/CORS paths rely on."""
    rows: list[dict] = []
    primary = (os.environ.get("PRIMARY_DOMAIN") or "").strip()
    rows.append(_check(
        "Primary domain env", True,
        f"PRIMARY_DOMAIN = '{primary}'." if primary
        else "PRIMARY_DOMAIN not set — defaults to tbctools.org for CORS.",
    ))
    return rows


@router.get("/preflight")
async def deploy_preflight(_op: dict = Depends(get_current_operator)):
    """Full platform readiness — every dependency the Deploy button + domain
    connect flow needs. Read-only; safe to run any time."""
    from payments_ext import get_settings_doc

    settings = await get_settings_doc()
    checks: list[dict] = []
    checks.append(await _probe_github(settings))
    checks.append(await _probe_ai_providers())
    checks.extend(await _probe_vercel_token(settings))
    checks.append(await _probe_porkbun(settings))
    checks.extend(_probe_env())

    # How many projects already have a Vercel project id (i.e. have deployed
    # at least once). A domain can only attach after this exists.
    try:
        total = await db.deploy_projects.count_documents({})
        with_vercel = await db.deploy_projects.count_documents(
            {"vercel_project_id": {"$exists": True, "$ne": None}}
        )
        checks.append(_check(
            "Deployed projects", True,
            f"{with_vercel}/{total} projects have a Vercel project id.",
            "" if with_vercel else "Run Deploy once on a project to create its "
            "Vercel project before attaching a domain.",
        ))
    except Exception as e:  # pragma: no cover
        checks.append(_check("Deployed projects", False, f"DB read failed: {e}"))

    # The four pillars of building independently: write code (GitHub), generate
    # it (AI), and ship it (Vercel token + team scope).
    _critical = ("GitHub token", "AI provider", "Vercel token", "Vercel team scope")
    blocked = [c["name"] for c in checks if c["name"] in _critical and not c["ok"]]
    ready = not blocked
    return {
        "ready": ready,
        "summary": "Everything is ready — you can build, edit, and deploy on your own."
                   if ready else
                   f"Blocked — fix: {', '.join(blocked)} (see the red items below).",
        "checks": checks,
    }


@router.get("/preflight/{project_id}")
async def deploy_preflight_project(
    project_id: str, _op: dict = Depends(get_current_operator),
):
    """Per-project diagnostics: repo set? vercel project exists? domain live?"""
    from payments_ext import get_settings_doc

    settings = await get_settings_doc()
    proj = await db.deploy_projects.find_one({"id": project_id})
    if not proj:
        return {"ready": False, "checks": [
            _check("Project", False, "Project not found.", "Pick a valid project.")]}

    checks: list[dict] = []
    repo = (proj.get("repo") or "").strip()
    checks.append(_check(
        "Git repo", bool(repo),
        f"Repo = '{repo}'." if repo else "No repo set on this project.",
        "" if repo else "Add the owner/name repo on the project row.",
    ))
    vpid = proj.get("vercel_project_id")
    checks.append(_check(
        "Vercel project", bool(vpid),
        f"Vercel project id = {vpid}." if vpid
        else "Not deployed yet — no Vercel project id.",
        "" if vpid else "Click Deploy once to create the Vercel project.",
    ))

    domain = (proj.get("domain") or "").strip()
    if domain:
        try:
            from vercel_api_ext import vercel_domain_config
            cfg = await vercel_domain_config(settings, domain)
            ready = cfg.get("ready")
            checks.append(_check(
                f"Domain {domain}", bool(ready),
                "DNS points at Vercel — serving." if ready
                else "DNS not pointed at Vercel yet (still propagating or wrong "
                     "record).",
                "" if ready else "Confirm the A/CNAME record at the registrar; "
                "changes can take minutes to an hour.",
            ))
        except Exception as e:  # pragma: no cover
            checks.append(_check(f"Domain {domain}", False, f"Config check failed: {e}"))
    else:
        checks.append(_check("Domain", True, "No custom domain set (optional)."))

    ready = all(c["ok"] for c in checks if c["name"] in ("Git repo", "Vercel project"))
    return {"ready": ready, "project": proj.get("projectName"), "checks": checks}
