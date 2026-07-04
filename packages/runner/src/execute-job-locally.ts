import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunRecord, Config } from '@cezar/core';
import type { ClaimedJob, RunnerEvent } from './runner-client.js';
import { RunnerClient } from './runner-client.js';
import { prepareJobWorktree, type JobWorktree } from './repo-clone.js';
import { redactToken } from './redact.js';

const execFileAsync = promisify(execFile);

export interface ExecuteJobControls {
  /** Polled between steps — true ⇒ finish the current step then pause the run. */
  shouldPause: () => boolean;
  /** Polled between steps — true ⇒ end the run `cancelled`. */
  shouldCancel: () => boolean;
}

export interface ExecuteJobOptions {
  /** Phase 5 — runner UUID stamped onto every `step-start` so the central
   *  populates `agent_runs.runner_id` (migration 0027). NULL when the runner
   *  daemon hasn't learned its own id yet (e.g. very first heartbeat hasn't
   *  landed) — the central will just leave runner_id NULL on those rows. */
  runnerId?: string | null;
}

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH = 25;
// Phase 5 — autosave the per-job worktree every 90s so a runner crash mid-step
// leaves recoverable WIP on the branch (the watchdog's re-claim then sees the
// partial work). `--allow-empty` so we get a heartbeat even with no file
// changes; `-c commit.gpgsign=false` so a host with signing on by default
// doesn't prompt for a key. Hardcoded author so commits are obvious in
// `git log` and we don't reuse the operator's identity.
const AUTOSAVE_INTERVAL_MS = 90_000;
const AUTOSAVE_AUTHOR = 'Cezar Autosave <autosave@cezar.local>';

/**
 * Runs a claimed workflow job on this runner and reports state back over HTTP.
 * The SaaS already created the `workflow_runs` row (returned as `workflowRunId`)
 * and minted `githubToken`; this only POSTs events + PATCHes the final state.
 *
 * Never throws — a failure is reported via `finalizeRun(status:'failed')`.
 */
