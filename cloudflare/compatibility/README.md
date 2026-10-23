# Cloudflare compatibility gates

This folder records evidence required before calling the Cloudflare migration complete.

## Initial findings from the current source

| Area | Current implementation | Cloudflare target | Status |
|---|---|---|---|
| HTTP API | FastAPI in `app/main.py` | Worker handlers or a separately validated Python Workers deployment | Not migrated |
| Persistence | `sqlite3`, one module-level connection, SQLite SQL placeholders and PRAGMA | Supabase PostgreSQL through server-side REST or a validated PostgreSQL connection path | Schema draft added; adapter not migrated |
| Follow-ups and inbox polling | APScheduler background daemon in `app/scheduler.py` | Cron Trigger + durable job processing; idempotency required | Not migrated |
| PDF ingestion | `pypdf` and upload-to-local-disk flow | Validate package support and replace local disk with object storage or bounded in-memory processing | Not validated |
| RAG | NumPy embeddings serialized as SQLite BLOB | Preserve bytes initially; confirm model/dimension before pgvector migration | Not migrated |
| SSE | FastAPI `StreamingResponse` and in-process event bus | Validate Worker streaming limits and replace process-local event bus for durable/shared state | Not migrated |
| Email/IMAP | SMTP/IMAP libraries and polling | Outbound email provider/API plus scheduled inbox integration; raw IMAP support is not assumed | Not migrated |
| Static frontend | `app/static/index.html`, `book.html` | Cloudflare Pages static deployment | Deployment instructions added separately |

## How to run checks

From `cloudflare/worker`:

```sh
npm test
```

The test suite validates only the Worker bootstrap, health status, CORS guard, and explicit 501 response for routes not yet ported. It does **not** validate a live Supabase connection or the original AutoSDR business workflow.

From the repository root, run `python -m compileall -q app` after installing `requirements.txt`. The GitHub Actions workflow performs this Python syntax/import-dependency check. It does not prove the Python packages can run inside Cloudflare Workers.

## Required release gates

- [ ] Create a disposable Supabase project and apply the migration.
- [ ] Implement and test the PostgreSQL adapter, including transaction rollback and query placeholder conversion.
- [ ] Test RLS and verify the service-role key is only stored as a Worker secret.
- [ ] Port API routes and add contract tests against the existing frontend.
- [ ] Move scheduler work to durable scheduled jobs with retries and idempotency.
- [ ] Verify PDF upload, RAG retrieval, SSE reconnect/keepalive, bookings, email simulation, and data persistence.
- [ ] Deploy Pages and Worker to a staging environment and run end-to-end tests before production.
