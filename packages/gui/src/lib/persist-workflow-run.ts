import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentRunRecord } from '@cezar/core';
import type { Database, AgentRunEventType } from './supabase/types';

type AgentRunsRow = Database['public']['Tables']['agent_runs']['Row'];

/**
 * High-stakes writes get a small in-memory retry with exponential backoff so a
 * transient Supabase blip (rate-limit / connection reset) doesn't silently
 * leave the run in a partial-write state. Transient `agent_run_events` inserts
 * stay fire-and-forget (no retry) — losing one of those is cheap.
 */
const PERSIST_MAX_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = 200;

export interface CreateWorkflowRunOpts {
  workspaceId: string;
  jobId?: string | null;
  /**
   * The `workflow_runs.workflow` column — plain text. Built-ins are 'autofix',
   * 'ci-followup', 'triage'; the legacy single-action path uses 'single-action';
   * custom data-driven workflows carry their descriptor id (e.g. 'autofix-lite').
   */
  workflow: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber?: number | null;
  /**
   * Reports a per-write persistence failure (Supabase rejection / network blip),
   * after retries are exhausted for the run's lifecycle writes (insert /
   * finalize / fail) and on first failure for best-effort writes (events, step
   * rows). The persister still never throws — a workflow run shouldn't die
   * because one event insert failed — but every swallowed failure is counted in
   * `failedWrites` and stamped into `workflow_runs.outcome` at finalize. Callers
   * can hook this to log, surface in their legacy event channel, etc. When unset
   * the persister logs a structured single-line `console.error` instead.
   */
  onPersistError?: (label: string, err: unknown) => void;
}

/**
 * The shared `workflow_runs` / `agent_runs` / `agent_run_events` persister.
 * `execute-workflow-job.ts` (the cron dispatch path) builds one and writes
 * through it; the runner-finalize API does its own thinner writes today.
 *
 * Designed for fire-and-forget callers — every write is wrapped in a `safe(...)`
 * try/catch so a transient Supabase error never propagates and kills the run.
 * The run's lifecycle writes (insert / finalize / fail) retry with backoff
 * before giving up; best-effort writes (events, step rows) try once. Any
 * write that exhausts its budget is counted in `failedWrites`.
 * The pause/cancel probes are simple re-reads of the same row.
 */
export interface WorkflowRunPersister {
  /** The `workflow_runs.id` this persister writes against. Null when the initial insert failed. */
  readonly id: string | null;
  /**
   * Count of writes that exhausted their retries and were swallowed. A non-zero
   * value means the persisted view of this run may be inconsistent with what
   * actually happened — `finalize` folds it into `workflow_runs.outcome`
   * (`{ failedWrites: n }`) so the cockpit can flag the row.
   */
  readonly failedWrites: number;
  /**
   * Open an `agent_runs` row with `status='running'` for a step that's about
   * to execute, then emit a matching `step-start` event so the cockpit can
   * render the step card and the ▶ marker as work begins (instead of waiting
   * for the step to finish). Upserts on `(workflow_run_id, step_id,
   * iteration)` — re-deliveries don't double-insert. Best-effort.
   */
  recordStepStart(record: AgentRunRecord): Promise<void>;
  /**
   * Close the `agent_runs` row opened by `recordStepStart` (or insert it
   * outright when no start was delivered — the previous fallback path),
   * then emit a matching `step-end` event tagged with that row's id and
   * bump `workflow_runs.current_step_id` to this step. Best-effort.
   */
  recordAgentRun(record: AgentRunRecord): Promise<void>;
  /** Append one `agent_run_events` row (best-effort). */
  recordEvent(type: AgentRunEventType, payload: unknown, agentRunId?: string | null): Promise<void>;
  /** Update the `workflow_runs` row with the supplied patch (best-effort). */
  finalize(patch: Database['public']['Tables']['workflow_runs']['Update']): Promise<void>;
  /** Convenience: mark the run failed with `reason` and `finished_at = now`. */
  fail(reason: string): Promise<void>;
  /** True when the `workflow_runs.pause_requested` flag is set. */
  isPauseRequested(): Promise<boolean>;
  /** True when the `workflow_runs.status` has been flipped to `'cancelled'`. */
  isCancelled(): Promise<boolean>;
}

