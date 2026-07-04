import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database, DbWorkflowRunStatus } from '@/lib/supabase/types';
import { CockpitList } from './cockpit-list';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];

const ALL_STATUSES: DbWorkflowRunStatus[] = [
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
];

interface SearchParams {
  status?: string;
  workflow?: string;
  repo?: string;
}

export interface CockpitCounts {
  running: number;
  paused: number;
  queued: number;
  failedLast24h: number;
}

export default async function CockpitPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  const sp = await searchParams;
  const statusFilter = (sp.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is DbWorkflowRunStatus => (ALL_STATUSES as string[]).includes(s));
  const workflowFilter = sp.workflow?.trim() || null;
  const repoFilter = sp.repo?.trim() || null;

  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('workflow_runs')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (statusFilter.length > 0) query = query.in('status', statusFilter);
  if (workflowFilter) query = query.eq('workflow', workflowFilter);
  if (repoFilter) query = query.eq('repo', repoFilter);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: runs },
    { count: running },
    { count: paused },
    { count: queued },
    { count: failedLast24h },
  ] = await Promise.all([
    query,
    supabase
      .from('workflow_runs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id)
      .eq('status', 'running'),
    supabase
      .from('workflow_runs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id)
      .eq('status', 'paused'),
    supabase
      .from('workflow_runs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id)
      .eq('status', 'queued'),
    supabase
      .from('workflow_runs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id)
      .eq('status', 'failed')
      .gte('created_at', since24h),
  ]);

  // Repo dropdown options: distinct repos across the (unfiltered) recent set.
  const { data: repoRows } = await supabase
    .from('workflow_runs')
    .select('repo')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(200);
  const repoOptions = Array.from(
    new Set((repoRows ?? []).map((r) => r.repo).filter((r): r is string => !!r)),
  ).sort();

  const counts: CockpitCounts = {
    running: running ?? 0,
    paused: paused ?? 0,
    queued: queued ?? 0,
    failedLast24h: failedLast24h ?? 0,
  };

  return (
    <CockpitList
      workspaceId={workspace.id}
      repoOwner={workspace.repoOwner}
      repoName={workspace.repoName}
      role={workspace.role}
      initialRuns={(runs ?? []) as WorkflowRunRow[]}
      counts={counts}
      repoOptions={repoOptions}
      filters={{
        statuses: statusFilter,
        workflow: workflowFilter,
        repo: repoFilter,
      }}
    />
  );
}
