"""SQLite/PostgreSQL persistence adapter for the existing AutoSDR query helpers.

Set DATABASE_URL to use Supabase PostgreSQL. Apply the checked-in SQL migration
before starting the app. Without DATABASE_URL, the local SQLite backend remains
the default for development.
"""
import json
import re
import sqlite3
import time
import uuid
import threading
from contextlib import contextmanager

from .config import DATABASE_URL, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, website TEXT,
  location TEXT, industry TEXT, size_hint TEXT, source TEXT,
  stage TEXT NOT NULL DEFAULT 'discovered',
  score INTEGER, score_reasons TEXT, service TEXT, research TEXT,
  created_ts REAL, updated_ts REAL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, name TEXT, role TEXT,
  email TEXT, email_status TEXT, source TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, kind TEXT, url TEXT,
  quote TEXT, meta TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, lead_id TEXT, contact_id TEXT,
  direction TEXT NOT NULL, channel TEXT NOT NULL,
  subject TEXT, body TEXT, meta TEXT, status TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, lead_id TEXT, contact_id TEXT,
  time_utc REAL, link TEXT, status TEXT, briefing TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY, lead_id TEXT, due_ts REAL, kind TEXT,
  status TEXT DEFAULT 'scheduled', meta TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, agent TEXT, type TEXT,
  label TEXT, lead_id TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY, doc TEXT, idx INTEGER, text TEXT, embedding BLOB
);
CREATE TABLE IF NOT EXISTS memory_notes (
  id TEXT PRIMARY KEY, lead_id TEXT, kind TEXT, note TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""

STAGES = [
    "discovered", "potential", "researching", "qualified", "contacted",
    "interested", "meeting_scheduled", "converted",
    "not_qualified", "not_interested", "do_not_contact",
]

_conn = None
_lock = threading.RLock()
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _connect_sqlite():
    connection = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def _connect_postgres():
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError(
            "DATABASE_URL is set but psycopg is not installed; install requirements.txt"
        ) from exc

    dsn = DATABASE_URL
    if dsn.startswith("postgres://"):
        dsn = "postgresql://" + dsn[len("postgres://"):]
    if "sslmode=" not in dsn:
        dsn += ("&" if "?" in dsn else "?") + "sslmode=require"
    # Use normal transactions: tx() commits writes atomically, while rows()/one()
    # commit their standalone read transaction before returning.
    connection = psycopg.connect(dsn, row_factory=dict_row)
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('public.leads') AS table_name")
            if not cur.fetchone()["table_name"]:
                raise RuntimeError(
                    "Supabase schema is missing: apply "
                    "supabase/migrations/20261023000100_autosdr_initial_schema.sql first"
                )
        connection.commit()
    except Exception:
        connection.close()
        raise
    return connection


def _convert_placeholders(sql: str) -> str:
    """Convert SQLite ? placeholders to psycopg %s, ignoring quoted text/comments."""
    out = []
    i = 0
    quote = None
    while i < len(sql):
        ch = sql[i]
        if quote:
            out.append(ch)
            if ch == quote:
                # SQL escapes quote characters by doubling them.
                if i + 1 < len(sql) and sql[i + 1] == quote:
                    out.append(sql[i + 1])
                    i += 1
                else:
                    quote = None
            elif ch == "\\\\" and quote == "'":
                # Be conservative with backslash-escaped strings.
                if i + 1 < len(sql):
                    out.append(sql[i + 1])
                    i += 1
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
        elif ch == "-" and i + 1 < len(sql) and sql[i + 1] == "-":
            end = sql.find("\n", i)
            if end < 0:
                out.append(sql[i:])
                break
            out.append(sql[i:end + 1])
            i = end
        elif ch == "/" and i + 1 < len(sql) and sql[i + 1] == "*":
            end = sql.find("*/", i + 2)
            if end < 0:
                out.append(sql[i:])
                break
            out.append(sql[i:end + 2])
            i = end + 1
        elif ch == "?":
            out.append("%s")
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def conn():
    """Return the process-wide connection, initializing SQLite only when needed."""
    global _conn
    with _lock:
        if _conn is None:
            if DATABASE_URL:
                _conn = _connect_postgres()
            else:
                _conn = _connect_sqlite()
                _conn.executescript(SCHEMA)
                _conn.commit()
        return _conn


@contextmanager
def tx():
    """Serialize access to the shared connection and commit or roll back atomically."""
    with _lock:
        c = conn()
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def now() -> float:
    return time.time()


def _ident(name: str) -> str:
    if not _IDENTIFIER.fullmatch(name):
        raise ValueError(f"invalid SQL identifier: {name!r}")
    return name


def _execute(connection, sql: str, args=()):
    if DATABASE_URL:
        sql = _convert_placeholders(sql)
    return connection.execute(sql, args)


def execute(connection, sql: str, args=()):
    """Execute a query through the backend-specific placeholder adapter."""
    return _execute(connection, sql, args)


def insert(table: str, row: dict) -> str:
    table = _ident(table)
    row = dict(row)
    row.setdefault("id", new_id())
    keys = [_ident(k) for k in row]
    columns = ",".join(keys)
    placeholders = ",".join("?" for _ in keys)
    with tx() as c:
        _execute(c, f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", list(row.values()))
    return row["id"]


def update(table: str, id_: str, fields: dict):
    table = _ident(table)
    if not fields:
        return
    keys = [_ident(k) for k in fields]
    sets = ",".join(f"{k}=?" for k in keys)
    with tx() as c:
        _execute(c, f"UPDATE {table} SET {sets} WHERE id=?", [*fields.values(), id_])


def rows(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        connection = conn()
        try:
            result = [dict(r) for r in _execute(connection, sql, args).fetchall()]
            if DATABASE_URL:
                connection.commit()
            return result
        except Exception:
            if DATABASE_URL:
                connection.rollback()
            raise


def one(sql: str, args: tuple = ()) -> dict | None:
    with _lock:
        connection = conn()
        try:
            row = _execute(connection, sql, args).fetchone()
            if DATABASE_URL:
                connection.commit()
            return dict(row) if row else None
        except Exception:
            if DATABASE_URL:
                connection.rollback()
            raise


def kv_get(k: str, default=None):
    r = one("SELECT v FROM kv WHERE k=?", (k,))
    return json.loads(r["v"]) if r else default


def kv_set(k: str, v):
    with tx() as c:
        _execute(
            c,
            "INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (k, json.dumps(v)),
        )


def set_stage(lead_id: str, stage: str):
    assert stage in STAGES, f"bad stage {stage}"
    update("leads", lead_id, {"stage": stage, "updated_ts": now()})
