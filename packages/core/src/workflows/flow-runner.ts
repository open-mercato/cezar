import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent as RunnerAgentEvent } from '../agents/agent-runner.js';
import type { Config } from '../config/config.model.js';
import type { GitHubService } from '../services/github.service.js';
import type { IssueStore } from '../store/store.js';
import { discoverSkills } from '../skills/skill-catalog.js';
import { createWorktree } from '../actions/autofix/worktree.js';
import { createRunEnv } from '../provision/create-run-env.js';
import type { RunEnv } from '../provision/run-env.js';
import type { WorkspaceLabel } from '../labels/label-catalog.js';
import {
  agentStep,
  type AgentRunRecord,
  type Workflow,
  type WorkflowRunResult,
  type WorkflowStep,
} from './workflow.js';
import { runWorkflow } from './workflow-engine.js';
import {
  describeMarkerForPrompt,
  findMarkerComment,
  upsertMarkerComment,
  type PrLinkData,
} from './pr-link-marker.js';

/**
 * Runtime for the simple "flows" UI (migration 0021). A flow is a named chain
 * of `{ skill, argsTemplate }` steps. This module turns one into a multi-step
 * `Workflow<FlowBlackboard>` and runs it through the existing engine.
 *
 *   - The skill body (from `<repo>/.ai/skills/<name>.md`) is appended to the
 *     step's system prompt via `resolveStepConfig` (existing path).
 *   - The args template is rendered against a fixed scope:
 *       {{input}}                  — passed by the caller (typically the issue number)
 *       {{previousTaskId}}         — the previous step's `agent_runs.id`
 *       {{previousPullRequestUrl}} — `PR_URL=…` parsed from the previous agent's text
 *       {{previousPullRequestNumber}} — `PR_NUMBER=…` parsed from the same
 *   - PR markers are a soft contract: skills that create PRs should emit
 *     `PR_URL=https://github.com/...` and `PR_NUMBER=42` in their final text
 *     so the next step can reference them.
 */

export interface FlowStep {
  skill: string;
  argsTemplate: string;
  /**
   * When set, if the step's text output contains this substring the chain
   * stops cleanly (status succeeded, reason "stopped at step N…"). Simple
   * short-circuit for skills that legitimately decide "no action needed".
   */
  stopChainIfContains?: string;
  /**
   * Extra system-prompt content for this step, prepended to the skill body.
   * When unset (or empty/whitespace-only), `DEFAULT_STEP_NOTES` is used —
   * the marker contract reminder so the chain works even if the skill body
   * doesn't itself document `PR_URL=` / `PR_NUMBER=`.
   */
  systemNotes?: string;
}

export interface FlowRow {
  name: string;
  steps: FlowStep[];
}

export interface RunFlowParams {
  flow: FlowRow;
  input: string;
  store: IssueStore;
  config: Config;
  github: GitHubService;
  issueNumber: number;
  /**
   * Workspace label catalog. When provided, the engine appends a
   * "Repository label catalog" section to every flow step's system prompt
   * (`labelScope: 'both'` — flow steps can transition issue→PR mid-run).
   */
  labels?: WorkspaceLabel[];
  onEvent: (msg: string) => void;
  onAgentEvent: (e: { type: string; [k: string]: unknown }) => void;
  /** Step has begun — record carries `status:'running'`. Fired before the
   *  step's body produces any lifecycle output so the cockpit can render
   *  a card and emit `step-start` as work begins. */
  onStepStart?: (r: AgentRunRecord) => void;
  onRunRecord: (r: AgentRunRecord) => void;
  pauseRequested?: () => boolean | Promise<boolean>;
  cancelRequested?: () => boolean | Promise<boolean>;
  /**
   * Phase 2 re-claim resume. Threaded into the engine so the runner can
   * `claude --resume <id>` on the first step of a re-claimed run. Cross-host
   * re-claims fall back to a fresh start under the same id.
   */
  resumeSessionId?: string;
}

