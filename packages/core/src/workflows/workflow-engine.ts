import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config } from '../config/config.model.js';
import type { IssueStore } from '../store/store.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentRunner,
  AgentRunSpec,
} from '../agents/agent-runner.js';
import { createAgentRunner } from '../agents/runner-factory.js';
import { discoverSkills, type Skill } from '../skills/skill-catalog.js';
import {
  resolveStepConfig,
  type WorkflowBinding,
  type WorkspaceWorkflowSettings,
  DEFAULT_WORKSPACE_WORKFLOW_SETTINGS,
} from './binding.js';
import type { WorkspaceLabel } from '../labels/label-catalog.js';
import {
  commitAll,
  getDiffAgainstBase,
  squashCommitsToBase,
  startWorktreeAutosaver,
} from '../actions/autofix/worktree.js';
import { upsertMarkerComment } from './pr-link-marker.js';
import type { RunEnv } from '../provision/run-env.js';
import { PersistentClaudeSession, ResumeFailedError } from '../agents/persistent-claude-session.js';
import {
  UNIFIED_AUTOFIX_SYSTEM_PROMPT,
  buildUnifiedFlowSystemPrompt,
} from '../actions/autofix/prompts/autofix-unified.js';
import { TokenBudget } from '../actions/autofix/token-budget.js';
import { parseStructured } from '../agents/structured-output.js';
import {
  type Workflow,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowRunResult,
  type WorkflowRunStatus,
  type StepRunStatus,
  type StepOutcome,
  type AgentRunRecord,
  type AgentStepDef,
  type CommentSection,
  type CommentTarget,
  type HumanGatePrompt,
  type HumanGateDecision,
  type WorkflowEffectDeps,
  type StepValue,
} from './workflow.js';

/** Resolve a `StepValue<T>` against the run's config (a fixed value or a `(config) => T`). */
function resolveStepValue<T>(value: StepValue<T>, config: Config): T {
  return typeof value === 'function' ? (value as (c: Config) => T)(config) : value;
}

/**
 * What the engine needs to drive a single workflow run. The caller (Phase 3:
 * the job dispatcher; today: tests / a thin CLI command) owns worktree setup
 * for repo-backed workflows — either pass `worktreePath` directly or supply
 * `prepareWorktree`.
 */
export interface WorkflowRunContext {
  store: IssueStore;
  config: Config;
  /** GitHub side. Structurally compatible with `GitHubService`; injectable for tests. */
  github: WorkflowGitHub;
  issueNumber: number;
  prNumber?: number;
  branch?: string;
  /** Picks the `AgentRunner` for a backend. Defaults to `createAgentRunner`. */
  runnerFactory?: (backend: AgentBackend) => AgentRunner;
  /** GUI-editable per-step bindings (from `config.workflow?.bindings`). */
  bindings?: WorkflowBinding[];
  settings?: WorkspaceWorkflowSettings;
  /** false ⇒ dry-run (no push, no PR). */
  apply: boolean;
  /** Pre-prepared worktree path for repo-backed workflows. */
  worktreePath?: string;
  /**
   * The commit sha the worktree branch was created from (`WorktreeHandle.baseSha`).
   * The commit step squashes autosaver commits back onto *this* fixed sha rather
   * than the live `baseBranch` ref — `origin/main` is a moving target, and a
   * concurrent fetch advancing it between worktree creation and the squash would
   * otherwise make `git reset --soft origin/main` drag every unrelated commit
   * `origin/main` gained in the meantime into the squashed commit as a revert.
   * When omitted the engine falls back to `config.autofix.baseBranch`.
   */
  baseSha?: string;
  /**
   * Pre-existing Claude session id for this workflow run, set on a re-claim
   * after a runner crash (the SaaS reads `workflow_runs.session_id` from the
   * previous attempt and threads it back here). The engine reuses it for
   * every step and asks the runner to `claude --resume <id>` on the first
   * step so the new process picks up the prior conversation. If the resume
   * fails (cross-host re-claim — the on-disk session blob lives under
   * `~/.claude/` on the original host), the runner falls back to a fresh
   * start under the same id.
   */
  resumeSessionId?: string;
  /** Or: a hook the engine calls to set one up (and dispose it at the end). */
  prepareWorktree?: () => Promise<{ path: string; dispose: () => Promise<void> }>;
  /**
   * The runnable project environment bound to the worktree (native shell or a
   * docker-compose project). Drives `shell-check` steps. When absent, those
   * steps are no-ops, so env-less runs (tests, triage) behave as before.
   */
  runEnv?: RunEnv;
  /** Per-attempt token budget; created fresh per loop iteration if omitted. */
  tokenBudgetPerAttempt?: number;
  /** Lifecycle progress strings. */
  onEvent?: (event: string) => void;
  /** Normalized agent stream. */
  onAgentEvent?: (event: AgentEvent) => void;
  /**
   * Fired the moment the engine is about to execute a step — before the agent
   * launches / the shell-check runs / etc. The record carries `status:
   * 'running'` and (for agent steps) the resolved backend/model. Lets the
   * cockpit render a step card and emit a `step-start` event as the work
   * begins instead of bunching them with the step's completion.
   */
  onStepStart?: (record: AgentRunRecord) => void;
  /** Phase 3 hook: persist each step's run record. */
  onRunRecord?: (record: AgentRunRecord) => void;
  /** Human-in-the-loop callback for `human-gate` steps; absent ⇒ pause cleanly unless `autoProceed`. */
  requestHumanDecision?: (prompt: HumanGatePrompt) => Promise<HumanGateDecision | null>;
  /** Pre-discovered repo skills; defaults to discovering from `config.autofix.repoRoot`. */
  skills?: Skill[];
  /**
   * Workspace label catalog. When present, the engine appends a "Repository
   * label catalog" section to each agent step's system prompt (filtered by
   * the step's `labelScope`, or `'both'` by default). Loaded by the GUI
   * dispatch layer from `workspace_labels`; the CLI leaves it undefined.
   */
  labels?: WorkspaceLabel[];
  /**
   * Set to request a graceful pause between steps (docs §3.4). May be a static
   * boolean or a (sync/async) probe — the dispatcher passes a function that
   * re-reads the DB so an out-of-band pause request is honoured mid-run.
   * A running step is NOT interrupted mid-flight (known limitation, §3.4).
   */
  pauseRequested?: boolean | (() => boolean | Promise<boolean>);
  /**
   * Set to request cancellation between steps. Same shape/semantics as
   * `pauseRequested`, but ends the run `cancelled` (with `reason: 'cancelled'`).
   */
  cancelRequested?: boolean | (() => boolean | Promise<boolean>);
  /** Per-loop-id `maxIterations` override (workflow defs are static; config drives the cap). */
  loopMaxIterations?: Record<string, number>;
  /** Git ops in the worktree — injectable for tests; defaults to the real `worktree.ts` helpers. */
  gitOps?: {
    commitAll(worktreePath: string, message: string): Promise<string | null>;
    getDiffAgainstBase(worktreePath: string, baseRef: string): Promise<string>;
    /** Optional. Used to recover from autosaver-already-committed work — see
     *  `squashCommitsToBase` in worktree.ts. When omitted the engine falls
     *  back to the no-changes path, matching pre-autosaver behavior. */
    squashCommitsToBase?(
      worktreePath: string,
      baseRef: string,
      message: string,
    ): Promise<string | null>;
  };
}

