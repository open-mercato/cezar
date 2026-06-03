-- 0029_workspace_sync_cooldown.sql
-- Server-side rate limit + concurrency guard for the "Sync & Digest" action.
--
-- syncAndDigest() (packages/gui/src/app/inbox/sync-action.ts) fetches issues
-- from GitHub and runs LLMService.generateDigests against every undigested
-- issue — every click is real Anthropic spend. Before this migration there
-- was no server-side debounce and no concurrency check, so rapid clicks or
-- two tabs racing could bill Claude multiple times for the same batch.
--
-- We add a dedicated `last_synced_at` timestamp (distinct from the store's
-- meta.lastSyncedAt, which background crons/webhooks also bump) and an atomic
-- `claim_sync_slot` that both enforces a cooldown and collapses concurrent
-- callers: only the single UPDATE that wins the cooldown window returns true.

alter table workspaces
  add column if not exists last_synced_at timestamptz;

-- ─── claim_sync_slot ────────────────────────────────────────────────────
-- Atomically claims the manual-sync slot for a workspace. Returns true and
-- stamps last_synced_at = now() iff the previous sync is older than
-- p_cooldown_seconds (or never ran); returns false otherwise. The WHERE
-- guard makes this race-safe — two concurrent callers both run the UPDATE,
-- but only the first to commit matches the predicate, so exactly one wins.
create or replace function claim_sync_slot(wid uuid, p_cooldown_seconds int default 30)
returns boolean
language plpgsql
as $$
declare
  claimed boolean;
begin
  update workspaces
     set last_synced_at = now()
   where id = wid
     and (
       last_synced_at is null
       or last_synced_at < now() - make_interval(secs => p_cooldown_seconds)
     )
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

-- Matches the access-control posture of claim_next_job: the function body is
-- the gate, not the caller. syncAndDigest invokes it with the service-role key.
grant execute on function claim_sync_slot(uuid, int) to anon, authenticated, service_role;
