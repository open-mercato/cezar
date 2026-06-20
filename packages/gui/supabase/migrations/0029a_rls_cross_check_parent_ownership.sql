-- 0029_rls_cross_check_parent_ownership.sql
-- Tighten the admin-write RLS policies on workflow_runs / agent_runs /
-- agent_run_events so they also cross-check parent-row ownership.
--
-- The 0008 policies only verified the row's own workspace_id:
--   for all using (is_workspace_admin(workspace_id))
--        with check (is_workspace_admin(workspace_id));
-- A workspace admin could therefore insert/update a child row that points at a
-- *parent* in a different workspace (e.g. an agent_run_events row whose own
-- workspace_id matches a workspace they admin, but whose workflow_run_id /
-- agent_run_id belongs to workspace B). The FK only checks the parent exists,
-- not that its workspace_id matches. Same for agent_runs.workflow_run_id and
-- workflow_runs.job_id (an admin could claim any job by setting job_id).
--
-- The realtime writers all use the service-role client (bypasses RLS), so the
-- production blast radius is limited today — but the policy is the only line of
-- defence if a future SSR action ever writes through the user-context client.
-- This migration adds the missing parent-ownership checks to the WITH CHECK
-- (and, where relevant, USING) clauses.

-- ─── workflow_runs: cross-check job ownership ────────────────────────────
drop policy "workflow_runs_admin_write" on workflow_runs;
create policy "workflow_runs_admin_write" on workflow_runs
  for all
  using (is_workspace_admin(workspace_id))
  with check (
    is_workspace_admin(workspace_id)
    and (job_id is null or exists (
      select 1 from jobs j
      where j.id = workflow_runs.job_id
        and j.workspace_id = workflow_runs.workspace_id
    ))
  );

-- ─── agent_runs: cross-check workflow_run ownership ──────────────────────
drop policy "agent_runs_admin_write" on agent_runs;
create policy "agent_runs_admin_write" on agent_runs
  for all
  using (is_workspace_admin(workspace_id))
  with check (
    is_workspace_admin(workspace_id)
    and exists (
      select 1 from workflow_runs wr
      where wr.id = agent_runs.workflow_run_id
        and wr.workspace_id = agent_runs.workspace_id
    )
  );

-- ─── agent_run_events: cross-check workflow_run + agent_run ownership ─────
drop policy "agent_run_events_admin_write" on agent_run_events;
create policy "agent_run_events_admin_write" on agent_run_events
  for all
  using (is_workspace_admin(workspace_id))
  with check (
    is_workspace_admin(workspace_id)
    and exists (
      select 1 from workflow_runs wr
      where wr.id = agent_run_events.workflow_run_id
        and wr.workspace_id = agent_run_events.workspace_id
    )
    and (agent_run_id is null or exists (
      select 1 from agent_runs ar
      where ar.id = agent_run_events.agent_run_id
        and ar.workspace_id = agent_run_events.workspace_id
    ))
  );
