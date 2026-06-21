import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authRunner, runnerScopesWorkspace } from '../../_auth';
import {
  maybeEnqueueAutofixFromTriage,
  type TriageOutcomeLike,
} from '@/lib/maybe-enqueue-autofix-from-triage';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import type { Database, DbWorkflowRunStatus, JobStatus } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/runner/runs/:runId → `{ pause_requested, status }` so the runner can
 * poll for pause/cancel. (The daemon mainly learns this via the heartbeat reply;
 * this endpoint is a harmless belt-and-braces.) */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;
  const { runId } = await params;

  const { data: run } = await admin
    .from('workflow_runs')
    .select('workspace_id, pause_requested, status')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  if (!runnerScopesWorkspace(runner, run.workspace_id))
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return NextResponse.json({ pause_requested: run.pause_requested, status: run.status });
}

/** The runner reports one of these run statuses; anything else is rejected
 *  (rather than silently mapped to `failed`, which a typo could trigger). */
const RunStatus = z.enum([
  'succeeded',
  'failed',
  'paused',
  'cancelled',
  'dry-run',
  'pr-opened',
  'pushed',
  'skipped',
]);

const FinalizeBodySchema = z
  .object({
    status: RunStatus,
    // `outcome` is opaque cockpit JSONB whose shape varies by workflow (autofix /
    // ci-followup / flow / triage). We keep it loose here (an object or null) and
    // strictly validate the *triage*-influencing subset at the point of use below,
    // where it actually gates the autofix enqueue.
    outcome: z.union([z.record(z.unknown()), z.null()]).optional(),
    prUrl: z.string().nullable().optional(),
    prNumber: z.number().int().nullable().optional(),
    branch: z.string().nullable().optional(),
    headSha: z.string().nullable().optional(),
    // Bounded so a buggy runner can't corrupt cockpit counters with a huge value.
    tokensUsed: z.number().int().min(0).max(10_000_000).optional(),
    reason: z.string().nullable().optional(),
    /** Phase 2: claude session id for this run. Stamped on
     *  `workflow_runs.session_id` if not already set so a future re-claim
     *  can `claude --resume <id>`. */
    sessionId: z.string().nullable().optional(),
  })
  .strict();

/** The triage-influencing subset of `outcome`. Bounded enums + a [0,1]
 *  confidence so a buggy/compromised runner can't force-trigger autofix via a
 *  junk `issueType`/`bugConfidence`. `.passthrough()` keeps any extra fields
 *  (e.g. `route`) flowing through to the enqueue helper. */
const TriageOutcomeSchema = z
  .object({
    route: z.string().nullable().optional(),
    issueType: z.enum(['bug', 'feature', 'question', 'other']).nullable().optional(),
    bugConfidence: z.number().min(0).max(1).nullable().optional(),
    bugReason: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    priorityReason: z.string().nullable().optional(),
  })
  .passthrough();

/** PATCH /api/runner/runs/:runId — the runner reports the final state. Updates
 * `workflow_runs` (+ `finished_at` on terminal) and the linked `jobs` row. */
