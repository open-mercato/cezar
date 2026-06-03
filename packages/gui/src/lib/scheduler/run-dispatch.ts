// Pure-function body of the /api/cron/dispatch route — shared between the HTTP
// handler (auth-gated) and the in-process scheduler (trusted, no auth). Same
// fire-and-forget semantics as before: each claimed job's workflow execution
// outlives this call.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CiFollowupInput } from '@cezar/core';
import { executeWorkflowJob } from '@/lib/execute-workflow-job';
import { executeLabelAnalysisJob } from '@/lib/execute-label-analysis-job';
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

export async function runDispatch(supabase: SupabaseClient<Database>): Promise<DispatchResult> {
  const DISPATCH_BATCH = Number(process.env.CEZAR_DISPATCH_BATCH) || 3;
  const STALE_MINUTES = Number(process.env.CEZAR_DISPATCH_STALE_MINUTES) || 15;
  const OFFLINE_RUNNER_MINUTES = Number(process.env.CEZAR_RUNNER_OFFLINE_MINUTES) || 3;

  // ── watchdog ──
  let requeued = 0;
  {
    const { data, error } = await supabase.rpc('requeue_stalled_jobs', { p_stale_minutes: STALE_MINUTES });
    if (error) console.error('[dispatch] requeue_stalled_jobs failed:', error.message);
    else requeued = typeof data === 'number' ? data : 0;
  }
  {
    const { data, error } = await supabase.rpc('requeue_jobs_for_offline_runners', { p_stale_minutes: OFFLINE_RUNNER_MINUTES });
    if (error) console.error('[dispatch] requeue_jobs_for_offline_runners failed:', error.message);
    else requeued += typeof data === 'number' ? data : 0;
  }

  // ── claim ──
  // 5-minute lease (migration 0025): cron handlers are fire-and-forget and
  // individual workflow jobs can run a few minutes. The longer lease avoids
  // needing an in-handler renewal tick (the runner-side 60s lease has a
  // heartbeat tick to renew it; the cron path doesn't).
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_next_job', {
    p_limit: DISPATCH_BATCH,
    p_lease_seconds: 300,
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
    };

    // Label analysis is not a workflow_run — it has no per-issue target and
    // no agent steps, so it routes to its own executor and writes only to
    // workspace_label_analyses.
    if (job.kind === 'label-analysis') {
      const analysisId = payload.analysisId;
      if (!analysisId) {
        console.error(`[dispatch] label-analysis job ${job.id} missing payload.analysisId`);
        await supabase
          .from('jobs')
          .update({ status: 'failed', claim_expires_at: null, updated_at: new Date().toISOString() })
          .eq('id', job.id);
        continue;
      }
      void executeLabelAnalysisJob(supabase, {
        workspaceId: job.workspace_id,
        jobId: job.id,
        analysisId,
      }).catch((err) => failStuckJob(supabase, job.id, err));
      dispatched += 1;
      continue;
    }

    void executeWorkflowJob(supabase, {
      workspaceId: job.workspace_id,
      repo: job.repo,
      workflow: job.kind as WorkflowJobKind,
      issueNumber: job.issue_number ?? undefined,
      prNumber: job.pr_number ?? undefined,
      jobId: job.id,
      ciFollowupSeed: payload.ciFollowup,
      flowId: payload.flowId,
      flowInput: payload.flowInput,
    }).catch((err) => failStuckJob(supabase, job.id, err));
    dispatched += 1;
  }

  return { claimed: dispatched, requeued };
}
