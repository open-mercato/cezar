import type { SupabaseClient } from '@supabase/supabase-js';
import type { CiFollowupInput, Skill, WorkspaceLabel } from '@cezar/core';
import { SupabaseStoreAdapter } from './adapters/supabase-store';
import { loadWorkspaceConfig } from './load-workspace-config';
import { loadWorkspaceLabels } from './load-workspace-labels';
import { createWorkflowRunPersister, type WorkflowRunPersister } from './persist-workflow-run';
import { acquireRepoLock, ensureRepoClone } from './repo-clone';
import { parseTriageTrigger, runTriagePassJob } from './run-triage-pass-job';
import { loadActiveSkillCatalog } from './workflow-config';
import type { Database } from './supabase/types';

type WorkflowKind = 'autofix' | 'ci-followup' | 'triage' | 'flow';

export interface ExecuteWorkflowJobParams {
  workspaceId: string;
  /** owner/repo as stored on the job (informational; the real owner/repo come from the workspace config). */
  repo: string | null;
  workflow: WorkflowKind;
  issueNumber?: number;
  prNumber?: number;
  /** The `jobs` row id this run drains, if any. When set, the row is finalized at the end. */
  jobId?: string | null;
  /** For `ci-followup` jobs — the seed lifted off `jobs.payload.ciFollowup` (a `CiFollowupInput`). */
  ciFollowupSeed?: CiFollowupInput;
  /** For `flow` jobs — the `flows.id` (uuid) whose `steps` to walk. */
  flowId?: string;
  /** For `flow` jobs — the `{{input}}` value passed to the first step (typically the issue number as a string). */
  flowInput?: string;
  /** For `triage` jobs — the raw `jobs.payload.trigger`. Validated here via
   *  `parseTriageTrigger`; absent/unknown values fall back to `'on-issue-opened'`
   *  (covers in-flight jobs enqueued before the field existed and sweep jobs). */
  triageTrigger?: string;
}

/**
 * Phase 3c — the single "run a workflow via the engine + persist
 * workflow_runs / agent_runs / agent_run_events" code path. Used by the
 * `/api/cron/dispatch` route (fire-and-forget, one call per claimed job).
 *
 * Forces `config.workflow.useEngine = true` so the orchestrator delegates to
 * the declarative engine. Honors pause/cancel by probing the `workflow_runs`
 * row between steps. Never rethrows — a failure marks the run (and job) failed.
 *
 * NOTE: this still inherits the serverless-duration caveat — a Vercel function
 * can be killed mid-run. The watchdog (`requeue_stalled_jobs`) re-queues such
 * jobs; the proper long-running runner is Phase 4.
 *
 * Persistence (`workflow_runs` / `agent_runs` / `agent_run_events`) flows
 * through {@link createWorkflowRunPersister}.
 */
