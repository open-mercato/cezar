// Pure-function body of the /api/cron/triage-sweep route — shared between the
// HTTP handler (auth-gated) and the in-process scheduler.
//
// For each workspace with `auto_triage_enabled`, finds open issues that have
// never been triaged (no `triage` job in queued/claimed/running/done and no
// `triage` workflow run) and enqueues a (deduped) `triage` job for the most
// recent N of them.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';

type WorkspaceRow = { id: string; repo_owner: string; repo_name: string };

export interface TriageSweepResult {
  enqueued: number;
  workspaces: number;
  error?: string;
}

export async function runTriageSweep(
  supabase: SupabaseClient<Database>,
): Promise<TriageSweepResult> {
  const SWEEP_BATCH = Number(process.env.CEZAR_TRIAGE_SWEEP_BATCH) || 10;
  const MAX_WORKSPACES_PER_TICK = Number(process.env.CEZAR_TRIAGE_SWEEP_MAX_WORKSPACES) || 25;

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, repo_owner, repo_name')
    .eq('auto_triage_enabled', true)
    .limit(MAX_WORKSPACES_PER_TICK);
  if (error) {
    console.error('[triage-sweep] workspace query failed:', error.message);
    return { enqueued: 0, workspaces: 0, error: error.message };
  }
  if (!workspaces || workspaces.length === 0) return { enqueued: 0, workspaces: 0 };

  let totalEnqueued = 0;
  for (const ws of workspaces as WorkspaceRow[]) {
    try {
      totalEnqueued += await sweepOne(ws, supabase, SWEEP_BATCH);
    } catch (err) {
      console.error(
        `[triage-sweep] workspace ${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { enqueued: totalEnqueued, workspaces: workspaces.length };
}

async function sweepOne(
  ws: WorkspaceRow,
  supabase: SupabaseClient<Database>,
  batchSize: number,
): Promise<number> {
  const repoSlug = `${ws.repo_owner}/${ws.repo_name}`;

  const { data: issues } = await supabase
    .from('issues')
    .select('number, updated_at')
    .eq('workspace_id', ws.id)
    .eq('state', 'open')
    .order('updated_at', { ascending: false })
    .limit(batchSize * 10);
  if (!issues || issues.length === 0) return 0;

  const [{ data: jobRows }, { data: runRows }] = await Promise.all([
    supabase
      .from('jobs')
      .select('issue_number')
      .eq('workspace_id', ws.id)
      .eq('kind', 'triage')
      .in('status', ['queued', 'claimed', 'running', 'done']),
    supabase
      .from('workflow_runs')
      .select('issue_number')
      .eq('workspace_id', ws.id)
      .eq('workflow', 'triage'),
  ]);
  const triaged = new Set<number>();
  for (const r of jobRows ?? []) if (r.issue_number != null) triaged.add(r.issue_number);
  for (const r of runRows ?? []) if (r.issue_number != null) triaged.add(r.issue_number);

  const untriaged = issues.filter((i) => !triaged.has(i.number)).slice(0, batchSize);
  if (untriaged.length === 0) return 0;

  let enqueued = 0;
  for (const issue of untriaged) {
    const { data: open } = await supabase
      .from('jobs')
      .select('id')
      .eq('workspace_id', ws.id)
      .eq('kind', 'triage')
      .eq('issue_number', issue.number)
      .in('status', ['queued', 'claimed', 'running'])
      .limit(1);
    if (open && open.length > 0) continue;
    const { error } = await supabase.from('jobs').insert({
      workspace_id: ws.id,
      repo: repoSlug,
      kind: 'triage',
      issue_number: issue.number,
      pr_number: null,
      priority: 5,
      status: 'queued',
      max_attempts: 1,
      // Backlog triage is semantically "treat as newly opened" — carry the
      // real ActionTrigger; `source` keeps the provenance the old 'sweep'
      // marker encoded.
      payload: { trigger: 'on-issue-opened', source: 'sweep' },
    });
    if (error) {
      // The webhook (or a concurrent sweep tick) already enqueued a triage job
      // for this issue; the partial unique index `jobs_triage_open_uniq`
      // (migration 0029) rejects the duplicate with 23505 — benign no-op.
      if (error.code !== '23505' && !/duplicate key/i.test(error.message)) {
        console.error(
          `[triage-sweep] enqueue failed for ws ${ws.id} #${issue.number}:`,
          error.message,
        );
      }
      continue;
    }
    enqueued++;
  }
  return enqueued;
}
