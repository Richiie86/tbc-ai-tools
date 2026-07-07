import asyncio, os

async def main():
    from payments_ext import get_db
    db = await get_db()
    doc = await db.settings.find_one({'_id': 'payment_settings'}) or {}
    print("=== dedicated AI key fields (what the router reads) ===")
    for f in ['anthropic_api_key','openai_api_key','gemini_api_key','openrouter_api_key','groq_api_key']:
        v = doc.get(f)
        setv = bool(isinstance(v,str) and v.strip())
        print(f"{f}: {'SET' if setv else 'empty'}")
    ck = doc.get('custom_keys') or []
    print(f"\n=== custom_keys entries: {len(ck)} ===")
    for k in ck:
        name = k.get('name','?')
        val = k.get('value') or k.get('secret') or ''
        # value is encrypted; just show length + name to spot misfiled AI keys
        print(f"name={name!r}  enc_len={len(val) if isinstance(val,str) else 'n/a'}")
    print("\n=== env vars present ===")
    for e in ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','OPENROUTER_API_KEY']:
        print(f"{e}: {'SET' if os.environ.get(e) else 'empty'}")

asyncio.run(main())