interface FlowBlackboard extends Record<string, unknown> {
  input: string;
  previousTaskId: string;
  previousPullRequestUrl: string;
  previousPullRequestNumber: string;
  /**
   * The previous step's raw text output, truncated. Without this, a step can
   * only reference the prior step by `previousTaskId` (an opaque UUID) — which
   * means the agent has no way to see what the prior agent actually decided.
   * Threaded into the next step's user prompt via `{{previousOutput}}`.
   */
  previousOutput: string;
  /**
   * One-line description of an existing `cezar:pr-link` marker on the issue,
   * if any was found at run start (e.g. "PR #2050 (changes-requested,
   * classified active) at https://…/pull/2050"). Empty string when no marker.
   * Threaded into step prompts via `{{existingCezarPr}}` so a verify step can
   * stop with NO_ACTION_NEEDED when a previous run already opened a PR for
   * the same issue. See pr-link-marker.ts for the marker schema.
   */
  existingCezarPr: string;
}

export async function runFlow(params: RunFlowParams): Promise<WorkflowRunResult<FlowBlackboard>> {
  if (params.flow.steps.length === 0) {
    throw new Error(`flow '${params.flow.name}' has no steps`);
  }

  // Discover skills so resolveStepConfig (called by the engine) can find each
  // step's skill body and append it to the system prompt.
  const repoRoot = params.config.autofix?.repoRoot;
  const skills = repoRoot
    ? await discoverSkills(repoRoot, params.config.autofix?.skillsDir ?? '.ai/skills').catch((err: Error) => {
        params.onEvent(`[flow] skill discovery failed: ${err.message}`);
        return [];
      })
    : [];

  // Closure-captured state the engine updates between steps. We need this so
  // each step's `buildUserPrompt` sees the freshest `previousTaskId` (which
  // the engine doesn't expose through the step context directly).
  let lastAgentRunId = '';

  // ── PR-link marker state ─────────────────────────────────────────────────
  // `existingMarker` is the marker (if any) we found on the issue *before* the
  // first step ran — it's what populates `{{existingCezarPr}}` so a verify
  // step can see "a previous Cezar run already opened PR #N for this issue".
  //
  // `pendingMarkerWrites` accumulates fire-and-forget upserts triggered when a
  // step emits PR markers in its text. We `await Promise.allSettled` on them
  // before `runFlow` returns so the marker is persisted even if a later step
  // fails — otherwise a successful open-pr followed by a failing review-pr
  // would lose the marker write.
  //
  // `lastUpsertedPr` dedupes consecutive identical writes (e.g. the same PR
  // number echoed by review-pr's output).
  const existingMarker = await findMarkerComment(params.github, params.issueNumber).catch((err: Error) => {
    params.onEvent(`[flow] could not read pr-link marker: ${err.message}`);
    return null;
  });
  const initialExistingPr = existingMarker ? describeMarkerForPrompt(existingMarker.data) : '';
  const pendingMarkerWrites = new Set<Promise<unknown>>();
  let lastUpsertedPr: { number: number; state: string } | null = existingMarker
    ? { number: existingMarker.data.prNumber, state: existingMarker.data.prState }
    : null;

  function scheduleMarkerUpsert(data: PrLinkData): void {
    // Skip when nothing changed — avoids spamming updateComment on every step
    // that echoes the PR number forward.
    if (lastUpsertedPr && lastUpsertedPr.number === data.prNumber && lastUpsertedPr.state === data.prState) return;
    lastUpsertedPr = { number: data.prNumber, state: data.prState };
    const p = upsertMarkerComment(params.github, params.issueNumber, data)
      .catch((err: Error) => {
        params.onEvent(`[flow] pr-link marker upsert failed: ${err.message}`);
      })
      .finally(() => {
        pendingMarkerWrites.delete(p);
      });
    pendingMarkerWrites.add(p);
  }

  // Auto-prepended env steps (install, dev-server). Only when both repo-backed
  // AND the workspace configured the corresponding `autofix.projectEnv` field;
  // otherwise the run behaves as before (agent steps only).
  const projectEnv = params.config.autofix?.projectEnv;
  const wantInstall = !!repoRoot && !!projectEnv?.install?.trim();
  const wantDevServer = !!repoRoot && !!projectEnv?.devServer?.enabled && (projectEnv.devServer.port ?? 0) > 0;
  const prefixSteps: WorkflowStep<FlowBlackboard>[] = [];
  if (wantInstall) prefixSteps.push(makeInstallStep());
  if (wantDevServer) prefixSteps.push(makeDevServerStep());

  const agentSteps = params.flow.steps.map((step, idx) => makeAgentStepForFlowStep(step, idx, params.config));

  const workflow: Workflow<FlowBlackboard> = {
    id: `flow:${params.flow.name}`,
    title: params.flow.name,
    commentTargetOrder: ['issue', 'pr'],
    initialBlackboard: () => ({
      input: params.input,
      previousTaskId: '',
      previousPullRequestUrl: '',
      previousPullRequestNumber: '',
      previousOutput: '',
      existingCezarPr: initialExistingPr,
    }),
    steps: [...prefixSteps, ...agentSteps],
  };

  // Repo-backed setup: prepare a worktree on a unique per-run branch, then a
  // RunEnv bound to it. The branch carries a random 8-char suffix so concurrent
  // runs against the same issue don't collide on `git worktree add` or on the
  // remote (each push lands on its own ref). The RunEnv lets `shell-check` /
  // `dev-server` steps actually do work (install deps, boot the app) and
  // injects `projectEnv.envVars` into every command.
  let worktreePath: string | undefined;
  let branchName: string | undefined;
  let baseSha: string | undefined;
  let disposeWorktree: (() => Promise<void>) | undefined;
  let runEnv: RunEnv | undefined;

  if (repoRoot) {
    const branchPrefix = params.config.autofix?.branchPrefix ?? 'autofix/cezar-issue-';
    const suffix = randomUUID().slice(0, 8);
    branchName = `${branchPrefix}${params.issueNumber}-${suffix}`;
    const wt = await createWorktree({
      repoRoot,
      branch: branchName,
      baseBranch: params.config.autofix?.baseBranch ?? 'main',
      remote: params.config.autofix?.remote ?? 'origin',
      fetchRemote: params.config.autofix?.fetchBeforeAttempt ?? true,
      authArgs: params.github.gitAuthArgs(),
      onWarn: (m: string) => params.onEvent(m),
    });
    worktreePath = wt.path;
    baseSha = wt.baseSha;
    disposeWorktree = wt.dispose;

    try {
      runEnv = await createRunEnv({
        worktreePath: wt.path,
        spec: projectEnv!,
        runId: `flow-${params.issueNumber}-${suffix}`,
        onWarn: (m) => params.onEvent(`[run-env] ${m}`),
      });
    } catch (err) {
      await disposeWorktree().catch(() => {});
      throw err;
    }
  }

  try {
    return await runWorkflow(workflow, {
      store: params.store,
      config: params.config,
      github: params.github,
      issueNumber: params.issueNumber,
      apply: true,
      skills,
      labels: params.labels,
      resumeSessionId: params.resumeSessionId,
      // Bindings: per-step, set the skillName so resolveStepConfig appends the
      // skill body to the system prompt. The engine reads these from `bindings`.
      // Only agent steps need bindings; prefix steps (install / dev-server)
      // resolve everything from their step definition + config.
      bindings: params.flow.steps.map((step, idx) => ({
        stepId: agentStepIdFor(idx),
        skillName: step.skill,
        backend: null,
        model: null,
        extraTools: [],
      })),
      worktreePath,
      baseSha,
      branch: branchName,
      runEnv,
      onEvent: params.onEvent,
      onAgentEvent: (e: RunnerAgentEvent) => params.onAgentEvent(e as unknown as { type: string; [k: string]: unknown }),
      onStepStart: params.onStepStart,
      onRunRecord: (r: AgentRunRecord) => {
        lastAgentRunId = r.id;
        params.onRunRecord(r);
      },
      pauseRequested: params.pauseRequested,
      cancelRequested: params.cancelRequested,
    });
  } finally {
    // Drain marker upserts before releasing the worktree/runEnv. Each upsert
    // is already wrapped in a `.catch` that logs and swallows, so allSettled
    // here is belt-and-braces — but it guarantees the marker is on the issue
    // before the run is reported as done in the cockpit.
    if (pendingMarkerWrites.size > 0) {
      await Promise.allSettled(Array.from(pendingMarkerWrites));
    }
    if (runEnv) await runEnv.dispose().catch(() => {});
    if (disposeWorktree) await disposeWorktree().catch(() => {});
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function agentStepIdFor(idx: number): string {
    return `step-${idx + 1}`;
  }

  function makeAgentStepForFlowStep(
    step: FlowStep,
    idx: number,
    cfg: Config,
  ): WorkflowStep<FlowBlackboard> {
    const autofix = cfg.autofix;
    const builtinTools = autofix?.allowedTools ?? ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];
    // Always permit gh label commands when there's a workspace label catalog
    // — the catalog is appended to every flow step's system prompt and the
    // instructions tell the agent to apply labels. A workspace bashAllowlist
    // override (saved before label management existed) shouldn't silently
    // strip these.
    const baseAllowlist = autofix?.bashAllowlist;
    const ghCmds = ['gh issue edit', 'gh issue view', 'gh pr edit', 'gh pr view'];
    const bashAllowlist = baseAllowlist
      ? Array.from(new Set([...baseAllowlist, ...ghCmds]))
      : undefined;
    const maxTurns = autofix?.maxTurns?.fixer ?? 45;
    const model = autofix?.models?.fixer ?? 'claude-sonnet-4-6';

    return agentStep<FlowBlackboard, unknown>({
      id: agentStepIdFor(idx),
      kind: 'agent',
      builtinSkillId: step.skill,
      builtinSystemPrompt: composeStepSystemPrompt(step),
      builtinModel: model,
      builtinTools,
      bashAllowlist,
      maxTurns,
      cwdRequired: true,
      // Free-form output. We don't enforce JSON; we parse PR_URL/PR_NUMBER
      // markers from the text in onNoParse below.
      responseSchema: z.never() as unknown as z.ZodSchema<unknown>,
      buildUserPrompt: (ctx) => {
        // Refresh `previousTaskId` from the closure right before render — it's
        // updated by `onRunRecord` between steps.
        const scope: FlowBlackboard = {
          ...ctx.blackboard,
          previousTaskId: lastAgentRunId,
        };
        return renderTemplate(step.argsTemplate, scope);
      },
      // If the agent emitted JSON that happened to validate, we still want
      // to chain — but `z.never()` ensures this branch never fires.
      onResult: () => ({ kind: 'continue' as const }),
      onNoParse: (rawText, _ctx) => {
        const { url, number } = extractPrMarkers(rawText);
        // Fall back to the existing marker when the step didn't emit its own
        // PR_URL/PR_NUMBER lines. Lets review-pr inherit "PR #N" from a marker
        // an earlier run wrote, even though the open-pr step on this run
        // skipped (e.g. NO_ACTION_NEEDED for an already-fixed issue).
        const fallbackNumber = lastUpsertedPr?.number;
        const fallbackUrl = existingMarker?.data.prUrl;
        const effectiveNumber = number ?? fallbackNumber ?? null;
        const effectiveUrl = url ?? (number == null ? fallbackUrl : null) ?? null;
        // Tell the engine to switch the living comment from issue → PR when
        // this step is the first to surface a PR (typically the open-pr step
        // that calls `gh pr create`). Without this, the engine only switches
        // for typed `open-pr` workflow steps — so a flow's review step's
        // output stays on the issue and is invisible on the PR's thread.
        const isFirstPrInThisRun = number != null && url != null && lastUpsertedPr == null;
        const patch: Partial<FlowBlackboard> = {
          previousPullRequestUrl: effectiveUrl ?? '',
          previousPullRequestNumber: effectiveNumber != null ? String(effectiveNumber) : '',
          previousOutput: truncateOutput(rawText),
        };
        // Persist a sticky `cezar:pr-link` comment on the issue whenever the
        // step's output yields a PR number. Fire-and-forget: awaited at the
        // end of `runFlow`. State defaults to 'draft' for a fresh open-pr;
        // downstream steps that change the PR's state should emit their own
        // marker (e.g. `PR_STATE=changes-requested`) — see extractPrState.
        if (number != null && url) {
          const state = extractPrState(rawText) ?? (lastUpsertedPr?.number === number ? lastUpsertedPr.state : 'draft');
          scheduleMarkerUpsert({
            prNumber: number,
            prUrl: url,
            prState: state,
            branch: branchName,
          });
        } else if (number == null && fallbackNumber != null) {
          // A later step (e.g. review-pr) may emit only `PR_STATE=...` to
          // update the existing marker without re-stating PR_URL/PR_NUMBER.
          const state = extractPrState(rawText);
          if (state && existingMarker) {
            scheduleMarkerUpsert({
              prNumber: existingMarker.data.prNumber,
              prUrl: existingMarker.data.prUrl,
              prState: state,
              branch: existingMarker.data.branch ?? branchName,
            });
          }
        }
        // Stop-chain: cleanly end the workflow when the agent's output
        // contains the configured marker. We rely on `skip-run` rather than
        // a hard fail so the cockpit shows it as `succeeded (with reason)`.
        if (step.stopChainIfContains && rawText.includes(step.stopChainIfContains)) {
          return {
            kind: 'skip-run',
            reason: `stopped at step ${idx + 1}: output matched "${step.stopChainIfContains}"`,
          };
        }
        // Universal stop-chain marker shipped by the autofix skill set: an
        // agent that ends with `NO_ACTION_NEEDED` on its own line is saying
        // "this issue doesn't need any further action" (already fixed, not a
        // bug, an in-flight human PR already addresses it, etc.). Downstream
        // steps (fix → open-pr → review) would be inappropriate. Matches the
        // existing heading display rule in `flowStepHeading` — without this,
        // the heading claims "stopped" but the chain actually proceeds, and
        // cumulative output usually blows past GitHub's 65536-byte comment
        // limit so the issue gets no visible update.
        if (isEndOfOutputStopMarker(rawText)) {
          return {
            kind: 'skip-run',
            reason: `stopped at step ${idx + 1}: agent emitted NO_ACTION_NEEDED`,
          };
        }
        // Hard fail when the skill explicitly reports a blocked/failed status.
        // Convention used by the autofix skill set ('fix', 'open-pr', etc.):
        // an end-of-output line like `Status: blocked` or `Status: failed`
        // means "I cannot proceed safely; do not run downstream steps."
        // Returning `fail` here (vs `continue`) marks the step failed in the
        // cockpit AND stops the chain — otherwise a no-op fix would cascade
        // into open-pr opening nothing, then review-pr asking which PR.
        const statusFail = findEndOfOutputStatus(rawText);
        if (statusFail) {
          const { status, reason } = statusFail;
          return {
            kind: 'fail',
            reason: `step ${idx + 1} (\`${step.skill}\`) reported Status: ${status}${reason ? ` — ${reason}` : ''}`,
            blackboardPatch: patch,
          };
        }
        return {
          kind: 'continue',
          blackboardPatch: patch,
          ...(isFirstPrInThisRun ? { openedPr: { number: number!, url: url! } } : {}),
        };
      },
      // Render the agent's actual output into the living comment. The flow
      // runtime never enforces a JSON schema, so the engine takes the
      // `unparsedCommentSection` path (not `commentSection`).
      unparsedCommentSection: (rawText) => ({
        heading: flowStepHeading(idx, step, rawText),
        body: flowStepBody(rawText),
      }),
      failCommentSection: (reason) => ({
        heading: `Step ${idx + 1} — \`${step.skill}\` (failed)`,
        body: reason,
      }),
    });
  }
}

