-- 0029_jobs_enqueue_dedup_uniq.sql
-- Race-proof the webhook / triage-sweep enqueue paths (audit #72).
--
-- The webhook (and the triage-sweep poll) dedupes new `jobs` with a
-- check-then-insert: SELECT for an in-flight job, INSERT only if none.
-- Two concurrent deliveries (opened+edited within ms, webhook + sweep poll,
-- opened+labeled) can both pass the SELECT and both INSERT — duplicate runs
-- that waste credit. The ci-followup path is worse: it also reads a
-- `priorAttempts` count before the insert, so two concurrent failing
-- check_runs can both observe `priorAttempts = N`, both enqueue, and blow
-- past the attempt cap that is the only guard against an infinite agent loop.
--
-- Fix: partial unique indexes that make a SECOND in-flight job for the same
-- dedup key physically impossible. The application-side SELECT stays as a
-- fast-path; the index is the real guard, so a lost race now surfaces as a
-- 23505 unique-violation the handler swallows as a no-op (already-enqueued).
--
--   * triage      — at most one open job per (workspace, issue).
--   * flow        — at most one open job per (workspace, flow, issue); the
--                   flow id lives in `payload->>'flowId'`.
--   * ci-followup — at most one open job per (workspace, pr). Serializing the
--                   enqueue also serializes the `priorAttempts` cap check, so
--                   the cap can no longer be raced.
--
-- "Open" = status in ('queued','claimed','running'). A job that reaches
-- done/failed/cancelled is no longer counted, so the next legitimate trigger
-- can enqueue again.

create unique index if not exists jobs_triage_open_uniq
  on jobs (workspace_id, issue_number)
  where kind = 'triage'
    and status in ('queued', 'claimed', 'running');

create unique index if not exists jobs_flow_open_uniq
  on jobs (workspace_id, (payload->>'flowId'), issue_number)
  where kind = 'flow'
    and status in ('queued', 'claimed', 'running');

create unique index if not exists jobs_cifollowup_open_uniq
  on jobs (workspace_id, pr_number)
  where kind = 'ci-followup'
    and status in ('queued', 'claimed', 'running');
