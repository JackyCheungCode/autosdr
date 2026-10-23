-- AutoSDR initial PostgreSQL schema.
-- Backend-only tables: no anon/authenticated access. The Worker will use a
-- server-side Supabase service-role secret; never expose it to the browser.
-- Keep timestamps as DOUBLE PRECISION and IDs as TEXT in this first migration
-- to preserve the existing SQLite application's Unix timestamps and UUID-hex IDs.
begin;

create table if not exists public.leads (
  id text primary key,
  name text not null,
  domain text,
  website text,
  location text,
  industry text,
  size_hint text,
  source text,
  stage text not null default 'discovered',
  score integer,
  score_reasons text,
  service text,
  research text,
  created_ts double precision,
  updated_ts double precision
);

create table if not exists public.contacts (
  id text primary key,
  lead_id text not null references public.leads(id) on delete cascade,
  name text,
  role text,
  email text,
  email_status text,
  source text,
  ts double precision
);

create table if not exists public.evidence (
  id text primary key,
  lead_id text not null references public.leads(id) on delete cascade,
  kind text,
  url text,
  quote text,
  meta text,
  ts double precision
);

create table if not exists public.messages (
  id text primary key,
  lead_id text references public.leads(id) on delete set null,
  contact_id text references public.contacts(id) on delete set null,
  direction text not null,
  channel text not null,
  subject text,
  body text,
  meta text,
  status text,
  ts double precision
);

create table if not exists public.meetings (
  id text primary key,
  lead_id text references public.leads(id) on delete set null,
  contact_id text references public.contacts(id) on delete set null,
  time_utc double precision,
  link text,
  status text,
  briefing text,
  ts double precision
);

create table if not exists public.followups (
  id text primary key,
  lead_id text references public.leads(id) on delete cascade,
  due_ts double precision,
  kind text,
  status text default 'scheduled',
  meta text,
  ts double precision
);

create table if not exists public.events (
  seq bigserial primary key,
  ts double precision,
  agent text,
  type text,
  label text,
  lead_id text references public.leads(id) on delete set null,
  payload text
);

-- Keep embeddings as BYTEA during the first migration: app/rag.py currently
-- serializes NumPy vectors to bytes. A pgvector migration requires confirming
-- embedding model and dimension before conversion.
create table if not exists public.kb_chunks (
  id text primary key,
  doc text,
  idx integer,
  text text,
  embedding bytea
);

create table if not exists public.memory_notes (
  id text primary key,
  lead_id text references public.leads(id) on delete cascade,
  kind text,
  note text,
  ts double precision
);

create table if not exists public.kv (
  k text primary key,
  v text
);

create index if not exists leads_stage_updated_idx
  on public.leads(stage, updated_ts desc);
create index if not exists leads_domain_idx on public.leads(domain);
create index if not exists contacts_lead_idx on public.contacts(lead_id);
create index if not exists contacts_email_idx on public.contacts(email);
create index if not exists evidence_lead_ts_idx on public.evidence(lead_id, ts);
create index if not exists messages_lead_ts_idx on public.messages(lead_id, ts);
create index if not exists messages_status_idx on public.messages(status);
create index if not exists meetings_lead_idx on public.meetings(lead_id);
create index if not exists followups_due_status_idx on public.followups(status, due_ts);
create index if not exists events_ts_idx on public.events(ts);
create index if not exists kb_chunks_doc_idx on public.kb_chunks(doc);
create index if not exists memory_notes_lead_ts_idx on public.memory_notes(lead_id, ts desc);

-- Defense in depth. The application is not multi-tenant yet, so exposed
-- browser roles get no table access or RLS policies. A future auth/tenant
-- migration must add workspace/user ownership before enabling client access.
alter table public.leads enable row level security;
alter table public.contacts enable row level security;
alter table public.evidence enable row level security;
alter table public.messages enable row level security;
alter table public.meetings enable row level security;
alter table public.followups enable row level security;
alter table public.events enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.memory_notes enable row level security;
alter table public.kv enable row level security;

revoke all on table public.leads, public.contacts, public.evidence,
  public.messages, public.meetings, public.followups, public.events,
  public.kb_chunks, public.memory_notes, public.kv from anon, authenticated;
grant all on table public.leads, public.contacts, public.evidence,
  public.messages, public.meetings, public.followups, public.events,
  public.kb_chunks, public.memory_notes, public.kv to service_role;
grant usage, select on all sequences in schema public to service_role;

commit;