// ─── Living-comment rendering helpers ──────────────────────────────────────

/** How many trailing non-empty lines count as the agent's "end of output".
 *  The autofix skill set's contract is to terminate with its verdict, so a
 *  `Status:`/`NO_ACTION_NEEDED` marker only counts when it lands in this tail
 *  window — not when an earlier line quotes a CI log or thinks aloud. */
const END_OF_OUTPUT_TAIL_LINES = 5;

/** Cap on `{{previousOutput}}` (chars) so a chain of long outputs doesn't
 *  cascade into runaway prompts. ~8KB ≈ ~2k tokens — enough for a structured
 *  brief, not enough to balloon. */
const MAX_PREV_OUTPUT_CHARS = 8000;

/** Cap on a single step's section body in the living comment (chars). GitHub
 *  rejects issue/PR comments over 65536 bytes; one step's raw output (e.g. a
 *  long investigation ending in NO_ACTION_NEEDED) can easily exceed that by
 *  itself, and `LivingComment.rerender` swallows the resulting 422 — leaving
 *  the issue with no visible update. ~20KB tail is the most-informative
 *  slice (the agent's final conclusion is at the end) and leaves headroom
 *  for multiple sections plus header overhead. */
const MAX_STEP_BODY_CHARS = 20000;

/** Matches a `Status: blocked` / `Status: failed` line (per the autofix skill
 *  set's output contract), capturing the trailing reason text. Case-insensitive.
 *  Only applied to individual tail lines (see `findEndOfOutputStatus`) so a
 *  quoted log line or a "if it returns Status: failed I'll retry" aside earlier
 *  in the output never trips a hard fail. */
