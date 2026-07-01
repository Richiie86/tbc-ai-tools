"""Read-only comparison of the OLD Emergent source DB and the current DB.

Reads connection info from env vars only. Performs NO writes.
"""
import os
from pymongo import MongoClient


def summarize(label, url_key, name_key):
    url = os.environ.get(url_key)
    name = os.environ.get(name_key)
    print(f"\n=== {label} ({url_key} -> db '{name}') ===")
    if not url or not name:
        print(f"  MISSING env: url={bool(url)} name={bool(name)}")
        return {}
    try:
        client = MongoClient(url, serverSelectionTimeoutMS=8000)
        db = client[name]
        counts = {}
        for coll in sorted(db.list_collection_names()):
            counts[coll] = db[coll].estimated_document_count()
        if not counts:
            print("  (no collections)")
        for coll, c in counts.items():
            print(f"  {coll:<40} {c:>8} docs")
        client.close()
        return counts
    except Exception as e:
        print(f"  ERROR connecting: {type(e).__name__}: {e}")
        return {}


src = summarize("OLD Emergent source", "SOURCE_MONGO_URL", "SOURCE_DB_NAME")
cur = summarize("CURRENT (live)", "MONGO_URL", "DB_NAME")

print("\n=== DIFF (collections only in source, or with more docs in source) ===")
for coll, c in sorted(src.items()):
    cur_c = cur.get(coll, 0)
    flag = ""
    if coll not in cur:
        flag = "  <-- MISSING in current"
    elif c > cur_c:
        flag = f"  <-- source has {c - cur_c} more"
    print(f"  {coll:<40} source={c:>8}  current={cur_c:>8}{flag}")
