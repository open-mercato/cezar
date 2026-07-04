-- CI-only post-apply smoke assertions (see .github/workflows/ci.yml →
-- apply-migrations). Runs after ci-bootstrap.sql + every migration has been
-- applied. Each block raises an exception (failing the psql run under
-- ON_ERROR_STOP) when the post-migration schema is not what we expect.
--
-- This is a lightweight sanity net, not a full schema test: it pins a couple
-- of invariants that have actually broken before — the `actions` table shape
-- (Actions v2) and the removal of the legacy seed_default_actions() function
-- consolidated away in 0044.

-- 1. The `actions` table exists with its core Actions v2 columns.
do $$
declare
  expected text[] := array[
    'workspace_id', 'name', 'kind', 'system_prompt',
    'skill_refs', 'target', 'triggers', 'effects', 'enabled'
  ];
  missing text;
begin
  if to_regclass('public.actions') is null then
    raise exception 'expected table public.actions to exist after migrations';
  end if;

  select string_agg(col, ', ') into missing
  from unnest(expected) as col
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'actions'
      and column_name = col
  );

  if missing is not null then
    raise exception 'public.actions is missing expected column(s): %', missing;
  end if;
end $$;

-- 2. seed_default_actions(uuid) must be gone — 0044 drops it.
do $$
declare
  n integer;
begin
  select count(*) into n
  from pg_proc
  where proname = 'seed_default_actions';

  if n <> 0 then
    raise exception 'seed_default_actions still exists (% definition(s)); 0044 should have dropped it', n;
  end if;
end $$;
