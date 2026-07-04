import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database } from '@/lib/supabase/types';
import { RunDetailShell, type RunnerLookup } from './run-detail-shell';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];
type AgentRunRow = Database['public']['Tables']['agent_runs']['Row'];
type AgentRunEventRow = Database['public']['Tables']['agent_run_events']['Row'];

export default async function CockpitRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  const supabase = await createSupabaseServerClient();
  const { data: runRow } = await supabase
    .from('workflow_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (!runRow || runRow.workspace_id !== workspace.id) {
    return (
      <div className="flex items-center justify-center py-32 text-fg-muted">Run not found.</div>
    );
  }

  const [{ data: steps }, { data: events }] = await Promise.all([
    supabase
      .from('agent_runs')
      .select('*')
      .eq('workflow_run_id', runId)
      .order('started_at', { ascending: true }),
    supabase
      .from('agent_run_events')
      .select('*')
      .eq('workflow_run_id', runId)
      .order('id', { ascending: false })
      .limit(200),
  ]);

  // Phase 5 (migration 0027) — fetch runner display info for every distinct
  // runner_id seen across this run's steps so the cockpit chip can render
  // "name · status · last heartbeat" without a per-row query. Null runner_id
  // (cron path) is filtered out.
  const stepRows = (steps ?? []) as AgentRunRow[];
  const runnerIds = Array.from(
    new Set(stepRows.map((s) => s.runner_id).filter((id): id is string => !!id)),
  );
  let runners: RunnerLookup = {};
  if (runnerIds.length > 0) {
    const { data: runnerRows } = await supabase
      .from('runners')
      .select('id, name, status, last_heartbeat_at, github_inherit_host, github_installation_id')
      .in('id', runnerIds);
    runners = Object.fromEntries(
      (runnerRows ?? []).map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          status: r.status,
          lastHeartbeatAt: r.last_heartbeat_at,
          // Phase 4 — derive a human-readable identity-source label so the
          // chip tooltip can show "inherit-host" / "install:123" / "workspace"
          // at a glance without joining workspaces.
          ghIdentity: r.github_inherit_host
            ? 'inherit-host'
            : r.github_installation_id != null
              ? `install:${r.github_installation_id}`
              : 'workspace',
        },
      ]),
    );
  }

  return (
    <RunDetailShell
      run={runRow as WorkflowRunRow}
      repoOwner={workspace.repoOwner}
      repoName={workspace.repoName}
      role={workspace.role}
      initialSteps={stepRows}
      initialEvents={((events ?? []) as AgentRunEventRow[]).slice().reverse()}
      runners={runners}
    />
  );
}
