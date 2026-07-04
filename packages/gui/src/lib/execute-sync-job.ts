import type { SupabaseClient } from '@supabase/supabase-js';
import { buildSyncContext, runSyncPhases, writeSyncStatus } from './sync/run-workspace-sync';
import { classifySyncError } from './sync/classify-sync-error';
import { resolveWorkspaceToken } from './sync/resolve-workspace-token';
import type { Database } from './supabase/types';

export interface ExecuteSyncJobParams {
  workspaceId: string;
  jobId: string;
  repoOwner: string;
  repoName: string;
}

/**
 * Unified-sync executor — runs end-to-end synchronously inside a dispatcher
 * tick. NOT a workflow_run: a reconcile sync has no per-issue target, no agent
 * steps, and no PR outcome, so it routes around executeWorkflowJob and runs the
 * shared sync engine (issues + PRs + digests + comments), which writes its own
 * per-phase + terminal `sync_status`. The CALLER (this fn) writes the initial
 * `'syncing'` start row and finalizes the `jobs` row.
 */
export async function executeSyncJob(
  supabase: SupabaseClient<Database>,
  params: ExecuteSyncJobParams,
): Promise<void> {
  const { workspaceId, jobId, repoOwner, repoName } = params;

  const finishJob = async (
    status: Database['public']['Tables']['jobs']['Row']['status'],
  ): Promise<void> => {
    // Drop the lease (migration 0025) on completion; guard on `running` like
    // the dispatch path so a watchdog requeue can't be clobbered.
    await supabase
      .from('jobs')
      .update({ status, claim_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'running');
  };

  // ── Resolve a GitHub token: prefer the GitHub App installation token
  //    (least-privilege), fall back to a workspace admin's OAuth token. ──
  const core = await import('@cezar/core');
  let token: string | null = null;
  try {
    if (core.GitHubAppService.isConfigured()) {
      token = await new core.GitHubAppService().getInstallationToken(repoOwner);
    }
  } catch (err) {
    console.warn(
      '[sync] installation token fetch failed; falling back to admin OAuth token:',
      err instanceof Error ? err.message : err,
    );
  }
  if (!token) token = await resolveWorkspaceToken(workspaceId, supabase);

  if (!token) {
    await writeSyncStatus(supabase, workspaceId, {
      status: 'error',
      phase: null,
      error: 'no github token available for workspace',
      // No usable token ⇒ an auth-recovery case (Reconnect / reinstall the App).
      error_kind: 'auth',
      finished_at: new Date().toISOString(),
    });
    await supabase
      .from('jobs')
      .update({ status: 'failed', claim_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'running');
    return;
  }

  try {
    // The initial `'syncing'` start row — runSyncPhases owns every row after
    // this (per-phase progress + the terminal done/error).
    await writeSyncStatus(supabase, workspaceId, {
      status: 'syncing',
      phase: 'issues',
      message: 'Fetching issues…',
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
    });

    const { store, github, config, digestPolicy } = await buildSyncContext({
      supabase,
      workspaceId,
      repoOwner,
      repoName,
      token,
    });
    // Cron path: pass the digest policy but DON'T force — digests follow their
    // own cadence (auto) / on-demand-only (manual) / off, except on the initial
    // import which `runSyncPhases` always digests.
    await runSyncPhases({ supabase, workspaceId, store, github, config, digestPolicy });

    await finishJob('done');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sync] job failed:', message);
    await writeSyncStatus(supabase, workspaceId, {
      status: 'error',
      phase: null,
      error: message,
      error_kind: classifySyncError(err),
      finished_at: new Date().toISOString(),
    });
    await supabase
      .from('jobs')
      .update({ status: 'failed', claim_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'running');
  }
}