export async function PATCH(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;
  const { runId } = await params;

  const { data: run } = await admin
    .from('workflow_runs')
    .select('id, job_id, workspace_id, workflow, repo, issue_number')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  if (!runnerScopesWorkspace(runner, run.workspace_id))
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Cap the request body so a buggy/hostile runner can't send a giant payload.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const result = FinalizeBodySchema.safeParse(parsed);
  if (!result.success) {
    return NextResponse.json(
      { error: 'invalid body', details: result.error.flatten() },
      { status: 400 },
    );
  }
  const body = result.data;

  const runStatus = mapRunStatus(body.status);
  const terminal = runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled';
  const patch: Database['public']['Tables']['workflow_runs']['Update'] = {
    status: runStatus,
    outcome: (body.outcome ??
      null) as Database['public']['Tables']['workflow_runs']['Update']['outcome'],
    reason: body.reason ?? null,
    pr_url: body.prUrl ?? null,
    pr_number: body.prNumber ?? null,
    branch: body.branch ?? null,
    head_sha: body.headSha ?? null,
  };
  if (typeof body.tokensUsed === 'number') patch.tokens_used = body.tokensUsed;
  if (terminal || runStatus === 'paused') patch.finished_at = new Date().toISOString();
  // Last-resort writer for `session_id` (the per-event RPC's coalesce path
  // is the primary route; this catches the case where no step event ever
  // landed on the SaaS).
  if (body.sessionId) patch.session_id = body.sessionId;
  await admin.from('workflow_runs').update(patch).eq('id', runId);

  if (run.job_id) {
    const jobStatus: JobStatus =
      runStatus === 'paused'
        ? 'queued' // re-queue a paused run
        : runStatus === 'cancelled'
          ? 'cancelled'
          : runStatus === 'failed'
            ? 'failed'
            : 'done';
    await admin
      .from('jobs')
      .update({
        status: jobStatus,
        claimed_by_runner: null,
        // Drop the lease — the job is no longer in-flight on this runner.
        claim_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', run.job_id);
  }

  // Phase 5 — a runner-driven `triage` run finalizes here; if it concluded
  // `route: 'autofix'` (and the workspace + confidence allow it) queue the
  // follow-up autofix job. Best-effort; never blocks the runner's response.
  if (run.workflow === 'triage' && runStatus === 'succeeded' && run.issue_number != null) {
    // Strictly validate the triage-influencing fields before they can gate the
    // autofix enqueue / land in `issues.analysis`. A junk `issueType` /
    // out-of-range `bugConfidence` from a buggy/compromised runner is rejected
    // here (treated as no triage outcome) rather than trusted.
    const triageParsed = body.outcome ? TriageOutcomeSchema.safeParse(body.outcome) : null;
    if (body.outcome && triageParsed && !triageParsed.success) {
      console.error(
        '[runner-finalize] invalid triage outcome, ignoring:',
        triageParsed.error.flatten(),
      );
    }
    const triageOutcome: TriageOutcomeLike | null = triageParsed?.success
      ? triageParsed.data
      : null;
    // Mirror execute-workflow-job.ts: persist the classification back to
    // `issues.analysis` so the follow-up autofix dispatch passes its
    // `issue.analysis.issueType === 'bug'` gate. The runner reports the
    // outcome shape; we merge into the existing JSONB.
    if (triageOutcome && triageOutcome.issueType) {
      try {
        const { data: issueRow } = await admin
          .from('issues')
          .select('analysis')
          .eq('workspace_id', run.workspace_id)
          .eq('number', run.issue_number)
          .maybeSingle();
        const prev = (issueRow?.analysis ?? {}) as Record<string, unknown>;
        const nowIso = new Date().toISOString();
        const merged = {
          ...prev,
          issueType: triageOutcome.issueType,
          bugConfidence: triageOutcome.bugConfidence ?? null,
          bugReason: triageOutcome.bugReason ?? null,
          bugAnalyzedAt: nowIso,
          priority: triageOutcome.priority ?? null,
          priorityReason: triageOutcome.priorityReason ?? null,
          priorityAnalyzedAt: triageOutcome.priority ? nowIso : null,
        };
        await admin
          .from('issues')
          .update({
            analysis: merged as Database['public']['Tables']['issues']['Update']['analysis'],
          })
          .eq('workspace_id', run.workspace_id)
          .eq('number', run.issue_number);
      } catch (err) {
        console.error(
          '[runner-finalize] persist triage analysis failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    try {
      const config = await loadWorkspaceConfig(run.workspace_id, admin);
      await maybeEnqueueAutofixFromTriage(admin, {
        workspaceId: run.workspace_id,
        repo: run.repo,
        issueNumber: run.issue_number,
        outcome: triageOutcome,
        workspaceConfig: config,
        // Phase 4 soft affinity — the runner finalizing this triage is the
        // same one whose bare clone + on-disk Claude session are warm. Pass
        // it as the follow-up's preferred runner so the autofix lands here
        // first (within the 30s soft window).
        parentRunnerId: runner.id,
      });
    } catch (err) {
      console.error(
        '[runner-finalize] triage→autofix enqueue failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({ ok: true });
}

/** Upper bound on the finalize request body (the runner only sends small JSON
 *  metadata; the `outcome` is a handful of bounded fields). */
const MAX_BODY_BYTES = 256 * 1024;

function mapRunStatus(s: z.infer<typeof RunStatus>): DbWorkflowRunStatus {
  switch (s) {
    case 'succeeded':
    case 'pr-opened':
    case 'pushed':
    case 'dry-run':
    case 'skipped':
      return 'succeeded';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}
