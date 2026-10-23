"""Idempotent SQLite -> Supabase REST importer for a staging project.

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
Nothing is written unless --apply is passed. Use a disposable/staging project.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

import httpx

TABLES = (
    "leads",
    "contacts",
    "evidence",
    "messages",
    "meetings",
    "followups",
    "events",
    "kb_chunks",
    "memory_notes",
    "kv",
)
CONFLICT_KEYS = {"events": "seq", "kv": "k"}
BATCH_SIZE = 100


def json_safe(value: Any) -> Any:
    # PostgreSQL bytea text input accepted by PostgREST.
    if isinstance(value, (bytes, bytearray, memoryview)):
        return chr(92) + "x" + bytes(value).hex()
    return value


def read_rows(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    connection.row_factory = sqlite3.Row
    try:
        return [
            {key: json_safe(value) for key, value in dict(row).items()}
            for row in connection.execute(f'SELECT * FROM "{table}"').fetchall()
        ]
    except sqlite3.OperationalError as exc:
        raise RuntimeError(f"Source SQLite table {table!r} is missing: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default="data/autosdr.db",
        help="Path to a backed-up AutoSDR SQLite database (default: data/autosdr.db)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write rows to Supabase; without this flag the script only reports counts.",
    )
    args = parser.parse_args()
    source = Path(args.source)
    if not source.is_file():
        print(f"SQLite database not found: {source}", file=sys.stderr)
        return 2

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if args.apply and (not supabase_url or not service_key):
        print(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.",
            file=sys.stderr,
        )
        return 2

    with sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True) as db:
        source_rows = {table: read_rows(db, table) for table in TABLES}

    print(f"Source: {source.resolve()}")
    print("Mode:", "APPLY (writes enabled)" if args.apply else "DRY RUN (no writes)")
    for table, rows in source_rows.items():
        print(f"  {table}: {len(rows)} rows")

    if not args.apply:
        print("\nDry run complete. Review the counts and take a database backup before --apply.")
        return 0

    headers = {
        "apikey": service_key,
        "authorization": f"Bearer {service_key}",
        "content-type": "application/json",
        "prefer": "resolution=merge-duplicates,return=minimal",
    }
    try:
        with httpx.Client(timeout=60.0, headers=headers) as client:
            for table, rows in source_rows.items():
                if not rows:
                    continue
                conflict_key = CONFLICT_KEYS.get(table, "id")
                url = f"{supabase_url}/rest/v1/{table}"
                for start in range(0, len(rows), BATCH_SIZE):
                    batch = rows[start : start + BATCH_SIZE]
                    response = client.post(
                        url,
                        params={"on_conflict": conflict_key},
                        json=batch,
                    )
                    if response.is_error:
                        raise RuntimeError(
                            f"Supabase import failed for {table} rows "
                            f"{start + 1}-{start + len(batch)}: "
                            f"HTTP {response.status_code}: {response.text[:500]}"
                        )
                    print(f"  imported {table}: {min(start + len(batch), len(rows))}/{len(rows)}")
    except (httpx.HTTPError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        print(
            "Some earlier batches may already have been written. The importer uses "
            "primary-key upserts, so fix the error and rerun against the same staging "
            "project to continue.",
            file=sys.stderr,
        )
        return 1

    print("\nImport requests completed. Verify row counts in Supabase before cutover.")
    print(
        "Because events.seq is imported explicitly, run this in the Supabase SQL Editor "
        "after import to advance its sequence:\n"
        "select setval(pg_get_serial_sequence('public.events','seq'), "
        "coalesce((select max(seq) from public.events), 1), "
        "(select max(seq) is not null from public.events));"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