export async function executeJobLocally(
  client: RunnerClient,
  claimed: ClaimedJob,
  controls: ExecuteJobControls,
  opts: ExecuteJobOptions = {},
): Promise<void> {
  const {
    workflowRunId,
    job,
    workspace,
    githubToken,
    ciFollowupSeed,
    flow,
    labels,
    resumeSessionId,
  } = claimed;
  // The runner-daemon substitutes the host token before calling us when
  // `ghIdentitySource === 'host'`. Any path that reaches here without a
  // token is a misconfiguration — surface it as a failed run instead of
  // letting GitHub-service ops fail with confusing 401s.
  if (!githubToken) {
    await client
      .finalizeRun(workflowRunId, {
        status: 'failed',
        reason: `no GitHub token available for this job (ghIdentitySource=${claimed.ghIdentitySource ?? 'unknown'})`,
        tokensUsed: 0,
      })
      .catch(() => {});
    return;
  }

  // ── event buffer ──────────────────────────────────────────────────────
  const buffer: RunnerEvent[] = [];
  let tokensUsed = 0;
  let flushing = false;
  const flush = async (): Promise<void> => {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, buffer.length);
    try {
      await client.postEvents(workflowRunId, batch);
    } catch (err) {
      // Re-queue so we don't silently drop them; if the API is down the daemon
      // will eventually surface it elsewhere.
      buffer.unshift(...batch);
      console.error(
        `[runner] postEvents failed (${batch.length} buffered):`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      flushing = false;
    }
  };
  const timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  const emit = (e: RunnerEvent): void => {
    if (typeof e.tokensUsed === 'number') tokensUsed += e.tokensUsed;
    buffer.push(e);
    if (buffer.length >= FLUSH_BATCH) void flush();
  };

  const onEvent = (msg: string): void => emit({ type: 'lifecycle', payload: { message: msg } });
  const onAgentEvent = (evt: { type: string; [k: string]: unknown }): void => {
    // The orchestrator/engine path emits the legacy agent-session event shape.
    if (evt.type === 'text') emit({ type: 'agent-text', payload: { text: evt.text } });
    else if (evt.type === 'tool')
      emit({ type: 'tool-call', payload: { tool: evt.tool, input: evt.input } });
    else if (evt.type === 'tool-result')
      emit({
        type: 'tool-result',
        payload: { toolUseId: evt.toolUseId, result: evt.result, isError: evt.isError },
      });
    else emit({ type: 'note', payload: evt });
  };
  // Fired at the moment the engine begins a step (before the agent launches).
  // Emits a `step-start` event so the cockpit can open the agent_runs row +
  // render a card right away — instead of waiting for the step to finish.
  // The first step-end that carries a sessionId stamps the whole run. We
  // hold onto it so finalizeRun can re-stamp `workflow_runs.session_id`
  // even if the per-event RPC hasn't landed yet.
  let runSessionId: string | undefined;
  const onStepStart = (r: AgentRunRecord): void => {
    if (r.sessionId) runSessionId = r.sessionId;
    emit({
      type: 'step-start',
      stepId: r.stepId,
      iteration: r.iteration,
      kind: r.kind ?? undefined,
      backend: r.backend,
      model: r.model,
      status: 'running',
      startedAt: r.startedAt,
      sessionId: r.sessionId,
      // Phase 5 — stamp the runner so the central can populate
      // `agent_runs.runner_id` (migration 0027). Coalesces server-side, so
      // re-deliveries don't overwrite with NULL.
      runnerId: opts.runnerId ?? undefined,
      payload: {
        stepId: r.stepId,
        iteration: r.iteration,
        sessionId: r.sessionId ?? null,
        runnerId: opts.runnerId ?? null,
      },
    });
  };
  // Fired when the engine has finished a step. Emits the matching `step-end`
  // that closes the agent_runs row opened by `onStepStart`.
  const onRunRecord = (r: AgentRunRecord): void => {
    if (r.sessionId) runSessionId = r.sessionId;
    emit({
      type: 'step-end',
      stepId: r.stepId,
      iteration: r.iteration,
      kind: r.kind ?? undefined,
      backend: r.backend,
      model: r.model,
      status: r.status,
      summary: r.summary ?? null,
      error: r.error ?? null,
      tokensUsed: r.tokensUsed,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      sessionId: r.sessionId,
      // Phase 5 — re-stamp the runner on close too. The RPC `coalesce`s, so
      // this is only a backstop when the step-start event was lost.
      runnerId: opts.runnerId ?? undefined,
      payload: {
        stepId: r.stepId,
        iteration: r.iteration,
        status: r.status,
        summary: r.summary,
        error: r.error,
        sessionId: r.sessionId ?? null,
        runnerId: opts.runnerId ?? null,
      },
    });
  };

  const pauseRequested = async (): Promise<boolean> => controls.shouldPause();
  const cancelRequested = async (): Promise<boolean> => controls.shouldCancel();

  let worktree: JobWorktree | null = null;
  let autosaveTimer: NodeJS.Timeout | null = null;
  try {
    const core = await import('@cezar/core');

    // Build the runtime Config from the SaaS-supplied merged config.
    const config: Config = claimed.config;
    config.github = {
      ...config.github,
      owner: workspace.owner,
      repo: workspace.repo,
      token: githubToken,
    };
    config.workflow = { ...(config.workflow ?? {}), useEngine: true };
    // Actions are repo-less — they classify an issue/PR and call GitHub effects,
    // never touching a working tree. Skip the (expensive) clone for them.
    if (job.kind !== 'action' && !config.autofix.repoRoot) {
      worktree = await prepareJobWorktree(
        workspace.owner,
        workspace.repo,
        githubToken,
        job.id,
        config.autofix.baseBranch,
      );
      config.autofix.repoRoot = worktree.worktreePath;
      // Phase 5 — autosave WIP on the worktree branch every 90s. If the runner
      // crashes mid-step the branch carries recoverable changes; a re-claim
      // (Phase 3 lease-based) sees them. Final commit/push at the workflow's
      // open-pr step is unaffected — autosave commits just trail the branch
      // history. Failures here are logged only — autosave MUST NOT abort the
      // job (a stuck index, an fsck blip, etc. shouldn't take down a run).
      //
      // The overlap guard is per-job (closure-scoped), not module-global, so a
      // slow autosave on one concurrent job never causes another job's tick to
      // silently no-op — each worktree keeps its own "one autosave per tick".
      let jobAutosaveRunning = false;
      autosaveTimer = setInterval(() => {
        if (jobAutosaveRunning) return;
        jobAutosaveRunning = true;
        void autosaveWorktree(worktree!.worktreePath).finally(() => {
          jobAutosaveRunning = false;
        });
      }, AUTOSAVE_INTERVAL_MS);
    }

    // No Supabase here — reconstruct the store from the snapshot. Store mutations
    // (autofixStatus etc.) are best-effort lost; round-tripping them is TODO(phase-4).
    const store = core.IssueStore.fromData(claimed.store);
    const github = new core.GitHubService(config);

    type Result = {
      status: 'succeeded' | 'failed' | 'paused' | 'cancelled';
      finalize: import('./runner-client.js').FinalizeRunBody;
    };
    let result: Result;

    if (job.kind === 'autofix') {
      if (job.issueNumber == null) throw new Error('autofix job has no issue_number');
      const outcome = await new core.AutofixOrchestrator(store, config, github).processIssue(
        job.issueNumber,
        {
          apply: true,
          labels,
          onEvent,
          onAgentEvent,
          onStepStart,
          onRunRecord,
          pauseRequested,
          cancelRequested,
          resumeSessionId: resumeSessionId ?? undefined,
        },
      );
      const ok =
        outcome.status === 'pr-opened' ||
        outcome.status === 'dry-run' ||
        outcome.status === 'skipped';
      result = {
        status: ok ? 'succeeded' : 'failed',
        finalize: {
          status:
            outcome.status === 'pr-opened'
              ? 'pr-opened'
              : outcome.status === 'dry-run'
                ? 'dry-run'
                : outcome.status === 'skipped'
                  ? 'skipped'
                  : 'failed',
          outcome,
          reason: 'reason' in outcome ? outcome.reason : null,
          prUrl: 'prUrl' in outcome ? outcome.prUrl : null,
          prNumber: 'prNumber' in outcome ? outcome.prNumber : (job.prNumber ?? null),
          branch: 'branch' in outcome ? (outcome.branch ?? null) : null,
          headSha: 'headSha' in outcome ? (outcome.headSha ?? null) : null,
          tokensUsed,
        },
      };
    } else if (job.kind === 'ci-followup') {
      if (!ciFollowupSeed) throw new Error('ci-followup job is missing payload.ciFollowup seed');
      const outcome = await new core.AutofixOrchestrator(store, config, github).processCiFollowup(
        ciFollowupSeed,
        {
          apply: true,
          labels,
          onEvent,
          onAgentEvent,
          onStepStart,
          onRunRecord,
          pauseRequested,
          cancelRequested,
          resumeSessionId: resumeSessionId ?? undefined,
        },
      );
      const ok = outcome.status === 'pushed' || outcome.status === 'skipped';
      result = {
        status: ok ? 'succeeded' : 'failed',
        finalize: {
          status:
            outcome.status === 'pushed'
              ? 'pushed'
              : outcome.status === 'skipped'
                ? 'skipped'
                : 'failed',
          outcome,
          reason: 'reason' in outcome ? outcome.reason : null,
          branch: 'branch' in outcome ? (outcome.branch ?? null) : (ciFollowupSeed.branch ?? null),
          headSha: 'headSha' in outcome ? (outcome.headSha ?? null) : null,
          prNumber: ciFollowupSeed.prNumber ?? job.prNumber ?? null,
          tokensUsed,
        },
      };
    } else if (job.kind === 'flow') {
      if (!flow) throw new Error('flow job is missing payload.flowId / claim payload');
      if (job.issueNumber == null) throw new Error('flow job has no issue_number');
      const flowOutcome = await core.runFlow({
        flow: { name: flow.name, steps: flow.steps },
        input: flow.input || String(job.issueNumber),
        store,
        config,
        github,
        issueNumber: job.issueNumber,
        labels,
        onEvent,
        onAgentEvent,
        onStepStart,
        onRunRecord,
        pauseRequested,
        cancelRequested,
        resumeSessionId: resumeSessionId ?? undefined,
      });
      const status =
        flowOutcome.status === 'succeeded'
          ? 'succeeded'
          : flowOutcome.status === 'paused'
            ? 'paused'
            : flowOutcome.status === 'cancelled'
              ? 'cancelled'
              : 'failed';
      // FinalizeRunBody.status is a narrow union — map our workflow status onto
      // it. The cockpit uses `outcome` for the rich detail anyway.
      const finalizeStatus =
        status === 'succeeded'
          ? 'succeeded'
          : status === 'paused'
            ? 'paused'
            : status === 'cancelled'
              ? 'cancelled'
              : 'failed';
      result = {
        status,
        finalize: {
          status: finalizeStatus,
          outcome: flowOutcome,
          reason: flowOutcome.reason ?? null,
          prUrl: flowOutcome.prUrl ?? null,
          prNumber: flowOutcome.prNumber ?? job.prNumber ?? null,
          branch: flowOutcome.branch ?? null,
          headSha: flowOutcome.headSha ?? null,
          tokensUsed,
        },
      };
    } else if (job.kind === 'action') {
      const action = claimed.action;
      const target = claimed.target;
      if (!action || !target) throw new Error('action job is missing action/target claim payload');

      // The job's required_backend selects the LLM transport. A self-hosted
      // runner only claims action jobs whose backend it serves, so this is a
      // CLI backend (subscription, no API key). Fall back to claude-cli if the
      // SaaS left it unstamped.
      const KNOWN_BACKENDS: import('@cezar/core').AgentBackend[] = [
        'anthropic-api',
        'claude-cli',
        'codex-cli',
      ];
      const backend = (KNOWN_BACKENDS as string[]).includes(job.requiredBackend ?? '')
        ? (job.requiredBackend as import('@cezar/core').AgentBackend)
        : 'claude-cli';

      const skills = await core.discoverBuiltinSkills();
      const deferred: import('./runner-client.js').DeferredEffectWire[] = [];
      const startedAt = new Date().toISOString();
      const model = action.model ?? 'claude-sonnet-4-6';
      const stepBase = {
        id: `${workflowRunId}:action`,
        workflow: 'single-action',
        stepId: action.name,
        iteration: 0,
        kind: 'agent' as const,
        backend,
        model,
      };
      onStepStart({ ...stepBase, status: 'running', startedAt, tokensUsed: 0 });

      let runStatus: 'succeeded' | 'failed' = 'succeeded';
      let summary: string | undefined;
      let runError: string | undefined;
      let effectsApplied: Array<{ effect: string; args: unknown; summary: string }> = [];
      try {
        const res = await core.runAction(action, target, {
          backend,
          config,
          skills,
          effectCtx: { github, targetNumber: target.number },
          labels,
          autoComment: {
            enabled: claimed.actionAutoComment ?? true,
            triggeredBy: 'runner · run now',
          },
          contextProviders: buildOpenIssuesContextProvidersFromStore(core, store, target.number),
          deferSink: async ({ call, confidence, summary: deferSummary }) => {
            deferred.push({
              effect: call.effect,
              args: call.args ?? {},
              summary: deferSummary,
              confidence,
            });
          },
        });
        summary = res.text ? res.text.slice(0, 500) : undefined;
        effectsApplied = res.effectsApplied.map((e) => ({
          effect: e.call.effect,
          args: e.call.args,
          summary: e.summary,
        }));
      } catch (err) {
        runStatus = 'failed';
        runError = err instanceof Error ? err.message : String(err);
      }

      // One tool-call event per applied effect so the cockpit timeline shows
      // what the action did.
      for (const ef of effectsApplied) {
        emit({
          type: 'tool-call',
          payload: { action: action.name, effect: ef.effect, args: ef.args, summary: ef.summary },
        });
      }

      onRunRecord({
        ...stepBase,
        status: runStatus,
        startedAt,
        finishedAt: new Date().toISOString(),
        tokensUsed,
        summary,
        error: runError,
      });

      const outcome: import('./runner-client.js').ActionRunOutcome = {
        action: action.name,
        effectsApplied,
        deferredEffects: deferred,
      };
      result = {
        status: runStatus,
        finalize: { status: runStatus, outcome, reason: runError ?? null, tokensUsed },
      };
    } else {
      // TODO(2b3+): wire the data-driven `runTriagePass` for the self-hosted
      // runner. Triage is repo-less and rare on self-hosted runners; until the
      // CLI/runner is rewritten on the new action model, skip the job so the
      // SaaS doesn't keep handing it back.
      const reason =
        'triage on self-hosted runners is not supported yet — re-run from the GUI or wait for 2b3';
      onEvent(`[runner] ${reason}`);
      result = {
        status: 'succeeded',
        finalize: { status: 'skipped', outcome: { status: 'skipped', reason }, reason, tokensUsed },
      };
    }

    await flush();
    await client.finalizeRun(workflowRunId, {
      ...result.finalize,
      tokensUsed,
      sessionId: runSessionId ?? null,
    });
  } catch (err) {
    // Redact any GitHub token before it reaches stderr, journalctl, or the
    // cockpit: `execFile` clone/fetch failures carry the token-bearing URL in
    // `err.message` (`Command failed: git clone https://x-access-token:…@…`).
    const message = redactToken(err instanceof Error ? err.message : String(err));
    console.error(`[runner] job ${job.id} failed:`, message);
    await flush().catch(() => {});
    await client
      .finalizeRun(workflowRunId, { status: 'failed', reason: message, tokensUsed })
      .catch((e) => {
        console.error(
          `[runner] finalizeRun(failed) also failed:`,
          e instanceof Error ? e.message : e,
        );
      });
  } finally {
    clearInterval(timer);
    if (autosaveTimer) clearInterval(autosaveTimer);
    await flush().catch(() => {});
    if (worktree) await worktree.cleanup().catch(() => {});
  }
}

