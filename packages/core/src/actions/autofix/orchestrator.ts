import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config } from '../../config/config.model.js';
import type { IssueStore } from '../../store/store.js';
import type { StoredIssue } from '../../store/store.model.js';
import { GitHubService } from '../../services/github.service.js';
import { createWorktree, commitAll, getDiffAgainstBase, fetchRemoteBranch } from './worktree.js';
import { runSetupCommand } from './setup-runner.js';
import { createRunEnv } from '../../provision/create-run-env.js';
import type { RunEnv } from '../../provision/run-env.js';
import { TokenBudget } from './token-budget.js';
import { runAgentSession, type AgentEvent } from './agent-session.js';
import type { AgentEvent as NormalizedAgentEvent } from '../../agents/agent-runner.js';
import { LLMService } from '../../services/llm.service.js';
import { buildDoneDetectorPrompt, DoneDetectorResponseSchema } from './done-detector-preflight.js';
import { detectBugSignal } from './bug-signal.js';
import {
  ANALYZER_SYSTEM_PROMPT,
  AnalyzerResultSchema,
  isNoActionNeeded,
  buildAnalyzerUserPrompt,
  type RootCause,
} from './prompts/analyzer.js';
import {
  FIXER_SYSTEM_PROMPT,
  FixReportSchema,
  buildFixerUserPrompt,
  type FixReport,
} from './prompts/fixer.js';
import {
  REVIEWER_SYSTEM_PROMPT,
  ReviewVerdictSchema,
  buildReviewerUserPrompt,
  normalizeVerdict,
  retryNotesFromVerdict,
  fallbackVerdictFromProse,
  type ReviewVerdict,
} from './prompts/reviewer.js';
import { discoverSkills, type Skill } from '../../skills/skill-catalog.js';
import { resolveStepConfig, type WorkflowBinding } from '../../workflows/binding.js';
import { runWorkflow } from '../../workflows/workflow-engine.js';
import {
  autofixWorkflow,
  type AutofixBlackboard,
} from '../../workflows/definitions/autofix.workflow.js';
import {
  ciFollowupWorkflow,
  type CiFollowupBlackboard,
  type CiFollowupSeed,
} from '../../workflows/definitions/ci-followup.workflow.js';
import {
  workflowResultToAutofixOutcome,
  workflowResultToCiFollowupOutcome,
} from '../../workflows/run-translation.js';
import type { AgentRunRecord } from '../../workflows/workflow.js';
import {
  buildCiFollowupNotes,
  buildCiFollowupCommitMessage,
  buildCiFollowupPrComment,
  buildCommitMessage,
  buildPrBody,
} from './messages.js';
import { normalizeTitle } from './prompts/untrusted.js';

/**
 * Raised when a single agent session exceeds `autofix.attemptTimeoutMs`.
 * Carries the configured limit so callers can surface it in the failure reason.
 */
export class AgentSessionTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`attempt timed out after ${Math.round(timeoutMs / 60000)} min`);
    this.name = 'AgentSessionTimeoutError';
  }
}

/**
 * Bound an agent session by wall-clock time. `runAgentSession` is otherwise
 * limited only by `maxTurns` and the `TokenBudget`, neither of which catches a
 * stalled network / server-side hang — so a single attempt could block forever
 * (issue #26). On timeout the returned promise rejects with
 * `AgentSessionTimeoutError`; the in-flight session is left to be GC'd (its
 * worktree is disposed by the caller's catch block). A non-positive timeout
 * disables the bound entirely.
 */
function withAttemptTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentSessionTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Phase 3a: the workflow engine streams the *normalized* runner `AgentEvent`,
 * but `OrchestratorOptions.onAgentEvent` (and its GUI/CLI consumers) speak the
 * legacy `AgentEvent` shape. Map between the two so the engine path is
 * drop-in for existing callers.
 */
function normalizedToLegacyAgentEvent(e: NormalizedAgentEvent): AgentEvent | null {
  switch (e.type) {
    case 'text':
      return { type: 'text', text: e.text };
    case 'tool-call':
      return { type: 'tool', tool: e.tool, input: e.input };
    case 'tool-result':
      return { type: 'tool-result', toolUseId: e.toolCallId, result: e.result, isError: e.isError };
    case 'token-usage':
      return { type: 'turn-end', tokensUsed: e.tokensUsed };
    case 'note':
    case 'done':
    case 'error':
      return null;
  }
}

/**
 * Overlay live GitHub fields (labels, state, title, body, updatedAt) onto
 * the stored issue so the autofix gate sees fresh data. Analysis state and
 * everything else local stays from the store — only the GitHub-authoritative
 * fields are replaced.
 */
function applyLiveOverlay(
  stored: StoredIssue,
  live: Partial<{
    state: 'open' | 'closed';
    labels: string[];
    title: string;
    body: string;
    updatedAt: string;
  }>,
): StoredIssue {
  return {
    ...stored,
    state: live.state ?? stored.state,
    labels: live.labels ?? stored.labels,
    title: live.title ?? stored.title,
    body: live.body ?? stored.body,
    updatedAt: live.updatedAt ?? stored.updatedAt,
  };
}

export type OrchestratorOutcome =
  | {
      status: 'pr-opened';
      prUrl: string;
      prNumber: number;
      branch: string;
      headSha: string;
      rootCause: RootCause;
      verdict: ReviewVerdict;
    }
  | { status: 'skipped'; reason: string }
  | {
      status: 'failed';
      reason: string;
      rootCause?: RootCause;
      fixReport?: FixReport;
      verdict?: ReviewVerdict;
      branch?: string;
    }
  | {
      status: 'dry-run';
      rootCause: RootCause;
      fixReport: FixReport;
      verdict: ReviewVerdict;
      branch: string;
      diff: string;
    };

export interface CiFollowupInput {
  issueNumber: number;
  prNumber: number;
  branch: string;
  attemptIndex: number; // 1-based — which follow-up attempt this is for the flow
  attemptMax: number;
  attribution: {
    reasoning: string;
    suggestedFocus?: string;
    preExistingChecks?: string[];
  };
  failedCheckNames: string[];
  logTails?: Array<{ checkName: string; lines: string[] }>;
}

export type CiFollowupOutcome =
  | {
      status: 'pushed';
      branch: string;
      headSha: string;
      verdict: Required<ReviewVerdict>;
      fixReport: FixReport;
    }
  | { status: 'skipped'; reason: string }
  | {
      status: 'failed';
      reason: string;
      branch?: string;
      verdict?: Required<ReviewVerdict>;
      fixReport?: FixReport;
    };

// Per-attempt result from runOneAttempt. Only 'review-failed' is retriable;
// other failure kinds bail out of the retry loop immediately.
type AttemptOutcome =
  | {
      kind: 'pr-opened';
      prUrl: string;
      prNumber: number;
      headSha: string;
      rootCause: RootCause;
      fixReport: FixReport;
      verdict: Required<ReviewVerdict>;
    }
  | {
      kind: 'dry-run';
      rootCause: RootCause;
      fixReport: FixReport;
      verdict: Required<ReviewVerdict>;
      diff: string;
    }
  | { kind: 'user-declined' }
  | { kind: 'no-action-needed'; reason: string }
  | {
      kind: 'review-failed';
      reason: string;
      rootCause: RootCause;
      fixReport: FixReport;
      verdict: Required<ReviewVerdict>;
    }
  | { kind: 'hard-failed'; reason: string; rootCause?: RootCause; fixReport?: FixReport };