const STATUS_FAIL_LINE_RE = /^Status:\s*(blocked|failed)\b\s*(.*)$/i;

/** Walks backwards over the final `END_OF_OUTPUT_TAIL_LINES` non-empty lines and
 *  returns the agent's end-of-output `Status: blocked|failed` verdict (with its
 *  reason) if present. Returns null if no such marker lands in the tail window,
 *  so only the agent's actual conclusion — not quoted text earlier in the run —
 *  hard-fails the chain. */
function findEndOfOutputStatus(rawText: string): { status: string; reason: string } | null {
  const lines = (rawText ?? '').trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < END_OF_OUTPUT_TAIL_LINES; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    seen++;
    const m = line.match(STATUS_FAIL_LINE_RE);
    if (m) {
      const reason = (m[2] || (lines[i + 1] ?? '').trim()).slice(0, 200);
      return { status: m[1].toLowerCase(), reason };
    }
  }
  return null;
}

/** True when `NO_ACTION_NEEDED` appears as an end-of-output marker (one of the
 *  final `END_OF_OUTPUT_TAIL_LINES` non-empty lines), not merely quoted earlier
 *  in conversational text. */
function isEndOfOutputStopMarker(rawText: string): boolean {
  const lines = (rawText ?? '').trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < END_OF_OUTPUT_TAIL_LINES; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    seen++;
    if (/^NO_ACTION_NEEDED\b/.test(line)) return true;
  }
  return false;
}

