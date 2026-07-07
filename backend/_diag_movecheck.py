import asyncio, os, sys, time, json
import urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(__file__))

async def main():
    from db import db
    from secret_crypto import decrypt_secret
    doc = await db.settings.find_one({"_id": "payment_settings"})
    ck = doc.get("custom_keys") or []

    # Prefer the correctly-spelled entry; fall back to any GitHub-ish one.
    target = None
    for e in ck:
        if (e.get("name") or "").strip().lower() == "github classic token":
            target = e; break
    if not target:
        for e in ck:
            if "github" in (e.get("name") or "").lower():
                target = e; break
    if not target:
        print("NO github custom key found"); return

    val = decrypt_secret(target.get("value")) or ""
    kind = "classic (ghp_)" if val.startswith("ghp_") else (
        "fine-grained" if val.startswith("github_pat_") else f"other({val[:4]}…)")
    print(f"custom key {target.get('name')!r}: decrypted type={kind} len={len(val)}")

    def gh(method, path, body=None):
        url = "https://api.github.com" + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {val}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "tbc-movecheck")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    st, body = gh("GET", "/user")
    login = json.loads(body).get("login") if st == 200 else None
    print(f"auth: HTTP {st} login={login}")

    name = f"tbc-classic-check-{int(time.time())}"
    st, body = gh("POST", "/user/repos", {"name": name, "private": True, "auto_init": False})
    if st in (200, 201):
        print("CREATE REPO: YES  -> this classic token is good to promote")
        ds, _ = gh("DELETE", f"/repos/{login}/{name}")
        print(f"cleanup: HTTP {ds}")
    else:
        print(f"CREATE REPO: NO  HTTP {st} {body[:120]}")

asyncio.run(main())
