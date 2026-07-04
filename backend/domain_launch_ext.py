"""Domain launch — charge credits + record the launch, feed the Income tab.

When a user (or the operator) launches a project onto a custom domain, we:
  1. Atomically deduct a flat DOMAIN_LAUNCH_COST in credits (race-safe via a
     conditional `$gte` update so two tabs can't double-spend).
  2. Record a `domain_launches` document — this is what the Income tab's
     separate "Domains" stat reads (kept OUT of revenue totals on purpose).
  3. Best-effort point the domain's DNS at Vercel through the connected
     Porkbun account, and attach it to the project's Vercel deployment, so it
     goes live on THAT domain directly.

Money-sensitive: the credit deduction happens first and is only committed when
the user actually had the balance. Everything after (DNS / Vercel) is
best-effort and never silently re-charges.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth_utils import get_current_user, get_current_operator
from db import db

logger = logging.getLogger("tbc.domain_launch")

# Flat price to launch a project onto a custom domain, in credits.
DOMAIN_LAUNCH_COST = 50

launch_router = APIRouter(prefix="/api/deploy", tags=["domain-launch"])
money_domains_router = APIRouter(prefix="/api/operator/money", tags=["income"])


class LaunchDomainIn(BaseModel):
    domain: str
    projectId: Optional[str] = None
    projectName: Optional[str] = None


def _normalize_domain(raw: str) -> str:
    d = (raw or "").strip().lower()
    for prefix in ("https://", "http://"):
        if d.startswith(prefix):
            d = d[len(prefix):]
    d = d.split("/", 1)[0].rstrip(".")
    return d


@launch_router.post("/launch-domain")
async def launch_domain(
    payload: LaunchDomainIn,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Charge DOMAIN_LAUNCH_COST credits and launch the project on `domain`."""
    domain = _normalize_domain(payload.domain)
    if "." not in domain or " " in domain:
        raise HTTPException(400, "Enter a full domain, e.g. app.example.com")

    uid = user["sub"]
    u = await db.users.find_one({"id": uid})
    if not u:
        raise HTTPException(404, "User not found")

    # 1) Atomic, race-safe deduction. Operators with unlimited/enterprise
    #    credits ('inf') are not charged. Everyone else must have >= cost.
    unlimited = str(u.get("credits")) in ("inf", "-1") or u.get("plan") == "enterprise"
    charged = 0
    if not unlimited:
        res = await db.users.update_one(
            {"id": uid, "credits": {"$gte": DOMAIN_LAUNCH_COST}},
            {"$inc": {"credits": -DOMAIN_LAUNCH_COST}},
        )
        if res.modified_count == 0:
            raise HTTPException(
                402,
                f"You need at least {DOMAIN_LAUNCH_COST} credits to launch a domain. "
                "Top up your credits and try again.",
            )
        charged = DOMAIN_LAUNCH_COST

    now = datetime.now(timezone.utc)

    # 2) Record the launch (drives the Income → Domains stat).
    launch_doc = {
        "user_id": uid,
        "user_email": u.get("email"),
        "domain": domain,
        "project_id": payload.projectId,
        "project_name": payload.projectName,
        "credits_charged": charged,
        "created_at": now,
        "dns_configured": False,
        "vercel_attached": False,
    }

    # 3) Best-effort DNS + Vercel attach. Failures here do NOT refund
    #    automatically — the launch is recorded; DNS can be retried from the
    #    Domains tab. But if BOTH fail we refund so the user isn't charged for
    #    a launch that did nothing.
    dns_error = None
    try:
        from porkbun_ext import configure_vercel_dns
        dns_res = await configure_vercel_dns(domain)
        launch_doc["dns_configured"] = bool(dns_res.get("ok"))
    except HTTPException as e:
        dns_error = e.detail if isinstance(e.detail, str) else str(e.detail)
    except Exception as e:  # pragma: no cover - network
        dns_error = f"DNS setup skipped: {e}"
        logger.warning("launch-domain DNS error for %s: %s", domain, e)

    # Attach to the project's Vercel deployment when we know the project.
    if payload.projectId:
        try:
            proj = await db.deploy_projects.find_one({"id": payload.projectId})
            if proj:
                await db.deploy_projects.update_one(
                    {"id": payload.projectId},
                    {"$set": {"domain": domain, "updated_at": now}},
                )
                launch_doc["vercel_attached"] = True
        except Exception as e:  # pragma: no cover
            logger.warning("launch-domain project update failed: %s", e)

    ins = await db.domain_launches.insert_one(launch_doc)

    # Trust the freshly-launched domain for CORS immediately (otherwise it
    # would wait for the next background refresh tick). Safe no-op if the
    # dynamic CORS layer isn't loaded.
    try:
        from cors_dynamic_ext import invalidate_cors_cache
        invalidate_cors_cache()
    except Exception:
        pass

    try:
        from audit_ext import record_audit
        await record_audit(
            u, "domain.launch", target=domain,
            details={"credits_charged": charged, "project_id": payload.projectId},
            request=request,
        )
    except Exception:
        pass

    fresh = await db.users.find_one({"id": uid})
    logger.info("Domain launch %s by %s (-%d credits)", domain, u.get("email"), charged)
    return {
        "ok": True,
        "id": str(ins.inserted_id),
        "domain": domain,
        "credits_charged": charged,
        "credits_remaining": fresh.get("credits"),
        "dns_configured": launch_doc["dns_configured"],
        "dns_error": dns_error,
    }


@money_domains_router.get("/domains")
async def money_domains(_op: dict = Depends(get_current_operator)):
    """Separate 'Domains' stat for the Income tab — count + credits collected
    from domain launches, kept out of the revenue totals."""
    cursor = db.domain_launches.find({}, {"_id": 0}).sort("created_at", -1).limit(100)
    launches = await cursor.to_list(length=100)
    total = await db.domain_launches.count_documents({})
    credits_agg = await db.domain_launches.aggregate([
        {"$group": {"_id": None, "credits": {"$sum": "$credits_charged"}}}
    ]).to_list(length=1)
    credits_total = int(credits_agg[0]["credits"]) if credits_agg else 0

    def _iso(v):
        return v.isoformat() if hasattr(v, "isoformat") else v

    return {
        "count": total,
        "credits_total": credits_total,
        "cost_per_launch": DOMAIN_LAUNCH_COST,
        "launches": [
            {
                "domain": l.get("domain"),
                "project_name": l.get("project_name"),
                "user_email": l.get("user_email"),
                "credits_charged": l.get("credits_charged", 0),
                "dns_configured": l.get("dns_configured", False),
                "created_at": _iso(l.get("created_at")),
            }
            for l in launches
        ],
    }