function truncateOutput(rawText: string): string {
  const trimmed = (rawText ?? '').trim();
  if (trimmed.length <= MAX_PREV_OUTPUT_CHARS) return trimmed;
  return `… (truncated; showing last ${MAX_PREV_OUTPUT_CHARS} chars)\n\n${trimmed.slice(-MAX_PREV_OUTPUT_CHARS)}`;
}

function flowStepHeading(idx: number, step: FlowStep, rawText: string): string {
  const base = `Step ${idx + 1} — \`${step.skill}\``;
  if (step.stopChainIfContains && rawText.includes(step.stopChainIfContains)) {
    return `${base} (stopped: \`${step.stopChainIfContains}\`)`;
  }
  if (isEndOfOutputStopMarker(rawText)) return `${base} (stopped: \`NO_ACTION_NEEDED\`)`;
  const { url, number } = extractPrMarkers(rawText);
  if (url && number != null) return `${base} → PR [#${number}](${url})`;
  return base;
}

/**
 * Render the agent's full output into the living comment. Caps the body at
 * `MAX_STEP_BODY_CHARS` (tail-biased) so one very-long step can't push the
 * combined comment past GitHub's 65536-byte limit — that error surfaces in
 * `LivingComment.rerender`'s swallowed try/catch and leaves the issue with
 * no visible update. The final conclusion (e.g. `NO_ACTION_NEEDED` with its
 * justification, or a verdict summary) is always at the end of the agent's
 * output, so keeping the tail is the right slice.
 */
