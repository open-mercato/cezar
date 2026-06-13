-- Issue #262 (PR 3) — disk uploads as a skill source.
--
-- Lets users add skills by dragging `.md` files into /skills (or pasting raw
-- markdown). Bodies live inline in this table — no on-disk clone exists for
-- uploaded skills, so dispatch reads bodies straight from the DB.
--
-- Re-uploading a skill with the same name replaces the row via the
-- `(workspace_id, name)` unique constraint (the upload action runs an upsert).

create table uploaded_skills (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  name             text not null,
  body             text not null default '',
  description      text,
  suggested_stages jsonb not null default '[]'::jsonb,
  uploaded_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  uploaded_by      uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  unique (workspace_id, name)
);

create index uploaded_skills_workspace_idx on uploaded_skills(workspace_id);

create or replace function uploaded_skills_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger uploaded_skills_set_updated_at
  before update on uploaded_skills
  for each row execute function uploaded_skills_set_updated_at();

alter table uploaded_skills enable row level security;

create policy "members read uploaded_skills"
  on uploaded_skills for select
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = uploaded_skills.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "admins write uploaded_skills"
  on uploaded_skills for all
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = uploaded_skills.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = uploaded_skills.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );
