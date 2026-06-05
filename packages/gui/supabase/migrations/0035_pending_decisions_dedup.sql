-- 0029_pending_decisions_dedup.sql
-- Dedup + FK indexes for pending_decisions (migration 0019).
--
-- 0019 noted that the inbox/runner wants "is there already a pending decision
-- for (action, issue, effect)?" for dedupe but never enforced it. The dispatch
-- sink (`lib/execute-workflow-job.ts`) plain-`insert`s a new row for every
-- deferred effect, so re-running the same action on the same target (e.g.
-- an `issues.edited` triage firing while an `issues.opened` decision is still
-- pending) silently creates duplicate inbox rows.
--
-- Enforce at most one *pending* decision per
--   (workspace, action, target, effect, effect_args)
-- so the duplicate insert hits the unique index and is swallowed (23505) by the
-- sink. The index doubles as the lookup the inbox grouper/runner wanted.
--
-- Also index the two FK columns that the run-detail and action-settings
-- "what's pending / what came out of this run?" queries filter on; both fell
-- back to seq scans before.

-- Dedup: at most one pending decision per
-- (workspace, action, target, effect, effect_args hash).
-- Pre-clean: environments already exhibiting the duplicate-inbox bug hold
-- duplicate *pending* rows, which would make the unique index below fail to
-- build (plain CREATE INDEX, not CONCURRENTLY). Collapse each dedup-key group
-- to its earliest row first so the index can apply everywhere.
delete from pending_decisions p
using (
  select id, row_number() over (
    partition by workspace_id, action_id, target_kind,
                 coalesce(issue_number, 0), coalesce(pr_number, 0),
                 effect, md5(effect_args::text)
    order by created_at, id
  ) as rn
  from pending_decisions
  where status = 'pending'
) d
where p.id = d.id and d.rn > 1;

create unique index pending_decisions_dedup_idx
  on pending_decisions (
    workspace_id, action_id, target_kind,
    coalesce(issue_number, 0), coalesce(pr_number, 0),
    effect, md5(effect_args::text)
  )
  where status = 'pending';

create index pending_decisions_action_idx
  on pending_decisions (action_id) where status = 'pending';

create index pending_decisions_workflow_run_idx
  on pending_decisions (workflow_run_id) where workflow_run_id is not null;
