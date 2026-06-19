-- Issue #262 (PR 1) — catalog/enabled two-list model for skills.
--
-- Today `skill_overrides.enabled` is the only "is this skill active" flag, but
-- it's scoped to overrides — a workspace can't disable a built-in or repo skill
-- it hasn't overridden. This migration introduces a dedicated state table that
-- covers every skill regardless of whether it has an override.
--
-- Semantics:
--   * Row exists with enabled=true  → skill is in the "Active" list (pickers,
--     workflow runs, dispatch).
--   * Row exists with enabled=false → skill is in the catalog but hidden from
--     pickers / not picked up by workflow runs.
--   * No row at all → skill is in the catalog but inactive by default. Empty
--     workspaces are seeded with all built-in skills enabled (see
--     `workspaces.skill_states_seeded` below).
--
-- `pinned_source` is forward-looking (PRs 2–4 add more sources): when set, the
-- workspace pins this skill to a specific provenance instead of letting the
-- priority order decide. NULL = follow default priority.

create table workspace_skill_states (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  skill_name    text not null,
  enabled       boolean not null default false,
  pinned_source text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  unique (workspace_id, skill_name)
);

create index workspace_skill_states_workspace_idx on workspace_skill_states(workspace_id);

-- Track whether the lazy built-in seed has already run for this workspace, so
-- subsequent loads don't reseed skills the user has since disabled.
alter table workspaces
  add column skill_states_seeded boolean not null default false;

-- Backfill from skill_overrides — every override row implied an enabled state
-- under the old model. Don't overwrite anything that's already there (no rows
-- exist yet but keep the upsert form for safety).
insert into workspace_skill_states (workspace_id, skill_name, enabled)
select workspace_id, skill_name, enabled
from skill_overrides
on conflict (workspace_id, skill_name) do nothing;

-- Workspaces that had at least one override before this migration already had a
-- "curated" surface; mark them seeded so the lazy seed doesn't undo a disable.
update workspaces
set skill_states_seeded = true
where id in (select distinct workspace_id from skill_overrides);

-- Keep updated_at fresh on every UPDATE.
create or replace function workspace_skill_states_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_skill_states_set_updated_at
  before update on workspace_skill_states
  for each row execute function workspace_skill_states_set_updated_at();

alter table workspace_skill_states enable row level security;

create policy "members read workspace_skill_states"
  on workspace_skill_states for select
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = workspace_skill_states.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "admins write workspace_skill_states"
  on workspace_skill_states for all
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = workspace_skill_states.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = workspace_skill_states.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );
