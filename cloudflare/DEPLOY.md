# Cloudflare Pages + Worker staging setup

This is an incremental deployment scaffold, not a completed port of the FastAPI app.

## 1. Supabase

1. Create a **new/disposable** Supabase project for staging; do not point this at an existing production database yet.
2. In the Supabase SQL Editor, apply `supabase/migrations/20261023000100_autosdr_initial_schema.sql`.
3. The migration enables RLS and grants table access only to `service_role`. Browser keys must not be used for server-side data access.
4. The migration retains embedding data as `BYTEA` until the current embedding model and vector dimension are confirmed.

## 1a. Import existing SQLite data (optional)

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

Configure secrets locally for the Worker (never commit values):

```sh
npx wrangler secret put SUPABASE_URL --config wrangler.jsonc
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.jsonc
```

Set `FRONTEND_ORIGIN` in `cloudflare/worker/wrangler.jsonc` to the exact Pages origin before deploying. The example value is local development only.

```sh
npx wrangler deploy --config wrangler.jsonc
```

The initial Worker implements only `GET /api/health` and explicit 501 responses for unmigrated API routes. Health confirms configuration presence only; it does not yet execute a Supabase query.

## 3. Pages static frontend

Create a Cloudflare Pages project with the repository connected to GitHub:

- Production branch: **do not select `cloudflare-supabase` as production yet**; use a preview/staging project until API porting and tests pass.
- Build command: leave empty for the current plain HTML frontend.
- Build output directory: `app/static`.
- Root directory: repository root.
- Deploy preview builds from `cloudflare-supabase` to validate static assets.

The existing frontend calls the FastAPI routes directly. Until API endpoints are ported, most app actions will not work against the Worker scaffold.

## 4. Current limitations

- No FastAPI business routes have been ported.
- No PostgreSQL adapter or data import script is included yet.
- Scheduler, IMAP, PDF/RAG, booking, and SSE migration remain open.
- No production deployment has been performed from this repository.