/** The subset of `GitHubService` the engine touches. */
export interface WorkflowGitHub {
  addComment(issueNumber: number, body: string): Promise<number | void>;
  updateComment(commentId: number, body: string): Promise<void>;
  getIssueWithComments(issueNumber: number): Promise<{
    issue: { number: number; title: string; body: string };
    comments: Array<{ author: string; body: string; createdAt: string }>;
  }>;
  /** Used by the pr-link-marker upsert; falls back to `addComment` when absent. */
  listIssueCommentsWithIds?(
    issueNumber: number,
  ): Promise<Array<{ id: number; author: string; body: string; createdAt: string }>>;
  setLabels(issueNumber: number, labels: string[]): Promise<void>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  closeIssue(issueNumber: number, reason?: 'completed' | 'not_planned'): Promise<void>;
  pushBranch(branch: string, localRepoPath: string, remote?: string): Promise<void>;
  createPullRequest(opts: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
    labels?: string[];
  }): Promise<{ url: string; number: number }>;
}

interface RenderedSection {
  stepId: string;
  heading: string;
  body: string;
}

type FinalOpts = { done: boolean; prNumber?: number; prUrl?: string; reason?: string };

/** Tracks the run's living comment(s) and renders the per-step checklist (docs §3.6). */
class LivingComment {
  private commentIds = new Map<CommentTarget, number>();
  private sections = new Map<CommentTarget, RenderedSection[]>();
  private active: CommentTarget;
  /** Set once the PR exists (so a 'pr'-first workflow can post on start). */
  private prNumber?: number;

  constructor(
    private readonly github: WorkflowGitHub,
    private readonly issueNumber: number,
    private readonly title: string,
    targetOrder: CommentTarget[],
    private readonly separatePerStep: boolean,
    prNumber?: number,
  ) {
    this.active = targetOrder[0] ?? 'issue';
    this.prNumber = prNumber;
  }

  private targetNumber(target: CommentTarget): number {
    return target === 'pr' && this.prNumber != null ? this.prNumber : this.issueNumber;
  }

  /** Post the initial "in progress" comment on the first target (if it exists). */
  async start(): Promise<void> {
    if (this.separatePerStep) return; // each section becomes its own comment instead
    if (this.active === 'pr' && this.prNumber == null) return; // PR not opened yet — wait for switchToPr
    const body = this.render(this.active, false);
    const id = await this.github.addComment(this.targetNumber(this.active), body);
    if (typeof id === 'number') this.commentIds.set(this.active, id);
  }

  async appendSection(stepId: string, section: CommentSection): Promise<void> {
    if (!section) return;
    if (this.separatePerStep) {
      // Old behavior: one comment per step.
      await this.github.addComment(
        this.targetNumber(this.active),
        `### ${section.heading}\n\n${section.body}`,
      );
      return;
    }
    const list = this.sections.get(this.active) ?? [];
    list.push({ stepId, heading: section.heading, body: section.body });
    this.sections.set(this.active, list);
    if (this.commentIds.has(this.active)) await this.rerender(this.active);
    // else: no comment to edit yet (e.g. PR-first workflow before the PR is
    // opened) — the sections are buffered and emitted when start()/switchToPr fires.
  }

  /** Switch the living comment to the PR (post a fresh single comment there). */
  async switchToPr(prNumber: number): Promise<void> {
    this.prNumber = prNumber;
    this.active = 'pr';
    if (this.separatePerStep) return;
    if (!this.commentIds.has('pr')) {
      const body = this.render('pr', false);
      const id = await this.github.addComment(prNumber, body);
      if (typeof id === 'number') this.commentIds.set('pr', id);
    } else {
      await this.rerender('pr');
    }
  }

  /** Finalize: re-render every comment with the final status; link the issue comment to the PR. */
  async finalize(opts: FinalOpts): Promise<void> {
    if (this.separatePerStep) return;
    for (const target of this.commentIds.keys()) {
      await this.rerender(target, opts);
    }
  }

  private async rerender(target: CommentTarget, finalOpts?: FinalOpts): Promise<void> {
    const id = this.commentIds.get(target);
    if (id == null) return;
    const body = this.render(target, true, finalOpts);
    try {
      await this.github.updateComment(id, body);
    } catch {
      // Editing the living comment is best-effort — the step results are the
      // source of truth, not the comment.
    }
  }

  private render(target: CommentTarget, started: boolean, finalOpts?: FinalOpts): string {
    const list = this.sections.get(target) ?? [];
    const header =
      target === 'pr'
        ? `## 🤖 Cezar — automated work for #${this.issueNumber}`
        : `## 🤖 Cezar autofix — ${finalOpts?.done ? 'done' : 'in progress'}`;
    const lines: string[] = [header, '', `**Issue:** #${this.issueNumber} — ${this.title}`, ''];
    if (list.length === 0) {
      lines.push(started ? '_(no sections yet)_' : '_Starting…_');
    } else {
      for (const s of list) {
        lines.push(`### ${s.heading}`, '', s.body, '');
      }
    }
    if (finalOpts?.done && target === 'issue') {
      if (finalOpts.prNumber != null) {
        lines.push(
          '---',
          `Done — see PR #${finalOpts.prNumber}${finalOpts.prUrl ? ` (${finalOpts.prUrl})` : ''}.`,
        );
      } else if (finalOpts.reason) {
        lines.push('---', `Done — ${finalOpts.reason}`);
      } else {
        lines.push('---', 'Done.');
      }
    }
    return lines.join('\n');
  }
}

