-- Issue #262 (PR 2) — external skill sources.
--
-- Lets a workspace pull skills from any GitHub repo (not just the one bound
-- to the workspace). Two tables land in this migration:
--
--   * skill_sources — polymorphic registry of every non-built-in source the
--     workspace knows about. PR 2 only supports kind='external-repo'; PR 4
--     will extend the CHECK constraint with 'skills-sh'. The legacy "workspace
--     repo" still lives under `repo_skills` (single, implicit source); this
--     table is for *additional* sources.
--
--   * external_repo_skills — per-source cache of metadata + body inline.
--     Unlike `repo_skills` (which only stores metadata because the dispatcher
--     already has the workspace clone on disk), an external repo may be
--     synced on machine A and dispatched on machine B, so we cache the body
--     in the DB. Skill bodies are small markdown blobs (a few KB).

create table skill_sources (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  -- Only 'external-repo' today. skills.sh shipped as its own table
  -- (skills_sh_skills), so this CHECK is not widened to 'skills-sh'.
  kind            text not null check (kind in ('external-repo')),
  -- Human-friendly label (slug-ish). Surfaced in the /skills "Sources" panel
  -- and in source badges next to each skill.
  name            text not null,
  -- Per-kind config blob. For 'external-repo' the shape is:
  --   { owner: string, repo: string, branch: string, folder: string }
  config          jsonb not null default '{}'::jsonb,
  last_synced_at  timestamptz,
  last_sync_error text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  updated_by      uuid references auth.users(id),
  unique (workspace_id, name)
);

create index skill_sources_workspace_idx on skill_sources(workspace_id);

create table external_repo_skills (
  source_id    uuid primary key references skill_sources(id) on delete cascade,
  commit_sha   text,
  -- Array of full Skill records (body inline so dispatch never needs a clone):
  --   { name, description, suggestedStages, path, source: 'external-repo', body }
  skills       jsonb not null default '[]'::jsonb,
  fetched_at   timestamptz not null default now()
);

-- Keep updated_at fresh on every UPDATE of skill_sources.
create or replace function skill_sources_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger skill_sources_set_updated_at
  before update on skill_sources
  for each row execute function skill_sources_set_updated_at();

alter table skill_sources       enable row level security;
alter table external_repo_skills enable row level security;

create policy "members read skill_sources"
  on skill_sources for select
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skill_sources.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "admins write skill_sources"
  on skill_sources for all
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skill_sources.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skill_sources.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );

-- external_repo_skills is keyed off a skill_sources row; mirror its access
-- model by joining on workspace membership through the parent.
create policy "members read external_repo_skills"
  on external_repo_skills for select
  to authenticated
  using (
    exists (
      select 1
      from skill_sources s
      join workspace_members wm on wm.workspace_id = s.workspace_id
      where s.id = external_repo_skills.source_id
        and wm.user_id = auth.uid()
    )
  );

create policy "admins write external_repo_skills"
  on external_repo_skills for all
  to authenticated
  using (
    exists (
      select 1
      from skill_sources s
      join workspace_members wm on wm.workspace_id = s.workspace_id
      where s.id = external_repo_skills.source_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from skill_sources s
      join workspace_members wm on wm.workspace_id = s.workspace_id
      where s.id = external_repo_skills.source_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );
