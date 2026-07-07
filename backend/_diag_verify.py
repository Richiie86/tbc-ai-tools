import asyncio, os, sys, time, json
import urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(__file__))

async def main():
    # Read the DECRYPTED token exactly the way the server does.
    try:
        from payments_ext import get_settings_doc
        doc = await get_settings_doc()
    except Exception:
        doc = None
        # Fallback: read settings doc directly through the secure collection.
        try:
            from db import db
            doc = await db.settings.find_one({"_id": "payment_settings"})
        except Exception as e:
            print("DIAG_ERR could not load settings:", repr(e)[:200])
            return

    token = (doc or {}).get("github_token") or ""
    if not token:
        print("RESULT token present: NO — nothing saved in github_token field")
        return

    prefix = token[:4]
    kind = "classic (ghp_)" if token.startswith("ghp_") else (
        "fine-grained (github_pat_)" if token.startswith("github_pat_") else f"other ({prefix}…)")
    print(f"token present: YES  len={len(token)}  type={kind}")

    def gh(method, path, body=None):
        url = "https://api.github.com" + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "tbctools-diag")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, dict(r.headers), r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode()

    st, hdrs, _ = gh("GET", "/user")
    login = None
    if st == 200:
        try: login = json.loads(_).get("login")
        except Exception: pass
    scopes = hdrs.get("x-oauth-scopes", "")
    print(f"auth: HTTP {st}  login={login}  scopes=[{scopes}]")

    # The decisive test: create a throwaway repo, then delete it.
    name = f"tbc-token-check-{int(time.time())}"
    st, _h, body = gh("POST", "/user/repos", {"name": name, "private": True, "auto_init": False})
    if st in (200, 201):
        print("CREATE REPO: YES ✅  (new-app deploys will work)")
        ds, _dh, _db = gh("DELETE", f"/repos/{login}/{name}")
        print(f"cleanup delete: HTTP {ds} ({'ok' if ds==204 else 'left behind — delete manually'})")
    else:
        short = (body or "")[:160].replace("\n", " ")
        print(f"CREATE REPO: NO ❌  HTTP {st}  {short}")

asyncio.run(main())
