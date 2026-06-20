-- Close the TOCTOU race in `maybeEnqueueAutofixFromTriage` (audit #90).
--
-- The TS helper used to SELECT for an open autofix job, then INSERT — with
-- nothing serializing the two, two concurrent triage finalizations for the
-- same issue (a webhook-triggered triage racing a triage-sweep one, say)
-- could both pass the SELECT and both INSERT, queueing duplicate autofix jobs
-- that the dispatcher then runs twice (two clones, two LLM bills, a branch-name
-- collision on `autofix/<issue>`).
--
-- This makes the "no open autofix job for this issue" check atomic with the
-- insert via a single `INSERT … SELECT … WHERE NOT EXISTS`, plus a partial
-- unique index as a hard backstop so even a torn read can't land two rows.

-- ─── partial unique index (hard backstop) ───────────────────────────────
-- At most one *open* (queued/claimed/running) autofix job per (workspace, issue).
-- Partial so terminal jobs (done/failed/cancelled) and a future re-queue don't
-- collide with it. `issue_number` is nullable on `jobs`; the predicate's
-- `issue_number is not null` keeps issue-less rows out of the index entirely.
create unique index if not exists jobs_open_autofix_unique_idx
  on jobs (workspace_id, issue_number)
  where kind = 'autofix'
    and issue_number is not null
    and status in ('queued', 'claimed', 'running');

-- ─── enqueue_autofix_if_not_open ────────────────────────────────────────
-- Inserts an autofix `jobs` row only if no open autofix job already exists for
-- the same (workspace, issue). The WHERE NOT EXISTS guard and the INSERT run in
-- one statement, so two concurrent callers can't both pass the check. On a lost
-- race the loser inserts zero rows (and the unique index above would reject it
-- anyway). Returns the new job id, or NULL when nothing was inserted.
create or replace function enqueue_autofix_if_not_open(
  p_workspace_id       uuid,
  p_repo               text,
  p_issue_number       integer,
  p_payload            jsonb default '{}'::jsonb,
  p_priority           integer default 10,
  p_max_attempts       integer default 1,
  p_preferred_runner_id uuid default null,
  p_preferred_until    timestamptz default null
)
returns uuid
language sql
as $$
  insert into jobs (
    workspace_id, repo, kind, issue_number, pr_number,
    priority, status, max_attempts, payload,
    preferred_runner_id, preferred_until
  )
  select
    p_workspace_id, p_repo, 'autofix', p_issue_number, null,
    p_priority, 'queued', p_max_attempts, p_payload,
    p_preferred_runner_id, p_preferred_until
  where not exists (
    select 1 from jobs
     where workspace_id = p_workspace_id
       and kind = 'autofix'
       and issue_number = p_issue_number
       and status in ('queued', 'claimed', 'running')
  )
  returning id;
$$;

-- Called from the cron dispatch path and the runner-finalize PATCH route, both
-- of which use the service-role key. The body is the access-control surface.
grant execute on function enqueue_autofix_if_not_open(
  uuid, text, integer, jsonb, integer, integer, uuid, timestamptz
) to anon, authenticated, service_role;
