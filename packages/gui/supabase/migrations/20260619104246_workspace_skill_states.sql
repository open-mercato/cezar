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

-- Backfill from skill_overrides — every override row carried an explicit
-- enabled value under the old model. Mirror it into state so an explicit
-- disable survives the migration. Don't overwrite anything already there
-- (the table is new but keep the upsert form for safety).
insert into workspace_skill_states (workspace_id, skill_name, enabled)
select workspace_id, skill_name, enabled
from skill_overrides
on conflict (workspace_id, skill_name) do nothing;

-- Intentionally leave `workspaces.skill_states_seeded = false` for every
-- workspace. The previous draft flipped it to true for any workspace with at
-- least one override row, which silently dropped every non-overridden
-- built-in (and every workspace-repo skill) from `loadActiveSkillCatalog` /
-- `listAvailableSkills` after migration — a hard regression vs. the pre-PR
-- "default-on" rule. The lazy seed in `seedBuiltinSkillStatesIfNeeded` flips
-- the flag on first /skills visit AND writes explicit enabled=true rows for
-- the default-on sources, so existing overrides continue to win and nothing
-- defaults-off behind the user's back.

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