export interface OrchestratorOptions {
  apply: boolean; // false = dry-run (no push, no PR)
  confirmBeforeFix?: (rootCause: RootCause, issue: StoredIssue) => Promise<boolean>;
  onEvent?: (event: string) => void;
  onAgentEvent?: (event: AgentEvent) => void;
  /**
   * Phase 3a: observe each workflow-engine step's run record (only fires on the
   * `config.workflow.useEngine` path). Lets the GUI persist `agent_runs` rows.
   */
  onRunRecord?: (record: AgentRunRecord) => void;
  /**
   * Engine-path only. Fires the moment the engine begins a step (before the
   * agent launches), so the cockpit can render a card + emit `step-start`
   * up-front instead of bunching everything onto the step's completion.
   */
  onStepStart?: (record: AgentRunRecord) => void;
  /**
   * Phase 3c: graceful pause/cancel probes, checked by the engine between steps
   * (engine path only). The dispatcher passes functions that re-read the DB.
   */
  pauseRequested?: boolean | (() => boolean | Promise<boolean>);
  cancelRequested?: boolean | (() => boolean | Promise<boolean>);
  /**
   * Workspace label catalog forwarded to the engine. When present, each agent
   * step's system prompt gets a "Repository label catalog" section so the
   * agent can apply labels (issue + both scopes pre-PR, full catalog around
   * review / open-pr). Engine-only path — ignored by the legacy hand-rolled
   * orchestrator path.
   */
  labels?: import('../../labels/label-catalog.js').WorkspaceLabel[];
  /**
   * Phase 2 re-claim resume — when set, the workflow engine reuses this
   * session id for every agent step and asks the runner to `claude --resume
   * <id>` on the first step so the new process picks up the prior on-disk
   * conversation. Cross-host re-claims fall back to a fresh start under the
   * same id. Engine-only path; ignored by the legacy hand-rolled orchestrator.
   */
  resumeSessionId?: string;
  /**
   * Issue #262 — pre-resolved skill catalog. When set, the orchestrator skips
   * the in-repo `discoverSkills` call and uses this list verbatim. Used by the
   * SaaS dispatcher to feed *only the workspace's active skills* (catalog
   * filtered by `workspace_skill_states.enabled`) so disabled skills never
   * surface in workflow step bindings. CLI callers leave it undefined to keep
   * the legacy "discover everything in the repo" behaviour.
   */
  skills?: Skill[];
}

export class AutofixOrchestrator {
  constructor(
    private readonly store: IssueStore,
    private readonly config: Config,
    private readonly github: GitHubService,
    private readonly llm = new LLMService(config),
  ) {}

  async processIssue(issueNumber: number, opts: OrchestratorOptions): Promise<OrchestratorOutcome> {
    if (this.config.workflow?.useEngine) return this.processIssueViaEngine(issueNumber, opts);
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) {
      return { status: 'skipped', reason: 'autofix disabled in config' };
    }
    if (!cfg.repoRoot) {
      return { status: 'skipped', reason: 'autofix.repoRoot not set' };
    }

    const storedIssue = this.store.getIssue(issueNumber);
    if (!storedIssue)
      return { status: 'skipped', reason: `issue #${issueNumber} not found in store` };
    if (storedIssue.state !== 'open') return { status: 'skipped', reason: 'issue is closed' };
    // Cheap store-only gates first — no point making a GitHub call to refresh
    // labels if the issue is already done / PR already opened / out of
    // attempts.
    if (storedIssue.analysis.doneDetected === true) {
      return {
        status: 'skipped',
        reason: storedIssue.analysis.doneReason ?? 'issue already appears resolved by a merged PR',
      };
    }
    if (storedIssue.analysis.autofixStatus === 'pr-opened') {
      return { status: 'skipped', reason: 'PR already opened' };
    }
    const attemptsAlready = storedIssue.analysis.autofixAttempts ?? 0;
    const maxAttempts = cfg.maxAttemptsPerIssue;
    const remainingAttempts = maxAttempts - attemptsAlready;
    if (remainingAttempts <= 0) {
      return { status: 'skipped', reason: 'max attempts reached (use --retry to reset counter)' };
    }

    // Refresh labels / state / title from GitHub before the bug-signal gate.
    // Effects applied by other actions (e.g. bug-detector adding the `bug`
    // label) write to GitHub directly — the local store stays stale until
    // the next sync. One API call here saves the user a manual sync between
    // bug-detector and autofix.
    const issueData = await this.github.getIssueWithComments(issueNumber);
    const issue = applyLiveOverlay(storedIssue, issueData.issue);
    if (issue.state !== 'open') return { status: 'skipped', reason: 'issue is closed' };
    const bugSignal = detectBugSignal(issue, { minConfidence: cfg.minBugConfidence });
    if (!bugSignal.isBug) return { status: 'skipped', reason: bugSignal.reason };

    opts.onEvent?.(`[#${issueNumber}] proceeding with autofix — ${bugSignal.reason}`);

    const repoRoot = resolve(cfg.repoRoot);
    const branch = `${cfg.branchPrefix}${issue.number}`;

    // Repo-discovered skills (Phase 1a). Discovery failure must never break
    // autofix — log and continue with no skills (built-in prompts unchanged).
    // Issue #262: when the caller supplied a pre-filtered catalog (SaaS path
    // with workspace_skill_states applied) use it instead of touching disk.
    const skills =
      opts.skills ?? (await this.discoverSkillsSafe(repoRoot, cfg.skillsDir, opts, issueNumber));

    const preflightSkip = await this.runAlreadyFixedPreflight(issue, opts);
    if (preflightSkip) {
      return { status: 'skipped', reason: preflightSkip };
    }

    this.markRunning(issueNumber);

    // In-session retry loop. Each iteration is one full analyze → fix → review
    // attempt with its own fresh worktree and token budget. Review failures
    // feed their blocker notes into the next iteration; hard failures break.
    let retryNotes = issue.analysis.autofixReviewNotes ?? undefined;
    let totalTokens = 0;
    let lastOutcome: OrchestratorOutcome | null = null;

