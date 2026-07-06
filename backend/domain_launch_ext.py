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
    return await perform_domain_launch(
        user,
        payload.domain,
        project_id=payload.projectId,
        project_name=payload.projectName,
        request=request,
    )


async def perform_domain_launch(
    user: dict,
    domain_raw: str,
    project_id: Optional[str] = None,
    project_name: Optional[str] = None,
    request: Optional[Request] = None,
) -> dict:
    """Core launch logic, shared by the standalone `/launch-domain` endpoint
    and the one-click Deploy flow (deploy → auto-connect the chosen domain).

    Behaviour:
      * Porkbun domains  → DNS is auto-configured (apex + www).
      * Other registrars → we can't touch their DNS, so we attach the domain
        in Vercel (so Vercel hosts it the moment DNS resolves) AND return
        `manual_dns` with the exact records / nameservers to paste. This is
        how we still host — and earn — on domains bought elsewhere.
    """
    domain = _normalize_domain(domain_raw)
    if "." not in domain or " " in domain:
        raise HTTPException(400, "Enter a full domain, e.g. app.example.com")

    uid = user["sub"]
    u = await db.users.find_one({"id": uid})
    if not u:
        raise HTTPException(404, "User not found")

    # 1) Atomic, race-safe deduction. The operator (the app owner) always
    #    launches for free — they own the Vercel/Porkbun accounts, so charging
    #    themselves credits is meaningless. Enterprise/unlimited-credit users
    #    are also free. Everyone else must have >= cost.
    unlimited = (
        u.get("role") == "operator"
        or str(u.get("credits")) in ("inf", "-1")
        or u.get("plan") == "enterprise"
    )
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
        "project_id": project_id,
        "project_name": project_name,
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
    manual_dns = None  # set for domains we don't hold registrar keys for
    # When the operator launches the naked root (e.g. `tbcdomain.com`) or its
    # `www`, point BOTH the apex and the `www` sub-domain at Vercel so the site
    # resolves either way — a domain that only works on one of the two is the
    # most common "why isn't it live?" complaint. For a deeper sub-domain
    # (app.example.com) we only touch that exact host.
    try:
        from porkbun_ext import (
            configure_vercel_dns, _split_domain,
            manual_dns_records, domain_in_porkbun,
        )
        root, sub = _split_domain(domain)
        targets = [root, f"www.{root}"] if sub in ("", "www") else [domain]
        launch_doc["dns_hosts"] = targets
        # Only Porkbun domains can be auto-pointed. For anything bought
        # elsewhere we can't rewrite DNS — we hand back manual steps instead
        # (but still attach in Vercel below so we host it once DNS resolves).
        if await domain_in_porkbun(root):
            ok_any = False
            for host in targets:
                try:
                    res = await configure_vercel_dns(host)
                    ok_any = ok_any or bool(res.get("ok"))
                except HTTPException as e:
                    dns_error = e.detail if isinstance(e.detail, str) else str(e.detail)
                except Exception as e:  # pragma: no cover - network
                    dns_error = f"DNS setup skipped: {e}"
                    logger.warning("launch-domain DNS error for %s: %s", host, e)
            launch_doc["dns_configured"] = ok_any
        else:
            manual_dns = manual_dns_records(domain)
            launch_doc["manual_dns_required"] = True
            dns_error = (
                "This domain isn't in the connected Porkbun account, so its DNS "
                "must be set at your registrar — follow the steps shown."
            )
    except HTTPException as e:
        dns_error = e.detail if isinstance(e.detail, str) else str(e.detail)
    except Exception as e:  # pragma: no cover - network
        dns_error = f"DNS setup skipped: {e}"
        logger.warning("launch-domain DNS error for %s: %s", domain, e)

    # Attach to the project's Vercel deployment when we know the project.
    # NOTE: previously this only wrote `domain` to Mongo and *claimed*
    # vercel_attached=True without ever telling Vercel — so the domain never
    # actually served the app. We now call the real Vercel API so the domain
    # goes live on the project (mirrors the operator "set domain" flow).
    vercel_error = None
    if project_id:
        try:
            proj = await db.deploy_projects.find_one({"id": project_id})
            if proj:
                await db.deploy_projects.update_one(
                    {"id": project_id},
                    {"$set": {"domain": domain, "updated_at": now}},
                )
                vercel_project_id = proj.get("vercel_project_id")
                from payments_ext import get_settings_doc
                from vercel_api_ext import vercel_attach_domain
                settings = await get_settings_doc()

                # Self-provision: if the project has never been deployed it has
                # no Vercel project id yet — instead of forcing the user to hit
                # Deploy first, create the Vercel project up-front (linked to
                # the repo so Vercel auto-builds the production branch). This is
                # what makes "Connect domain" work on a brand-new project.
                if not vercel_project_id and (proj.get("repo") or "").strip():
                    try:
                        from vercel_api_ext import vercel_ensure_project
                        from deploy_projects_ext import _slugify
                        ensured = await vercel_ensure_project(
                            settings,
                            _slugify(proj.get("projectName") or "project"),
                            proj["repo"],
                            proj.get("repoType", "github"),
                            proj.get("gitRef"),
                        )
                        vercel_project_id = ensured.get("id")
                        if vercel_project_id:
                            await db.deploy_projects.update_one(
                                {"id": project_id},
                                {"$set": {"vercel_project_id": vercel_project_id,
                                          "updated_at": now}},
                            )
                    except HTTPException as e:
                        vercel_error = e.detail if isinstance(e.detail, str) else str(e.detail)
                    except Exception as e:  # pragma: no cover - network
                        vercel_error = f"Vercel project create failed: {e}"

                # Deploy-first-then-attach: a domain pointed at a Vercel
                # project that has NO ready production deployment serves the
                # dreaded `404 NOT_FOUND` (exactly the tbcdomain.com symptom).
                # Before attaching, guarantee a READY production deployment —
                # trigger one and poll if the project has never shipped (or its
                # last deploy didn't reach READY). Best-effort: a deploy hiccup
                # never blocks the attach (Vercel will serve once a build lands).
                if vercel_project_id and (proj.get("repo") or "").strip():
                    last_state = (proj.get("last_deployment_state") or "").upper()
                    if last_state != "READY":
                        try:
                            from deploy_projects_ext import _trigger_deploy
                            from app_builder_ext import _poll_deployment_ready
                            dep = await _trigger_deploy(
                                project_id, settings, "production",
                                proj.get("gitRef") or "main",
                                bypass_review=True, user_id=uid,
                            )
                            dep_id = dep.get("deployment_id")
                            if dep_id:
                                ready = await _poll_deployment_ready(settings, dep_id)
                                rstate = (ready.get("readyState")
                                          or ready.get("status") or "").upper()
                                launch_doc["production_deploy_state"] = rstate
                                await db.deploy_projects.update_one(
                                    {"id": project_id},
                                    {"$set": {"last_deployment_state": rstate,
                                              "updated_at": now}},
                                )
                        except HTTPException as e:
                            logger.warning(
                                "launch-domain deploy-first failed for %s: %s",
                                domain, e.detail,
                            )
                        except Exception as e:  # pragma: no cover - network
                            logger.warning(
                                "launch-domain deploy-first error for %s: %s", domain, e,
                            )
                if vercel_project_id:
                    # Attach every host we pointed DNS for (apex + www, or the
                    # single sub-domain) so Vercel serves the app on all of
                    # them. Attaching is idempotent, so re-launching is safe.
                    hosts = launch_doc.get("dns_hosts") or [domain]
                    attached_any = False
                    reconciled = False
                    from deploy_projects_ext import (
                        _looks_like_missing_project, _reconcile_vercel_project, _slugify,
                    )
                    for host in hosts:
                        try:
                            await vercel_attach_domain(settings, vercel_project_id, host)
                            attached_any = True
                        except HTTPException as e:
                            detail = e.detail if isinstance(e.detail, str) else str(e.detail)
                            # Self-heal a stale project id (deleted/recreated
                            # after a rebuild): reconcile once, then retry this
                            # host. Same fix the Deploy path uses, so connecting
                            # a domain "just works" even on a stale project.
                            if not reconciled and _looks_like_missing_project(detail):
                                reconciled = True
                                healed = await _reconcile_vercel_project(
                                    proj, settings,
                                    _slugify(proj.get("projectName") or "project"),
                                    proj.get("gitRef"),
                                )
                                if healed:
                                    vercel_project_id = healed
                                    try:
                                        await vercel_attach_domain(settings, vercel_project_id, host)
                                        attached_any = True
                                        continue
                                    except HTTPException as e2:
                                        detail = e2.detail if isinstance(e2.detail, str) else str(e2.detail)
                            vercel_error = detail
                    launch_doc["vercel_attached"] = attached_any
                elif not vercel_error:
                    vercel_error = (
                        "Project has no repo set, so a Vercel project can't be "
                        "created automatically. Add the owner/name repo to the "
                        "project, then connect the domain again."
                    )
        except HTTPException as e:
            vercel_error = e.detail if isinstance(e.detail, str) else str(e.detail)
            logger.warning("launch-domain Vercel attach failed for %s: %s", domain, vercel_error)
        except Exception as e:  # pragma: no cover - network
            vercel_error = f"Vercel attach failed: {e}"
            logger.warning("launch-domain project update failed: %s", e)

    # Money-safety: the docstring promises we don't charge for a launch that
    # did nothing. If we actually charged AND both the DNS step and the Vercel
    # attach failed, refund the credits and record the launch as free so the
    # user (or a customer) is never billed for a no-op. A partial success
    # (either DNS or Vercel worked) is still a real launch and stays charged.
    refunded = False
    both_failed = (not launch_doc["dns_configured"]) and (not launch_doc["vercel_attached"])
    if charged > 0 and both_failed:
        try:
            await db.users.update_one({"id": uid}, {"$inc": {"credits": charged}})
            launch_doc["credits_charged"] = 0
            launch_doc["refunded"] = True
            refunded = True
            logger.info(
                "Domain launch %s refunded %d credits (DNS + Vercel both failed)",
                domain, charged,
            )
        except Exception as e:  # pragma: no cover - refund best-effort
            logger.error("Refund failed for %s launch by %s: %s", domain, uid, e)

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
            details={"credits_charged": charged, "project_id": project_id},
            request=request,
        )
    except Exception:
        pass

    fresh = await db.users.find_one({"id": uid})
    logger.info(
        "Domain launch %s by %s (-%d credits%s)",
        domain, u.get("email"), launch_doc["credits_charged"],
        ", refunded" if refunded else "",
    )

    # A single, human-readable summary the UI can show as-is.
    if launch_doc["dns_configured"] and launch_doc["vercel_attached"]:
        message = (
            f"{domain} is launching. DNS is pointed at Vercel and the domain is "
            "attached to your project — it goes live once DNS propagates "
            "(usually a few minutes, up to an hour)."
        )
    elif manual_dns and launch_doc["vercel_attached"]:
        message = (
            f"{domain} is attached to your project and hosted on Vercel. "
            "Because this domain isn't registered with us, add the DNS records "
            "shown at your current registrar — it goes live once they propagate."
        )
    elif refunded:
        message = (
            f"Couldn't launch {domain} automatically, so you were NOT charged. "
            + (dns_error or vercel_error or "Check that both your Porkbun keys and "
               "Vercel token are saved in Operator settings, then try again.")
        )
    else:
        parts = []
        parts.append("DNS pointed at Vercel." if launch_doc["dns_configured"]
                     else f"DNS not set ({dns_error}).")
        parts.append("Domain attached to Vercel." if launch_doc["vercel_attached"]
                     else f"Vercel attach pending ({vercel_error}).")
        message = f"{domain}: " + " ".join(parts)

    return {
        "ok": True,
        "id": str(ins.inserted_id),
        "domain": domain,
        "credits_charged": launch_doc["credits_charged"],
        "credits_remaining": fresh.get("credits"),
        "dns_configured": launch_doc["dns_configured"],
        "dns_error": dns_error,
        "manual_dns": manual_dns,
        "vercel_attached": launch_doc["vercel_attached"],
        "vercel_error": vercel_error,
        "refunded": refunded,
        "message": message,
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