function flowStepBody(rawText: string): string {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) return '_(no output)_';
  if (trimmed.length <= MAX_STEP_BODY_CHARS) return trimmed;
  return `_… (truncated; showing last ${MAX_STEP_BODY_CHARS} of ${trimmed.length} chars — full output is in the cockpit event log)_\n\n${trimmed.slice(-MAX_STEP_BODY_CHARS)}`;
}

// ─── PR marker extraction ──────────────────────────────────────────────────

/**
 * Extracts `PR_URL=...` and `PR_NUMBER=...` markers from a step's text output.
 * Soft contract: skills that create PRs should print these lines (anywhere in
 * the response) so the next step can reference them via `{{previousPullRequest*}}`.
 * Also tries common URL patterns as a fallback.
 */
export function extractPrMarkers(text: string): { url: string | null; number: number | null } {
  let url: string | null = null;
  let number: number | null = null;

  const urlMatch = text.match(/PR_URL\s*=\s*(\S+)/);
  if (urlMatch) url = urlMatch[1];
  const numMatch = text.match(/PR_NUMBER\s*=\s*(\d+)/);
  if (numMatch) number = Number(numMatch[1]);

  // Fallback: scrape any GitHub PR URL.
  if (!url) {
    const fall = text.match(/https?:\/\/[\w./-]*github\.com\/[\w-]+\/[\w.-]+\/pull\/(\d+)/);
    if (fall) {
      url = fall[0];
      if (number == null) number = Number(fall[1]);
    }
  }
  return { url, number };
}