/**
 * Inserts the `workflow_runs` row and returns a persister bound to it.
 * If the insert fails the returned persister's `id` is null and all subsequent
 * writes are no-ops — callers don't need to special-case that.
 */
export async function createWorkflowRunPersister(
  supabase: SupabaseClient<Database>,
  opts: CreateWorkflowRunOpts,
): Promise<WorkflowRunPersister> {
  const { workspaceId, jobId, workflow, repo, issueNumber, prNumber, onPersistError } = opts;

  let failedWrites = 0;

  /**
   * Run `fn`, retrying transient Supabase failures with exponential backoff.
   * `critical` writes (the run row's lifecycle: insert / finalize / fail) get
   * the full retry budget; best-effort writes (events, step rows) try once.
   * On final failure the error is logged with structured context and counted —
   * it never propagates, so a single blip can't kill the run.
   */
  const safe = async (
    label: string,
    fn: () => Promise<void>,
    opts2?: { critical?: boolean },
  ): Promise<void> => {
    const attempts = opts2?.critical ? PERSIST_MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await fn(); return; } catch (err) {
        if (attempt < attempts - 1) {
          await new Promise((r) => setTimeout(r, PERSIST_BACKOFF_MS * 2 ** attempt));
          continue;
        }
        failedWrites++;
        if (onPersistError) onPersistError(label, err);
        else {
          // Structured single-line log so an operator can grep by workspace /
          // run id and reconstruct the intended write from agent traces.
          console.error('[persist-workflow-run] persist failed', JSON.stringify({
            label,
            workspaceId,
            workflowRunId,
            attempts,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        return;
      }
    }
  };

  // Mint the id client-side so the insert is idempotent: a retry after a write
  // that actually landed (e.g. the response was lost to a connection reset)
  // hits `ON CONFLICT DO NOTHING` on the primary key instead of inserting a
  // duplicate run.
  let workflowRunId: string | null = null;
  const candidateId = randomUUID();
  await safe('workflow_runs insert', async () => {
    const { data, error } = await supabase
      .from('workflow_runs')
      .upsert(
        {
          id: candidateId,
          workspace_id: workspaceId,
          job_id: jobId ?? null,
          workflow,
          repo,
          issue_number: issueNumber,
          pr_number: prNumber ?? null,
          status: 'running',
          started_at: new Date().toISOString(),
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      .select('id')
      // `maybeSingle`, not `single`: with `ignoreDuplicates` the conflict path
      // returns zero rows, which `single` would surface as an error and falsely
      // count as a failed write.
      .maybeSingle();
    if (error) throw error;
    // No row means the conflict path was taken (a retry-after-success on the
    // same `candidateId`) — that row already landed, so reuse the id we minted.
    workflowRunId = data?.id ?? candidateId;
  }, { critical: true });

  const recordEvent: WorkflowRunPersister['recordEvent'] = async (type, payload, agentRunId) => {
    if (!workflowRunId) return;
    await safe(`event:${type}`, async () => {
      await supabase.from('agent_run_events').insert({
        workspace_id: workspaceId,
        workflow_run_id: workflowRunId!,
        agent_run_id: agentRunId ?? null,
        type,
        payload: payload as Database['public']['Tables']['agent_run_events']['Row']['payload'],
      });
    });
  };

  const recordStepStart: WorkflowRunPersister['recordStepStart'] = async (r) => {
    if (!workflowRunId) return;
    await safe('agent_runs step-start', async () => {
      // Upsert on the (workflow_run_id, step_id, iteration) unique key from
      // migration 0020 — a re-delivery is a no-op, and the row stays in
      // `running` until `recordAgentRun` closes it.
      const { data, error } = await supabase
        .from('agent_runs')
        .upsert(
          {
            workspace_id: workspaceId,
            workflow_run_id: workflowRunId!,
            step_id: r.stepId,
            iteration: r.iteration,
            kind: (r.kind ?? null) as AgentRunsRow['kind'],
            backend: r.backend,
            model: r.model,
            status: 'running',
            started_at: r.startedAt,
            tokens_used: 0,
            // Phase 2: stamp the per-run claude session id (migration 0024)
            // so the cockpit can show "session XYZ" and a re-claim can read
            // it back to `claude --resume <id>`.
            session_id: r.sessionId ?? null,
          },
          { onConflict: 'workflow_run_id,step_id,iteration', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (error) throw error;
      await recordEvent(
        'step-start',
        { stepId: r.stepId, iteration: r.iteration, sessionId: r.sessionId ?? null },
        data?.id,
      );
      const updatePatch: Database['public']['Tables']['workflow_runs']['Update'] = { current_step_id: r.stepId };
      // First step that mints a session id seeds `workflow_runs.session_id`.
      // We only set it if it isn't already populated (the column has a
      // `coalesce`-style "first writer wins" semantic — same as the RPC).
      if (r.sessionId) updatePatch.session_id = r.sessionId;
      await supabase.from('workflow_runs').update(updatePatch).eq('id', workflowRunId!);
    });
  };

  const recordAgentRun: WorkflowRunPersister['recordAgentRun'] = async (r) => {
    if (!workflowRunId) return;
    await safe('agent_runs step-end', async () => {
      // Upsert closes the row opened by `recordStepStart` (or inserts it
      // outright if start wasn't delivered — the previous fallback path).
      const { data, error } = await supabase
        .from('agent_runs')
        .upsert(
          {
            workspace_id: workspaceId,
            workflow_run_id: workflowRunId!,
            step_id: r.stepId,
            iteration: r.iteration,
            kind: (r.kind ?? null) as AgentRunsRow['kind'],
            backend: r.backend,
            model: r.model,
            status: r.status === 'running' ? 'running' : r.status,
            started_at: r.startedAt,
            finished_at: r.finishedAt ?? null,
            tokens_used: r.tokensUsed,
            summary: r.summary ?? null,
            error: r.error ?? null,
            session_id: r.sessionId ?? null,
          },
          { onConflict: 'workflow_run_id,step_id,iteration', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (error) throw error;
      await recordEvent(
        'step-end',
        { stepId: r.stepId, iteration: r.iteration, status: r.status, summary: r.summary, error: r.error, sessionId: r.sessionId ?? null },
        data?.id,
      );
      const updatePatch: Database['public']['Tables']['workflow_runs']['Update'] = { current_step_id: r.stepId };
      if (r.sessionId) updatePatch.session_id = r.sessionId;
      await supabase.from('workflow_runs').update(updatePatch).eq('id', workflowRunId!);
    });
  };

  const finalize: WorkflowRunPersister['finalize'] = async (patch) => {
    if (!workflowRunId) return;
    // Fold the swallowed-write count into `outcome` so a non-zero value is
    // visible in the cockpit (the row may be inconsistent with reality). We
    // merge rather than clobber any caller-supplied outcome.
    const finalPatch: Database['public']['Tables']['workflow_runs']['Update'] = { ...patch };
    if (failedWrites > 0) {
      const base = (patch.outcome && typeof patch.outcome === 'object' && !Array.isArray(patch.outcome))
        ? (patch.outcome as Record<string, unknown>)
        : {};
      finalPatch.outcome = { ...base, failedWrites } as Database['public']['Tables']['workflow_runs']['Update']['outcome'];
    }
    await safe('workflow_runs finalize', async () => {
      await supabase.from('workflow_runs').update(finalPatch).eq('id', workflowRunId!);
    }, { critical: true });
  };

  const fail: WorkflowRunPersister['fail'] = async (reason) => {
    if (!workflowRunId) return;
    await finalize({ status: 'failed', reason, finished_at: new Date().toISOString() });
  };

  const isPauseRequested = async (): Promise<boolean> => {
    if (!workflowRunId) return false;
    const { data } = await supabase
      .from('workflow_runs')
      .select('pause_requested')
      .eq('id', workflowRunId)
      .single();
    return data?.pause_requested === true;
  };

  const isCancelled = async (): Promise<boolean> => {
    if (!workflowRunId) return false;
    const { data } = await supabase
      .from('workflow_runs')
      .select('status')
      .eq('id', workflowRunId)
      .single();
    return data?.status === 'cancelled';
  };

  return {
    get id() { return workflowRunId; },
    get failedWrites() { return failedWrites; },
    recordStepStart,
    recordAgentRun,
    recordEvent,
    finalize,
    fail,
    isPauseRequested,
    isCancelled,
  };
}
