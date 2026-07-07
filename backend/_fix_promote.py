import asyncio, os, sys, time, json
from datetime import datetime, timezone
import urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(__file__))

async def main():
    from db import db
    from secret_crypto import decrypt_secret
    doc = await db.settings.find_one({"_id": "payment_settings"})
    ck = doc.get("custom_keys") or []

    target = None
    for e in ck:
        if (e.get("name") or "").strip().lower() == "github classic token":
            target = e; break
    if not target:
        for e in ck:
            if "github" in (e.get("name") or "").lower():
                target = e; break
    if not target:
        print("ABORT: no github custom key"); return

    val = decrypt_secret(target.get("value")) or ""
    if not val.startswith("ghp_"):
        print(f"ABORT: not a classic token (prefix {val[:4]})"); return

    # Final safety re-test before mutating.
    def gh(method, path, body=None):
        req = urllib.request.Request("https://api.github.com"+path,
            data=json.dumps(body).encode() if body is not None else None, method=method)
        req.add_header("Authorization", f"token {val}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "tbc-promote")
        try:
            with urllib.request.urlopen(req, timeout=20) as r: return r.status, r.read().decode()
        except urllib.error.HTTPError as e: return e.code, e.read().decode()
    st, body = gh("GET", "/user")
    login = json.loads(body).get("login") if st == 200 else None
    name = f"tbc-promote-check-{int(time.time())}"
    cst, _ = gh("POST", "/user/repos", {"name": name, "private": True, "auto_init": False})
    if cst not in (200, 201):
        print(f"ABORT: token can't create repos (HTTP {cst})"); return
    gh("DELETE", f"/repos/{login}/{name}")

    # Promote into the real slot (secure wrapper encrypts on write) + remove
    # BOTH github custom entries so there is exactly one source of truth.
    now = datetime.now(timezone.utc).isoformat()
    remaining = [e for e in ck if "github" not in (e.get("name") or "").lower()]
    await db.settings.update_one(
        {"_id": "payment_settings"},
        {"$set": {"github_token": val, "github_token_rotated_at": now,
                  "custom_keys": remaining}},
    )
    print(f"PROMOTED classic token to github_token slot (login={login}); "
          f"removed {len(ck)-len(remaining)} github custom key(s).")

asyncio.run(main())
