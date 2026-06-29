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

from pymongo import MongoClient, UpdateOne

# Collections we know how to restore from the snapshot format.
RESTORABLE = [
    "deploy_projects",
    "app_settings",
    "promo_codes",
    "kyc_bypass_emails",
    "vanished_emails",
]


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

    client.close()
    print("\nDone." if not dry_run else "\nDry run complete (no writes).")


if __name__ == "__main__":
    main()
