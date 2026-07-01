"""Non-destructive restore from a local JSON snapshot into the live MongoDB.

Reads MONGO_URL / DB_NAME from the environment and upserts every document
from the snapshot into its collection. It NEVER drops collections and NEVER
deletes documents. Existing documents are matched by their `id` field and
updated in place; new ones are inserted.

Usage:
    python scripts/restore_from_backup.py [path-to-snapshot.json] [--dry-run]
"""
import glob
import json
import os
import sys
from datetime import datetime, timezone

from pymongo import MongoClient, UpdateOne

# Collections we know how to restore from the snapshot format.
RESTORABLE = [
    "deploy_projects",
    "promo_codes",
    "kyc_bypass_emails",
    "vanished_emails",
]

# Singleton collections: the whole collection is one logical doc identified
# by a fixed _id. The snapshot may contain duplicates; we collapse them into
# a single upsert. Maps collection name -> fixed _id (per the backend code).
SINGLETONS = {
    "app_settings": "main",  # app_settings_ext.py reads _id='main'
}

# Flat-array exports (one file == one collection), e.g. the AI learnings
# recovered from Emergent. Maps collection name -> glob pattern.
FLAT_EXPORTS = {
    "ai_learnings": "data/backups/ai_learnings-*.json",
}

# Fields that must be stored as real datetimes, not ISO strings, so the
# backend's date handling and sorting keep working exactly as before.
_DATE_FIELDS = ("created_at", "updated_at")


def _coerce_dates(doc):
    """Convert ISO-8601 date strings into timezone-aware datetimes."""
    for field in _DATE_FIELDS:
        val = doc.get(field)
        if isinstance(val, str):
            try:
                dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                doc[field] = dt
            except ValueError:
                pass
    return doc


def seed_flat_exports(db, dry_run):
    """Restore flat-array collections (e.g. ai_learnings) by upserting on id."""
    for coll_name, pattern in FLAT_EXPORTS.items():
        files = sorted(glob.glob(pattern))
        if not files:
            print(f"  {coll_name}: no export file matching {pattern}, skipping")
            continue
        path = files[-1]
        with open(path) as f:
            docs = json.load(f)
        if not isinstance(docs, list) or not docs:
            print(f"  {coll_name}: {path} is empty, skipping")
            continue

        ops = [
            UpdateOne({"id": d["id"]}, {"$set": _coerce_dates(d)}, upsert=True)
            for d in docs
            if "id" in d
        ]
        if dry_run:
            print(f"  {coll_name}: would upsert {len(ops)} docs from {path}")
            continue
        if ops:
            result = db[coll_name].bulk_write(ops, ordered=False)
            print(
                f"  {coll_name}: matched={result.matched_count} "
                f"upserted={result.upserted_count} modified={result.modified_count} "
                f"(from {path})"
            )


def pick_snapshot(arg_path):
    if arg_path and not arg_path.startswith("--"):
        return arg_path
    candidates = sorted(glob.glob("data/backups/snapshot-*.json"))
    if not candidates:
        sys.exit("No snapshot files found in data/backups/")
    return candidates[-1]


def key_for(doc):
    """Return the field used to match an existing document."""
    for field in ("id", "_id", "email", "key", "code"):
        if field in doc:
            return field, doc[field]
    return None, None


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    snapshot_path = pick_snapshot(args[0] if args else None)

    with open(snapshot_path) as f:
        snapshot = json.load(f)

    print(f"Snapshot: {snapshot_path}")
    print(f"Exported at: {snapshot.get('exported_at')}\n")

    client = MongoClient(os.environ["MONGO_URL"], serverSelectionTimeoutMS=10000)
    client.admin.command("ping")  # fail fast on bad auth / network
    db = client[os.environ["DB_NAME"]]

    for coll_name in RESTORABLE:
        docs = snapshot.get(coll_name) or []
        if not docs:
            print(f"  {coll_name}: nothing in snapshot, skipping")
            continue

        ops = []
        skipped = 0
        for doc in docs:
            field, value = key_for(doc)
            if field is None:
                skipped += 1
                continue
            ops.append(UpdateOne({field: value}, {"$set": doc}, upsert=True))

        if dry_run:
            print(f"  {coll_name}: would upsert {len(ops)} docs ({skipped} skipped)")
            continue

        if ops:
            result = db[coll_name].bulk_write(ops, ordered=False)
            print(
                f"  {coll_name}: matched={result.matched_count} "
                f"upserted={result.upserted_count} modified={result.modified_count} "
                f"({skipped} skipped)"
            )

    print("\nSingleton settings:")
    for coll_name, fixed_id in SINGLETONS.items():
        docs = snapshot.get(coll_name) or []
        if not docs:
            print(f"  {coll_name}: nothing in snapshot, skipping")
            continue
        # All copies are identical; take the last one and drop any stored _id.
        merged = dict(docs[-1])
        merged.pop("_id", None)
        if dry_run:
            print(f"  {coll_name}: would upsert 1 doc as _id='{fixed_id}' "
                  f"(collapsed from {len(docs)} copies)")
        else:
            db[coll_name].update_one(
                {"_id": fixed_id}, {"$set": merged}, upsert=True
            )
            print(f"  {coll_name}: upserted _id='{fixed_id}' "
                  f"(collapsed from {len(docs)} copies)")

    print("\nAI learnings + other flat exports:")
    seed_flat_exports(db, dry_run)

    client.close()
    print("\nDone." if not dry_run else "\nDry run complete (no writes).")


if __name__ == "__main__":
    main()
