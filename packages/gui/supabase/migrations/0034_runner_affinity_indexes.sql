-- 0029_runner_affinity_indexes.sql
-- Fix the affinity-claim index introduced in 0026.
--
-- 0026 added `jobs_preferred_runner_idx` as a single-column partial index on
-- (preferred_runner_id) WHERE preferred_runner_id is not null and status =
-- 'queued'. But `claim_next_job_for_runner` filters with
-- `preferred_runner_id = X OR preferred_runner_id IS NULL OR …` and orders by a
-- CASE-based affinity key, then priority desc, scheduled_at asc. The planner
-- cannot satisfy that OR-predicate from a single-column-on-preferred-runner-id
-- index, so it seq-scans the queued partition and sorts in memory — the
-- affinity fast path degenerates to the no-affinity plan once the queue grows.
--
-- Replace it with an index whose key matches the claim's ORDER BY shape so the
-- planner can serve both the affinity scan and the sort from the index, and add
-- the missing runner-side index: `runners` lookups by workspace are seq scans,
-- and the `on delete set null` cascade on jobs.preferred_runner_id (FK to
-- runners) scans `jobs` for lack of an index on that column — the new
-- affinity-claim index also covers that FK.
--
-- NOTE: in production, run the two creates with `CREATE INDEX CONCURRENTLY`
-- (outside a transaction) to avoid locking the hot `jobs` / `runners` tables.

drop index if exists jobs_preferred_runner_idx;

create index if not exists jobs_affinity_claim_idx
  on jobs (preferred_runner_id, priority desc, scheduled_at asc)
  where status = 'queued';

create index if not exists runners_workspace_kind_idx
  on runners (workspace_id, kind);