/** Execute one declarative workflow run. */
export class WorkflowEngine {
  async runWorkflow<W>(
    workflow: Workflow<W>,
    ctx: WorkflowRunContext,
  ): Promise<WorkflowRunResult<W>> {
    const settings: WorkspaceWorkflowSettings = ctx.settings ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS;
    const runnerFactory =
      ctx.runnerFactory ?? ((backend) => createAgentRunner(backend, { config: ctx.config }));
    const bindings = ctx.bindings ?? ctx.config.workflow?.bindings ?? [];
    // The workspace's effective default backend, used to stamp non-agent steps'
    // synthetic records so the cockpit's per-row backend icon matches where the
    // run actually executes (claude-cli / codex-cli) instead of always reading
    // 'anthropic-api'. Derived from the per-step bindings — the same source the
    // agent steps resolve their backend from (see resolveStepConfig) — using the
    // first binding that pins one. Falls back to the API path when none do.
    const workspaceBackend: AgentBackend =
      bindings.find((b) => b.backend != null)?.backend ?? 'anthropic-api';

    // Issue data — repo-less workflows still want title/body for prompts.
    let issueTitle = `#${ctx.issueNumber}`;
    let issueBody = '';
    let issueComments: Array<{ author: string; body: string; createdAt: string }> = [];
    try {
      const data = await ctx.github.getIssueWithComments(ctx.issueNumber);
      issueTitle = data.issue.title;
      issueBody = data.issue.body;
      issueComments = data.comments;
    } catch (err) {
      ctx.onEvent?.(`[#${ctx.issueNumber}] could not fetch issue data: ${(err as Error).message}`);
    }

    const storedIssue = ctx.store.getIssue(ctx.issueNumber);
    const digest = storedIssue?.digest
      ? {
          summary: storedIssue.digest.summary,
          affectedArea: storedIssue.digest.affectedArea,
          keywords: storedIssue.digest.keywords,
        }
      : undefined;

    const skills: Skill[] = ctx.skills ?? (await this.discoverSkillsSafe(ctx));

    // Worktree (repo-backed workflows). The caller may pass a path directly or
    // a `prepareWorktree` hook; repo-less workflows leave both undefined.
    let worktreePath = ctx.worktreePath;
    let disposeWorktree: (() => Promise<void>) | undefined;
    if (!worktreePath && ctx.prepareWorktree) {
      const wt = await ctx.prepareWorktree();
      worktreePath = wt.path;
      disposeWorktree = wt.dispose;
    }

    const blackboard = workflow.initialBlackboard();
    const runRecords: AgentRunRecord[] = [];
    let totalTokens = 0;
    let branch = ctx.branch;
    let headSha: string | undefined;
    let prUrl: string | undefined;
    let prNumber = ctx.prNumber;
    let devServerUrl: string | undefined;

    // One claude session id for the whole workflow run — reused across every
    // agent step's `--session-id`. With `transport: 'stream-json'` claude
    // resumes the same on-disk session between staged spawns, so each step
    // after the first sees the prior turns as conversation context and
    // Anthropic's prompt cache reads the cumulative prefix instead of a cold
    // start. In `mode: 'unified'` the same id pins the single long-lived
    // child. Used to be `record.id` per step (a fresh UUID), which threw
    // away every chance at a cache hit.
    //
    // On a re-claim after a runner crash the caller passes the existing id
    // through `ctx.resumeSessionId` so the workflow keeps the same session
    // (and `resumingFromCrash` flips the first step to `--resume <id>` so
    // the new process picks up the prior conversation prefix on the same
    // host; cross-host fallback is the runner's job).
    const runSessionId = ctx.resumeSessionId ?? randomUUID();
    let resumingFromCrash = ctx.resumeSessionId != null;

    // Unified persistent session: one long-lived `claude` child for the whole
    // run. Applies to the typed autofix workflow (`UNIFIED_AUTOFIX_SYSTEM_PROMPT`)
    // and to user-defined flow workflows (per-flow unified prompt built from
    // each step's resolved skill body); other workflows stay staged.
    // Requires `runner.mode: 'unified'` and a worktree.
    const unifiedSession = await this.maybeStartUnifiedSession({
      workflow,
      config: ctx.config,
      worktreePath,
      onEvent: ctx.onAgentEvent,
      sessionId: runSessionId,
      bindings,
      skills,
      labels: ctx.labels,
      resume: resumingFromCrash,
      onResumeFallback: () => {
        ctx.onEvent?.(
          `[#${ctx.issueNumber}] claude --resume ${runSessionId} failed — falling back to fresh start under same id`,
        );
        resumingFromCrash = false;
      },
    });

    const living = new LivingComment(
      ctx.github,
      ctx.issueNumber,
      issueTitle,
      workflow.commentTargetOrder,
      settings.separateCommentPerStep,
      ctx.prNumber,
    );

    const gitOps = ctx.gitOps ?? { commitAll, getDiffAgainstBase, squashCommitsToBase };

    const effectDeps: WorkflowEffectDeps = {
      github: {
        addComment: (n, b) => ctx.github.addComment(n, b),
        updateComment: (id, b) => ctx.github.updateComment(id, b),
        setLabels: (n, l) => ctx.github.setLabels(n, l),
        addLabel: (n, l) => ctx.github.addLabel(n, l),
        closeIssue: (n, r) => ctx.github.closeIssue(n, r),
        pushBranch: (br, p, r) => ctx.github.pushBranch(br, p, r),
        createPullRequest: (o) => ctx.github.createPullRequest(o),
      },
      git: gitOps,
      store: ctx.store,
    };

    const finishRun = async (
      status: WorkflowRunStatus,
      reason?: string,
    ): Promise<WorkflowRunResult<W>> => {
      // Stop the unified session FIRST — its child needs the worktree
      // path to still exist for any pending flushes. (dispose may remove it.)
      if (unifiedSession) {
        await unifiedSession.stop().catch((err) => {
          ctx.onEvent?.(
            `[#${ctx.issueNumber}] unified session stop failed: ${(err as Error).message}`,
          );
        });
      }
      if (disposeWorktree) await disposeWorktree().catch(() => {});
      // Best-effort: finalizing the living comment must never throw out of
      // finishRun — that would discard the run result and leak the run.
      await living
        .finalize({
          done: status === 'succeeded',
          prNumber,
          prUrl,
          reason,
        })
        .catch((err) => {
          ctx.onEvent?.(
            `[#${ctx.issueNumber}] living comment finalize failed: ${(err as Error).message}`,
          );
        });
      return {
        status,
        blackboard,
        runRecords,
        reason,
        prUrl,
        prNumber,
        branch,
        headSha,
        tokensUsed: totalTokens,
        // The same id is used for every claude-cli step; report it back so
        // the caller can persist it onto `workflow_runs.session_id`.
        sessionId: runSessionId,
      };
    };

    // Best-effort, mirroring how appendSection/rerender already swallow GitHub
    // errors: a flaky GitHub API at run-start must not leak the run as
    // forever-running (it would skip the try/catch loop and never reach
    // finishRun, leaking the unified session + worktree). The living comment is
    // best-effort per its own design — the step results are the source of truth.
    await living.start().catch((err: Error) => {
      ctx.onEvent?.(`[#${ctx.issueNumber}] living comment start failed: ${err.message}`);
    });
    ctx.onEvent?.(
      `[#${ctx.issueNumber}] workflow '${workflow.id}' — ${workflow.steps.length} step(s)`,
    );

    // Build a quick lookup for which loop (if any) a step belongs to. Apply
    // any `loopMaxIterations` override (workflow defs are static; config caps it).
    const effectiveLoops = (workflow.loops ?? []).map((loop) => {
      const override = ctx.loopMaxIterations?.[loop.id];
      const maxIterations = override != null ? Math.max(1, override) : loop.maxIterations;
      return { ...loop, maxIterations };
    });
    const loopById = new Map(effectiveLoops.map((l) => [l.id, l]));
    const loopOfStep = new Map<string, (typeof effectiveLoops)[number]>();
    for (const loop of effectiveLoops) {
      for (const sid of loop.stepIds) loopOfStep.set(sid, loop);
    }

    // Validate loops up front: a typo'd or stale `stepIds` entry would otherwise
    // make `findIndex` return -1 and the cursor walk `steps[-1]` (undefined),
    // dying as "step 'undefined' threw…" with no hint at the real cause. Catch
    // it here and precompute each loop's first-step index so the jumps below are
    // a guaranteed-valid map lookup rather than a re-scan that can return -1.
    const loopFirstIndex = new Map<string, number>();
    for (const loop of effectiveLoops) {
      for (const sid of loop.stepIds) {
        if (!workflow.steps.some((s) => s.id === sid)) {
          throw new Error(
            `workflow '${workflow.id}' loop '${loop.id}' references unknown step '${sid}'`,
          );
        }
      }
      loopFirstIndex.set(
        loop.id,
        workflow.steps.findIndex((s) => s.id === loop.stepIds[0]),
      );
    }

    // Engine main loop. We walk `workflow.steps` by index; when a loop body
    // step fails-retriable (or returns goto-loop) we jump the cursor back to
    // the loop's first step and bump the iteration counter.
    const resolveFlag = async (flag: WorkflowRunContext['pauseRequested']): Promise<boolean> => {
      if (flag == null) return false;
      if (typeof flag === 'boolean') return flag;
      return (await flag()) === true;
    };

    let i = 0;
    const loopIterations = new Map<string, number>();

    // Re-entering a loop is the ONE canonical place we bump the iteration
    // counter — whether the re-entry is a fail-retriable retry, an explicit
    // `goto-loop`, or a tail `until` returning false. Centralizing it keeps
    // a single logical iteration from burning two slots (e.g. a mid-loop
    // fail-retriable followed by the tail `until` for the same pass — see
    // `justReentered` below) and makes the cap mean exactly "N body passes".
    // Returns the step index to jump to, or a finished run when the cap is hit.
    const reenterLoop = (
      loop: (typeof effectiveLoops)[number],
      reason?: string,
    ): number | Promise<WorkflowRunResult<W>> => {
      const next = (loopIterations.get(loop.id) ?? 0) + 1;
      if (next >= loop.maxIterations) {
        return finishRun(
          'failed',
          reason
            ? `${reason} (loop '${loop.id}' exhausted ${loop.maxIterations} iteration(s))`
            : `loop '${loop.id}' exhausted ${loop.maxIterations} iteration(s)`,
        );
      }
      loopIterations.set(loop.id, next);
      ctx.onEvent?.(
        `[#${ctx.issueNumber}] loop '${loop.id}' — iteration ${next}/${loop.maxIterations}${reason ? `: ${reason}` : ''}`,
      );
      return loopFirstIndex.get(loop.id)!;
    };

    // One-shot: set when a fail-retriable just bumped + jumped to the loop
    // head, so the tail `until`-false branch on the resulting pass doesn't
    // double-bump the same logical iteration. Cleared once that pass reaches
    // the loop tail (or the run otherwise moves on).
    let justReentered = false;
    while (i < workflow.steps.length) {
      if (await resolveFlag(ctx.cancelRequested)) {
        return finishRun('cancelled', 'cancelled');
      }
      if (await resolveFlag(ctx.pauseRequested)) {
        return finishRun('paused', 'paused — pause requested between steps');
      }
      const step = workflow.steps[i];
      const loop = loopOfStep.get(step.id);
      const iteration = loop ? (loopIterations.get(loop.id) ?? 0) : 0;

      // Skip open-pr when not applying.
      if (step.kind === 'open-pr' && !ctx.apply) {
        ctx.onEvent?.(`[#${ctx.issueNumber}] DRY-RUN — skipping ${step.id}`);
        i++;
        continue;
      }

      const stepCtx = this.makeStepContext<W>({
        blackboard,
        iteration,
        config: ctx.config,
        issue: {
          number: ctx.issueNumber,
          title: issueTitle,
          body: issueBody,
          comments: issueComments,
          digest,
        },
        prNumber,
        branch,
        worktreePath,
        devServerUrl,
        tokenBudget: undefined, // set per agent step below
        onAgentEvent: ctx.onAgentEvent,
        onEvent: ctx.onEvent,
        appendCommentSection: (section) => living.appendSection(step.id, section),
        requestHumanDecision: ctx.requestHumanDecision,
      });

      let outcome: StepOutcome<W>;
      let record: AgentRunRecord | undefined;

      // Fire onStepStart for non-agent steps right here so the cockpit can
      // render a card + emit a `step-start` event before the step's body
      // produces any lifecycle output. Agent steps fire their own onStepStart
      // from inside runAgentStep — after binding resolution — so the record
      // carries the real backend/model instead of placeholders.
      if (step.kind !== 'agent') {
        record = this.syntheticRecord(
          workflow.id,
          step.id,
          step.kind,
          iteration,
          'running',
          workspaceBackend,
        );
        ctx.onStepStart?.(record);
      }

      try {
        if (step.kind === 'agent') {
          const r = await this.runAgentStep(step as AgentStepDef<W, unknown>, {
            stepCtx,
            iteration,
            bindings,
            skills,
            runnerFactory,
            tokenBudgetPerAttempt:
              ctx.tokenBudgetPerAttempt ?? ctx.config.autofix?.tokenBudgetPerAttempt,
            workflowId: workflow.id,
            worktreePath,
            living,
            labels: ctx.labels,
            unifiedSession,
            runSessionId,
            // Cross-restart resume — `resumingFromCrash` is true only for the
            // first step on a re-claim. After that step's runner has either
            // resumed the on-disk session or fallen back to a cold start
            // under the same id, all subsequent steps use the regular
            // `--session-id` path (claude resumes off the prior step's turn
            // file regardless).
            resume: resumingFromCrash,
            onResumeFallback: () => {
              ctx.onEvent?.(
                `[#${ctx.issueNumber}] claude --resume ${runSessionId} failed — fell back to fresh start under same id`,
              );
            },
            onStepStart: ctx.onStepStart,
          });
          // After the first step in a re-claimed run finishes (or fell back),
          // we've reattached the session — subsequent steps treat it as a
          // normal continuation.
          resumingFromCrash = false;
          outcome = r.outcome;
          record = r.record;
          totalTokens += r.record.tokensUsed;
        } else if (step.kind === 'effect') {
          outcome = await step.run(stepCtx, effectDeps);
          if (step.commentSection)
            await living.appendSection(step.id, step.commentSection(stepCtx));
        } else if (step.kind === 'human-gate') {
          const r = await this.runHumanGate(step, stepCtx);
          if (r.kind === 'paused') {
            // Finalize the synthetic record before bailing so the cockpit's
            // `agent_runs` row for this gate transitions out of 'running'
            // (StepRunStatus has no 'paused' — 'skipped' is the closest) and
            // shows up in WorkflowRunResult.runRecords.
            record!.status = 'skipped';
            record!.summary = `paused — awaiting human decision at '${step.id}'`;
            record!.finishedAt = new Date().toISOString();
            runRecords.push(record!);
            ctx.onRunRecord?.(record!);
            return finishRun('paused', `paused — awaiting human decision at '${step.id}'`);
          }
          outcome = r.outcome;
          if (step.commentSection)
            await living.appendSection(step.id, step.commentSection(stepCtx));
        } else if (step.kind === 'commit') {
          const wt = this.requireWorktree(worktreePath, step.id);
          const baseRef = ctx.config.autofix?.baseBranch ?? 'main';
          // Squash against the fixed sha the branch was created from, not the
          // live base ref. `origin/main` can move under us between worktree
          // creation and this step (a concurrent fetch); resetting to it would
          // drag everything it gained into the squash as a revert. Fall back to
          // `baseRef` only when the caller didn't thread the captured sha.
          const squashBase = ctx.baseSha ?? baseRef;
          const message = step.buildMessage(stepCtx);
          let sha = await gitOps.commitAll(wt, message);
          // `commitAll` returns null when the working tree is clean. That can
          // mean two things: (a) the fixer really did nothing, or (b) the
          // autosaver already committed everything under `cezar: autosave
          // (fix)`. Squash autosave commits into one clean commit when (b);
          // only declare "no changes" when there's truly no diff against base.
          if (!sha && gitOps.squashCommitsToBase) {
            sha = await gitOps.squashCommitsToBase(wt, squashBase, message);
          }
          if (!sha) {
            if (step.failOnNoChanges) {
              outcome = { kind: 'fail', reason: 'fixer made no file changes' };
            } else {
              outcome = {
                kind: 'skip-run',
                reason: 'fixer made no file changes — CI failure may no longer reproduce',
              };
            }
          } else {
            // Diff against the same fixed branch point we squashed onto, so the
            // reviewed/displayed diff matches the committed change exactly even
            // if the live base ref moved during the run.
            const diff = await gitOps.getDiffAgainstBase(wt, squashBase);
            headSha = sha;
            outcome = step.onCommitted({ commitSha: sha, diff }, stepCtx);
            if (step.commentSection)
              await living.appendSection(step.id, step.commentSection({ commitSha: sha }, stepCtx));
          }
        } else if (step.kind === 'open-pr') {
          const wt = this.requireWorktree(worktreePath, step.id);
          const cfg = ctx.config.autofix;
          // Prefer the branch the caller seeded into the context (the worktree's
          // actual local branch — e.g. the unique per-flow branch generated by
          // `runFlow`). Fall back to the legacy derivation so the autofix path,
          // which doesn't seed `ctx.branch`, behaves identically.
          const pushBranchName =
            branch ?? (cfg?.branchPrefix ?? 'autofix/cezar-issue-') + ctx.issueNumber;
          await ctx.github.pushBranch(pushBranchName, wt, cfg?.remote);
          const { title, body } = step.buildPr(stepCtx);
          const pr = await ctx.github.createPullRequest({
            title,
            body,
            head: pushBranchName,
            base: cfg?.baseBranch ?? 'main',
            draft: cfg?.draftPr ?? true,
            labels: cfg?.prLabels,
          });
          prUrl = pr.url;
          prNumber = pr.number;
          branch = pushBranchName;
          // Post-PR steps edit the PR comment now.
          await living.switchToPr(pr.number);
          if (step.prCommentSection)
            await living.appendSection(step.id, step.prCommentSection(stepCtx));
          // Sticky pr-link marker on the issue — see pr-link-marker.ts. A
          // best-effort write: a network blip here shouldn't fail the run,
          // since the PR itself was created successfully. Future runs of
          // any workflow against this issue can read the marker to detect
          // "PR already open".
          await upsertMarkerComment(ctx.github, ctx.issueNumber, {
            prNumber: pr.number,
            prUrl: pr.url,
            prState: cfg?.draftPr === false ? 'open' : 'draft',
            branch: pushBranchName,
          }).catch((err: Error) => {
            ctx.onEvent?.(`[#${ctx.issueNumber}] pr-link marker upsert failed: ${err.message}`);
          });
          outcome = step.onOpened(
            { url: pr.url, number: pr.number, headSha: headSha ?? '' },
            stepCtx,
          );
        } else if (step.kind === 'push') {
          const wt = this.requireWorktree(worktreePath, step.id);
          const cfg = ctx.config.autofix;
          if (!branch) {
            outcome = { kind: 'fail', reason: `push step '${step.id}' has no branch to push` };
          } else {
            await ctx.github.pushBranch(branch, wt, cfg?.remote);
            if (prNumber != null) {
              await living.switchToPr(prNumber);
              if (step.prCommentSection)
                await living.appendSection(step.id, step.prCommentSection(stepCtx));
            }
            outcome = step.onPushed({ headSha: headSha ?? '' }, stepCtx);
          }
        } else if (step.kind === 'shell-check') {
          outcome = await this.runShellCheck(step, stepCtx, ctx, living);
        } else if (step.kind === 'dev-server') {
          const r = await this.runDevServer(step, stepCtx, ctx, living);
          if (r.url) devServerUrl = r.url; // exposed to later agent steps
          outcome = r.outcome;
        } else {
          const exhaustive: never = step;
          throw new Error(`unknown step kind: ${JSON.stringify(exhaustive)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (record) {
          record.status = 'failed';
          record.error = msg;
          record.finishedAt = new Date().toISOString();
          runRecords.push(record);
          ctx.onRunRecord?.(record);
        }
        return finishRun('failed', `step '${step.id}' threw: ${msg}`);
      }

      // Record the step (non-agent steps get a synthetic record too so the
      // cockpit shows every step; agent steps already have theirs).
      if (!record) {
        record = this.syntheticRecord(
          workflow.id,
          step.id,
          step.kind,
          iteration,
          'succeeded',
          workspaceBackend,
        );
      }
      if (outcome.kind === 'skip-run') {
        record.status = 'skipped';
        record.summary = outcome.reason;
      } else if (outcome.kind === 'fail') {
        record.status = 'failed';
        record.error = outcome.reason;
      } else if (record.status === 'running') {
        // Non-agent steps start with status='running' (so onStepStart carries
        // it). Agent steps set their final status inside runAgentStep, so
        // this only flips the leftover 'running' on a `continue` outcome.
        record.status = 'succeeded';
      }
      record.finishedAt ??= new Date().toISOString();
      runRecords.push(record);
      ctx.onRunRecord?.(record);

      // Apply blackboard patch (continue / goto-loop / fail-retriable can carry one).
      if ('blackboardPatch' in outcome && outcome.blackboardPatch) {
        Object.assign(blackboard as object, outcome.blackboardPatch);
      }

      // Pick up the PR opened by an agent step so downstream step contexts see
      // it (the typed open-pr / push path sets these directly; the flow path
      // surfaces them through `openedPr` on the outcome).
      if ('openedPr' in outcome && outcome.openedPr) {
        if (prNumber == null) prNumber = outcome.openedPr.number;
        if (!prUrl) prUrl = outcome.openedPr.url;
      }

      // ── Outcome dispatch ──
      if (outcome.kind === 'skip-run') {
        return finishRun('succeeded', outcome.reason);
      }

      if (outcome.kind === 'fail') {
        const retriable = outcome.retriable === true && loop != null;
        if (!retriable) {
          return finishRun('failed', outcome.reason);
        }
        // Retry the loop. This re-entry IS the iteration bump — flag it so the
        // tail `until` on the resulting pass doesn't bump again for the same
        // logical iteration.
        const target = reenterLoop(loop, outcome.reason);
        if (typeof target !== 'number') return target;
        justReentered = true;
        i = target;
        continue;
      }

      if (outcome.kind === 'goto-loop') {
        const targetLoop = loopById.get(outcome.loopId);
        if (!targetLoop)
          return finishRun('failed', `goto-loop to unknown loop '${outcome.loopId}'`);
        const target = reenterLoop(targetLoop);
        if (typeof target !== 'number') return target;
        // A fresh re-entry into the loop body — drop any pending one-shot from
        // a prior in-loop retry so the new pass's tail `until` bumps normally.
        justReentered = false;
        i = target;
        continue;
      }

      // continue — but if this was the last step of a loop, check `until`.
      if (loop && step.id === loop.stepIds[loop.stepIds.length - 1]) {
        const done = loop.until(stepCtx);
        if (!done) {
          // If a fail-retriable already bumped this pass, the re-entry was
          // counted there — don't burn a second slot for the same iteration.
          // Consume the one-shot and re-enter without bumping.
          if (justReentered) {
            justReentered = false;
            i = loopFirstIndex.get(loop.id)!;
            continue;
          }
          const target = reenterLoop(loop);
          if (typeof target !== 'number') return target;
          i = target;
          continue;
        }
        // Loop tail with `until` satisfied — the loop is done. Clear the
        // one-shot (a fail-retriable earlier in this pass is now moot).
        justReentered = false;
      }

      i++;
    }

    return finishRun('succeeded');
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private requireWorktree(path: string | undefined, stepId: string): string {
    if (!path) throw new Error(`step '${stepId}' requires a worktree but none was provided`);
    return path;
  }

  /**
   * Run a `shell-check` step's command in the run's `RunEnv`. No env, or an
   * unconfigured command, ⇒ a silent `continue` (env-less runs unaffected).
   * Gated failures inside a loop fail-`retriable` so the engine re-enters it.
   */
  private async runShellCheck<W>(
    step: Extract<WorkflowStep<W>, { kind: 'shell-check' }>,
    stepCtx: WorkflowStepContext<W>,
    ctx: WorkflowRunContext,
    living: LivingComment,
  ): Promise<StepOutcome<W>> {
    const env = ctx.runEnv;
    if (!env) return { kind: 'continue' };
    const result = await env[step.which]((line) => stepCtx.log(`  [${step.which}] ${line}`));
    if (!result) return { kind: 'continue' }; // command not configured ⇒ skip the check
    const gate = resolveStepValue(step.gate, ctx.config);
    const patch = step.onResult?.(result, stepCtx) as Partial<W> | undefined;
    if (step.commentSection)
      await living.appendSection(step.id, step.commentSection(result, stepCtx));
    if (result.ok || !gate) {
      if (!result.ok)
        ctx.onEvent?.(
          `[#${ctx.issueNumber}] ${step.which} failed (exit ${result.exitCode}) — not gated, continuing`,
        );
      return { kind: 'continue', blackboardPatch: patch };
    }
    return {
      kind: 'fail',
      reason: `${step.which} failed (exit ${result.exitCode})`,
      retriable: step.retriable === true,
      blackboardPatch: patch,
    };
  }

  /**
   * Boot the run's dev server. Returns the URL (so the engine can expose it to
   * later agent steps) plus the step outcome. No env / disabled dev server ⇒ a
   * silent `continue`. A boot error, or a never-ready server when `gate` is on,
   * fails the run; otherwise it's recorded and the run continues.
   */
  private async runDevServer<W>(
    step: Extract<WorkflowStep<W>, { kind: 'dev-server' }>,
    stepCtx: WorkflowStepContext<W>,
    ctx: WorkflowRunContext,
    living: LivingComment,
  ): Promise<{ outcome: StepOutcome<W>; url?: string }> {
    const env = ctx.runEnv;
    if (!env) return { outcome: { kind: 'continue' } };
    const gate = step.gate ? resolveStepValue(step.gate, ctx.config) : false;

    let handle;
    try {
      handle = await env.startDevServer((line) => stepCtx.log(`  ${line}`));
    } catch (err) {
      const reason = `dev server failed to start: ${(err as Error).message}`;
      if (step.commentSection)
        await living.appendSection(
          step.id,
          step.commentSection({ url: null, ready: false }, stepCtx),
        );
      return { outcome: gate ? { kind: 'fail', reason } : { kind: 'continue' } };
    }
    if (!handle) return { outcome: { kind: 'continue' } }; // not configured

    if (step.commentSection)
      await living.appendSection(
        step.id,
        step.commentSection({ url: handle.url, ready: handle.ready }, stepCtx),
      );
    const patch = step.onReady?.({ url: handle.url, ready: handle.ready }, stepCtx) as
      | Partial<W>
      | undefined;

    if (!handle.ready && gate) {
      return {
        outcome: { kind: 'fail', reason: `dev server at ${handle.url} never became ready` },
        url: handle.url,
      };
    }
    if (!handle.ready) {
      ctx.onEvent?.(
        `[#${ctx.issueNumber}] dev server at ${handle.url} not confirmed ready — continuing`,
      );
    }
    return { outcome: { kind: 'continue', blackboardPatch: patch }, url: handle.url };
  }

  private async discoverSkillsSafe(ctx: WorkflowRunContext): Promise<Skill[]> {
    const repoRoot = ctx.config.autofix?.repoRoot;
    if (!repoRoot) return [];
    try {
      return await discoverSkills(resolve(repoRoot), ctx.config.autofix?.skillsDir ?? '.ai/skills');
    } catch (err) {
      ctx.onEvent?.(
        `[#${ctx.issueNumber}] SKILLS — discovery failed, continuing with built-in prompts (${(err as Error).message})`,
      );
      return [];
    }
  }

  private makeStepContext<W>(args: {
    blackboard: W;
    iteration: number;
    config: Config;
    issue: WorkflowStepContext<W>['issue'];
    prNumber?: number;
    branch?: string;
    worktreePath?: string;
    devServerUrl?: string;
    tokenBudget?: TokenBudget;
    onAgentEvent?: (e: AgentEvent) => void;
    onEvent?: (e: string) => void;
    appendCommentSection: (section: CommentSection) => Promise<void>;
    requestHumanDecision?: (prompt: HumanGatePrompt) => Promise<HumanGateDecision | null>;
  }): WorkflowStepContext<W> {
    return {
      blackboard: args.blackboard,
      iteration: args.iteration,
      config: args.config,
      issue: args.issue,
      prNumber: args.prNumber,
      branch: args.branch,
      worktreePath: args.worktreePath,
      devServerUrl: args.devServerUrl,
      tokenBudget: args.tokenBudget,
      emit: (e) => args.onAgentEvent?.(e),
      log: (m) => args.onEvent?.(m),
      appendCommentSection: args.appendCommentSection,
      requestHumanDecision: async (prompt) =>
        args.requestHumanDecision ? args.requestHumanDecision(prompt) : null,
    };
  }

  private syntheticRecord(
    workflow: string,
    stepId: string,
    kind: AgentRunRecord['kind'],
    iteration: number,
    status: StepRunStatus,
    // The workspace's effective default backend — non-agent steps (effect,
    // commit, open-pr, push, shell-check, dev-server, human-gate) run wherever
    // the workflow itself runs, so they should report that backend rather than
    // a hardcoded 'anthropic-api' (which mislabels CLI runs in the cockpit).
    workspaceBackend: AgentBackend = 'anthropic-api',
  ): AgentRunRecord {
    return {
      id: randomUUID(),
      workflow,
      stepId,
      kind,
      iteration,
      backend: workspaceBackend,
      // Non-agent steps have no model; render neutrally rather than "(none)".
      model: '—',
      status,
      startedAt: new Date().toISOString(),
      tokensUsed: 0,
    };
  }

  private async runHumanGate<W>(
    step: Extract<WorkflowStep<W>, { kind: 'human-gate' }>,
    ctx: WorkflowStepContext<W>,
  ): Promise<{ kind: 'paused' } | { kind: 'resolved'; outcome: StepOutcome<W> }> {
    if (step.autoProceed?.(ctx)) {
      return { kind: 'resolved', outcome: { kind: 'continue' } };
    }
    // TODO (unified-mode alive-gate): in unified mode, a paused gate should
    // keep the PersistentClaudeSession's child alive so resume can pick up
    // mid-conversation with the cache prefix intact. Today we still return
    // `paused`; the workflow_runs row is paused, the runner process exits,
    // and a resume re-spawns a fresh session (same as staged). Wiring up
    // the alive-child path requires:
    //   1. A Supabase channel subscription here that resolves on
    //      'resume' or 'cancel' broadcasts for this workflow_run.id.
    //   2. Keeping the parent runner process alive for the whole pause
    //      duration (today the dispatch worker is short-lived).
    //   3. A heartbeat/keepalive on the child every ~5 min so the SDK
    //      doesn't time out.
    // Left as the next PR's work — staged mode handles the gate just
    // fine while the rest of Phase B settles.
    const prompt = step.buildPrompt(ctx);
    const decision = await ctx.requestHumanDecision(prompt);
    if (!decision) return { kind: 'paused' };
    const outcome = step.onDecision
      ? step.onDecision(decision, ctx)
      : decision.choice === 'proceed'
        ? ({ kind: 'continue' } as StepOutcome<W>)
        : ({ kind: 'skip-run', reason: `human chose '${decision.choice}'` } as StepOutcome<W>);
    return { kind: 'resolved', outcome };
  }

  private async runAgentStep<W>(
    step: AgentStepDef<W, unknown>,
    args: {
      stepCtx: WorkflowStepContext<W>;
      iteration: number;
      bindings: WorkflowBinding[];
      skills: Skill[];
      runnerFactory: (backend: AgentBackend) => AgentRunner;
      tokenBudgetPerAttempt?: number;
      workflowId: string;
      worktreePath?: string;
      living: LivingComment;
      labels?: WorkspaceLabel[];
      /** Phase B: when set, the engine routes agent steps through this
       *  long-lived session instead of spawning a fresh `claude` per step. */
      unifiedSession: PersistentClaudeSession | null;
      /** Workflow-run-level claude session id reused across every agent step
       *  so claude-cli resumes the same on-disk session (and Anthropic's
       *  prompt cache hits the prior conversation prefix). */
      runSessionId: string;
      /** True on the first step of a re-claim — flips the runner from
       *  `--session-id` to `--resume <id>` so the new process picks up the
       *  prior conversation. The runner falls back transparently on a
       *  cross-host re-claim where the session blob isn't local. */
      resume: boolean;
      /** Invoked when a resume fell back to fresh start under the same id. */
      onResumeFallback?: () => void;
      /** Fire `onStepStart` from inside the agent step (after binding
       *  resolution) so the start record carries the resolved backend/model. */
      onStepStart?: (record: AgentRunRecord) => void;
    },
  ): Promise<{ outcome: StepOutcome<W>; record: AgentRunRecord }> {
    const { stepCtx, iteration, bindings, skills, runnerFactory, workflowId, labels } = args;

    if (step.cwdRequired && !args.worktreePath) {
      throw new Error(`agent step '${step.id}' requires a worktree but none was provided`);
    }

    const config = stepCtx.config;
    const builtinModel = resolveStepValue(step.builtinModel, config);
    const builtinTools = resolveStepValue(step.builtinTools, config);
    const bashAllowlist =
      step.bashAllowlist != null ? resolveStepValue(step.bashAllowlist, config) : undefined;
    const maxTurns = step.maxTurns != null ? resolveStepValue(step.maxTurns, config) : undefined;

    const resolved = resolveStepConfig({
      stepId: step.id,
      builtinSystemPrompt: step.builtinSystemPrompt,
      builtinModel,
      binding: bindings.find((b) => b.stepId === step.id),
      skills,
      labels,
      labelScope: step.labelScope ?? 'both',
    });

    const budget = args.tokenBudgetPerAttempt
      ? new TokenBudget(args.tokenBudgetPerAttempt)
      : undefined;
    const ctxWithBudget: WorkflowStepContext<W> = { ...stepCtx, tokenBudget: budget };

    const record: AgentRunRecord = {
      id: randomUUID(),
      workflow: workflowId,
      stepId: step.id,
      kind: 'agent',
      iteration,
      backend: resolved.backend,
      model: resolved.model,
      status: 'running',
      startedAt: new Date().toISOString(),
      tokensUsed: 0,
      // Stamp the run session id on every agent_runs row so the cockpit can
      // surface "session XYZ" and a future re-claim can read it back. Only
      // claude-cli honors session ids today; for other backends this is a
      // best-effort hint (the runner still ignores it).
      sessionId: resolved.backend === 'claude-cli' ? args.runSessionId : undefined,
    };
    args.onStepStart?.(record);

    const runner = runnerFactory(resolved.backend);
    const allowedTools = [...builtinTools, ...resolved.extraTools];

    let userPrompt = step.buildUserPrompt(ctxWithBudget);
    let effectiveBashAllowlist = bashAllowlist;

    // For flow workflows running in a prepared worktree, tell the agent
    // upfront where it is and that the sandbox is offline for git. Without
    // this hint, a skill that opens with `gh pr checkout` / `git fetch
    // origin pull/<n>/head` (a common pattern in repo-local review skills)
    // burns turns on DNS errors before realizing the worktree is already
    // on the PR's head branch. Typed workflows (autofix, ci-followup)
    // already encode this in their built-in system prompts.
    if (args.workflowId.startsWith('flow:') && args.worktreePath) {
      const baseBranch = config.autofix?.baseBranch ?? 'main';
      const branch = stepCtx.branch ?? '(branch not exposed to step context)';
      userPrompt += [
        '',
        '',
        '---',
        'You are running inside a sandboxed git worktree.',
        `  CWD:    ${args.worktreePath}`,
        `  BRANCH: ${branch}   (this is the PR's head branch)`,
        `  BASE:   ${baseBranch}`,
        "The PR's changes are already applied on top of BASE in this worktree.",
        'Do NOT `git clone`, `git fetch`, or `gh pr checkout` — the sandbox has no network for git, and the worktree is already in the correct state.',
        `Review the diff with \`git diff ${baseBranch}...HEAD\` and read files directly with Read.`,
      ].join('\n');
    }

    // When a dev server is up, give this agent step the live URL and let it
    // probe the running app with `curl` over Bash (backend-agnostic "read-url").
    if (stepCtx.devServerUrl && allowedTools.includes('Bash')) {
      userPrompt += `\n\n---\nA dev server for this project is running at ${stepCtx.devServerUrl}. You can probe the live application with curl (e.g. \`curl -sS ${stepCtx.devServerUrl}/\`) to reproduce the issue or verify your change.`;
      // Only widen an existing allowlist; an undefined allowlist already permits curl.
      if (bashAllowlist) effectiveBashAllowlist = [...bashAllowlist, 'curl'];
    }

    const spec: AgentRunSpec<unknown> = {
      systemPrompt: resolved.systemPrompt,
      userPrompt,
      cwd: args.worktreePath ?? process.cwd(),
      allowedTools,
      bashAllowlist: effectiveBashAllowlist,
      model: resolved.model,
      maxTurns,
      tokenBudget: budget,
      responseSchema: step.responseSchema,
      // Reuse one claude session id for the whole workflow run. Each step
      // after the first resumes the same on-disk session, so prior turns
      // become conversation context and Anthropic's prompt cache reads
      // the cumulative prefix instead of starting cold. An operator can
      // `cd <worktree> && claude --resume <runSessionId>` to take over.
      sessionId: args.runSessionId,
      // On the first step of a re-claimed run, switch the runner to
      // `claude --resume <runSessionId>` so the new process picks up
      // the conversation prefix from the host that crashed. The runner
      // catches a non-zero exit (cross-host re-claim) and transparently
      // retries with `--session-id` for a cold start under the same id.
      resume: args.resume,
    };

    // Periodic autosave for steps that can mutate the worktree (fixer-class).
    // A crashed agent leaves a recoverable branch instead of an empty run.
    const writeTools = new Set(['Edit', 'Write', 'NotebookEdit']);
    const mutates = allowedTools.some((t) => writeTools.has(t));
    const stopAutosave =
      mutates && args.worktreePath
        ? startWorktreeAutosaver({
            worktreePath: args.worktreePath,
            message: `cezar: autosave (${step.id})`,
            onWarn: (m) => stepCtx.emit({ type: 'note', message: m }),
          })
        : null;

    let result: Awaited<ReturnType<typeof runner.run>>;
    try {
      if (args.unifiedSession) {
        // Phase B: route through the persistent session. The unified
        // system prompt was set once when the session started; here we
        // send the step's user prompt with a phase marker and let the
        // session return the assistant text + per-phase token delta.
        //
        // On a re-claim, the unified session was spawned with `--resume`.
        // If that fails (cross-host — the on-disk blob isn't here), the
        // child exits early and `sendPhase` rejects with `ResumeFailedError`.
        // Recover by stopping the dead session and falling back to the
        // staged runner for THIS step under the same session id (which
        // re-spawns with `--session-id` for a cold start). Subsequent
        // steps go back through the per-step `runner.run` path since the
        // unified session is now defunct.
        try {
          const phaseResult = await args.unifiedSession.sendPhase(step.id, spec.userPrompt);
          result = {
            text: phaseResult.text,
            parsed: null,
            toolCalls: phaseResult.toolCalls,
            tokensUsed: phaseResult.tokensUsed,
            budgetExceeded: false,
            sessionId: args.runSessionId,
          };
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err;
          args.onResumeFallback?.();
          await args.unifiedSession.stop().catch(() => {});
          stepCtx.emit({
            type: 'note',
            message: `falling back to staged runner for step '${step.id}' after resume failure`,
          });
          result = await runner.run({ ...spec, resume: false }, (e) => stepCtx.emit(e));
        }
      } else {
        result = await runner.run(spec, (e) => stepCtx.emit(e));
      }
    } finally {
      if (stopAutosave) await stopAutosave();
    }
    record.tokensUsed = result.tokensUsed;
    record.finishedAt = new Date().toISOString();

    if (result.budgetExceeded) {
      record.status = 'failed';
      record.error = `token budget exceeded during '${step.id}'`;
      if (step.failCommentSection)
        await args.living.appendSection(step.id, step.failCommentSection(record.error, stepCtx));
      return { outcome: { kind: 'fail', reason: record.error }, record };
    }

    // The runner extracts structured output, but fall back to parseStructured
    // on the raw text (mirrors the orchestrator's recovery behavior).
    const parsed = result.parsed ?? parseStructured(result.text, step.responseSchema);
    if (parsed == null) {
      if (step.onNoParse) {
        const outcome = step.onNoParse(result.text, stepCtx);
        record.status =
          outcome.kind === 'fail'
            ? 'failed'
            : outcome.kind === 'skip-run'
              ? 'skipped'
              : 'succeeded';
        if (outcome.kind === 'fail') record.error = outcome.reason;
        // Flow runtime: an agent step may open a PR via `gh pr create` and
        // signal it via `openedPr` (extracted from PR_URL/PR_NUMBER markers in
        // flow-runner's onNoParse). Switch the living comment to the PR
        // BEFORE appending the unparsed section, so this step's output AND
        // every subsequent step's output (e.g. the review verdict) lands on
        // the PR instead of the issue. Without this, the typed `open-pr` step
        // is the only path that calls `switchToPr`.
        if ('openedPr' in outcome && outcome.openedPr) {
          await args.living.switchToPr(outcome.openedPr.number);
        }
        if (step.failCommentSection && outcome.kind === 'fail') {
          await args.living.appendSection(
            step.id,
            step.failCommentSection(outcome.reason, stepCtx),
          );
        } else if (step.unparsedCommentSection && outcome.kind !== 'fail') {
          // Flows runtime path: agent emitted free text and onNoParse said go.
          // Surface what the agent actually produced in the living comment.
          await args.living.appendSection(
            step.id,
            step.unparsedCommentSection(result.text, stepCtx),
          );
        }
        return { outcome, record };
      }
      const tail = result.text.slice(-400).trim();
      const reason = tail
        ? `${step.id} did not return a valid JSON response. Last output: "${tail}"`
        : `${step.id} returned no parseable output (likely hit maxTurns without emitting JSON)`;
      record.status = 'failed';
      record.error = reason;
      if (step.failCommentSection)
        await args.living.appendSection(step.id, step.failCommentSection(reason, stepCtx));
      return { outcome: { kind: 'fail', reason }, record };
    }

    const outcome = step.onResult(parsed, stepCtx);
    record.status =
      outcome.kind === 'fail' ? 'failed' : outcome.kind === 'skip-run' ? 'skipped' : 'succeeded';
    if (outcome.kind === 'fail') record.error = outcome.reason;
    if (outcome.kind === 'skip-run') record.summary = outcome.reason;

    if (outcome.kind === 'fail') {
      if (step.failCommentSection)
        await args.living.appendSection(step.id, step.failCommentSection(outcome.reason, stepCtx));
    } else if (step.commentSection) {
      await args.living.appendSection(step.id, step.commentSection(parsed, stepCtx));
    }

    return { outcome, record };
  }

  /**
   * Start a unified `PersistentClaudeSession` — one long-lived `claude`
   * process for the whole run that the engine drives via `sendPhase(stepId, …)`
   * — when the workspace opted in via `config.autofix.runner.mode = 'unified'`.
   * Returns `null` otherwise; staged mode keeps spawning a fresh child per step.
   *
   * Supported workflow shapes:
   *   • The typed autofix workflow — uses `UNIFIED_AUTOFIX_SYSTEM_PROMPT`,
   *     which hard-codes the verify/analyzer/fixer/reviewer roles.
   *   • Any flow workflow (`workflow.id.startsWith('flow:')`) — the system
   *     prompt is built from each agent step's resolved body (built-in step
   *     prompt + bound skill body + label catalog), so the model has every
   *     phase's instructions upfront and the user-side just sends short
   *     per-step payloads via `## PHASE: <stepId>` markers.
   *
   * Other workflows (ci-followup, triage) stay staged.
   *
   * Backend lock (Q4) is enforced in the runner factory — by the time
   * this method is called the workspace is already in CLI territory.
   */
  private async maybeStartUnifiedSession<W>(args: {
    workflow: Workflow<W>;
    config: Config;
    worktreePath: string | undefined;
    onEvent: ((evt: AgentEvent) => void) | undefined;
    sessionId: string;
    bindings: WorkflowBinding[];
    skills: Skill[];
    labels?: WorkspaceLabel[];
    /** True on a re-claim — spawn `claude --resume <sessionId>` first. */
    resume?: boolean;
    /** Invoked when resume fails and we cold-start under the same id. */
    onResumeFallback?: () => void;
  }): Promise<PersistentClaudeSession | null> {
    if (args.config.autofix?.runner?.mode !== 'unified') return null;
    if (!args.worktreePath) return null;

    const systemPrompt = this.buildUnifiedSystemPrompt(args.workflow, {
      bindings: args.bindings,
      skills: args.skills,
      labels: args.labels,
      config: args.config,
    });
    if (!systemPrompt) return null;

    const sessionOpts = {
      systemPrompt,
      sessionId: args.sessionId,
      cwd: args.worktreePath,
      model: args.config.autofix?.models?.analyzer,
      // Unified mode pools every phase's tool budget; the model picks
      // per-phase which to use from this union. Read + write are both
      // allowed since fixer/edit-capable phases need them.
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
      bashAllowlist: args.config.autofix?.bashAllowlist,
      onEvent: (e: AgentEvent) => {
        // Forward to the same agent-event sink the staged path uses so
        // the cockpit doesn't need to know which mode produced an event.
        args.onEvent?.(e);
      },
    };

    // First try: respect the caller's `resume` flag. If resume start
    // throws ResumeFailedError synchronously we'd never see it (the start
    // is sync; the failure shows up on the child's exit event). The
    // engine catches it on `sendPhase` (see `runAgentStep`) and rebuilds
    // a fresh session under the same id. This `try` only covers a synchronous
    // spawn failure (e.g. `claude` binary missing), which we let bubble.
    const session = new PersistentClaudeSession({ ...sessionOpts, resume: args.resume === true });
    try {
      session.start();
    } catch (err) {
      if (err instanceof ResumeFailedError) {
        // Defensive — start() can't throw ResumeFailedError today (the
        // child exit fires asynchronously), but if a future version did,
        // honor the same fallback path.
        args.onResumeFallback?.();
        const fresh = new PersistentClaudeSession({ ...sessionOpts, resume: false });
        fresh.start();
        return fresh;
      }
      throw err;
    }
    return session;
  }

  /**
   * Resolve the unified system prompt to ship at session start. Returns
   * `null` for workflows whose shape doesn't support unified mode (today:
   * everything other than `'autofix'` and `'flow:*'`).
   */
  private buildUnifiedSystemPrompt<W>(
    workflow: Workflow<W>,
    deps: {
      bindings: WorkflowBinding[];
      skills: Skill[];
      labels?: WorkspaceLabel[];
      config: Config;
    },
  ): string | null {
    if (workflow.id === 'autofix') return UNIFIED_AUTOFIX_SYSTEM_PROMPT;
    if (!workflow.id.startsWith('flow:')) return null;

    // Resolve each agent step's body the same way `runAgentStep` does
    // (so the unified prompt embeds exactly what staged mode would send,
    // minus the per-step duplication of the scaffolding).
    const phases: Array<{ id: string; body: string }> = [];
    for (const step of workflow.steps) {
      if (step.kind !== 'agent') continue;
      const agentStep = step as AgentStepDef<W, unknown>;
      const resolved = resolveStepConfig({
        stepId: agentStep.id,
        builtinSystemPrompt: agentStep.builtinSystemPrompt,
        builtinModel: resolveStepValue(agentStep.builtinModel, deps.config),
        binding: deps.bindings.find((b) => b.stepId === agentStep.id),
        skills: deps.skills,
        labels: deps.labels,
        labelScope: agentStep.labelScope ?? 'both',
      });
      phases.push({ id: agentStep.id, body: resolved.systemPrompt });
    }
    if (phases.length === 0) return null;

    return buildUnifiedFlowSystemPrompt({ workflowId: workflow.id, phases });
  }
}

/** Functional sugar — `runWorkflow(workflow, ctx)` ≡ `new WorkflowEngine().runWorkflow(...)`. */
export function runWorkflow<W>(
  workflow: Workflow<W>,
  ctx: WorkflowRunContext,
): Promise<WorkflowRunResult<W>> {
  return new WorkflowEngine().runWorkflow(workflow, ctx);
}
