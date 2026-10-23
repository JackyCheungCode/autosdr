# Cloudflare Pages + Worker staging setup

This is an incremental deployment scaffold, not a completed port of the FastAPI app.

## 1. Supabase

1. Create a **new/disposable** Supabase project for staging; do not point this at an existing production database yet.
2. In the Supabase SQL Editor, apply `supabase/migrations/20261023000100_autosdr_initial_schema.sql`.
3. The migration enables RLS and grants table access only to `service_role`. Browser keys must not be used for server-side data access.
4. The migration retains embedding data as `BYTEA` until the current embedding model and vector dimension are confirmed.

## 1a. Python/FastAPI PostgreSQL adapter (separate from the Worker)

The legacy Python application can use Supabase PostgreSQL by setting a server-side `DATABASE_URL` connection string (use the Supabase PostgreSQL connection details and TLS). Install `requirements.txt`, apply the SQL migration first, then run the FastAPI app in a Python-compatible host. If `DATABASE_URL` is unset, the app continues to use local SQLite. Never put this URL or database password in frontend variables. This adapter does **not** make FastAPI routes run inside Cloudflare Workers; those routes still need a separate port. A real Supabase connection has not been tested from this repository.

## 1b. Import existing SQLite data (optional)

Make a copy of `data/autosdr.db` from the machine that currently runs AutoSDR. Install the existing Python requirements, then run a dry run first:

```sh
python scripts/migrate_sqlite_to_supabase.py --source data/autosdr.db
```

Only after reviewing the counts and backing up the staging database should you set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the shell environment and add `--apply`. The importer uses primary-key upserts and can partially write before an error; rerun only against the same staging project after resolving the error. Verify all table counts and run the printed `events.seq` sequence-fix SQL in Supabase before using the database. Do not point the first import at a production project.

## 2. Worker API

Install a current Wrangler CLI locally, then:

```sh
cd cloudflare/worker
npm test
npx wrangler dev --config wrangler.jsonc
```

Configure secrets for the Worker (never commit values):

```sh
npx wrangler secret put SUPABASE_URL --config wrangler.jsonc
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.jsonc
npx wrangler secret put API_PROXY_TOKEN --config wrangler.jsonc
```

Set `FRONTEND_ORIGIN` in `cloudflare/worker/wrangler.jsonc` to the exact Pages origin before deploying. The example value is local development only.

```sh
npx wrangler deploy --config wrangler.jsonc
```

The Worker requires the shared `API_PROXY_TOKEN` from the Pages Function for API access. Supabase-backed routes include `GET /api/health`, `/api/state`, `/api/stats`, `/api/memory`, `/api/outbox`, `/api/leads/:id`, `POST /api/settings/approval`, and `POST /api/outbox/:id/reject`. ICP generation is available through `POST /api/icp` when `company_profile` exists and `OPENAI_API_KEY` plus `OPENAI_MODEL` are configured as Worker secrets/variables; optionally set `OPENAI_BASE_URL` for an OpenAI-compatible endpoint. Configure the LLM key with `npx wrangler secret put OPENAI_API_KEY --config wrangler.jsonc` and set `OPENAI_MODEL` in Worker variables. Health performs a real database query. These routes require the migration to be applied and server-side secrets to be configured. Email sending for `POST /api/outbox/:id/approve` intentionally remains disabled (501); company upload/text, pipeline run/stop, reply simulation, booking actions, SSE, scheduler, and report/booking pages are not migrated and return explicit 501 for unported `/api/*` paths.

## 3. Pages static frontend

Create a Cloudflare Pages project with the repository connected to GitHub:

- Production branch: **do not select `cloudflare-supabase` as production yet**; use a preview/staging project until API porting and tests pass.
- Build command: leave empty for the current plain HTML frontend.
- Build output directory: `app/static`.
- Root directory: repository root.
- Set the Pages environment variable `API_WORKER_URL` to the deployed Worker origin (for example, the origin shown by Wrangler; do not include an API path). Set a Pages **secret** named `API_PROXY_TOKEN` to the same high-entropy random value configured as the Worker secret. The Pages Function adds this token server-side; it is never sent to the browser. The Pages Function at `functions/api/[[path]].js` proxies same-origin `/api/*` calls to that Worker, so the existing frontend URL pattern is preserved.
- Set Worker variable `FRONTEND_ORIGIN` to the exact Pages origin for CORS. Keep preview and production origins separate.\n- **Protect the Pages site with Cloudflare Access before using real lead/contact data.** The Pages proxy is not user authentication: without Access (or a future application login), anyone who can reach the site can call its same-origin API routes. CORS is not an access-control mechanism. Use test data until access protection is verified.
- Deploy preview builds from `cloudflare-supabase` to validate static assets.

The existing frontend calls FastAPI routes directly. The read-only dashboard endpoints are ported, but most mutating actions and streaming workflows still will not work against the Worker scaffold.

## 4. Current limitations

- Only a read-only subset of FastAPI routes has been ported; no pipeline or outreach mutations are implemented in Worker.
- The Python/FastAPI code now has a dual SQLite/PostgreSQL adapter; it has not been verified against a live Supabase project. The JavaScript Worker still does not serve the FastAPI business routes.
- Scheduler, IMAP, PDF/RAG, booking, and SSE migration remain open.
- No production deployment has been performed from this repository.\n- The proxy token protects direct Worker calls; it does not replace end-user authentication. Cloudflare Access is required in front of Pages before exposing non-demo data.


## ICP generation

`POST /api/icp` requires a saved `company_profile` in Supabase `kv` and accepts JSON or form fields `location`, `industry`, `size`, and `targeting`. Configure Worker secrets `OPENAI_API_KEY` and `OPENAI_MODEL`; optionally `OPENAI_BASE_URL` for an OpenAI-compatible endpoint. Keep all credentials server-side. Tests mock the LLM and Supabase calls; live provider compatibility is not yet verified.


`POST /api/company/text` accepts `name` and `text` (JSON or form fields), creates a structured company profile with the configured LLM, and stores it in Supabase `kv`. This initial Worker path stores the source chunks in `company_profile_source`; it does not yet implement PDF upload parsing or the original embedding/RAG pipeline.