    for (let localAttempt = 0; localAttempt < remainingAttempts; localAttempt++) {
      const globalAttempt = attemptsAlready + localAttempt + 1;
      const isFirst = localAttempt === 0;
      const isLast = localAttempt === remainingAttempts - 1;

      opts.onEvent?.(
        `[#${issueNumber}] Attempt ${globalAttempt}/${maxAttempts} — preparing worktree`,
      );

      let worktree;
      try {
        worktree = await createWorktree({
          repoRoot,
          branch,
          baseBranch: cfg.baseBranch,
          remote: cfg.remote,
          fetchRemote: cfg.fetchBeforeAttempt,
          authArgs: this.github.gitAuthArgs(),
          // Always start fresh: local branches with this name are always
          // stale work from a prior run (cezar only pushes on review-pass).
          // Inheriting them lets the previous run's autosave commits leak
          // into verify-in-repo and skip the new run.
          resetBranch: true,
        });
      } catch (err) {
        // Worktree setup failure is the same next attempt too — hard stop.
        return this.recordFailure(
          issueNumber,
          `worktree setup failed: ${(err as Error).message}`,
          totalTokens,
        );
      }

      this.store.setAnalysis(issueNumber, {
        autofixWorktreePath: worktree.path,
        autofixBranch: branch,
      });
      await this.store.save();

      // Run any user-configured env setup (yarn install, db migrate, etc.)
      // before the analyzer/fixer touch the worktree. Each attempt re-runs
      // setup because every retry creates a fresh worktree.
      if (cfg.setupCommands && cfg.setupCommands.length > 0) {
        opts.onEvent?.(`[#${issueNumber}] SETUP — running ${cfg.setupCommands.length} command(s)`);
        for (const command of cfg.setupCommands) {
          opts.onEvent?.(`[#${issueNumber}] $ ${command}`);
          const result = await runSetupCommand(command, worktree.path, (line) => {
            opts.onEvent?.(`  ${line}`);
          });
          if (!result.ok) {
            await worktree.dispose().catch(() => {});
            const tail = (result.stderr || result.stdout).split('\n').slice(-5).join(' | ').trim();
            return this.recordFailure(
              issueNumber,
              `env setup failed: \`${command}\` exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`,
              totalTokens,
              undefined,
              branch,
            );
          }
        }
      }

      const budget = new TokenBudget(cfg.tokenBudgetPerAttempt);
      let outcome: AttemptOutcome;
      try {
        outcome = await this.runOneAttempt({
          issueNumber,
          worktree,
          budget,
          retryNotes,
          cfg,
          issue,
          issueData,
          skills,
          confirmBeforeFix: isFirst ? opts.confirmBeforeFix : undefined,
          onEvent: opts.onEvent,
          onAgentEvent: opts.onAgentEvent,
          apply: opts.apply,
        });
      } catch (err) {
        await worktree.dispose().catch(() => {});
        totalTokens += budget.current;
        const msg = err instanceof Error ? err.message : String(err);
        return this.recordFailure(issueNumber, msg, totalTokens, undefined, branch);
      }

      totalTokens += budget.current;

      if (outcome.kind === 'pr-opened' || outcome.kind === 'dry-run') {
        // Success path — save, dispose, return.
        if (outcome.kind === 'pr-opened') {
          this.store.setAnalysis(issueNumber, {
            autofixStatus: 'pr-opened',
            autofixPrUrl: outcome.prUrl,
            autofixPrNumber: outcome.prNumber,
            autofixAttempts: globalAttempt,
            autofixLastRunAt: new Date().toISOString(),
            autofixTokensUsed: totalTokens,
            autofixLastError: null,
            autofixReviewVerdict: outcome.verdict.verdict,
            autofixReviewNotes: outcome.verdict.summary,
          });
        } else {
          this.store.setAnalysis(issueNumber, {
            autofixStatus: 'succeeded',
            autofixAttempts: globalAttempt,
            autofixLastRunAt: new Date().toISOString(),
            autofixTokensUsed: totalTokens,
            autofixLastError: null,
            autofixReviewVerdict: outcome.verdict.verdict,
            autofixReviewNotes: outcome.verdict.summary,
          });
        }
        await this.store.save();
        await worktree.dispose();
        this.store.setAnalysis(issueNumber, { autofixWorktreePath: null });
        await this.store.save();

        if (outcome.kind === 'pr-opened') {
          opts.onEvent?.(`[#${issueNumber}] DONE — ${outcome.prUrl}`);
          return {
            status: 'pr-opened',
            prUrl: outcome.prUrl,
            prNumber: outcome.prNumber,
            branch,
            headSha: outcome.headSha,
            rootCause: outcome.rootCause,
            verdict: outcome.verdict,
          };
        }
        return {
          status: 'dry-run',
          rootCause: outcome.rootCause,
          fixReport: outcome.fixReport,
          verdict: outcome.verdict,
          branch,
          diff: outcome.diff,
        };
      }

      if (outcome.kind === 'user-declined') {
        await worktree.dispose();
        this.store.setAnalysis(issueNumber, {
          autofixStatus: 'skipped',
          autofixWorktreePath: null,
        });
        await this.store.save();
        return { status: 'skipped', reason: 'user declined after analysis' };
      }

      if (outcome.kind === 'no-action-needed') {
        await worktree.dispose();
        this.store.setAnalysis(issueNumber, {
          autofixStatus: 'skipped',
          autofixWorktreePath: null,
          autofixAttempts: globalAttempt,
          autofixLastRunAt: new Date().toISOString(),
          autofixTokensUsed: totalTokens,
          autofixLastError: null,
        });
        await this.store.save();
        opts.onEvent?.(`[#${issueNumber}] SKIPPED — ${outcome.reason}`);
        return { status: 'skipped', reason: outcome.reason };
      }

      // All remaining kinds are failures. Narrow verdict/fixReport access.
      const failureVerdict = outcome.kind === 'review-failed' ? outcome.verdict : undefined;
      const failureFixReport =
        outcome.kind === 'review-failed' ? outcome.fixReport : outcome.fixReport;

      this.store.setAnalysis(issueNumber, {
        autofixStatus: 'failed',
        autofixAttempts: globalAttempt,
        autofixLastError: outcome.reason,
        autofixTokensUsed: totalTokens,
        autofixLastRunAt: new Date().toISOString(),
        autofixWorktreePath: null,
        autofixRootCause: outcome.rootCause?.summary ?? null,
        autofixReviewVerdict: failureVerdict?.verdict ?? null,
        autofixReviewNotes: failureVerdict ? retryNotesFromVerdict(failureVerdict) : null,
      });
      await this.store.save();
      await worktree.dispose().catch(() => {});

      lastOutcome = {
        status: 'failed',
        reason: outcome.reason,
        rootCause: outcome.rootCause,
        fixReport: failureFixReport,
        verdict: failureVerdict,
        branch,
      };

      // Only 'review-failed' is retriable. Structural/hard failures break.
      if (outcome.kind !== 'review-failed') {
        return lastOutcome;
      }
      if (!cfg.retryOnReviewFailure || isLast) {
        return lastOutcome;
      }

      retryNotes = retryNotesFromVerdict(outcome.verdict);
      opts.onEvent?.(
        `[#${issueNumber}] review failed — retrying with reviewer feedback (${outcome.verdict.issues.filter((i) => i.severity === 'blocker').length} blocker(s))`,
      );
    }

