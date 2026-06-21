'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { Database, JobKind } from '@/lib/supabase/types';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];

export interface ActionResult {
  ok?: boolean;
  error?: string;
}

interface Ctx {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
  actorLabel: string;
}

/**
 * Shared preamble for every cockpit run-control action: require a session,
 * an active workspace, and a non-viewer role (admins + actors can control
 * runs; viewers cannot).
 */
async function guard(): Promise<Ctx | { error: string }> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role === 'viewer') return { error: 'Viewers cannot control runs' };
  return {
    supabase: createSupabaseAdminClient(),
    workspaceId: workspace.id,
    actorLabel: user.name || user.email || user.id,
  };
}

async function loadRun(ctx: Ctx, runId: string): Promise<WorkflowRunRow | { error: string }> {
  const { data, error } = await ctx.supabase
    .from('workflow_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: 'Run not found' };
  if (data.workspace_id !== ctx.workspaceId) return { error: 'Run not in this workspace' };
  return data;
}

/**
 * Request a graceful pause. The workflow engine checks `pause_requested`
 * between steps (and the Phase-3c dispatcher will too) — a running step is
 * NOT interrupted mid-flight.
 */
export async function pauseRun(runId: string): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  const run = await loadRun(ctx, runId);
  if ('error' in run) return run;

  const { error } = await ctx.supabase
    .from('workflow_runs')
    .update({ pause_requested: true })
    .eq('id', runId)
    .eq('workspace_id', ctx.workspaceId);
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

/**
 * Clear the pause request and re-queue. NOTE: the actual resume (re-dispatch
 * to a runner) needs the Phase-3c dispatcher — for now we just flip the run
 * back to `queued` so a future runner picks it up.
 */
export async function resumeRun(runId: string): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  const run = await loadRun(ctx, runId);
  if ('error' in run) return run;
  if (run.status !== 'paused') return { error: 'Run is not paused' };

  const { error } = await ctx.supabase
    .from('workflow_runs')
    .update({
      pause_requested: false,
      status: 'queued',
      reason: 'resume requested — will continue when a runner picks it up',
    })
    .eq('id', runId)
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'paused');
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

/**
 * Mark a run cancelled. A running engine won't actually stop mid-step until
 * Phase 3c adds a cancel check in the engine loop — that's acceptable; the
 * row is the source of truth and the next step boundary will honour it.
 */
export async function cancelRun(runId: string): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  const run = await loadRun(ctx, runId);
  if ('error' in run) return run;
  if (!['queued', 'running', 'paused'].includes(run.status)) {
    return { error: `Run is ${run.status}, cannot cancel` };
  }

  const { error } = await ctx.supabase
    .from('workflow_runs')
    .update({
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      reason: `cancelled by ${ctx.actorLabel}`,
    })
    .eq('id', runId)
    .eq('workspace_id', ctx.workspaceId)
    .in('status', ['queued', 'running', 'paused']);
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

export async function cancelRuns(ids: string[]): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  if (ids.length === 0) return { ok: true };

  const { error } = await ctx.supabase
    .from('workflow_runs')
    .update({
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      reason: `cancelled by ${ctx.actorLabel}`,
    })
    .in('id', ids)
    .eq('workspace_id', ctx.workspaceId)
    .in('status', ['queued', 'running', 'paused']);
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

