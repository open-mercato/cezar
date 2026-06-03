import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '@cezar/core';
import type { Database } from './supabase/types';

/**
 * The triage-run outcome shape `maybeEnqueueAutofixFromTriage` reads — a subset
 * of `@cezar/core`'s `TriageOutcome` (we accept anything structurally close so
 * the runner-finalize PATCH route can pass its JSON `outcome` straight through).
 */
export interface TriageOutcomeLike {
  route?: string | null;
  issueType?: string | null;
  bugConfidence?: number | null;
  bugReason?: string | null;
  priority?: string | null;
  priorityReason?: string | null;
}

export interface MaybeEnqueueAutofixParams {
  workspaceId: string;
  /** owner/repo as stored on the originating job/run (informational on the job row). */
  repo: string | null;
  issueNumber: number;
  outcome: TriageOutcomeLike | null | undefined;
  /** Resolved workspace `Config` — for `autofix.minBugConfidence`. Optional: defaults are used if absent. */
  workspaceConfig?: Pick<Config, 'autofix'> | null;
  /**
   * Phase 4 (migration 0026) soft affinity — the runner that handled the
   * parent triage job. When set, the follow-up autofix job gets it as
   * `preferred_runner_id` with a 30s `preferred_until` so the same runner
   * reuses its warm bare clone / on-disk Claude session. Null/undefined
   * (cron path, or parent ran on the cron path) → no affinity, behaves as
   * before. Triage entry-point jobs (no parent) should never set this.
   */
  parentRunnerId?: string | null;
}

/** Phase 4 — soft affinity window. Long enough for a heartbeat to land and a
 *  fresh claim to fire, short enough that a wedged/slow runner can't strand a
 *  follow-up for more than a few seconds. */
const SOFT_AFFINITY_WINDOW_MS = 30_000;

const DEFAULT_MIN_BUG_CONFIDENCE = 0.7;

/**
 * Phase 5 — when a `triage` run concludes `route: 'autofix'`, this decides
 * whether to put an `autofix` job on the queue. Conservative by §7.17:
 *   - only if the workspace has `autofix_enabled` (the triage summary comment
 *     already told the user when it's off),
 *   - only if the issue is classified `bug` and `bugConfidence ≥ minBugConfidence`
 *     (below threshold → no enqueue; a triage-driven human-gate pause is a
 *     follow-up TODO(phase-5)),
 *   - deduped: skip if there's already a queued/claimed/running autofix `jobs`
 *     row, or a non-terminal autofix `workflow_runs` row, or the issue is
 *     already `analysis.autofixStatus === 'pr-opened'`. (The autofix workflow's
 *     own `verify-in-repo` step also skip-runs an already-fixed issue, so the
 *     dedupe here is pragmatic, not exhaustive.)
 *
 * Never throws — a failure here just means the autofix didn't get queued.
 * Called from `executeWorkflowJob` (cron path) and the runner-finalize PATCH
 * route (`/api/runner/runs/:runId`).
 */
export async function maybeEnqueueAutofixFromTriage(
  adminSupabase: SupabaseClient<Database>,
  params: MaybeEnqueueAutofixParams,
): Promise<{ enqueued: boolean; reason?: string }> {
  const { workspaceId, repo, issueNumber, outcome, workspaceConfig, parentRunnerId } = params;
  try {
    if (!outcome || outcome.route !== 'autofix') return { enqueued: false, reason: 'route is not autofix' };

    const { data: ws, error: wsErr } = await adminSupabase
      .from('workspaces')
      .select('autofix_enabled')
      .eq('id', workspaceId)
      .single();
    if (wsErr) return { enqueued: false, reason: `workspace lookup failed: ${wsErr.message}` };
    if (!ws?.autofix_enabled) return { enqueued: false, reason: 'autofix disabled for workspace' };

    if (outcome.issueType !== 'bug') return { enqueued: false, reason: `issueType '${outcome.issueType ?? 'unknown'}' is not a bug` };
    const threshold = workspaceConfig?.autofix?.minBugConfidence ?? DEFAULT_MIN_BUG_CONFIDENCE;
    const confidence = typeof outcome.bugConfidence === 'number' ? outcome.bugConfidence : 0;
    if (confidence < threshold) {
      return { enqueued: false, reason: `bugConfidence ${confidence.toFixed(2)} < threshold ${threshold.toFixed(2)}` };
    }

    // ── dedupe ──
    {
      const { data: openJobs } = await adminSupabase
        .from('jobs')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('kind', 'autofix')
        .eq('issue_number', issueNumber)
        .in('status', ['queued', 'claimed', 'running'])
        .limit(1);
      if (openJobs && openJobs.length > 0) return { enqueued: false, reason: 'an autofix job is already queued/running for this issue' };

      const { data: openRuns } = await adminSupabase
        .from('workflow_runs')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('workflow', 'autofix')
        .eq('issue_number', issueNumber)
        .in('status', ['queued', 'running', 'paused'])
        .limit(1);
      if (openRuns && openRuns.length > 0) return { enqueued: false, reason: 'an autofix run is already in flight for this issue' };

      const { data: issueRow } = await adminSupabase
        .from('issues')
        .select('analysis')
        .eq('workspace_id', workspaceId)
        .eq('number', issueNumber)
        .maybeSingle();
      const analysis = (issueRow?.analysis ?? {}) as { autofixStatus?: string | null };
      if (analysis.autofixStatus === 'pr-opened') return { enqueued: false, reason: 'issue already has an autofix PR open' };
    }

    // Phase 4 soft affinity — prefer the runner that handled the parent
    // triage when one is known (cron-path parents leave it null, which
    // means "no preference; any matching runner may claim").
    const preferred = parentRunnerId
      ? {
          preferred_runner_id: parentRunnerId,
          preferred_until: new Date(Date.now() + SOFT_AFFINITY_WINDOW_MS).toISOString(),
        }
      : {};
    const { error: insErr } = await adminSupabase.from('jobs').insert({
      workspace_id: workspaceId,
      repo,
      kind: 'autofix',
      issue_number: issueNumber,
      pr_number: null,
      priority: 10,
      status: 'queued',
      max_attempts: 1,
      payload: { trigger: 'triage' },
      ...preferred,
    });
    // 23505 = a concurrent path already enqueued this autofix job (partial
    // UNIQUE index from migration 0029) — treat as "already in flight", not a
    // hard failure.
    if (insErr) {
      if (insErr.code === '23505') return { enqueued: false, reason: 'an autofix job is already queued/running for this issue' };
      return { enqueued: false, reason: `enqueue failed: ${insErr.message}` };
    }
    return { enqueued: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[triage→autofix] maybeEnqueueAutofixFromTriage failed:', msg);
    return { enqueued: false, reason: msg };
  }
}
