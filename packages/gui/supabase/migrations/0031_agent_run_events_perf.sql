-- agent_run_events scan indexes — same class of hot-path fix as 0020_runner_perf.
-- 0008 only created agent_run_events_run_idx (workflow_run_id, id), which serves
-- the cockpit detail page (/cockpit/[runId]) and the runner long-poll dedup scan.
-- Two other read paths have no covering index and degrade to a seq scan as the
-- table grows (one autofix step easily emits 200 events):
--
--   * /activity + /inbox — workspace-scoped, recent-events-first:
--       select … from agent_run_events where workspace_id = $1 order by id desc limit 50;
--   * the cockpit step-detail panel — events filtered by agent_run_id.
--
-- NOTE: the audit suggested CREATE INDEX CONCURRENTLY, but `supabase db push`
-- runs each migration inside a transaction (CONCURRENTLY is disallowed there),
-- and every existing index in this tree is created plain — so we match that.
-- These tables are small in practice when the migration first applies.

create index if not exists agent_run_events_workspace_recent_idx
  on agent_run_events (workspace_id, id desc);

-- Partial: lifecycle events have a null agent_run_id, so they're excluded from
-- the per-step panel's lookups and don't need to bloat the index.
create index if not exists agent_run_events_agent_run_idx
  on agent_run_events (agent_run_id)
  where agent_run_id is not null;
