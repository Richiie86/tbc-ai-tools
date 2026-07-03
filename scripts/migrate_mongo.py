#!/usr/bin/env python3
"""
One-time data migration: copy every collection from the OLD MongoDB
(the old source database) into the NEW MongoDB Atlas database.

It is SAFE to run more than once: by default it only copies a collection if
the destination collection is empty, so it won't duplicate data. Use
--overwrite to force a clean re-copy (drops the destination collection first).

Required environment variables:
  OLD_MONGO_URL   full connection string of the CURRENT/old database
  MONGO_URL       full connection string of the NEW Atlas database
  DB_NAME         database name to copy into on the new side (e.g. tbctools)
  OLD_DB_NAME     (optional) source db name if different from DB_NAME

Usage:
  set -a && source /vercel/share/.env.project && set +a
  python3 scripts/migrate_mongo.py            # safe copy (skips non-empty)
  python3 scripts/migrate_mongo.py --overwrite  # force clean re-copy
"""
import os
import sys
from pymongo import MongoClient
from pymongo.errors import PyMongoError

BATCH = 1000


def _db_name_from_uri(uri: str, fallback: str) -> str:
    """Pull the db name out of a mongodb URI path, else use fallback."""
    try:
        tail = uri.split('/', 3)[3] if uri.count('/') >= 3 else ''
        name = tail.split('?', 1)[0].strip()
        return name or fallback
    except Exception:
        return fallback


def main() -> int:
    overwrite = '--overwrite' in sys.argv

    old_uri = os.environ.get('OLD_MONGO_URL', '').strip()
    new_uri = os.environ.get('MONGO_URL', '').strip()
    new_db_name = os.environ.get('DB_NAME', 'tbctools').strip()
    old_db_name = os.environ.get('OLD_DB_NAME', '').strip() or _db_name_from_uri(old_uri, new_db_name)

    if not old_uri:
        print('ERROR: OLD_MONGO_URL is not set (the old/source database).')
        return 1
    if not new_uri:
        print('ERROR: MONGO_URL is not set (the new Atlas database).')
        return 1

    print(f'Source DB name: {old_db_name}')
    print(f'Target DB name: {new_db_name}')
    print(f'Mode: {"OVERWRITE" if overwrite else "SAFE (skip non-empty)"}')
    print('-' * 50)

    try:
        src = MongoClient(old_uri, serverSelectionTimeoutMS=15000)
        dst = MongoClient(new_uri, serverSelectionTimeoutMS=15000)
        src.admin.command('ping')
        dst.admin.command('ping')
    except PyMongoError as e:
        print(f'ERROR connecting: {type(e).__name__}: {str(e)[:300]}')
        return 1

    sdb = src[old_db_name]
    ddb = dst[new_db_name]

    collections = [c for c in sdb.list_collection_names() if not c.startswith('system.')]
    if not collections:
        print('No collections found in the source database — nothing to migrate.')
        return 0

    print(f'Found {len(collections)} collection(s): {", ".join(collections)}')
    print('-' * 50)

    total_docs = 0
    for name in collections:
        src_col = sdb[name]
        dst_col = ddb[name]
        src_count = src_col.estimated_document_count()
        dst_count = dst_col.estimated_document_count()

        if dst_count > 0 and not overwrite:
            print(f'SKIP  {name}: destination already has {dst_count} docs (use --overwrite to replace)')
            continue
        if overwrite and dst_count > 0:
            dst_col.drop()
            print(f'DROP  {name}: cleared {dst_count} existing docs')

        copied = 0
        batch = []
        for doc in src_col.find({}):
            batch.append(doc)
            if len(batch) >= BATCH:
                dst_col.insert_many(batch, ordered=False)
                copied += len(batch)
                batch = []
        if batch:
            dst_col.insert_many(batch, ordered=False)
            copied += len(batch)

        total_docs += copied
        print(f'COPY  {name}: {copied}/{src_count} docs migrated')

    print('-' * 50)
    print(f'DONE. Migrated {total_docs} documents into "{new_db_name}".')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
