// Pure-function body of the /api/cron/dispatch route — shared between the HTTP
// handler (auth-gated) and the in-process scheduler (trusted, no auth). Same
// fire-and-forget semantics as before: each claimed job's workflow execution
// outlives this call.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CiFollowupInput } from '@cezar/core';
import { executeWorkflowJob } from '@/lib/execute-workflow-job';
import { executeActionJob } from '@/lib/execute-action-job';
import { executeLabelAnalysisJob } from '@/lib/execute-label-analysis-job';
import { executeSyncJob } from '@/lib/execute-sync-job';
import type { Database } from '@/lib/supabase/types';

type WorkflowJobKind = 'triage' | 'autofix' | 'ci-followup' | 'flow';

type JobRow = Database['public']['Tables']['jobs']['Row'];

export interface DispatchResult {
  claimed: number;
  requeued: number;
  error?: string;
}

// Last-resort cleanup for a job whose executor promise rejected *before/outside*
// its own try/catch (e.g. a synchronous throw while dynamically importing
// `@cezar/core`). In the normal path the executor finalizes the job itself; here
// the row would otherwise sit stuck in `running` (holding its claim lease and
// blocking dedupe in triage) until the watchdog's lease reclaim fires. Fail it
// immediately and drop the lease so the row's lifetime is always bound.
async function failStuckJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  err: unknown,
): Promise<void> {
  console.error(`[dispatch] job ${jobId} crashed:`, err);
  const { error } = await supabase
    .from('jobs')
    .update({ status: 'failed', claim_expires_at: null, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'running');
  if (error) console.error(`[dispatch] could not fail stuck job ${jobId}:`, error.message);
}

// Lease window for cron-dispatched jobs. Unlike the runner path (60s lease +
// heartbeat), the cron path runs jobs in the same long-lived process, so we
// renew the lease from here while the job runs (see startLeaseRenewal). Without
// renewal a job that outran the fixed lease — e.g. a full sync of a few hundred
// PRs taking longer than the lease — would be reclaimed mid-run by
// `requeue_jobs_for_offline_runners` and, with `max_attempts = 1`, marked
// `failed` while still executing.
const CRON_LEASE_SECONDS = Number(process.env.CEZAR_DISPATCH_LEASE_SECONDS) || 300;

/**
 * Keep a claimed job's lease ahead of the watchdog while it executes. Renews
 * `claim_expires_at` on an interval (half the lease window) until the returned
 * stop fn is called. The timer is `unref`'d so it never holds the process open
 * on its own — the executor's own pending I/O does. The `.in('status', …)`
 * guard means a job the watchdog already reclaimed (back to `queued`/`failed`)
 * isn't resurrected.
 */
function startLeaseRenewal(
  supabase: SupabaseClient<Database>,
  jobId: string,
  leaseSeconds: number,
): () => void {
  const renewEveryMs = Math.max(30_000, Math.floor((leaseSeconds * 1000) / 2));
  const tick = () => {
    void supabase
      .from('jobs')
      .update({ claim_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
      .eq('id', jobId)
      .in('status', ['claimed', 'running'])
      .then(({ error }) => {
        if (error) console.error(`[dispatch] lease renew for ${jobId} failed:`, error.message);
      });
  };
  const iv = setInterval(tick, renewEveryMs);
  (iv as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(iv);
}

/**
 * Fire-and-forget a claimed job's executor with lease renewal: the lease is
 * kept alive for the whole run and dropped when it settles, and a rejection is
 * funneled to `failStuckJob` so the row never sits stuck in `running`.
 */
function launchJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  run: () => Promise<void>,
): void {
  const stopRenewal = startLeaseRenewal(supabase, jobId, CRON_LEASE_SECONDS);
  void run()
    .catch((err) => failStuckJob(supabase, jobId, err))
    .finally(stopRenewal);
}

export async function runDispatch(supabase: SupabaseClient<Database>): Promise<DispatchResult> {
  const DISPATCH_BATCH = Number(process.env.CEZAR_DISPATCH_BATCH) || 3;
  const STALE_MINUTES = Number(process.env.CEZAR_DISPATCH_STALE_MINUTES) || 15;
  const OFFLINE_RUNNER_MINUTES = Number(process.env.CEZAR_RUNNER_OFFLINE_MINUTES) || 3;

  // ── watchdog ──
  let requeued = 0;
  {
    const { data, error } = await supabase.rpc('requeue_stalled_jobs', {
      p_stale_minutes: STALE_MINUTES,
    });
    if (error) console.error('[dispatch] requeue_stalled_jobs failed:', error.message);
    else requeued = typeof data === 'number' ? data : 0;
  }
  {
    const { data, error } = await supabase.rpc('requeue_jobs_for_offline_runners', {
      p_stale_minutes: OFFLINE_RUNNER_MINUTES,
    });
    if (error) console.error('[dispatch] requeue_jobs_for_offline_runners failed:', error.message);
    else requeued += typeof data === 'number' ? data : 0;
  }
  {
    // GC the webhook delivery-id dedup table (migration 0029). Best-effort;
    // retention only needs to outlive GitHub's retry window.
    const { error } = await supabase.rpc('prune_webhook_deliveries', {
      p_retention_hours: Number(process.env.CEZAR_WEBHOOK_DEDUP_RETENTION_HOURS) || 48,
    });
    if (error) console.error('[dispatch] prune_webhook_deliveries failed:', error.message);
  }

  // ── claim ──
  // Stamp the initial lease (migration 0025); `startLeaseRenewal` keeps it
  // ahead of the watchdog for the whole run, so a job that outlives the lease
  // window (e.g. a large sync) is no longer reclaimed and failed mid-flight.
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_next_job', {
    p_limit: DISPATCH_BATCH,
    p_lease_seconds: CRON_LEASE_SECONDS,
  });
  if (claimErr) {
    console.error('[dispatch] claim_next_job failed:', claimErr.message);
    return { claimed: 0, requeued, error: claimErr.message };
  }
  const jobs = (claimed ?? []) as JobRow[];
  if (jobs.length === 0) return { claimed: 0, requeued };

  let dispatched = 0;
  for (const job of jobs) {
    const { error: runErr } = await supabase
      .from('jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'claimed');
    if (runErr) {
      console.error(`[dispatch] could not mark job ${job.id} running:`, runErr.message);
      continue;
    }

    const payload = (job.payload ?? {}) as {
      ciFollowup?: CiFollowupInput;
      flowId?: string;
      flowInput?: string;
      analysisId?: string;
      actionId?: string;
      runId?: string;
      /** Triage jobs: the derived ActionTrigger (webhook) or a legacy marker
       *  ('sweep'/'webhook'); executeWorkflowJob validates + defaults it. */
      trigger?: string;
    };

    // Manual "run action on issue/PR" — not a multi-step workflow_run; it runs
    // a single action against its target and binds to the workflow_runs row
    // that enqueueActionRun pre-created.
    if (job.kind === 'action') {
      const number = job.pr_number ?? job.issue_number;
      if (!payload.actionId || !payload.runId || number == null) {
        console.error(
          `[dispatch] action job ${job.id} missing payload.actionId/runId or target number`,
        );
        await supabase
          .from('jobs')
          .update({
            status: 'failed',
            claim_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        continue;
      }
      launchJob(supabase, job.id, () =>
        executeActionJob(supabase, {
          workspaceId: job.workspace_id,
          jobId: job.id,
          runId: payload.runId!,
          actionId: payload.actionId!,
          number,
        }),
      );
      dispatched += 1;
      continue;
    }

    // Label analysis is not a workflow_run — it has no per-issue target and
    // no agent steps, so it routes to its own executor and writes only to
    // workspace_label_analyses.
    if (job.kind === 'label-analysis') {
      const analysisId = payload.analysisId;
      if (!analysisId) {
        console.error(`[dispatch] label-analysis job ${job.id} missing payload.analysisId`);
        await supabase
          .from('jobs')
          .update({
            status: 'failed',
            claim_expires_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        continue;
      }
      launchJob(supabase, job.id, () =>
        executeLabelAnalysisJob(supabase, {
          workspaceId: job.workspace_id,
          jobId: job.id,
          analysisId,
        }),
      );
      dispatched += 1;
      continue;
    }

    if (job.kind === 'sync') {
      // Reconcile sync (issues + PRs + digests + comments) — not a workflow_run;
      // routes to its own executor which runs the shared sync engine.
      const [repoOwner, repoName] = (job.repo ?? '/').split('/');
      launchJob(supabase, job.id, () =>
        executeSyncJob(supabase, {
          workspaceId: job.workspace_id,
          jobId: job.id,
          repoOwner,
          repoName,
        }),
      );
      dispatched += 1;
      continue;
    }

    launchJob(supabase, job.id, () =>
      executeWorkflowJob(supabase, {
        workspaceId: job.workspace_id,
        repo: job.repo,
        workflow: job.kind as WorkflowJobKind,
        issueNumber: job.issue_number ?? undefined,
        prNumber: job.pr_number ?? undefined,
        jobId: job.id,
        ciFollowupSeed: payload.ciFollowup,
        flowId: payload.flowId,
        flowInput: payload.flowInput,
        triageTrigger: payload.trigger,
      }),
    );
    dispatched += 1;
  }

  return { claimed: dispatched, requeued };
}
