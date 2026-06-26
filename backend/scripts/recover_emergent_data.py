"""
One-off recovery tool: copy projects, chat history and related data from the
OLD Emergent MongoDB into the NEW Atlas database.

This is SAFE to run repeatedly:
  - It never deletes anything.
  - It upserts documents by their natural id, so re-running just refreshes.

Usage
-----
1. Inspect only (no writes) -- run this FIRST once Emergent grants access:
       python scripts/recover_emergent_data.py --inspect

2. Copy everything across:
       python scripts/recover_emergent_data.py --copy

3. Copy only specific collections:
       python scripts/recover_emergent_data.py --copy --only deploy_projects,projects

Environment variables required
------------------------------
  OLD_EMERGENT_MONGO_URL : full connection string for the old Emergent cluster
  OLD_EMERGENT_DB_NAME   : (optional) old database name. If omitted, the script
                           auto-detects the non-system database that actually
                           contains your data.
  MONGO_URL              : new Atlas connection string (target)
  DB_NAME                : new database name (defaults to 'tbctools')
"""

import argparse
import os
import sys

from pymongo import MongoClient, UpdateOne

# Collections that hold your projects + the work behind them.
# Ordered so that parents are copied before children where it matters.
DATA_COLLECTIONS = [
    "deploy_projects",
    "projects",
    "ai_build_plans",
    "chat_sessions",
    "chat_messages",
]

# Also offered, but copied only when explicitly requested via --include-accounts,
# because the new DB already has a working operator/user set up.
ACCOUNT_COLLECTIONS = [
    "users",
    "settings",
]

SYSTEM_DBS = {"admin", "local", "config"}


def _natural_key(doc):
    """Pick the best stable id field to upsert on."""
    for k in ("id", "_id", "uuid", "session_id"):
        if k in doc and doc[k] is not None:
            return k
    return "_id"


def detect_old_db(client, explicit_name):
    if explicit_name:
        return explicit_name
    best_name, best_score = None, -1
    for name in client.list_database_names():
        if name in SYSTEM_DBS:
            continue
        db = client[name]
        score = 0
        for col in DATA_COLLECTIONS:
            try:
                score += db[col].estimated_document_count()
            except Exception:
                pass
        if score > best_score:
            best_name, best_score = name, score
    return best_name


def inspect(old_db):
    print(f"\n=== OLD database: '{old_db.name}' ===")
    all_cols = set(old_db.list_collection_names())
    grand_total = 0
    for col in DATA_COLLECTIONS + ACCOUNT_COLLECTIONS:
        if col not in all_cols:
            print(f"  {col:<18} (not present)")
            continue
        n = old_db[col].count_documents({})
        grand_total += n
        print(f"  {col:<18} {n}")
        # Show a few project titles so the user can recognise their work.
        if col in ("deploy_projects", "projects") and n:
            for d in old_db[col].find({}, {"title": 1, "name": 1, "status": 1}).limit(15):
                label = d.get("title") or d.get("name") or "(untitled)"
                print(f"        - {label}   [{d.get('status', '')}]")
    print(f"\n  total documents in data collections: {grand_total}")
    return grand_total


def copy(old_db, new_db, collections, include_accounts):
    targets = list(collections)
    if include_accounts:
        targets += ACCOUNT_COLLECTIONS
    old_cols = set(old_db.list_collection_names())
    for col in targets:
        if col not in old_cols:
            print(f"  {col}: skipped (not in old DB)")
            continue
        docs = list(old_db[col].find({}))
        if not docs:
            print(f"  {col}: 0 documents")
            continue
        ops = []
        for d in docs:
            key = _natural_key(d)
            ops.append(UpdateOne({key: d[key]}, {"$set": d}, upsert=True))
        res = new_db[col].bulk_write(ops, ordered=False)
        upserted = (res.upserted_count or 0)
        modified = (res.modified_count or 0)
        print(f"  {col}: {len(docs)} read -> {upserted} new, {modified} updated")
    print("\nDone. Your projects should now appear in the app after a refresh.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspect", action="store_true", help="report what is recoverable, no writes")
    ap.add_argument("--copy", action="store_true", help="copy data into the new DB")
    ap.add_argument("--only", default="", help="comma-separated subset of collections to copy")
    ap.add_argument("--include-accounts", action="store_true", help="also copy users + settings")
    args = ap.parse_args()

    old_url = os.environ.get("OLD_EMERGENT_MONGO_URL")
    new_url = os.environ.get("MONGO_URL")
    new_name = os.environ.get("DB_NAME", "tbctools")
    if not old_url:
        sys.exit("OLD_EMERGENT_MONGO_URL is not set.")
    if args.copy and not new_url:
        sys.exit("MONGO_URL (target) is not set.")

    old_client = MongoClient(old_url, serverSelectionTimeoutMS=20000)
    old_name = detect_old_db(old_client, os.environ.get("OLD_EMERGENT_DB_NAME"))
    if not old_name:
        sys.exit("Could not find a non-system database in the old cluster.")
    old_db = old_client[old_name]

    total = inspect(old_db)

    if args.copy:
        if total == 0:
            sys.exit("\nNothing to copy (no documents found). Aborting.")
        only = [c.strip() for c in args.only.split(",") if c.strip()] or DATA_COLLECTIONS
        new_db = MongoClient(new_url, serverSelectionTimeoutMS=20000)[new_name]
        print(f"\n=== Copying into NEW database: '{new_name}' ===")
        copy(old_db, new_db, only, args.include_accounts)
    elif not args.inspect:
        print("\n(no action taken -- pass --inspect or --copy)")


if __name__ == "__main__":
    main()
