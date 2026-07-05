"""Recurring hosting billing — the "keep it live" fee  (NEW — additive, Jul 2026).

Launching a domain is a one-off charge (see domain_launch_ext.DOMAIN_LAUNCH_COST).
Keeping it live costs the platform money every month (Vercel + registrar), so we
charge the domain owner a small recurring fee in the SAME credits they already
hold. No new payment rail — just periodic credit deduction, exactly as the
operator chose.

Design:
  • A `hosting_subscriptions` doc per (user, domain). Created lazily from the
    existing `domain_launches` history so we don't have to touch the launch
    flow. Fields: user_id, domain, project_id, next_charge_at, status
    ('active' | 'suspended'), last_charged_at.
  • A background loop (`hosting_billing_loop`) wakes hourly and charges every
    subscription whose `next_charge_at` has passed:
        – enough credits  → deduct, advance next_charge_at one period, log an
          income row in `hosting_charges` (feeds the operator Money tab).
        – not enough      → mark 'suspended' and detach the domain from Vercel
          so we stop paying to host a non-paying site. The user can top up
          credits and hit "Resume" to relist it.
  • Operator + user endpoints to view status, resume, and see recurring income.

Everything is additive: no existing collection schema or endpoint changes.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

from auth_utils import get_current_user, get_current_operator
from db import db

logger = logging.getLogger("tbc.hosting_billing")

VERCEL_API = "https://api.vercel.com"


def hosting_fee_credits() -> int:
    """Recurring per-domain fee in credits (env-overridable)."""
    try:
        return max(0, int(os.environ.get("HOSTING_FEE_CREDITS", "20")))
    except ValueError:
        return 20


def hosting_period_days() -> int:
    """Billing period length in days (env-overridable, default 30)."""
    try:
        return max(1, int(os.environ.get("HOSTING_PERIOD_DAYS", "30")))
    except ValueError:
        return 30


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


async def _is_unlimited(user_doc: dict) -> bool:
    """Operator + enterprise/unlimited users are never charged recurring fees
    (same rule as the one-off launch charge)."""
    return (
        user_doc.get("role") == "operator"
        or str(user_doc.get("credits")) in ("inf", "-1")
        or user_doc.get("plan") == "enterprise"
    )


async def ensure_subscription(
    user_id: str, domain: str, project_id: Optional[str], user_email: Optional[str],
) -> dict:
    """Create (idempotently) a hosting subscription for a launched domain.

    Called lazily by the billing tick when it discovers a launched domain with
    no subscription yet, so no change to the launch flow is required.
    """
    existing = await db.hosting_subscriptions.find_one(
        {"user_id": user_id, "domain": domain})
    if existing:
        return existing
    now = datetime.now(timezone.utc)
    doc = {
        "user_id": user_id,
        "user_email": user_email,
        "domain": domain,
        "project_id": project_id,
        "fee_credits": hosting_fee_credits(),
        "period_days": hosting_period_days(),
        "status": "active",
        "created_at": now,
        # First recurring charge falls one period AFTER launch (launch already
        # covered the initial period via DOMAIN_LAUNCH_COST).
        "next_charge_at": now + timedelta(days=hosting_period_days()),
        "last_charged_at": None,
    }
    await db.hosting_subscriptions.insert_one(doc)
    logger.info("Created hosting subscription for %s (%s)", domain, user_email)
    return doc


async def _backfill_subscriptions() -> None:
    """Ensure every distinct launched domain has a subscription row."""
    seen: set[tuple] = set()
    cursor = db.domain_launches.find(
        {"refunded": {"$ne": True}},
        {"_id": 0, "user_id": 1, "domain": 1, "project_id": 1, "user_email": 1},
    )
    async for l in cursor:
        key = (l.get("user_id"), l.get("domain"))
        if not all(key) or key in seen:
            continue
        seen.add(key)
        await ensure_subscription(
            l["user_id"], l["domain"], l.get("project_id"), l.get("user_email"))


async def _detach_domain(project_id: Optional[str], domain: str) -> None:
    """Best-effort remove the domain from its Vercel project on suspension so
    we stop hosting a non-paying site. Never raises."""
    if not project_id:
        return
    try:
        proj = await db.deploy_projects.find_one({"id": project_id})
        vpid = (proj or {}).get("vercel_project_id")
        if not vpid:
            return
        from payments_ext import get_settings_doc
        from vercel_api_ext import vercel_token, vercel_team_qs
        settings = await get_settings_doc()
        token = vercel_token(settings)
        if not token:
            return
        async with httpx.AsyncClient(timeout=12.0) as client:
            await client.delete(
                f"{VERCEL_API}/v9/projects/{vpid}/domains/{domain}",
                params=vercel_team_qs(settings),
                headers={"Authorization": f"Bearer {token}"},
            )
        logger.info("Detached %s from Vercel project %s (suspended)", domain, vpid)
    except Exception as e:  # pragma: no cover - network
        logger.warning("Detach on suspend failed for %s: %s", domain, e)


async def _charge_one(sub: dict) -> str:
    """Charge a single due subscription. Returns an outcome string."""
    now = datetime.now(timezone.utc)
    uid = sub["user_id"]
    fee = int(sub.get("fee_credits") or hosting_fee_credits())
    period = int(sub.get("period_days") or hosting_period_days())

    user_doc = await db.users.find_one({"id": uid})
    if not user_doc:
        # Orphaned subscription — cancel it so we stop scanning it.
        await db.hosting_subscriptions.update_one(
            {"_id": sub["_id"]}, {"$set": {"status": "cancelled"}})
        return "cancelled_no_user"

    # Free tiers: just roll the period forward, no charge, no income row.
    if await _is_unlimited(user_doc) or fee == 0:
        await db.hosting_subscriptions.update_one(
            {"_id": sub["_id"]},
            {"$set": {"next_charge_at": now + timedelta(days=period),
                      "last_charged_at": now}},
        )
        return "free"

    # Atomic, race-safe deduction (same pattern as the launch charge).
    res = await db.users.update_one(
        {"id": uid, "credits": {"$gte": fee}},
        {"$inc": {"credits": -fee}},
    )
    if res.modified_count == 0:
        # Not enough credits → suspend + detach.
        await db.hosting_subscriptions.update_one(
            {"_id": sub["_id"]},
            {"$set": {"status": "suspended", "suspended_at": now,
                      "suspend_reason": "insufficient_credits"}},
        )
        await _detach_domain(sub.get("project_id"), sub["domain"])
        logger.info("Suspended hosting for %s (%s) — insufficient credits",
                    sub["domain"], sub.get("user_email"))
        return "suspended"

    # Success → advance the period + record income.
    await db.hosting_subscriptions.update_one(
        {"_id": sub["_id"]},
        {"$set": {"next_charge_at": now + timedelta(days=period),
                  "last_charged_at": now}},
    )
    await db.hosting_charges.insert_one({
        "user_id": uid,
        "user_email": sub.get("user_email"),
        "domain": sub["domain"],
        "project_id": sub.get("project_id"),
        "credits_charged": fee,
        "created_at": now,
    })
    return "charged"


async def run_hosting_billing_tick() -> dict:
    """Charge every due subscription once. Safe to call manually or on a timer."""
    await _backfill_subscriptions()
    now = datetime.now(timezone.utc)
    due = db.hosting_subscriptions.find(
        {"status": "active", "next_charge_at": {"$lte": now}})
    counts = {"charged": 0, "suspended": 0, "free": 0, "cancelled_no_user": 0}
    async for sub in due:
        try:
            outcome = await _charge_one(sub)
            counts[outcome] = counts.get(outcome, 0) + 1
        except Exception as e:  # pragma: no cover
            logger.warning("Hosting charge failed for %s: %s", sub.get("domain"), e)
    if any(counts.values()):
        logger.info("Hosting billing tick: %s", counts)
    return counts


async def hosting_billing_loop(interval_seconds: int = 3600) -> None:
    """Background loop: run a billing tick every hour. Started at app startup."""
    # Small initial delay so it never competes with boot-time index creation.
    await asyncio.sleep(30)
    while True:
        try:
            await run_hosting_billing_tick()
        except Exception as e:  # pragma: no cover
            logger.warning("Hosting billing loop error (non-fatal): %s", e)
        await asyncio.sleep(interval_seconds)


# ===================================================================
# User surface — see + manage your own hosted domains
# ===================================================================
user_router = APIRouter(prefix="/api/hosting", tags=["hosting"])


@user_router.get("/status")
async def hosting_status(user: dict = Depends(get_current_user)):
    """The signed-in user's hosted domains, fee, next charge date + balance."""
    uid = user["sub"]
    u = await db.users.find_one({"id": uid}) or {}
    subs = await db.hosting_subscriptions.find(
        {"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(length=200)
    return {
        "credits": u.get("credits"),
        "fee_credits": hosting_fee_credits(),
        "period_days": hosting_period_days(),
        "domains": [
            {
                "domain": s.get("domain"),
                "project_id": s.get("project_id"),
                "status": s.get("status"),
                "fee_credits": s.get("fee_credits"),
                "next_charge_at": _iso(s.get("next_charge_at")),
                "last_charged_at": _iso(s.get("last_charged_at")),
                "suspend_reason": s.get("suspend_reason"),
            }
            for s in subs
        ],
    }


@user_router.post("/resume")
async def hosting_resume(
    domain: str, user: dict = Depends(get_current_user),
):
    """Re-activate a suspended domain after topping up credits. Charges the fee
    immediately + re-attaches the domain to Vercel."""
    uid = user["sub"]
    sub = await db.hosting_subscriptions.find_one({"user_id": uid, "domain": domain})
    if not sub:
        raise HTTPException(404, "No hosting subscription for that domain")
    if sub.get("status") == "active":
        return {"ok": True, "status": "active", "message": "Already active"}

    now = datetime.now(timezone.utc)
    fee = int(sub.get("fee_credits") or hosting_fee_credits())
    res = await db.users.update_one(
        {"id": uid, "credits": {"$gte": fee}}, {"$inc": {"credits": -fee}})
    if res.modified_count == 0:
        raise HTTPException(
            402, f"You need at least {fee} credits to resume hosting {domain}. "
                 "Top up and try again.")
    await db.hosting_subscriptions.update_one(
        {"_id": sub["_id"]},
        {"$set": {"status": "active", "next_charge_at": now + timedelta(
            days=int(sub.get("period_days") or hosting_period_days())),
            "last_charged_at": now, "suspend_reason": None}},
    )
    await db.hosting_charges.insert_one({
        "user_id": uid, "user_email": sub.get("user_email"),
        "domain": domain, "project_id": sub.get("project_id"),
        "credits_charged": fee, "created_at": now, "kind": "resume",
    })
    # Re-attach to Vercel so it serves again.
    try:
        proj = await db.deploy_projects.find_one({"id": sub.get("project_id")})
        vpid = (proj or {}).get("vercel_project_id")
        if vpid:
            from payments_ext import get_settings_doc
            from vercel_api_ext import vercel_attach_domain
            settings = await get_settings_doc()
            await vercel_attach_domain(settings, vpid, domain)
    except Exception as e:  # pragma: no cover
        logger.warning("Re-attach on resume failed for %s: %s", domain, e)
    fresh = await db.users.find_one({"id": uid})
    return {"ok": True, "status": "active", "credits_remaining": fresh.get("credits")}


# ===================================================================
# Operator surface — recurring income + manual controls
# ===================================================================
op_router = APIRouter(prefix="/api/operator/money", tags=["income"])


@op_router.get("/hosting")
async def hosting_income(_op: dict = Depends(get_current_operator)):
    """Recurring hosting income for the Money tab (kept separate from one-off
    launch + plan revenue)."""
    active = await db.hosting_subscriptions.count_documents({"status": "active"})
    suspended = await db.hosting_subscriptions.count_documents({"status": "suspended"})
    agg = await db.hosting_charges.aggregate([
        {"$group": {"_id": None, "credits": {"$sum": "$credits_charged"},
                    "count": {"$sum": 1}}},
    ]).to_list(length=1)
    credits_total = int(agg[0]["credits"]) if agg else 0
    charge_count = int(agg[0]["count"]) if agg else 0
    recent = await db.hosting_charges.find({}, {"_id": 0}).sort(
        "created_at", -1).limit(50).to_list(length=50)
    return {
        "fee_credits": hosting_fee_credits(),
        "period_days": hosting_period_days(),
        "active_subscriptions": active,
        "suspended_subscriptions": suspended,
        "credits_collected_total": credits_total,
        "charge_count": charge_count,
        "recent": [
            {**r, "created_at": _iso(r.get("created_at"))} for r in recent
        ],
    }


@op_router.post("/hosting/run-now")
async def hosting_run_now(_op: dict = Depends(get_current_operator)):
    """Manually trigger a billing tick (useful for testing / immediate sweep)."""
    counts = await run_hosting_billing_tick()
    return {"ok": True, "counts": counts}