/**
 * Runner-side `open-issues` context provider, built from the issue-store
 * snapshot the SaaS ships in the claim (the cron path queries Supabase instead;
 * see `gui/src/lib/open-issues-context.ts`). Same rule: open issues
 * lower-numbered than the target, newest first, capped at 100, digest summary
 * preferred over the body.
 */
function buildOpenIssuesContextProvidersFromStore(
  core: typeof import('@cezar/core'),
  store: import('@cezar/core').IssueStore,
  targetNumber: number,
): Record<string, () => Promise<string>> {
  return {
    'open-issues': async () => {
      const open = store
        .getIssues({ state: 'open' })
        .filter((i) => i.number < targetNumber)
        .sort((a, b) => b.number - a.number)
        .slice(0, 100);
      return core.formatOpenIssuesKb(
        open.map((i) => ({
          number: i.number,
          title: i.title,
          summary: i.digest?.summary ?? i.body,
        })),
        { cap: 100 },
      );
    },
  };
}

/**
 * Phase 5 autosave. Stages changes to *already-tracked* files (`git add -u`)
 * and commits with `--allow-empty` so even a "nothing changed since last tick"
 * iteration still leaves a heartbeat commit. `commit.gpgsign=false` is set
 * inline so a host with signing on by default doesn't prompt; the author is
 * hardcoded so we never depend on the operator's git identity (and so the
 * commits stand out in `git log`).
 *
 * We deliberately use `-u` rather than `-A`: `-A` would stage *new* untracked
 * files too — including `.env` / `credentials.json` an agent may have written
 * while debugging, or large build/fixture blobs — and these autosave commits
 * are published by the Phase 4 push-to-PR step without the agent reviewing
 * them. Staging tracked files only loses some recoverable brand-new WIP but
 * eliminates the secret-leak / diff-noise class (see issue #62).
 *
 * The caller skips overlapping ticks via a per-job guard — git is generally
 * fast enough that 90s gives plenty of slack, but a slow disk shouldn't queue
 * stale commits behind a still-running `git add`. The guard lives in the caller
 * (closure-scoped per job) so concurrent jobs autosave independently.
 */
async function autosaveWorktree(cwd: string): Promise<void> {
  try {
    await execFileAsync('git', ['add', '-u'], { cwd });
    await execFileAsync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'wip: cezar autosave [skip ci]',
        '--author',
        AUTOSAVE_AUTHOR,
      ],
      {
        cwd,
        env: {
          ...process.env,
          GIT_COMMITTER_NAME: 'Cezar Autosave',
          GIT_COMMITTER_EMAIL: 'autosave@cezar.local',
        },
      },
    );
  } catch (err) {
    // Autosave failures are best-effort — never abort the job. Common causes
    // are an unborn HEAD (worktree just created, no initial commit on this
    // branch) or a transient git lock; the next tick will retry.
    console.warn('[runner] autosave failed:', err instanceof Error ? err.message : err);
  }
}
