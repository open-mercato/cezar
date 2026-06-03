-- 0029_jobs_autofix_inflight_unique.sql
-- Close the TOCTOU race in the `startAutofix` server action
-- (packages/gui/src/app/issues/autofix-actions.ts).
--
-- That action SELECTs in-flight autofix jobs for an issue and, if none,
-- INSERTs a new one in a separate statement. Two concurrent clicks (a
-- double-click or a rapid retry) both observe zero open jobs and both
-- insert, enqueuing duplicate autofix runs for the same issue. Each
-- duplicate burns a clone + LLM budget on the same issue.
--
-- A partial unique index makes the database the single arbiter: at most
-- one *in-flight* (queued/claimed/running) autofix job can exist per
-- (workspace_id, issue_number). The second concurrent insert raises
-- 23505 (unique_violation), which the server action now swallows as a
-- benign "already in flight" no-op.
--
-- The index is partial on status so a finished/failed/cancelled job does
-- not block re-running the issue later — only live work is deduped.
--
-- NOTE: the audit's suggested index keyed on `input->>'issue_number'`,
-- but the `jobs` table stores the issue on a real `issue_number` integer
-- column (see 0008_agent_runs.sql), so this index uses that column.

create unique index if not exists jobs_autofix_inflight_unique
  on jobs (workspace_id, issue_number)
  where kind = 'autofix'
    and status in ('queued', 'claimed', 'running');
