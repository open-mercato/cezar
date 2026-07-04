'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export interface RunNowResult {
  ok: boolean;
  error?: string;
  workflowRunId?: string;
}

/** Where a run can execute. `anthropic-api` runs on the managed cron path; the
 *  `*-cli` backends route the job to a self-hosted runner advertising that
 *  backend (subscription transport, no API key). */
export type ActionBackend = 'anthropic-api' | 'claude-cli' | 'codex-cli';
const ACTION_BACKENDS: ActionBackend[] = ['anthropic-api', 'claude-cli', 'codex-cli'];

/**
 * Queue a "run this action against this issue or PR" job and return
 * immediately so the modal can close and navigate to `/cockpit/[runId]`
 * without blocking the UI for the whole run.
 *
 * Validates fast (auth, action exists, target is in the local store), creates
 * the `workflow_runs` row up front as `queued` so the cockpit has something to
 * render, then enqueues an `action` job. The dispatch worker claims it and runs
 * `core.runAction` in the background via `executeActionJob` — flipping the run
 * to `running`, applying effects, and finalizing it.
 *
 * The `number` arg is the issue/PR number — which table it resolves against is
 * determined by `actionRow.target`. PRs live in `pull_requests` (synced by
 * /api/cron/sync), not `issues`.
 */
export async function enqueueActionRun(
  actionId: string,
  number: number,
  backend?: ActionBackend,
): Promise<RunNowResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  // Validate the backend against the known set — default to the managed API
  // path so the prior behaviour is preserved when the caller omits it.
  const requiredBackend: ActionBackend =
    backend && ACTION_BACKENDS.includes(backend) ? backend : 'anthropic-api';

  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can run actions' };

  const supabase = createSupabaseAdminClient();

  const { data: actionRow } = await supabase
    .from('actions')
    .select('id, name, target')
    .eq('id', actionId)
    .eq('workspace_id', workspace.id)
    .maybeSingle();
  if (!actionRow) return { ok: false, error: 'Action not found' };

  const isPr = actionRow.target === 'pr';

  // Fail fast with the right noun if the target isn't in the local store —
  // the executor re-reads the full row later in the dispatch context.
  if (isPr) {
    const { data } = await supabase
      .from('pull_requests')
      .select('number')
      .eq('workspace_id', workspace.id)
      .eq('number', number)
      .maybeSingle();
    if (!data)
      return {
        ok: false,
        error: `PR #${number} not in the workspace's PR store — run /api/cron/sync to refresh`,
      };
  } else {
    const { data } = await supabase
      .from('issues')
      .select('number')
      .eq('workspace_id', workspace.id)
      .eq('number', number)
      .maybeSingle();
    if (!data) return { ok: false, error: `Issue #${number} not in the workspace's issue store` };
  }

  const repoSlug = `${workspace.repoOwner}/${workspace.repoName}`;

  // Pre-create the workflow_runs row as `queued` so the modal can navigate to
  // /cockpit/[runId] immediately; the executor binds to it and flips it to
  // `running` when the worker picks the job up.
  const runId = randomUUID();
  const { error: runErr } = await supabase.from('workflow_runs').insert({
    id: runId,
    workspace_id: workspace.id,
    workflow: 'single-action',
    repo: repoSlug,
    issue_number: isPr ? null : number,
    pr_number: isPr ? number : null,
    status: 'queued',
  });
  if (runErr) return { ok: false, error: `Could not create workflow run: ${runErr.message}` };

  const { error: jobErr } = await supabase.from('jobs').insert({
    workspace_id: workspace.id,
    repo: repoSlug,
    kind: 'action',
    issue_number: isPr ? null : number,
    pr_number: isPr ? number : null,
    priority: 5,
    status: 'queued',
    max_attempts: 1,
    // The backend selects where this action executes: `anthropic-api` is claimed
    // by the cron dispatcher; a `*-cli` backend is claimed by a self-hosted
    // runner advertising it, which runs `core.runAction` over that CLI transport.
    required_backend: requiredBackend,
    payload: { trigger: 'manual', actionId, runId, target: actionRow.target },
  });
  if (jobErr) {
    // Roll the orphaned run forward to a terminal state so it doesn't sit
    // stuck on `queued` forever in the cockpit.
    await supabase
      .from('workflow_runs')
      .update({
        status: 'failed',
        reason: `enqueue failed: ${jobErr.message}`,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
    return { ok: false, error: `Could not queue action: ${jobErr.message}` };
  }

  revalidatePath('/cockpit');
  return { ok: true, workflowRunId: runId };
}

export interface RunNowIssue {
  number: number;
  title: string;
}

/**
 * Top-20 most-recently-updated issues from the local cache, used to populate
 * the "Run now" modal's dropdown. PR-targeted actions get the same list —
 * the GUI doesn't cache PRs separately, so the modal falls back to a free
 * number input on the client side when `target === 'pr'`.
 */
export async function listRecentIssuesForRunNow(): Promise<RunNowIssue[]> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return [];

  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('issues')
    .select('number, title')
    .eq('workspace_id', workspace.id)
    .order('updated_at', { ascending: false })
    .limit(20);
  return (data ?? []).map((r) => ({ number: r.number, title: r.title ?? '' }));
}

/**
 * Which backends can actually run an action right now: `anthropic-api` is always
 * available (the managed cron path), plus any CLI backend advertised by a live
 * self-hosted runner (status `online`, heartbeat within the last 5 minutes,
 * scoped to this workspace or a managed/global runner). The "Run now" modal uses
 * this to grey out backends with no runner so a job can't sit unclaimed.
 */
export async function listAvailableBackends(): Promise<ActionBackend[]> {
  const available = new Set<ActionBackend>(['anthropic-api']);
  const workspace = await getActiveWorkspace();
  if (!workspace) return [...available];

  const supabase = createSupabaseAdminClient();
  const freshSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('runners')
    .select('backends, workspace_id, status, last_heartbeat_at')
    .eq('status', 'online')
    .gte('last_heartbeat_at', freshSince)
    .or(`workspace_id.eq.${workspace.id},workspace_id.is.null`);

  for (const row of data ?? []) {
    for (const b of row.backends ?? []) {
      if ((ACTION_BACKENDS as string[]).includes(b)) available.add(b as ActionBackend);
    }
  }
  return ACTION_BACKENDS.filter((b) => available.has(b));
}
