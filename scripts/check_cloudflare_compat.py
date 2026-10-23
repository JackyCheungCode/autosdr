"""Diagnostic for the legacy Python app; not a Cloudflare runtime certification."""
from __future__ import annotations

import importlib.util
import sys

MODULES = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "pydantic": "pydantic",
    "httpx": "httpx",
    "bs4": "beautifulsoup4",
    "pypdf": "pypdf",
    "numpy": "numpy",
    "dotenv": "python-dotenv",
    "openai": "openai",
    "apscheduler": "apscheduler",
    "multipart": "python-multipart",
    "psycopg": "psycopg[binary]",
}

ARCHITECTURE_BLOCKERS = [
    "The Python app has a psycopg adapter; a live Supabase connection and Cloudflare Worker business-route port remain unverified.",
    "APScheduler BackgroundScheduler is a long-running process model, not a Worker scheduler.",
    "Local upload paths and SQLite files are not durable Worker storage.",
    "SSE currently relies on an in-process event bus; reconnect and cross-instance state need redesign.",
    "IMAP/SMTP network behavior and every native/third-party dependency need runtime-specific tests.",
]

def main() -> int:
    missing = []
    print("Python dependency import availability (environment only):")
    for module, package in MODULES.items():
        available = importlib.util.find_spec(module) is not None
        print(f"  {'OK' if available else 'MISSING':7} {module} (package: {package})")
        if not available:
            missing.append(package)
    print("\nKnown architecture blockers (these are not package import failures):")
    for item in ARCHITECTURE_BLOCKERS:
        print(f"  BLOCKER: {item}")
    print("\nThis diagnostic does not certify Cloudflare Workers compatibility.")
    if missing:
        print(f"Missing packages: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