export async function executeWorkflowJob(
  adminSupabase: SupabaseClient<Database>,
  params: ExecuteWorkflowJobParams,
): Promise<void> {
  const { workspaceId, workflow, issueNumber, prNumber, jobId, ciFollowupSeed, flowId, flowInput, triageTrigger } = params;
  let persister: WorkflowRunPersister | null = null;
  // Held for the whole run: the engine clones into a per-repo shared worktree
  // and the agent edits it across steps, so concurrent jobs for the same repo
  // must be serialized (see withRepoLock in repo-clone). Released in finally.
  let releaseRepoLock: (() => void) | null = null;

  const finishJob = async (status: Database['public']['Tables']['jobs']['Row']['status']): Promise<void> => {
    if (!jobId) return;
    // Drop the lease (migration 0025) so the watchdog doesn't see a stale
    // claim_expires_at on a row that's already done/failed.
    await adminSupabase.from('jobs').update({
      status,
      claim_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
  };

  try {
    const core = await import('@cezar/core');
    const adapter = new SupabaseStoreAdapter(adminSupabase, workspaceId);
    const store = await core.IssueStore.fromPort(adapter);

    // Read the workspace row ONCE (issue #98). The same row feeds the owner
    // peek, the merged-config load, the workflow settings, and the triage
    // pass — collapsing four `SELECT … FROM workspaces WHERE id=$ws` round-trips
    // into one column-broad fetch per job.
    const { data: workspaceRow } = await adminSupabase
      .from('workspaces')
      .select(
        'config, repo_owner, repo_name, auto_triage_enabled, autofix_enabled, separate_comment_per_step, action_auto_comment',
      )
      .eq('id', workspaceId)
      .single();

    // GitHub token: prefer an installation token (if a GitHub App is wired up),
    // else fall back to the per-workspace admin token the crons use.
    let githubToken: string | null = null;
    const owner: string | undefined = workspaceRow?.repo_owner ?? undefined;
    if (owner && core.GitHubAppService.isConfigured()) {
      try {
        githubToken = await new core.GitHubAppService().getInstallationToken(owner);
      } catch (err) {
        console.error(`[dispatch] installation token failed for ${owner}:`, err instanceof Error ? err.message : err);
      }
    }
    if (!githubToken) githubToken = await resolveWorkspaceToken(workspaceId, adminSupabase);
    if (!githubToken) throw new Error('no github token available for workspace');

    const config = await loadWorkspaceConfig(workspaceId, adminSupabase, {
      githubToken,
      prefetchedWorkspace: workspaceRow,
    });
    // Phase 3c — the dispatcher always runs the declarative engine.
    config.workflow = { ...(config.workflow ?? {}), useEngine: true };

    // Workspace label catalog — appended to every agent step's system prompt
    // by the engine (see resolveStepConfig in core/workflows/binding.ts).
    // Loaded once per job to avoid an extra round-trip per step.
    const labels: WorkspaceLabel[] = await loadWorkspaceLabels(adminSupabase, workspaceId);

    // Issue #262 — narrow the catalog to skills the workspace has marked
    // active. Resolved here once per job and threaded into the orchestrator
    // so the legacy + engine paths skip in-repo discovery. `undefined` means
    // discovery or the activation context failed — the orchestrator then
    // falls back to its legacy `discoverSkillsSafe` path which emits a
    // per-issue event on failure (observability vs. silent zero-skill run).
    let activeSkills: Skill[] | undefined;

    if (!config.autofix.repoRoot) {
      // Serialize on the shared per-repo worktree before the clone, and hold
      // the lock until the run finishes (released in the finally below) so a
      // sibling job can't reset/checkout the tree while the agent edits it.
      releaseRepoLock = await acquireRepoLock(config.github.owner, config.github.repo);
      const repoRoot = await ensureRepoClone(
        config.github.owner,
        config.github.repo,
        config.github.token,
        config.autofix.baseBranch,
      );
      config.autofix.repoRoot = repoRoot;
    }

    activeSkills = await loadActiveSkillCatalog(
      workspaceId,
      config.autofix.repoRoot,
      config.autofix.skillsDir ?? '.ai/skills',
      adminSupabase,
    );

    const github = new core.GitHubService(config);
    const repoSlug = config.github.owner && config.github.repo ? `${config.github.owner}/${config.github.repo}` : params.repo ?? null;
    const runIssueNumber = workflow === 'ci-followup' ? ciFollowupSeed?.issueNumber ?? issueNumber : issueNumber;
    if (runIssueNumber == null) throw new Error(`workflow '${workflow}' job has no issue_number`);

    // ── flow workflow: load the flow row up-front so the `workflow_runs.workflow`
    //    column gets the flow's name (e.g. 'fix-github-issue') instead of the
    //    opaque 'flow' kind. Surfaces in the cockpit alongside the built-ins.
    let flowRow: { name: string; steps: Array<{ skill: string; argsTemplate: string }> } | null = null;
    if (workflow === 'flow') {
      if (!flowId) throw new Error('flow job missing payload.flowId');
      const { data, error: fErr } = await adminSupabase
        .from('flows')
        .select('name, steps')
        .eq('id', flowId)
        .eq('workspace_id', workspaceId)
        .single();
      if (fErr || !data) throw new Error(`flow ${flowId} not found: ${fErr?.message ?? 'no row'}`);
      flowRow = { name: data.name, steps: data.steps as Array<{ skill: string; argsTemplate: string }> };
    }

    // ── workflow_runs row + persistence (the shared persister) ──
    persister = await createWorkflowRunPersister(adminSupabase, {
      workspaceId,
      jobId,
      workflow: flowRow ? `flow:${flowRow.name}` : workflow,
      repo: repoSlug,
      issueNumber: runIssueNumber,
      prNumber: prNumber ?? ciFollowupSeed?.prNumber ?? null,
      onPersistError: (label, err) =>
        console.error(`[dispatch] persist ${label} failed:`, err instanceof Error ? err.message : err),
    });
    if (!persister.id) throw new Error('workflow_runs insert failed');

    // ── persistence callbacks ──
    const onEvent = (msg: string): void => { void persister!.recordEvent('lifecycle', { message: msg }); };
    const onAgentEvent = (evt: { type: string; [k: string]: unknown }): void => {
      // The orchestrator/engine path emits the legacy agent-session event
      // shape here; map it onto agent_run_events rows.
      if (evt.type === 'text') void persister!.recordEvent('agent-text', { text: evt.text });
      else if (evt.type === 'tool') void persister!.recordEvent('tool-call', { tool: evt.tool, input: evt.input });
      else if (evt.type === 'tool-result') void persister!.recordEvent('tool-result', { toolUseId: evt.toolUseId, result: evt.result, isError: evt.isError });
      else void persister!.recordEvent('note', evt);
    };
    const onStepStart = (r: import('@cezar/core').AgentRunRecord): void => { void persister!.recordStepStart(r); };
    const onRunRecord = (r: import('@cezar/core').AgentRunRecord): void => { void persister!.recordAgentRun(r); };
    const pauseRequested = () => persister!.isPauseRequested();
    const cancelRequested = () => persister!.isCancelled();

    // ── run ──
    type RunStatus = 'succeeded' | 'failed' | 'paused' | 'cancelled';
    let runStatus: RunStatus = 'succeeded';
    let reason: string | undefined;
    let prUrl: string | null = null;
    let outPrNumber: number | null = prNumber ?? null;
    let branch: string | null = null;
    let headSha: string | null = null;
    let tokensUsed = 0;
    let outcomeJson: unknown = null;

    // Phase 2 — on a re-claim the watchdog reuses the existing workflow_runs
    // row, so its `session_id` is the one the previous (crashed) attempt was
    // driving. Pass it back through so the engine can `claude --resume <id>`
    // on the first agent step. Cross-host re-claims fall back to a fresh
    // start under the same id; same-host re-claims pick up where we left off.
    const { data: existingRunRow } = await adminSupabase
      .from('workflow_runs')
      .select('session_id')
      .eq('id', persister.id)
      .maybeSingle();
    const resumeSessionId = existingRunRow?.session_id ?? undefined;

    if (workflow === 'flow') {
      if (!flowRow) throw new Error('flow not loaded (internal error)');
      const result = await core.runFlow({
        flow: flowRow,
        input: flowInput ?? String(runIssueNumber),
        store,
        config,
        github,
        issueNumber: runIssueNumber,
        labels,
        skills: activeSkills,
        onEvent,
        onAgentEvent,
        onStepStart,
        onRunRecord,
        pauseRequested,
        cancelRequested,
        resumeSessionId,
      });
      outcomeJson = result;
      runStatus = result.status === 'succeeded' ? 'succeeded'
        : result.status === 'paused' ? 'paused'
        : result.status === 'cancelled' ? 'cancelled'
        : 'failed';
      reason = result.reason;
      prUrl = result.prUrl ?? null;
      outPrNumber = result.prNumber ?? outPrNumber;
      branch = result.branch ?? null;
      headSha = result.headSha ?? null;
      tokensUsed = result.tokensUsed;
    } else if (workflow === 'autofix') {
      const orch = new core.AutofixOrchestrator(store, config, github);
      const outcome = await orch.processIssue(runIssueNumber, {
        apply: true,
        confirmBeforeFix: undefined, // dispatcher = autonomous
        labels,
        skills: activeSkills,
        onEvent,
        onAgentEvent,
        onStepStart,
        onRunRecord,
        pauseRequested,
        cancelRequested,
        resumeSessionId,
      });
      outcomeJson = outcome;
      runStatus =
        outcome.status === 'pr-opened' || outcome.status === 'dry-run' || outcome.status === 'skipped'
          ? 'succeeded'
          : 'failed';
      reason = 'reason' in outcome ? outcome.reason : undefined;
      prUrl = 'prUrl' in outcome ? outcome.prUrl : null;
      outPrNumber = 'prNumber' in outcome ? outcome.prNumber : outPrNumber;
      branch = 'branch' in outcome ? outcome.branch ?? null : null;
      headSha = 'headSha' in outcome ? outcome.headSha ?? null : null;
    } else if (workflow === 'ci-followup') {
      if (!ciFollowupSeed) throw new Error('ci-followup job is missing payload.ciFollowup seed');
      const orch = new core.AutofixOrchestrator(store, config, github);
      const outcome = await orch.processCiFollowup(ciFollowupSeed, {
        apply: true,
        labels,
        skills: activeSkills,
        onEvent,
        onAgentEvent,
        onStepStart,
        onRunRecord,
        pauseRequested,
        cancelRequested,
        resumeSessionId,
      });
      outcomeJson = outcome;
      runStatus = outcome.status === 'pushed' || outcome.status === 'skipped' ? 'succeeded' : 'failed';
      reason = 'reason' in outcome ? outcome.reason : undefined;
      branch = 'branch' in outcome ? outcome.branch ?? null : ciFollowupSeed.branch ?? null;
      headSha = 'headSha' in outcome ? outcome.headSha ?? null : null;
      outPrNumber = ciFollowupSeed.prNumber ?? outPrNumber;
    } else {
      // Phase 2b1 soft cutover — triage runs the data-driven `runTriagePass`
      // instead of the legacy `triageWorkflow`. The action set (auto-triage
      // first, then every other enabled action whose target+trigger match) is
      // loaded from the `actions` table. The follow-up autofix enqueue that
      // the old path performed via `maybeEnqueueAutofixFromTriage` is
      // intentionally not wired here — the new actions emit labels via
      // effects, not a structured `route` outcome; a routing action that
      // produces that signal is the next deliverable.
      // Capture persister.id locally so the deferSink closure has a
      // narrowed non-null string regardless of the enclosing `persister`
      // variable's nullable type.
      const workflowRunId = persister.id;
      const triageResult = await runTriagePassJob({
        workspaceId,
        issueNumber: runIssueNumber,
        github,
        supabase: adminSupabase,
        persister,
        trigger: parseTriageTrigger(triageTrigger),
        labels,
        skills: activeSkills,
        actionAutoComment: workspaceRow?.action_auto_comment ?? null,
        deferSink: async ({ call, confidence, summary, action, target }) => {
          // Write the deferred effect to pending_decisions for the inbox.
          const { error } = await adminSupabase.from('pending_decisions').insert({
            workspace_id: workspaceId,
            action_id: action.id,
            workflow_run_id: workflowRunId,
            target_kind: target.kind,
            issue_number: target.kind === 'issue' ? target.number : null,
            pr_number: target.kind === 'pr' ? target.number : null,
            target_title: target.title,
            effect: call.effect,
            effect_args: (call.args ?? {}) as Database['public']['Tables']['pending_decisions']['Insert']['effect_args'],
            summary,
            confidence,
          });
          // 23505 = unique_violation against pending_decisions_dedup_idx: a
          // pending decision for this (action, target, effect, args) already
          // exists. That's the intended dedup behaviour (see migration 0029),
          // not a failure — drop it silently.
          if (error && error.code !== '23505') {
            console.error('[dispatch] pending_decisions insert failed:', error.message);
          }
        },
      });
      outcomeJson = triageResult.outcome;
      runStatus = triageResult.status as RunStatus;
      reason = triageResult.reason;
      tokensUsed = triageResult.tokensUsed;
    }

    // The engine path doesn't surface tokensUsed through the autofix outcome,
    // but the run records do; sum them as a best-effort total when unknown.
    if (tokensUsed === 0 && persister.id) {
      const { data: runs } = await adminSupabase.from('agent_runs').select('tokens_used').eq('workflow_run_id', persister.id);
      tokensUsed = (runs ?? []).reduce((s, r) => s + (r.tokens_used ?? 0), 0);
    }

    // Phase 2: surface the final session id onto `workflow_runs.session_id`
    // as a last-resort writer if no step event landed it yet (e.g. a run
    // that failed before its first agent step finished).
    const outcomeWithSession = (outcomeJson ?? null) as { sessionId?: string } | null;
    const finalSessionId = outcomeWithSession?.sessionId ?? null;
    await persister.finalize({
      status: runStatus,
      outcome: outcomeJson as Database['public']['Tables']['workflow_runs']['Row']['outcome'],
      reason: reason ?? null,
      pr_url: prUrl,
      pr_number: outPrNumber,
      branch,
      head_sha: headSha,
      tokens_used: tokensUsed,
      finished_at: new Date().toISOString(),
      ...(finalSessionId ? { session_id: finalSessionId } : {}),
    });
    await finishJob(
      runStatus === 'succeeded' ? 'done'
      : runStatus === 'paused' ? 'queued' // re-queue a paused run so it's picked up again
      : runStatus === 'cancelled' ? 'cancelled'
      : 'failed',
    );

    await store.save().catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[dispatch] executeWorkflowJob failed:', message);
    if (persister) await persister.fail(message).catch(() => {});
    await finishJob('failed').catch(() => {});
  } finally {
    // Release the per-repo worktree lock so the next job for this repo can run.
    releaseRepoLock?.();
  }
}

/**
 * Mirrors the per-workspace token lookup in api/cron/issue-fix & issue-sync:
 * grab any workspace admin's stored GitHub token, else fall back to the
 * ambient `GITHUB_TOKEN` env var.
 */
async function resolveWorkspaceToken(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');
  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }
  return process.env.GITHUB_TOKEN || null;
}