/**
 * Optional companion to PR_URL/PR_NUMBER. A skill can emit a single line like
 *
 *   PR_STATE=changes-requested
 *
 * to update the `pr-link` marker's `pr_state` field without restating the PR
 * number. Used by review-pr to flip the marker from `draft` → `review` /
 * `changes-requested` / `approved` as the PR moves through the pipeline.
 *
 * Free-form: the marker schema doesn't enforce a fixed set; classifyActivity
 * in pr-link-marker.ts buckets unknown values as `other`.
 */
export function extractPrState(text: string): string | null {
  const m = text.match(/PR_STATE\s*=\s*([\w-]+)/);
  return m ? m[1].toLowerCase() : null;
}

// ─── Template rendering ────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Render `{{path}}` references against a flat scope. Missing → empty string. */
export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(TEMPLATE_RE, (_, path: string) => {
    const v = lookupDotPath(scope, path);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  });
}

function lookupDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ─── Per-step scaffolding system prompt ────────────────────────────────────

/**
 * Minimal scaffolding shipped to every flow step. Generic — describes that
 * this is one step of a workflow and that the skill body holds the actual
 * instructions. The marker contract lives in `DEFAULT_STEP_NOTES` so users
 * can edit/override it per step (see `step.systemNotes`).
 */
export const FLOW_STEP_SCAFFOLDING = `You are an agent executing one step of a user-defined workflow. Follow the SKILL instructions appended below to complete the task described in the user message.

When the task is done, respond with a short plain-text summary (no JSON).`;

/**
 * Default notes prepended to the skill body when `step.systemNotes` is unset.
 * Documents the marker contract that lets the next step reference the PR via
 * `{{previousPullRequestUrl}}` / `{{previousPullRequestNumber}}` templates.
 * Users override this per step via the pencil/notes panel in the editor.
 */
export const DEFAULT_STEP_NOTES = `If you open a pull request, end your response with two lines on separate lines:
  PR_URL=<the PR url>
  PR_NUMBER=<the PR number>
so the next step in the workflow can reference it via {{previousPullRequestUrl}} / {{previousPullRequestNumber}}.`;

/** Back-compat alias — kept temporarily for any out-of-tree code. */
export const FLOW_STEP_SYSTEM_PROMPT = FLOW_STEP_SCAFFOLDING + '\n\n' + DEFAULT_STEP_NOTES;

/** What the scaffolding+notes actually compose to at run time. */
export function effectiveStepNotes(step: FlowStep): string {
  const trimmed = (step.systemNotes ?? '').trim();
  return trimmed.length > 0 ? step.systemNotes! : DEFAULT_STEP_NOTES;
}

/** The system prompt the engine actually sends (before the skill body is appended). */
export function composeStepSystemPrompt(step: FlowStep): string {
  return `${FLOW_STEP_SCAFFOLDING}\n\n${effectiveStepNotes(step)}`;
}

// ─── Auto-prepended env steps (install + dev-server) ──────────────────────
// Used when `autofix.projectEnv.install` is set / `autofix.projectEnv.devServer.enabled`
// is true on a repo-backed flow run. The engine no-ops these when the run has
// no `RunEnv` (i.e. repo-less flows), so adding them unconditionally would also
// be safe — we gate them in `runFlow` only to keep the cockpit clean.

function makeInstallStep(): WorkflowStep<FlowBlackboard> {
  return {
    id: 'install',
    kind: 'shell-check',
    builtinSkillId: 'install',
    which: 'install',
    // Gate on `projectEnv.gateOnInstall`. Failed install ⇒ failed run (agents
    // can't do useful work against an unbuilt project anyway).
    gate: (cfg) => cfg.autofix?.projectEnv?.gateOnInstall ?? true,
    retriable: false,
    // Setup-phase step — no `commentSection` on purpose: install logs would
    // bury the actual flow output in the living comment. Status/output still
    // appears in the cockpit via the agent_run_events stream.
  };
}

function makeDevServerStep(): WorkflowStep<FlowBlackboard> {
  return {
    id: 'dev-server',
    kind: 'dev-server',
    builtinSkillId: 'dev-server',
    // Informational: don't fail the run if the server is slow to come up. The
    // engine still exposes `devServerUrl` to subsequent agent steps via the
    // step context, so agents can `curl` it once it's ready.
    gate: false,
    // Setup-phase step — no `commentSection` on purpose (see install above).
  };
}
