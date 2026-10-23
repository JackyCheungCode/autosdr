# Cloudflare compatibility gates

This folder records evidence required before calling the Cloudflare migration complete.

## Initial findings from the current source

| Area | Current implementation | Cloudflare target | Status |
|---|---|---|---|
| HTTP API | FastAPI in `app/main.py` | Worker handlers or a separately validated Python Workers deployment | Read-only state/stats/memory/outbox/lead-detail routes added; write actions and SSE remain unported; shared Pages-to-Worker token required |
| Persistence | SQLite locally or psycopg PostgreSQL when `DATABASE_URL` is set; shared query helper converts placeholders | Supabase PostgreSQL using a server-side connection URL | Adapter implemented; local tests added, live Supabase connection not verified |
| Follow-ups and inbox polling | APScheduler background daemon in `app/scheduler.py` | Cron Trigger + durable job processing; idempotency required | Not migrated |
| PDF ingestion | `pypdf` and upload-to-local-disk flow | Validate package support and replace local disk with object storage or bounded in-memory processing | Not validated |
| RAG | NumPy embeddings serialized as SQLite BLOB | Preserve bytes initially; confirm model/dimension before pgvector migration | Not migrated |
| SSE | FastAPI `StreamingResponse` and in-process event bus | Validate Worker streaming limits and replace process-local event bus for durable/shared state | Not migrated |
| Email/IMAP | SMTP/IMAP libraries and polling | Outbound email provider/API plus scheduled inbox integration; raw IMAP support is not assumed | Not migrated |
| Static frontend | `app/static/index.html`, `book.html` call relative `/api/*` routes | Cloudflare Pages static deployment plus a same-origin Pages Function proxy to the Worker | Proxy scaffold added; not yet tested in a deployed Pages project |

## How to run checks

From `cloudflare/worker`:

```sh
npm test
```

The test suite validates Worker health/error handling, trusted Pages proxy token enforcement, CORS, read-only state/stats/lead detail using mocked Supabase REST responses, plus the explicit 501 response for unported routes. It does **not** validate a live Supabase project or the original AutoSDR business workflow.

From the repository root, run `python -m compileall -q app` after installing `requirements.txt`. The GitHub Actions workflow performs this Python syntax/import-dependency check. It does not prove the Python packages can run inside Cloudflare Workers.

## Required release gates

- [ ] Create a disposable Supabase project and apply the migration.
- [x] Implement the dual SQLite/PostgreSQL adapter and add local regression tests for transaction rollback, placeholder conversion, event sequence, KV JSON and embedding bytes.
- [ ] Run tests in CI and verify against a disposable Supabase project; local adapter tests do not validate a live PostgreSQL connection.
- [ ] Test RLS and verify the service-role key is only stored as a Worker secret.
- [ ] Configure Cloudflare Access on Pages before exposing lead/contact data; the proxy token is service-to-service protection, not user authentication.
- [ ] Port write/action routes and SSE, then add contract tests against the existing frontend. Read-only routes have unit tests with mocked Supabase REST responses.
- [ ] Move scheduler work to durable scheduled jobs with retries and idempotency.
- [ ] Verify PDF upload, RAG retrieval, SSE reconnect/keepalive, bookings, email simulation, and data persistence.
- [ ] Deploy Pages and Worker to a staging environment and run end-to-end tests before production.
