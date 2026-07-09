-- 20260706075137_runner_join_tokens.sql
-- Join-token runner registration + owner-based job routing.
--
-- (A) `runner_join_tokens` — from now on the ONLY way to register a runner.
--     A workspace member mints a join token in Settings → Runners; the
--     runner daemon presents it to POST /api/runner/register, which creates
--     (or re-keys) the `runners` row and returns the per-runner bearer
--     token. The join token is stored hashed (SHA-256, same scheme as
--     `runners.token_hash`) and is reusable until revoked — one token can
--     register any number of runners across devices.
--
-- (B) Ownership + routing. `runners.owner_user_id` records whose runner it
--     is (the join token's creator); `jobs.requested_by` records which user
--     asked for the work (NULL for system-initiated jobs: webhooks, sweeps,
--     schedulers). The claim RPC routes:
--       * user-requested jobs  → only runners owned by that user;
--       * system jobs          → any runner in the workspace (including
--                                legacy unowned rows).
--     It also closes a pre-existing gap: the claim RPC had no workspace
--     filter at all, so a workspace-scoped runner could claim another
--     workspace's jobs whose backend matched.

-- ─── runner_join_tokens ─────────────────────────────────────────────────
create table runner_join_tokens (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  created_by        uuid not null references auth.users(id) on delete cascade,
  -- GitHub login of the creator, denormalized at mint time so the runners
  -- list can show "owner" without an auth-admin lookup.
  created_by_login  text not null default '',
  label             text not null default '',
  token_hash        text not null unique,
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz
);

create index runner_join_tokens_workspace_idx on runner_join_tokens(workspace_id);

alter table runner_join_tokens enable row level security;

-- Members mint tokens for themselves; they see (and may revoke) their own,
-- admins see and revoke any in the workspace. The register endpoint reads
-- via the service-role key (bypasses RLS).
create policy "rjt_select" on runner_join_tokens
  for select using (
    is_workspace_member(workspace_id)
    and (created_by = auth.uid() or is_workspace_admin(workspace_id))
  );
create policy "rjt_insert" on runner_join_tokens
  for insert with check (is_workspace_member(workspace_id) and created_by = auth.uid());
create policy "rjt_update" on runner_join_tokens
  for update using (
    is_workspace_member(workspace_id)
    and (created_by = auth.uid() or is_workspace_admin(workspace_id))
  );
create policy "rjt_delete" on runner_join_tokens
  for delete using (
    is_workspace_member(workspace_id)
    and (created_by = auth.uid() or is_workspace_admin(workspace_id))
  );

-- ─── runners: ownership ─────────────────────────────────────────────────
alter table runners
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists owner_login   text,
  add column if not exists join_token_id uuid references runner_join_tokens(id) on delete set null;

-- A runner is identified by (workspace, owner, name): re-registering from
-- the same device re-keys the existing row instead of piling up duplicates.
-- Legacy rows (owner NULL) are exempt so the migration can't fail on
-- pre-existing name collisions.
create unique index if not exists runners_workspace_owner_name_uniq
  on runners (workspace_id, owner_user_id, name)
  where owner_user_id is not null;

-- Owners manage their own runners (revoke from Settings → Runners) even when
-- they aren't workspace admins; 0008's runners_admin_write stays for admins.
create policy "runners_owner_delete" on runners
  for delete using (owner_user_id = auth.uid() and is_workspace_member(workspace_id));

-- ─── jobs: requester ────────────────────────────────────────────────────
alter table jobs
  add column if not exists requested_by uuid references auth.users(id) on delete set null;

-- Hot-path helper: the claim scan now filters on requested_by too. Partial
-- on queued rows, same shape as jobs_preferred_runner_idx (0026/0034).
create index if not exists jobs_requested_by_queued_idx
  on jobs (requested_by)
  where requested_by is not null and status = 'queued';

-- ─── claim_next_job_for_runner — supersedes the 0033 body ───────────────
-- Adds workspace scoping + owner routing on top of lease (0025) and soft
-- affinity (0026). Owner routing is strict: a job with `requested_by` set is
-- claimable only by runners whose `owner_user_id` matches; unowned runners
-- (legacy rows, managed cloud) serve only system jobs. `claim_next_job`
-- (the cron/in-process path) is deliberately unchanged — the managed
-- anthropic-api path is not per-user.
create or replace function claim_next_job_for_runner(
  p_runner_id uuid,
  p_backends  text[],
  p_limit     int default 1,
  p_lease_seconds int default 60
)
returns setof jobs
language plpgsql
as $$
declare
  v_now       timestamptz := now();
  v_workspace uuid;
  v_owner     uuid;
begin
  select workspace_id, owner_user_id
    into v_workspace, v_owner
    from runners
   where id = p_runner_id;

  return query
  update jobs
     set status            = 'claimed',
         claimed_by_runner = p_runner_id,
         claim_expires_at  = v_now + make_interval(secs => p_lease_seconds),
         attempts          = attempts + 1,
         updated_at        = v_now
   where id in (
     select j.id
       from jobs j
      where j.status = 'queued'
        and j.scheduled_at <= v_now
        and j.kind <> 'label-analysis'
        and (j.required_backend is null or j.required_backend = any(p_backends))
        -- workspace scoping: a workspace-bound runner serves only its own
        -- workspace; managed runners (workspace_id NULL) serve any.
        and (v_workspace is null or j.workspace_id = v_workspace)
        -- owner routing: user-requested jobs go only to that user's runners.
        -- NULL v_owner never equals a non-NULL requested_by, so unowned
        -- runners fall through to system jobs only.
        and (j.requested_by is null or j.requested_by = v_owner)
        and (
          -- this runner is the preferred one (affinity match)
          j.preferred_runner_id = p_runner_id
          -- or no preference set
          or j.preferred_runner_id is null
          -- or the soft-affinity window has expired (fallback)
          or j.preferred_until is null
          or j.preferred_until <= v_now
        )
      order by
        -- prioritize affinity matches over fallback matches
        case when j.preferred_runner_id = p_runner_id then 0 else 1 end,
        j.priority desc,
        j.scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
end;
$$;

grant execute on function claim_next_job_for_runner(uuid, text[], int, int)
  to anon, authenticated, service_role;
