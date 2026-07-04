-- CI-only bootstrap for applying the Supabase migrations against a *plain*
-- postgres:15 image (see .github/workflows/ci.yml → apply-migrations).
--
-- A real Supabase database ships an `auth` schema (the GoTrue auth server)
-- with an `auth.users` table and the `auth.uid()` / `auth.role()` helper
-- functions. A vanilla Postgres container has none of that, so the very first
-- migration (0001_init.sql) fails immediately: it declares foreign keys to
-- `auth.users(id)` and RLS policies that call `auth.uid()`.
--
-- This file is a *minimal stand-in* — just enough surface area for the
-- migrations to apply cleanly. It is NOT a faithful reproduction of Supabase
-- auth and must never ship to a real database. It lives OUTSIDE the
-- migrations/ directory on purpose so the migration numbering-sanity check
-- and the lexicographic apply loop never pick it up.
--
-- Two kinds of Supabase-isms appear across all migrations:
--   * The `auth` schema
--     (`grep -rn 'auth\.' packages/gui/supabase/migrations/`):
--       - `auth.users(id)` — FK target; only the `id` column is referenced.
--       - `auth.uid()`     — used inside RLS policy expressions. Policies are
--                            registered (not evaluated) at apply time, so a
--                            stub returning NULL is sufficient for migrations.
--   * The Supabase API roles `anon` / `authenticated` / `service_role`, which
--     migrations target with `GRANT ... TO`. They are created by Supabase, not
--     by these migrations, so a plain Postgres lacks them and the GRANTs fail.

create extension if not exists "pgcrypto";

-- Supabase predefines these NOLOGIN roles; recreate them so the GRANT
-- statements in the migrations resolve. Postgres has no
-- `CREATE ROLE IF NOT EXISTS`, hence the guarded DO block.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema if not exists auth;

-- Stub of Supabase's auth.users. Migrations only reference the `id` column
-- (as a FK target); `email` is added defensively in case future migrations
-- reference it. This is intentionally not the full GoTrue schema.
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- auth.uid() returns the current user's id from the request JWT in real
-- Supabase. At migration-apply time no request context exists and policy
-- bodies are not evaluated, so a NULL-returning stub is enough.
create or replace function auth.uid()
  returns uuid
  language sql
  stable
as $$ select null::uuid $$;

-- auth.role() / auth.jwt() are not referenced by any current migration, but
-- are cheap to stub and guard against the next migration that uses them.
create or replace function auth.role()
  returns text
  language sql
  stable
as $$ select null::text $$;

create or replace function auth.jwt()
  returns jsonb
  language sql
  stable
as $$ select null::jsonb $$;
