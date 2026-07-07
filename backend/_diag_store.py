import asyncio, os, sys
sys.path.insert(0, os.path.dirname(__file__))

async def main():
    from db import db
    doc = await db.settings.find_one({"_id": "payment_settings"})
    if not doc:
        print("no settings doc"); return

    gt = doc.get("github_token") or ""
    def kind(t):
        if not t: return "EMPTY"
        if t.startswith("ghp_"): return "classic (ghp_)"
        if t.startswith("github_pat_"): return "fine-grained (github_pat_)"
        return f"other ({t[:4]}…)"
    print(f"github_token slot: {kind(gt)}  len={len(gt)}")

    ck = doc.get("custom_keys") or []
    print(f"custom_keys count: {len(ck)}")
    for e in ck:
        val = e.get("value") or ""
        print(f"  - name={e.get('name')!r} id={e.get('id')} env={e.get('env')!r} valtype={kind(val)} len={len(val)}")

asyncio.run(main())
