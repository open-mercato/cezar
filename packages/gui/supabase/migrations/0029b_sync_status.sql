-- ─────────────────────────────────────────────────────────────────────────
-- 0029_sync_status — live status for the user-triggered "Sync & Digest" action.
--
-- The sync used to run inline in a server action (blocking the request + the
-- whole UI for 30s–2min). It now runs as a detached background task that flips
-- this single per-workspace row through its phases; the client subscribes over
-- Realtime to render progress and refresh when it finishes. One row per
-- workspace, upserted on `workspace_id`.
-- ─────────────────────────────────────────────────────────────────────────

create table sync_status (
  workspace_id  uuid primary key references workspaces(id) on delete cascade,
  status        text not null default 'idle'
                  check (status in ('idle', 'syncing', 'done', 'error')),
  -- Current phase while status='syncing': matches the 4 phases of syncAndDigest.
  phase         text check (phase in ('issues', 'digests', 'comments', 'prs')),
  -- Human-readable one-liner for the button/toast (e.g. "Digesting 42 issues…").
  message       text,
  -- Accumulated counts: { issuesFetched, issuesCreated, issuesUpdated,
  --                       digestsCreated, commentsFetched, prsUpdated }.
  counts        jsonb not null default '{}'::jsonb,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  updated_at    timestamptz not null default now()
);

-- ─── RLS (mirrors workflow_runs in 0008) ─────────────────────────────────
-- Members read; admins write. The server action writes via the service-role
-- key, which bypasses RLS — no special policy needed for it.
alter table sync_status enable row level security;

create policy "sync_status_member_select" on sync_status
  for select using (is_workspace_member(workspace_id));
create policy "sync_status_admin_write" on sync_status
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- ─── updated_at trigger (reuse touch_updated_at() from 0001) ─────────────
create trigger sync_status_touch before update on sync_status
  for each row execute function touch_updated_at();

-- ─── Realtime ────────────────────────────────────────────────────────────
-- The Sync button subscribes to this row for live phase/progress updates.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table sync_status;
  end if;
exception when duplicate_object then
  -- table already in the publication — fine.
  null;
end $$;
