-- jobs claim hot-path index.
--
-- The 0008 index `jobs_status_scheduled_idx (status, scheduled_at)` predates the
-- priority ordering that every `claim_next_job*` body has used since 0009/0025:
--
--   where status = 'queued' and scheduled_at <= now()
--   order by priority desc, scheduled_at asc
--   limit p_limit for update skip locked
--
-- Postgres could use the old index to filter `status = 'queued'`, but then had
-- to sort the candidate set in memory to satisfy the `priority desc,
-- scheduled_at asc` ordering. Under a deep queue (triage-sweep / issue-sync can
-- enqueue thousands of jobs in one tick) that sort-and-take-N fights with
-- SKIP LOCKED for lock contention at the head of the queue.
--
-- This partial index is keyed on the exact claim ORDER BY and scoped to the
-- only status the claim path ever reads (`queued`), so it stays small and lets
-- Postgres walk it in claim order without an in-memory sort. Terminal rows
-- (done/failed/cancelled) no longer bloat the index.
--
-- NOTE: created plain (not CONCURRENTLY) because Supabase applies each migration
-- inside a transaction — CONCURRENTLY can't run there. On a hot production
-- table with a large existing backlog, prefer running this out-of-band as
-- `create index concurrently ...` before deploying the migration.

create index if not exists jobs_claim_hot_idx
  on jobs (priority desc, scheduled_at asc)
  where status = 'queued';

-- The full-table (status, scheduled_at) index is now redundant for the claim
-- path. The 0008 `jobs_workspace_status_idx` still covers the cockpit's
-- per-workspace listings.
drop index if exists jobs_status_scheduled_idx;