/**
 * Hard-delete a workflow run row. `agent_runs` and `agent_run_events` cascade
 * via FK; `pending_decisions.workflow_run_id` is `on delete set null`. Only
 * terminal runs are deletable — cancel an in-flight run first so the engine
 * can't keep writing to the row we just removed.
 */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export async function deleteRun(runId: string): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  const run = await loadRun(ctx, runId);
  if ('error' in run) return run;
  if (!(TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
    return { error: `Run is ${run.status}; cancel it first` };
  }

  const { error } = await ctx.supabase
    .from('workflow_runs')
    .delete()
    .eq('id', runId)
    .eq('workspace_id', ctx.workspaceId)
    .in('status', TERMINAL_STATUSES as readonly string[] as string[]);
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

export async function deleteRuns(ids: string[]): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  if (ids.length === 0) return { ok: true };

  const { error } = await ctx.supabase
    .from('workflow_runs')
    .delete()
    .in('id', ids)
    .eq('workspace_id', ctx.workspaceId)
    .in('status', TERMINAL_STATUSES as readonly string[] as string[]);
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

/**
 * Re-enqueue a finished run. Actual re-dispatch needs the Phase-3c dispatcher;
 * here we insert a `jobs` row so it runs once a runner is available.
 */
export async function retryRun(runId: string): Promise<ActionResult> {
  const ctx = await guard();
  if ('error' in ctx) return ctx;
  const run = await loadRun(ctx, runId);
  if ('error' in run) return run;
  if (!['failed', 'cancelled'].includes(run.status)) {
    return { error: 'Only failed or cancelled runs can be retried' };
  }

  const kind: Database['public']['Tables']['jobs']['Row']['kind'] =
    run.workflow === 'ci-followup'
      ? 'ci-followup'
      : run.workflow === 'triage'
        ? 'triage'
        : 'autofix';

  const { error } = await ctx.supabase.from('jobs').insert({
    workspace_id: ctx.workspaceId,
    repo: run.repo,
    kind,
    issue_number: run.issue_number,
    pr_number: run.pr_number,
    status: 'queued',
    max_attempts: 1,
    payload: { retryOf: runId },
  });
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true };
}

/**
 * Phase 3c — put a fresh workflow job on the `jobs` queue. The `/api/cron/dispatch`
 * cron claims it and runs it via the engine (persisting `workflow_runs` etc.).
 * This is the minimal "enqueue from the UI" path; `retryRun` above also inserts
 * jobs.
 */
const ENQUEUEABLE_KINDS: readonly JobKind[] = ['autofix', 'triage', 'ci-followup'];

export async function enqueueWorkflowRun(params: {
  workflow: JobKind;
  issueNumber?: number;
  prNumber?: number;
}): Promise<ActionResult & { jobId?: string }> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role === 'viewer') return { error: 'Viewers cannot start runs' };

  if (!ENQUEUEABLE_KINDS.includes(params.workflow)) {
    return { error: 'Unsupported workflow kind' };
  }
  if (
    params.issueNumber != null &&
    (!Number.isInteger(params.issueNumber) || params.issueNumber <= 0)
  ) {
    return { error: 'Invalid issue number' };
  }
  if (params.prNumber != null && (!Number.isInteger(params.prNumber) || params.prNumber <= 0)) {
    return { error: 'Invalid PR number' };
  }

  const repo =
    workspace.repoOwner && workspace.repoName
      ? `${workspace.repoOwner}/${workspace.repoName}`
      : null;

  const supabase = createSupabaseAdminClient();

  // Dedupe: a double-click, network burst, or stale tab must not queue two
  // jobs for the same workflow+issue. If one's already in flight, return it.
  if (params.issueNumber != null) {
    const { data: existing } = await supabase
      .from('jobs')
      .select('id')
      .eq('workspace_id', workspace.id)
      .eq('kind', params.workflow)
      .eq('issue_number', params.issueNumber)
      .in('status', ['queued', 'claimed', 'running'])
      .limit(1);
    if (existing && existing.length > 0) {
      return { ok: true, jobId: existing[0].id };
    }
  }

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      workspace_id: workspace.id,
      repo,
      kind: params.workflow,
      issue_number: params.issueNumber ?? null,
      pr_number: params.prNumber ?? null,
      status: 'queued',
      priority: 10,
      max_attempts: 1,
      payload: {},
    })
    .select('id')
    .single();
  if (error) return { error: error.message };
  revalidatePath('/cockpit');
  return { ok: true, jobId: data?.id };
}
