"""Auto-subdomain + wildcard bootstrap  (NEW — additive, Jul 2026).

Goal (from the operator): every project should be instantly reachable at
`<slug>.tbctools.org` with zero DNS work, and the one-time wildcard setup
should be automated via the saved Vercel token + Porkbun keys.

How it works:
  1. `ensure_wildcard_dns()` creates a single `*` CNAME on the platform root
     (tbctools.org) at Porkbun → cname.vercel-dns.com. That one record makes
     EVERY future `<anything>.tbctools.org` resolve to Vercel. Idempotent.
     If the root isn't in the Porkbun account, we return the exact manual
     record instead of failing (honest fallback — DNS can't be forged).
  2. `assign_subdomain(project)` picks a unique `<slug>.tbctools.org`, stores
     it on the project doc as `subdomain`, and — when the project already has
     a Vercel project id — attaches it so Vercel serves the app there.

Nothing here mutates existing project behaviour: the subdomain is an *extra*
field; a project's custom `domain` (bought elsewhere) is untouched.
"""
from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_operator
from db import db

logger = logging.getLogger("tbc.wildcard")

router = APIRouter(prefix="/api/operator/deploy", tags=["deploy"])


def platform_domain() -> str:
    """Root domain every project gets a subdomain under. Overridable via env
    so this isn't hard-locked to tbctools.org."""
    return (os.environ.get("PLATFORM_DOMAIN") or "tbctools.org").strip().lower()


async def ensure_wildcard_dns() -> dict:
    """Create the one-time `*` CNAME at Porkbun so all subdomains resolve to
    Vercel. Idempotent + best-effort. Returns a status dict; never raises for
    the 'root not in Porkbun' case — hands back the manual record instead."""
    root = platform_domain()
    try:
        from porkbun_ext import (
            _creds, _call, domain_in_porkbun, _VERCEL_CNAME,
        )
    except Exception as e:  # pragma: no cover
        return {"ok": False, "reason": f"porkbun helpers unavailable: {e}"}

    if not await domain_in_porkbun(root):
        return {
            "ok": False,
            "manual": True,
            "reason": f"{root} isn't in the connected Porkbun account.",
            "record": {"type": "CNAME", "host": "*", "value": _VERCEL_CNAME},
            "hint": f"Add a CNAME with host '*' on {root} pointing to "
                    f"{_VERCEL_CNAME} at whichever registrar holds it.",
        }

    try:
        apikey, secret = await _creds()
        # Idempotent: remove any existing '*' CNAME first, then create ours.
        try:
            existing = await _call(
                f"/dns/retrieveByNameType/{root}/CNAME/*", apikey, secret)
            for rec in (existing.get("records") or []):
                rid = rec.get("id")
                if rid:
                    try:
                        await _call(f"/dns/delete/{root}/{rid}", apikey, secret)
                    except HTTPException:
                        pass
        except HTTPException:
            pass
        await _call("/dns/create", apikey, secret, {
            "type": "CNAME", "name": "*", "content": _VERCEL_CNAME, "ttl": "600",
        })
        logger.info("Wildcard *.%s CNAME → %s created", root, _VERCEL_CNAME)
        return {"ok": True, "root": root,
                "record": f"CNAME * → {_VERCEL_CNAME}"}
    except Exception as e:  # pragma: no cover - network
        return {"ok": False, "reason": f"Porkbun wildcard create failed: {e}"}


async def _unique_subdomain(base_slug: str) -> str:
    """Return `<slug>.<platform>` guaranteed not already used by another
    project. Appends a short random suffix on collision."""
    root = platform_domain()
    slug = (base_slug or "app").strip("-.") or "app"
    candidate = f"{slug}.{root}"
    exists = await db.deploy_projects.find_one({"subdomain": candidate})
    if not exists:
        return candidate
    suffix = secrets.token_urlsafe(3).lower().replace("_", "").replace("-", "")[:4]
    return f"{slug}-{suffix}.{root}"


async def assign_subdomain(project: dict, *, attach: bool = True) -> dict:
    """Give `project` a `<slug>.tbctools.org` subdomain, persist it, and (when
    the project has a Vercel project id) attach it so Vercel serves it.

    Returns {subdomain, attached, attach_error}. Best-effort: attach failures
    are reported but never raise, so this is safe to call opportunistically
    right after project creation.
    """
    from deploy_projects_ext import _slugify  # reuse the canonical slug rule

    pid = project.get("id")
    # Don't clobber an already-assigned subdomain.
    if project.get("subdomain"):
        subdomain = project["subdomain"]
    else:
        subdomain = await _unique_subdomain(_slugify(project.get("projectName") or "app"))
        await db.deploy_projects.update_one(
            {"id": pid},
            {"$set": {"subdomain": subdomain, "updated_at": datetime.now(timezone.utc)}},
        )
        logger.info("Assigned subdomain %s to project %s", subdomain, pid)

    attached, attach_error = False, None
    if attach and project.get("vercel_project_id"):
        try:
            from payments_ext import get_settings_doc
            from vercel_api_ext import vercel_attach_domain
            settings = await get_settings_doc()
            await vercel_attach_domain(settings, project["vercel_project_id"], subdomain)
            attached = True
            await db.deploy_projects.update_one(
                {"id": pid}, {"$set": {"subdomain_attached": True}})
        except HTTPException as e:
            attach_error = e.detail if isinstance(e.detail, str) else str(e.detail)
        except Exception as e:  # pragma: no cover - network
            attach_error = str(e)
    elif attach:
        attach_error = ("Project has no Vercel deployment yet — the subdomain "
                        "attaches automatically after the first Deploy.")

    # Trust the new subdomain for CORS immediately.
    try:
        from cors_dynamic_ext import invalidate_cors_cache
        invalidate_cors_cache()
    except Exception:
        pass

    return {"subdomain": subdomain, "attached": attached, "attach_error": attach_error}


@router.post("/wildcard/bootstrap")
async def wildcard_bootstrap(_op: dict = Depends(get_current_operator)):
    """One-time (idempotent) automated setup of `*.tbctools.org`."""
    res = await ensure_wildcard_dns()
    return res


@router.get("/wildcard/status")
async def wildcard_status(_op: dict = Depends(get_current_operator)):
    """Is the wildcard CNAME in place, and how many projects have a subdomain?"""
    root = platform_domain()
    with_sub = await db.deploy_projects.count_documents(
        {"subdomain": {"$exists": True, "$ne": None}})
    return {"platform_domain": root, "projects_with_subdomain": with_sub}


@router.post("/projects/{project_id}/auto-subdomain")
async def project_auto_subdomain(
    project_id: str, _op: dict = Depends(get_current_operator),
):
    """Assign (or re-attach) `<slug>.tbctools.org` for one project on demand."""
    proj = await db.deploy_projects.find_one({"id": project_id})
    if not proj:
        raise HTTPException(404, "Project not found")
    # Make sure the wildcard DNS exists first (cheap + idempotent).
    await ensure_wildcard_dns()
    result = await assign_subdomain(proj, attach=True)
    return {"ok": True, "project_id": project_id, **result}
