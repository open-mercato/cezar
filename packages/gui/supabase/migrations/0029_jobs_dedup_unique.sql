-- 0029_jobs_dedup_unique.sql
-- Enforce "one in-flight job per dedup key" at the database level.
--
-- The webhook receiver (packages/gui/src/app/api/github/webhook/route.ts) and
-- the triage-sweep cron dedupe purely in application code: SELECT for an
-- in-flight job, then INSERT if none found. There's no lock between the read
-- and the write, so two concurrent deliveries (label-added + reopened in the
-- same second, or GitHub's at-least-once retry) both see an empty result and
-- both insert. Each duplicate burns a real Anthropic call, posts a duplicate
-- cockpit "running" card, and (for autofix) opens a duplicate PR.
--
-- These partial UNIQUE indexes close the race. Combined with `ON CONFLICT DO
-- NOTHING` on the enqueue paths, a concurrent double-insert collapses to one
-- row. The predicate is scoped to in-flight statuses + non-null issue_number,
-- so finished/failed/cancelled jobs never block a fresh re-enqueue.
--
--   * triage / autofix / ci-followup key on (workspace_id, kind, issue_number).
--   * flow keys on (workspace_id, issue_number, payload->>'flowId') — one
--     in-flight run per (flow, issue), matching the application dedupe in
--     enqueueFlowsForIssueEvent.

create unique index jobs_dedup_kind_idx on jobs (workspace_id, kind, issue_number)
  where kind in ('triage', 'autofix', 'ci-followup')
    and status in ('queued', 'claimed', 'running')
    and issue_number is not null;

create unique index jobs_dedup_flow_idx on jobs (workspace_id, issue_number, (payload ->> 'flowId'))
  where kind = 'flow'
    and status in ('queued', 'claimed', 'running')
    and issue_number is not null;