    // Loop exhausted — shouldn't reach here because the last iteration always
    // returns, but guard anyway.
    return (
      lastOutcome ?? { status: 'failed', reason: 'retry loop exhausted with no outcome', branch }
    );
  }

  private async runAlreadyFixedPreflight(
    issue: StoredIssue,
    opts: OrchestratorOptions,
  ): Promise<string | null> {
    // TODO(phase-1a): also honor a `verify-in-repo` binding here — skipped for
    // now because this path uses LLMService.analyze(promptString), not the
    // system/user split runAgentSession exposes, so appending a skill body isn't
    // clean. Revisit when verify-in-repo becomes a real workflow step (Phase 2).
    let mergedPRs;
    try {
      mergedPRs = await this.github.getIssueTimeline(issue.number);
    } catch (err) {
      opts.onEvent?.(
        `[#${issue.number}] PREFLIGHT — timeline lookup failed, continuing (${(err as Error).message})`,
      );
      return null;
    }

    if (mergedPRs.length === 0) return null;

    const doneMergedPRs = mergedPRs.map((pr) => ({ prNumber: pr.prNumber, prTitle: pr.prTitle }));

    if (!issue.digest) {
      opts.onEvent?.(
        `[#${issue.number}] PREFLIGHT — merged PR references found but digest is missing, continuing`,
      );
      return null;
    }

    opts.onEvent?.(
      `[#${issue.number}] PREFLIGHT — checking ${doneMergedPRs.length} merged PR reference(s) for an existing fix`,
    );

    try {
      const parsed = await this.llm.analyze(
        buildDoneDetectorPrompt([{ issue, mergedPRs: doneMergedPRs }]),
        DoneDetectorResponseSchema,
      );
      const result = parsed?.results.find((r) => r.number === issue.number);
      if (!result) return null;

      this.store.setAnalysis(issue.number, {
        doneDetected: result.isDone,
        doneConfidence: result.confidence,
        doneReason: result.reason,
        doneDraftComment: result.draftComment || null,
        doneMergedPRs,
        doneAnalyzedAt: new Date().toISOString(),
      });
      await this.store.save();

      if (!result.isDone) return null;
      opts.onEvent?.(
        `[#${issue.number}] PREFLIGHT — skipping autofix, existing merged PR likely resolved the issue`,
      );
      return result.reason;
    } catch (err) {
      opts.onEvent?.(
        `[#${issue.number}] PREFLIGHT — merged-PR verification failed, continuing (${(err as Error).message})`,
      );
      return null;
    }
  }

  private async runOneAttempt(args: {
    issueNumber: number;
    worktree: { path: string };
    budget: TokenBudget;
    retryNotes?: string;
    cfg: NonNullable<Config['autofix']>;
    issue: StoredIssue;
    issueData: {
      issue: { title: string; body: string };
      comments: Array<{ author: string; body: string; createdAt: string }>;
    };
    skills: Skill[];
    confirmBeforeFix?: (rootCause: RootCause, issue: StoredIssue) => Promise<boolean>;
    onEvent?: (event: string) => void;
    onAgentEvent?: (event: AgentEvent) => void;
    apply: boolean;
  }): Promise<AttemptOutcome> {
    const { issueNumber, worktree, budget, retryNotes, cfg, issue, issueData, skills } = args;
    const bindings = this.config.workflow?.bindings ?? [];

    args.onEvent?.(`[#${issueNumber}] ANALYZE — locating root cause`);
    const analyzerStep = this.resolveStep({
      stepId: 'root-cause',
      builtinSystemPrompt: ANALYZER_SYSTEM_PROMPT,
      builtinModel: cfg.models.analyzer,
      builtinTools: ['Read', 'Grep', 'Glob', 'Bash'],
      bindings,
      skills,
      onEvent: args.onEvent,
      issueNumber,
    });
    const analyzer = await withAttemptTimeout(
      runAgentSession({
        systemPrompt: analyzerStep.systemPrompt,
        userPrompt: buildAnalyzerUserPrompt({
          issueNumber,
          title: issueData.issue.title,
          body: issueData.issue.body,
          comments: issueData.comments,
          digest: issue.digest
            ? {
                summary: issue.digest.summary,
                affectedArea: issue.digest.affectedArea,
                keywords: issue.digest.keywords,
              }
            : undefined,
          priorAttemptNotes: retryNotes,
        }),
        cwd: worktree.path,
        allowedTools: analyzerStep.allowedTools,
        bashAllowlist: ['git log', 'git diff', 'git show', 'git status'],
        responseSchema: AnalyzerResultSchema,
        model: analyzerStep.model,
        maxTurns: cfg.maxTurns.analyzer,
        tokenBudget: budget,
        onEvent: args.onAgentEvent,
      }),
      cfg.attemptTimeoutMs,
    );

    if (analyzer.budgetExceeded)
      return { kind: 'hard-failed', reason: 'token budget exceeded during analysis' };
    if (!analyzer.parsed) {
      const tail = analyzer.text.slice(-400).trim();
      return {
        kind: 'hard-failed',
        reason: tail
          ? `analyzer did not return a valid JSON response. Last output: "${tail}"`
          : 'analyzer returned no parseable output (likely hit maxTurns without emitting JSON)',
      };
    }

    if (isNoActionNeeded(analyzer.parsed)) {
      return { kind: 'no-action-needed', reason: analyzer.parsed.reason };
    }

    const rootCause = analyzer.parsed;
    if (rootCause.confidence < cfg.minAnalyzerConfidence) {
      return {
        kind: 'hard-failed',
        reason: `analyzer confidence ${rootCause.confidence.toFixed(2)} below threshold ${cfg.minAnalyzerConfidence}`,
        rootCause,
      };
    }

    if (args.confirmBeforeFix) {
      const proceed = await args.confirmBeforeFix(rootCause, issue);
      if (!proceed) return { kind: 'user-declined' };
    }

    args.onEvent?.(`[#${issueNumber}] FIX — implementing change`);
    const fixStep = this.resolveStep({
      stepId: 'fix',
      builtinSystemPrompt: FIXER_SYSTEM_PROMPT,
      builtinModel: cfg.models.fixer,
      builtinTools: cfg.allowedTools,
      bindings,
      skills,
      onEvent: args.onEvent,
      issueNumber,
    });
    const fixer = await withAttemptTimeout(
      runAgentSession({
        systemPrompt: fixStep.systemPrompt,
        userPrompt: buildFixerUserPrompt({
          issueNumber,
          title: issueData.issue.title,
          rootCause,
          priorAttemptNotes: retryNotes,
        }),
        cwd: worktree.path,
        allowedTools: fixStep.allowedTools,
        bashAllowlist: cfg.bashAllowlist,
        responseSchema: FixReportSchema,
        model: fixStep.model,
        maxTurns: cfg.maxTurns.fixer,
        tokenBudget: budget,
        onEvent: args.onAgentEvent,
      }),
      cfg.attemptTimeoutMs,
    );

    if (fixer.budgetExceeded)
      return { kind: 'hard-failed', reason: 'token budget exceeded during fix', rootCause };
    if (!fixer.parsed)
      return { kind: 'hard-failed', reason: 'fixer did not return a valid FixReport', rootCause };
    const fixReport = fixer.parsed;

    args.onEvent?.(`[#${issueNumber}] COMMIT — staging changes`);
    const commitMessage = buildCommitMessage(issueNumber, issueData.issue.title, fixReport);
    const commitSha = await commitAll(worktree.path, commitMessage);
    if (!commitSha)
      return { kind: 'hard-failed', reason: 'fixer made no file changes', rootCause, fixReport };

    const diff = await getDiffAgainstBase(worktree.path, cfg.baseBranch);

    args.onEvent?.(`[#${issueNumber}] REVIEW — running code review`);
    const reviewStep = this.resolveStep({
      stepId: 'review',
      builtinSystemPrompt: REVIEWER_SYSTEM_PROMPT,
      builtinModel: cfg.models.reviewer,
      builtinTools: ['Read', 'Grep', 'Glob'],
      bindings,
      skills,
      onEvent: args.onEvent,
      issueNumber,
    });
    const reviewer = await withAttemptTimeout(
      runAgentSession({
        systemPrompt: reviewStep.systemPrompt,
        userPrompt: buildReviewerUserPrompt({
          issueNumber,
          title: issueData.issue.title,
          rootCause,
          fixReport,
          diff,
          baseBranch: cfg.baseBranch,
        }),
        cwd: worktree.path,
        allowedTools: reviewStep.allowedTools,
        responseSchema: ReviewVerdictSchema,
        model: reviewStep.model,
        maxTurns: cfg.maxTurns.reviewer,
        tokenBudget: budget,
        onEvent: args.onAgentEvent,
      }),
      cfg.attemptTimeoutMs,
    );

    // If the reviewer emitted prose instead of JSON we recover what we can so
    // the retry loop keeps its signal. Worst case: synthetic fail that tells
    // the fixer "your last diff needs further review — re-verify correctness".
    const verdict: Required<ReviewVerdict> = reviewer.parsed
      ? normalizeVerdict(reviewer.parsed)
      : fallbackVerdictFromProse(reviewer.text);

    const blockers = verdict.issues.filter((i) => i.severity === 'blocker').length;
    const passes = cfg.requireReviewPass
      ? verdict.verdict === 'pass' && blockers === 0
      : blockers === 0;

    if (!passes) {
      return {
        kind: 'review-failed',
        reason: reviewer.parsed
          ? `review ${verdict.verdict} (${blockers} blocker(s))`
          : `reviewer emitted prose; recovered verdict=${verdict.verdict} with ${blockers} blocker(s)`,
        rootCause,
        fixReport,
        verdict,
      };
    }

    if (!args.apply) {
      args.onEvent?.(`[#${issueNumber}] DRY-RUN — review passed, skipping push/PR`);
      return { kind: 'dry-run', rootCause, fixReport, verdict, diff };
    }

    args.onEvent?.(`[#${issueNumber}] PUSH — publishing branch`);
    await this.github.pushBranch(cfg.branchPrefix + issueNumber, worktree.path, cfg.remote);

    args.onEvent?.(`[#${issueNumber}] PR — opening draft pull request`);
    const prBody = buildPrBody(issueNumber, rootCause, fixReport, verdict);
    const pr = await this.github.createPullRequest({
      title: `fix: ${normalizeTitle(issueData.issue.title)} (#${issueNumber})`,
      body: prBody,
      head: cfg.branchPrefix + issueNumber,
      base: cfg.baseBranch,
      draft: cfg.draftPr,
      labels: cfg.prLabels,
    });

    return {
      kind: 'pr-opened',
      prUrl: pr.url,
      prNumber: pr.number,
      headSha: commitSha,
      rootCause,
      fixReport,
      verdict,
    };
  }

  /**
   * Follow-up attempt triggered after attribution concludes a CI failure on
   * an already-opened autofix PR was caused by our changes. Unlike
   * processIssue, this:
   *   - starts from the EXISTING PR branch, not baseBranch
   *   - skips the analyzer (attribution already told us what to focus on)
   *   - pushes new commits to the same branch (PR auto-updates)
   *   - does NOT open a new PR
   *   - posts a PR comment explaining what changed
   *
   * One attempt per call. The ci-fix cron loops if attempts remain.
   */
  async processCiFollowup(
    input: CiFollowupInput,
    opts: OrchestratorOptions,
  ): Promise<CiFollowupOutcome> {
    if (this.config.workflow?.useEngine) return this.processCiFollowupViaEngine(input, opts);
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) return { status: 'skipped', reason: 'autofix disabled in config' };
    if (!cfg.repoRoot) return { status: 'skipped', reason: 'autofix.repoRoot not set' };

    const issue = this.store.getIssue(input.issueNumber);
    if (!issue)
      return { status: 'skipped', reason: `issue #${input.issueNumber} not found in store` };

    const repoRoot = resolve(cfg.repoRoot);
    const issueData = await this.github.getIssueWithComments(input.issueNumber);

    opts.onEvent?.(
      `[#${input.issueNumber}] CI-FIX ${input.attemptIndex}/${input.attemptMax} — fetching branch ${input.branch}`,
    );

    // Materialise the PR branch into cezar's private ref namespace. The
    // follow-up worktree attaches to the existing local branch
    // (resetBranch:false) so the prior autofix commits stay — we're extending
    // the PR, not replacing it — or starts a fresh local branch from the
    // fetched PR tip when none exists yet.
    let prRef: string;
    try {
      prRef = await fetchRemoteBranch(
        repoRoot,
        cfg.remote,
        input.branch,
        this.github.gitAuthArgs(),
      );
    } catch (err) {
      return {
        status: 'failed',
        reason: `failed to fetch ${cfg.remote}/${input.branch}: ${(err as Error).message}`,
        branch: input.branch,
      };
    }

    let worktree;
    try {
      worktree = await createWorktree({
        repoRoot,
        branch: input.branch,
        baseBranch: cfg.baseBranch,
        remote: cfg.remote,
        fetchRemote: cfg.fetchBeforeAttempt,
        startRef: prRef,
        authArgs: this.github.gitAuthArgs(),
        resetBranch: false,
      });
    } catch (err) {
      return {
        status: 'failed',
        reason: `worktree setup failed: ${(err as Error).message}`,
        branch: input.branch,
      };
    }

    // Wrap everything after worktree creation so an uncaught throw from a
    // runAgentSession / commit / push call can't leak the worktree.
    try {
      // Re-run setup commands (fresh worktree, no deps installed yet).
      if (cfg.setupCommands && cfg.setupCommands.length > 0) {
        opts.onEvent?.(
          `[#${input.issueNumber}] CI-FIX SETUP — running ${cfg.setupCommands.length} command(s)`,
        );
        for (const command of cfg.setupCommands) {
          opts.onEvent?.(`[#${input.issueNumber}] $ ${command}`);
          const result = await runSetupCommand(command, worktree.path, (line) => {
            opts.onEvent?.(`  ${line}`);
          });
          if (!result.ok) {
            const tail = (result.stderr || result.stdout).split('\n').slice(-5).join(' | ').trim();
            return {
              status: 'failed',
              reason: `env setup failed: \`${command}\` exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`,
              branch: input.branch,
            };
          }
        }
      }

      const budget = new TokenBudget(cfg.ciFixTokenBudget ?? cfg.tokenBudgetPerAttempt);

      // Attribution IS our root-cause diagnosis. Confidence=1 because the
      // attributor already cleared the "is this ours?" hurdle; the fixer
      // shouldn't second-guess that.
      const rootCause: RootCause = {
        summary: input.attribution.suggestedFocus
          ? `CI follow-up: ${input.attribution.suggestedFocus}`
          : `CI failure on PR #${input.prNumber} attributed to this autofix`,
        hypothesis: input.attribution.reasoning,
        suspectedFiles: [],
        reproductionNotes:
          input.failedCheckNames.length > 0
            ? `Failing CI checks: ${input.failedCheckNames.join(', ')}`
            : undefined,
        confidence: 1,
      };

      const priorAttemptNotes = buildCiFollowupNotes(input);

      opts.onEvent?.(`[#${input.issueNumber}] CI-FIX FIX — implementing adjustment`);
      let fixer;
      try {
        fixer = await withAttemptTimeout(
          runAgentSession({
            systemPrompt: FIXER_SYSTEM_PROMPT,
            userPrompt: buildFixerUserPrompt({
              issueNumber: input.issueNumber,
              title: issueData.issue.title,
              rootCause,
              priorAttemptNotes,
            }),
            cwd: worktree.path,
            allowedTools: cfg.allowedTools,
            bashAllowlist: cfg.bashAllowlist,
            responseSchema: FixReportSchema,
            model: cfg.models.fixer,
            maxTurns: cfg.maxTurns.fixer,
            tokenBudget: budget,
            onEvent: opts.onAgentEvent,
          }),
          cfg.attemptTimeoutMs,
        );
      } catch (err) {
        await worktree.dispose().catch(() => {});
        return {
          status: 'failed',
          reason: `CI follow-up fix ${(err as Error).message}`,
          branch: input.branch,
        };
      }

      if (fixer.budgetExceeded) {
        return {
          status: 'failed',
          reason: 'token budget exceeded during CI follow-up fix',
          branch: input.branch,
        };
      }
      if (!fixer.parsed) {
        return {
          status: 'failed',
          reason: 'fixer did not return a valid FixReport for CI follow-up',
          branch: input.branch,
        };
      }
      const fixReport = fixer.parsed;

      opts.onEvent?.(`[#${input.issueNumber}] CI-FIX COMMIT — staging changes`);
      const commitMessage = buildCiFollowupCommitMessage(input, issueData.issue.title, fixReport);
      const commitSha = await commitAll(worktree.path, commitMessage);
      if (!commitSha) {
        return {
          status: 'skipped',
          reason: 'fixer made no file changes — CI failure may no longer reproduce',
        };
      }

      const diff = await getDiffAgainstBase(worktree.path, cfg.baseBranch);

      opts.onEvent?.(`[#${input.issueNumber}] CI-FIX REVIEW — running code review`);
      let reviewer;
      try {
        reviewer = await withAttemptTimeout(
          runAgentSession({
            systemPrompt: REVIEWER_SYSTEM_PROMPT,
            userPrompt: buildReviewerUserPrompt({
              issueNumber: input.issueNumber,
              title: issueData.issue.title,
              rootCause,
              fixReport,
              diff,
              baseBranch: cfg.baseBranch,
            }),
            cwd: worktree.path,
            allowedTools: ['Read', 'Grep', 'Glob'],
            responseSchema: ReviewVerdictSchema,
            model: cfg.models.reviewer,
            maxTurns: cfg.maxTurns.reviewer,
            tokenBudget: budget,
            onEvent: opts.onAgentEvent,
          }),
          cfg.attemptTimeoutMs,
        );
      } catch (err) {
        await worktree.dispose().catch(() => {});
        return {
          status: 'failed',
          reason: `CI follow-up review ${(err as Error).message}`,
          branch: input.branch,
          fixReport,
        };
      }

      const verdict: Required<ReviewVerdict> = reviewer.parsed
        ? normalizeVerdict(reviewer.parsed)
        : fallbackVerdictFromProse(reviewer.text);

      const blockers = verdict.issues.filter((i) => i.severity === 'blocker').length;
      const passes = cfg.requireReviewPass
        ? verdict.verdict === 'pass' && blockers === 0
        : blockers === 0;

      if (!passes) {
        return {
          status: 'failed',
          reason: `CI follow-up review ${verdict.verdict} (${blockers} blocker(s))`,
          verdict,
          fixReport,
          branch: input.branch,
        };
      }

      opts.onEvent?.(`[#${input.issueNumber}] CI-FIX PUSH — updating PR #${input.prNumber}`);
      try {
        await this.github.pushBranch(input.branch, worktree.path, cfg.remote);
      } catch (err) {
        return {
          status: 'failed',
          reason: `push failed: ${(err as Error).message}`,
          verdict,
          fixReport,
          branch: input.branch,
        };
      }

      // PR-comment is best-effort — don't fail the attempt just because we
      // couldn't attach a note. The commit itself is the source of truth.
      try {
        await this.github.addComment(
          input.prNumber,
          buildCiFollowupPrComment(input, fixReport, verdict),
        );
      } catch (err) {
        opts.onEvent?.(
          `[#${input.issueNumber}] CI-FIX NOTE — could not post PR comment: ${(err as Error).message}`,
        );
      }

      opts.onEvent?.(
        `[#${input.issueNumber}] CI-FIX DONE — ${commitSha.slice(0, 8)} pushed to ${input.branch}`,
      );

      return { status: 'pushed', branch: input.branch, headSha: commitSha, verdict, fixReport };
    } finally {
      await worktree.dispose().catch(() => {});
    }
  }

  // ─── Phase 3a: workflow-engine path (config.workflow.useEngine) ─────────
  // When the flag is OFF (the default) none of this runs and the legacy path
  // above is byte-identical to before.

  private async processIssueViaEngine(
    issueNumber: number,
    opts: OrchestratorOptions,
  ): Promise<OrchestratorOutcome> {
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) return { status: 'skipped', reason: 'autofix disabled in config' };
    if (!cfg.repoRoot) return { status: 'skipped', reason: 'autofix.repoRoot not set' };

    const storedIssue = this.store.getIssue(issueNumber);
    if (!storedIssue)
      return { status: 'skipped', reason: `issue #${issueNumber} not found in store` };
    // Refresh from GitHub before the gate — same rationale as the legacy
    // path. The downstream workflow re-fetches what it needs anyway, so
    // the only marginal cost is this one extra API call.
    let issue = storedIssue;
    try {
      const live = await this.github.getIssueWithComments(issueNumber);
      issue = applyLiveOverlay(storedIssue, live.issue);
    } catch (err) {
      opts.onEvent?.(
        `[#${issueNumber}] GitHub refresh failed, using cached labels: ${(err as Error).message}`,
      );
    }
    if (issue.state !== 'open') return { status: 'skipped', reason: 'issue is closed' };
    const bugSignal = detectBugSignal(issue, { minConfidence: cfg.minBugConfidence });
    if (!bugSignal.isBug) return { status: 'skipped', reason: bugSignal.reason };
    if (issue.analysis.doneDetected === true) {
      return {
        status: 'skipped',
        reason: issue.analysis.doneReason ?? 'issue already appears resolved by a merged PR',
      };
    }
    if (issue.analysis.autofixStatus === 'pr-opened') {
      return { status: 'skipped', reason: 'PR already opened' };
    }
    const attemptsAlready = issue.analysis.autofixAttempts ?? 0;
    if (cfg.maxAttemptsPerIssue - attemptsAlready <= 0) {
      return { status: 'skipped', reason: 'max attempts reached (use --retry to reset counter)' };
    }

    opts.onEvent?.(`[#${issueNumber}] proceeding with autofix — ${bugSignal.reason}`);

    const repoRoot = resolve(cfg.repoRoot);
    const branch = `${cfg.branchPrefix}${issue.number}`;

    this.markRunning(issueNumber);

    let worktree;
    try {
      worktree = await createWorktree({
        repoRoot,
        branch,
        baseBranch: cfg.baseBranch,
        remote: cfg.remote,
        fetchRemote: cfg.fetchBeforeAttempt,
        authArgs: this.github.gitAuthArgs(),
        // Always start fresh — see the matching call site above.
        resetBranch: true,
        onWarn: (m) => opts.onEvent?.(`[#${issueNumber}] ${m}`),
      });
    } catch (err) {
      return this.recordFailure(
        issueNumber,
        `worktree setup failed: ${(err as Error).message}`,
        0,
        undefined,
        branch,
      );
    }

    this.store.setAnalysis(issueNumber, {
      autofixWorktreePath: worktree.path,
      autofixBranch: branch,
    });
    await this.store.save();

    if (cfg.setupCommands && cfg.setupCommands.length > 0) {
      opts.onEvent?.(`[#${issueNumber}] SETUP — running ${cfg.setupCommands.length} command(s)`);
      for (const command of cfg.setupCommands) {
        opts.onEvent?.(`[#${issueNumber}] $ ${command}`);
        const result = await runSetupCommand(command, worktree.path, (line) =>
          opts.onEvent?.(`  ${line}`),
        );
        if (!result.ok) {
          await worktree.dispose().catch(() => {});
          const tail = (result.stderr || result.stdout).split('\n').slice(-5).join(' | ').trim();
          return this.recordFailure(
            issueNumber,
            `env setup failed: \`${command}\` exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`,
            0,
            undefined,
            branch,
          );
        }
      }
    }

    // Build the runnable project env (native shell or a per-run docker-compose
    // project) bound to the worktree. Drives the install/build/test shell-check
    // steps. createRunEnv only throws for an explicit compose config that can't
    // run here (no compose file / no Docker); auto falls back to native.
    let runEnv: RunEnv;
    try {
      runEnv = await createRunEnv({
        worktreePath: worktree.path,
        spec: cfg.projectEnv,
        runId: `${issueNumber}-${randomUUID().slice(0, 8)}`,
        onWarn: (m) => opts.onEvent?.(`[#${issueNumber}] ${m}`),
      });
    } catch (err) {
      await worktree.dispose().catch(() => {});
      return this.recordFailure(
        issueNumber,
        `project env setup failed: ${(err as Error).message}`,
        0,
        undefined,
        branch,
      );
    }

    let result;
    try {
      result = await runWorkflow<AutofixBlackboard>(autofixWorkflow, {
        store: this.store,
        config: this.config,
        github: this.github,
        issueNumber,
        apply: opts.apply,
        worktreePath: worktree.path,
        baseSha: worktree.baseSha,
        runEnv,
        bindings: this.config.workflow?.bindings,
        settings: this.config.workflow?.settings,
        labels: opts.labels,
        skills: opts.skills,
        resumeSessionId: opts.resumeSessionId,
        loopMaxIterations: { 'fix-review': cfg.maxAttemptsPerIssue },
        tokenBudgetPerAttempt: cfg.tokenBudgetPerAttempt,
        onEvent: opts.onEvent,
        onAgentEvent: opts.onAgentEvent
          ? (e) => {
              const legacy = normalizedToLegacyAgentEvent(e);
              if (legacy) opts.onAgentEvent!(legacy);
            }
          : undefined,
        onStepStart: opts.onStepStart,
        onRunRecord: opts.onRunRecord,
        pauseRequested: opts.pauseRequested,
        cancelRequested: opts.cancelRequested,
        // The engine's `confirm-fix` human-gate gates on the verify-in-repo
        // output, not a full root cause; adapt `confirmBeforeFix` accordingly.
        // TODO(phase-3a): in practice `confirm-fix` auto-proceeds whenever
        // verify-in-repo confidence cleared the threshold (and verify-in-repo
        // already skip-runs below it), so this callback is rarely hit — kept
        // wired for parity. No resume-after-pause in 3a.
        requestHumanDecision: opts.confirmBeforeFix
          ? async (prompt) => {
              const verify = (
                prompt.context as { verify?: { reason?: string; confidence?: number } } | undefined
              )?.verify;
              const synthetic = {
                summary: verify?.reason ?? prompt.question,
                hypothesis: '',
                suspectedFiles: [] as string[],
                confidence: verify?.confidence ?? 0,
              };
              const proceed = await opts.confirmBeforeFix!(synthetic as RootCause, issue);
              return { choice: proceed ? 'proceed' : 'skip' };
            }
          : undefined,
      });
    } catch (err) {
      await runEnv.dispose().catch(() => {});
      await worktree.dispose().catch(() => {});
      return this.recordFailure(issueNumber, (err as Error).message, 0, undefined, branch);
    }

    await runEnv.dispose().catch(() => {});
    await worktree.dispose().catch(() => {});

    const outcome = workflowResultToAutofixOutcome(result);
    await this.persistEngineOutcome(issueNumber, outcome, result.tokensUsed, attemptsAlready + 1);
    if (outcome.status === 'pr-opened') opts.onEvent?.(`[#${issueNumber}] DONE — ${outcome.prUrl}`);
    return outcome;
  }

  private async processCiFollowupViaEngine(
    input: CiFollowupInput,
    opts: OrchestratorOptions,
  ): Promise<CiFollowupOutcome> {
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) return { status: 'skipped', reason: 'autofix disabled in config' };
    if (!cfg.repoRoot) return { status: 'skipped', reason: 'autofix.repoRoot not set' };

    const issue = this.store.getIssue(input.issueNumber);
    if (!issue)
      return { status: 'skipped', reason: `issue #${input.issueNumber} not found in store` };

    const repoRoot = resolve(cfg.repoRoot);

    opts.onEvent?.(
      `[#${input.issueNumber}] CI-FIX ${input.attemptIndex}/${input.attemptMax} — fetching branch ${input.branch}`,
    );
    let prRef: string;
    try {
      prRef = await fetchRemoteBranch(
        repoRoot,
        cfg.remote,
        input.branch,
        this.github.gitAuthArgs(),
      );
    } catch (err) {
      return {
        status: 'failed',
        reason: `failed to fetch ${cfg.remote}/${input.branch}: ${(err as Error).message}`,
        branch: input.branch,
      };
    }

    let worktree;
    try {
      worktree = await createWorktree({
        repoRoot,
        branch: input.branch,
        baseBranch: cfg.baseBranch,
        remote: cfg.remote,
        fetchRemote: cfg.fetchBeforeAttempt,
        startRef: prRef,
        authArgs: this.github.gitAuthArgs(),
        resetBranch: false,
        onWarn: (m) => opts.onEvent?.(`[#${input.issueNumber}] ${m}`),
      });
    } catch (err) {
      return {
        status: 'failed',
        reason: `worktree setup failed: ${(err as Error).message}`,
        branch: input.branch,
      };
    }

    if (cfg.setupCommands && cfg.setupCommands.length > 0) {
      opts.onEvent?.(
        `[#${input.issueNumber}] CI-FIX SETUP — running ${cfg.setupCommands.length} command(s)`,
      );
      for (const command of cfg.setupCommands) {
        opts.onEvent?.(`[#${input.issueNumber}] $ ${command}`);
        const result = await runSetupCommand(command, worktree.path, (line) =>
          opts.onEvent?.(`  ${line}`),
        );
        if (!result.ok) {
          await worktree.dispose().catch(() => {});
          const tail = (result.stderr || result.stdout).split('\n').slice(-5).join(' | ').trim();
          return {
            status: 'failed',
            reason: `env setup failed: \`${command}\` exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`,
            branch: input.branch,
          };
        }
      }
    }

    // Seed the transient field the ci-followup workflow reads off `config`.
    const seed: CiFollowupSeed = {
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      attemptIndex: input.attemptIndex,
      attemptMax: input.attemptMax,
      attribution: input.attribution,
      failedCheckNames: input.failedCheckNames,
      logTails: input.logTails,
      branch: input.branch,
    };
    const configWithSeed = { ...this.config, __ciFollowup: seed } as Config;

    let runEnv: RunEnv;
    try {
      runEnv = await createRunEnv({
        worktreePath: worktree.path,
        spec: cfg.projectEnv,
        runId: `ci-${input.issueNumber}-${randomUUID().slice(0, 8)}`,
        onWarn: (m) => opts.onEvent?.(`[#${input.issueNumber}] ${m}`),
      });
    } catch (err) {
      await worktree.dispose().catch(() => {});
      return {
        status: 'failed',
        reason: `project env setup failed: ${(err as Error).message}`,
        branch: input.branch,
      };
    }

    let result;
    try {
      result = await runWorkflow<CiFollowupBlackboard>(ciFollowupWorkflow, {
        store: this.store,
        config: configWithSeed,
        github: this.github,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        branch: input.branch,
        apply: true,
        worktreePath: worktree.path,
        baseSha: worktree.baseSha,
        runEnv,
        bindings: this.config.workflow?.bindings,
        settings: this.config.workflow?.settings,
        labels: opts.labels,
        skills: opts.skills,
        resumeSessionId: opts.resumeSessionId,
        tokenBudgetPerAttempt: cfg.ciFixTokenBudget ?? cfg.tokenBudgetPerAttempt,
        onEvent: opts.onEvent,
        onAgentEvent: opts.onAgentEvent
          ? (e) => {
              const legacy = normalizedToLegacyAgentEvent(e);
              if (legacy) opts.onAgentEvent!(legacy);
            }
          : undefined,
        onStepStart: opts.onStepStart,
        onRunRecord: opts.onRunRecord,
        pauseRequested: opts.pauseRequested,
        cancelRequested: opts.cancelRequested,
      });
    } catch (err) {
      await runEnv.dispose().catch(() => {});
      await worktree.dispose().catch(() => {});
      return { status: 'failed', reason: (err as Error).message, branch: input.branch };
    }

    await runEnv.dispose().catch(() => {});
    await worktree.dispose().catch(() => {});
    return workflowResultToCiFollowupOutcome(result);
  }

  /** Persist the autofix-status store fields from a translated engine outcome. */
  private async persistEngineOutcome(
    issueNumber: number,
    outcome: OrchestratorOutcome,
    tokensUsed: number,
    attempts: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (outcome.status === 'pr-opened') {
      this.store.setAnalysis(issueNumber, {
        autofixStatus: 'pr-opened',
        autofixPrUrl: outcome.prUrl,
        autofixPrNumber: outcome.prNumber,
        autofixAttempts: attempts,
        autofixLastRunAt: now,
        autofixTokensUsed: tokensUsed,
        autofixLastError: null,
        autofixWorktreePath: null,
        autofixReviewVerdict: outcome.verdict.verdict,
        autofixReviewNotes: outcome.verdict.summary,
      });
    } else if (outcome.status === 'dry-run') {
      this.store.setAnalysis(issueNumber, {
        autofixStatus: 'succeeded',
        autofixAttempts: attempts,
        autofixLastRunAt: now,
        autofixTokensUsed: tokensUsed,
        autofixLastError: null,
        autofixWorktreePath: null,
        autofixReviewVerdict: outcome.verdict.verdict,
        autofixReviewNotes: outcome.verdict.summary,
      });
    } else if (outcome.status === 'skipped') {
      this.store.setAnalysis(issueNumber, {
        autofixStatus: 'skipped',
        autofixWorktreePath: null,
        autofixAttempts: attempts,
        autofixLastRunAt: now,
        autofixTokensUsed: tokensUsed,
        autofixLastError: null,
      });
    } else {
      this.store.setAnalysis(issueNumber, {
        autofixStatus: 'failed',
        autofixAttempts: attempts,
        autofixLastError: outcome.reason,
        autofixTokensUsed: tokensUsed,
        autofixLastRunAt: now,
        autofixWorktreePath: null,
        autofixRootCause: outcome.rootCause?.summary ?? null,
        autofixReviewVerdict: outcome.verdict?.verdict ?? null,
        autofixReviewNotes: outcome.verdict
          ? retryNotesFromVerdict(outcome.verdict as Required<ReviewVerdict>)
          : null,
      });
    }
    await this.store.save();
  }

  /**
   * Discover repo skills, swallowing any failure (missing dir, read error) —
   * skill discovery is best-effort and must never break an autofix run.
   */
  private async discoverSkillsSafe(
    repoRoot: string,
    skillsDir: string,
    opts: OrchestratorOptions,
    issueNumber: number,
  ): Promise<Skill[]> {
    try {
      return await discoverSkills(repoRoot, skillsDir);
    } catch (err) {
      opts.onEvent?.(
        `[#${issueNumber}] SKILLS — discovery failed, continuing with built-in prompts (${(err as Error).message})`,
      );
      return [];
    }
  }

  /**
   * Resolve a step's system prompt / model / tools via the binding chain
   * (docs §3.5). Backend is honored in the resolution but execution stays on
   * `anthropic-api` until Phase 4 — a non-API binding emits a warning.
   */
  private resolveStep(args: {
    stepId: string;
    builtinSystemPrompt: string;
    builtinModel: string;
    builtinTools: string[];
    bindings: WorkflowBinding[];
    skills: Skill[];
    onEvent?: (event: string) => void;
    issueNumber: number;
  }): { systemPrompt: string; model: string; allowedTools: string[] } {
    const binding = args.bindings.find((b) => b.stepId === args.stepId) ?? null;
    const resolved = resolveStepConfig({
      stepId: args.stepId,
      builtinSystemPrompt: args.builtinSystemPrompt,
      builtinModel: args.builtinModel,
      binding,
      skills: args.skills,
    });
    if (resolved.backend !== 'anthropic-api') {
      args.onEvent?.(
        `[#${args.issueNumber}] binding requests backend '${resolved.backend}' but multi-backend execution lands in Phase 4 — using anthropic-api`,
      );
    }
    return {
      systemPrompt: resolved.systemPrompt,
      model: resolved.model,
      allowedTools: [...args.builtinTools, ...resolved.extraTools],
    };
  }

  private markRunning(issueNumber: number): void {
    this.store.setAnalysis(issueNumber, {
      autofixStatus: 'running',
      autofixLastRunAt: new Date().toISOString(),
    });
  }

  private async recordFailure(
    issueNumber: number,
    reason: string,
    tokens: number,
    dispose?: () => Promise<void>,
    branch?: string,
    artifacts?: { rootCause?: RootCause; fixReport?: FixReport; verdict?: ReviewVerdict },
  ): Promise<OrchestratorOutcome> {
    if (dispose) await dispose().catch(() => {});
    const issue = this.store.getIssue(issueNumber);
    const attempts = (issue?.analysis.autofixAttempts ?? 0) + 1;
    this.store.setAnalysis(issueNumber, {
      autofixStatus: 'failed',
      autofixAttempts: attempts,
      autofixLastError: reason,
      autofixTokensUsed: tokens,
      autofixLastRunAt: new Date().toISOString(),
      autofixWorktreePath: null,
    });
    await this.store.save();
    return {
      status: 'failed',
      reason,
      rootCause: artifacts?.rootCause,
      fixReport: artifacts?.fixReport,
      verdict: artifacts?.verdict,
      branch,
    };
  }
}
