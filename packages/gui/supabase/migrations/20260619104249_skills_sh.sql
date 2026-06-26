-- Issue #262 (PR 4) — skills.sh registry as a skill source.
--
-- Users install a skill from skills.sh by its '{source}/{slug}' identifier
-- (e.g. 'vercel-labs/skills/find-skills'). The body comes back inline from
-- the API, so dispatch doesn't need to call out at runtime — body, metadata,
-- and the API's content_hash all live in this table.
--
-- `content_hash` is the API's snapshot fingerprint; Refresh compares it to
-- decide whether the body actually changed. UI shows `install_url` as a
-- "View on skills.sh" link.

create table skills_sh_skills (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  source_slug      text not null,
  name             text not null,
  body             text not null default '',
  description      text,
  suggested_stages jsonb not null default '[]'::jsonb,
  content_hash     text,
  install_url      text,
  imported_at      timestamptz not null default now(),
  last_synced_at   timestamptz not null default now(),
  last_sync_error  text,
  imported_by      uuid references auth.users(id),
  unique (workspace_id, source_slug),
  unique (workspace_id, name)
);

create index skills_sh_skills_workspace_idx on skills_sh_skills(workspace_id);

alter table skills_sh_skills enable row level security;

create policy "members read skills_sh_skills"
  on skills_sh_skills for select
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skills_sh_skills.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "admins write skills_sh_skills"
  on skills_sh_skills for all
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skills_sh_skills.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skills_sh_skills.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );
