"""Event bus: every agent action -> SQLite (audit) + live SSE queues (trace panel).

This is the spine of the demo: judges see plans, tool calls, decisions,
retries, token spend — live. Nothing the system does is invisible.
"""
import asyncio
import json
from typing import Any

from . import db

_subscribers: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop):
    global _loop
    _loop = loop


def emit(agent: str, type_: str, label: str, payload: Any = None, lead_id: str | None = None):
    """Thread-safe: callable from worker threads and async code alike."""
    evt = {
        "ts": db.now(),
        "agent": agent,
        "type": type_,          # plan|step|tool_call|tool_result|decision|error|retry|email|whatsapp|memory|cost|stage
        "label": label,
        "lead_id": lead_id,
        "payload": payload,
    }
    with db.tx() as c:
        cur = c.execute(
            "INSERT INTO events (ts,agent,type,label,lead_id,payload) VALUES (?,?,?,?,?,?) RETURNING seq",
            (evt["ts"], agent, type_, label, lead_id, json.dumps(payload, default=str)),
        )
        evt["seq"] = cur.fetchone()["seq"]
    if _loop is not None:
        _loop.call_soon_threadsafe(_fanout, evt)
    return evt


def _fanout(evt: dict):
    dead = []
    for q in _subscribers:
        try:
            q.put_nowait(evt)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _subscribers.discard(q)


def subscribe() -> asyncio.Queue:
    q = asyncio.Queue(maxsize=1000)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue):
    _subscribers.discard(q)


def recent(limit: int = 200) -> list[dict]:
    evts = db.rows("SELECT * FROM events ORDER BY seq DESC LIMIT ?", (limit,))
    for e in evts:
        e["payload"] = json.loads(e["payload"]) if e["payload"] else None
    return list(reversed(evts))
