import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { collectSecretValues, redactDeep, redactSecrets } from '../core/secret-redaction.js';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
/**
 * A sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
 * the agent ended its turn still working on its own downstream work (a sub-agent
 * or a monitored command) and declared it with the `CEZ:MONITORING` marker — so
 * the cockpit shows a non-attention "monitoring" label instead of "needs you".
 * Only ever set while `status === 'running'`; cleared on resume/terminal.
 */
export type RunActivity = 'monitoring';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: z.enum(['pending', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled', 'skipped']),
  iterations: z.number(),
  tokensUsed: z.number(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Latest backend-owned session id, used for same-backend Continue. */
  sessionId: z.string().optional(),
  /** Backend that owns `sessionId`. Optional so pre-affinity runs.json files still parse. */
  backend: z.enum(['claude', 'codex', 'opencode']).optional(),
  /** Dollar cost reported by the claude CLI for this step's turns. */
  costUsd: z.number().optional(),
});

/** One prompt message stacked onto a run while it waits for a free agent slot
 *  (#472). Folded into `{{task}}` at dequeue by `hydrateQueuedInput`; never
 *  delivered as its own turn — a follow-up turn would reach only the first step
 *  of a chain and would race the opening turn. */
const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `/api/runs/:id/images/…` URLs — the base64 never enters `runs.json`. */
  images: z.array(z.string()).optional(),
  createdAt: z.string(),
});

const runRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display title (#389): the auto-derived summary of the first agent turn,
   *  or the user's inline edit (`PATCH /api/runs/:id` sets it together with
   *  `title` so edits always win). The UI shows `titleSummary ?? title`. */
  titleSummary: z.string().optional(),
  /** `git diff --shortstat` of the worktree vs its base, refreshed on every
   *  turn-end (#389) — what the quick list / table shows without a git call. */
  diffStat: z
    .object({ adds: z.number(), dels: z.number(), files: z.number() })
    .optional(),
  workflow: z.string(),
  task: z.string(),
  /** Prompt messages stacked onto this run while it was queued (#472). Optional:
   *  `undefined` on every pre-#472 record reads as an empty stack. Like `task`,
   *  `text` is the user's own prompt and is replayed into `{{task}}`, so it is
   *  deliberately NOT in `redactPatch`'s field list — scrubbing it would corrupt
   *  the run the same way scrubbing `task` would. */
  queuedMessages: z.array(queuedMessageSchema).optional(),
  /** URLs of images attached to the initial task prompt, for the thread's first bubble
   *  (#image-display) — persisted like agent screenshots, served from `/images/`. */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Canonical provider/model identity (#405) — the normalised `provider/model`
   *  (e.g. `anthropic/claude-opus-4-8`) the run actually used, resolved from the
   *  free-text `model` against the chosen runner. Additive and optional: pre-#405
   *  records carry only `model`, and it stays the human/hand-edit surface; this
   *  is the parseable identity cost attribution and reproducible replay key off. */
  modelIdentity: z.string().optional(),
  /** Agent backend this run used — drives "open in CLI" resume command. */
  runner: z.enum(['claude', 'codex', 'opencode']).optional(),
  /** Echo of the extra system prompt this run actually used (R2): the
   *  `POST /api/runs` override, or the `config.json` default it fell back to.
   *  Deliberately NOT the full composed prompt — skill bodies and the handoff
   *  contract are derivable from the persisted workflow and would bloat the
   *  index. Resolved at execute time (a queued run picks up config edits). */
  systemPrompt: z.string().optional(),
  /** Per-task follow-up inbox contract (spec 007, #444). Missing on old runs
   *  means enabled — the historical behavior. */
  generateFollowups: z.boolean().optional(),
  /** Autonomous mode (#489): the run was started with the "autonomous" checkbox,
   *  so it never parks at `waiting` (auto-nudge) and — once persisted here —
   *  never parks at the terminal `review` gate either (`settleSuccess` + the
   *  group-pick winner-park read it). Additive-safe: absent = falsy = not
   *  autonomous. Set at creation from `WorkflowInput.autonomous`. */
  autonomous: z.boolean().optional(),
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  /** Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
   *  `monitoring` while the agent is still working on its own downstream work.
   *  Optional/absent on old runs; cleared when the run resumes or ends. */
  activity: z.enum(['monitoring']).optional(),
  /** Exact server-computed deadline for the next automatic monitoring check. */
  monitoringWakeAt: z.string().datetime().optional().catch(undefined),
  /** True only for the live epoch that exhausted all automatic monitoring checks. */
  monitoringWakeCapReached: z.boolean().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  costUsd: z.number().optional(),
  /** First GitHub PR URL spotted in the transcript (the janitor trick). */
  pullRequestUrl: z.string().optional(),
  /** The PR this task is ABOUT (#407, spec 2026-07-16-pr-autodiscovery):
   *  auto-discovered from conversation references for tasks that work on an
   *  existing PR (review/continue/merge). Display-only tier — `pullRequestUrl`
   *  (the PR this task CREATED) always wins, and action gates ignore this. */
  referencedPullRequestUrl: z.string().optional(),
  /** The PR/issue number this task is ABOUT (spec 2026-07-17-task-auto-naming):
   *  regex-extracted from the task prompt, upgradable by the namer's
   *  cross-checked output. Display tier — never gates actions. */
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  /** Provenance for an `issueNumber` seeded by referenced-issue discovery.
   *  Persisted so ambiguity can revoke only the janitor's own value, including
   *  after a restart. Any prompt, namer, or marker write clears this flag. */
  referencedIssueNumberSeeded: z.boolean().optional(),
  /** Who owns the display title: `user` (PATCH rename — never auto-overwritten),
   *  `marker` (agent-declared via `CEZ:TITLE`, spec 2026-07-18-task-ref-markers —
   *  beats the namer, silences live refresh) or `auto` (namer-owned — a later
   *  namer result may replace it). Missing on old runs = legacy behavior (auto
   *  fills only an unset titleSummary). Precedence: user > marker > auto. */
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  /** References the agent itself declared via `CEZ:PR=` / `CEZ:ISSUE=` markers
   *  (spec 2026-07-18-task-ref-markers). Presence of a kind makes it
   *  authoritative: the namer may no longer write that kind, and a declared PR
   *  owns the referenced tier's resolution. */
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** Distinct PR URLs spotted so far — the referenced tier's working set,
   *  persisted so a resumed run keeps disambiguating against the full history
   *  instead of re-adopting the next URL as "the only one". Capped. */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** The issue this task is ABOUT (spec 2026-07-21-report-ref-discovery):
   *  auto-discovered from `github.com/…/issues/N` links in the conversation,
   *  mirroring the referenced-PR tier. Display-only; never gates actions. */
  referencedIssueUrl: z.string().optional(),
  /** Distinct issue URLs spotted so far — the referenced-issue working set,
   *  persisted like `referencedPrCandidates`. Capped. */
  referencedIssueCandidates: z.array(z.string()).optional(),
  /** Task worktree (spec 006) — absent when the run executed in the repo root. */
  worktreePath: z.string().optional(),
  /** The task's own branch (`cez/<id8>`), created off `baseBranch`. */
  branch: z.string().optional(),
  /** Branch (or commit, when HEAD was detached) the worktree was forked from. */
  baseBranch: z.string().optional(),
  /** Set when count-based retention (#483) reclaimed this run's worktree
   *  *directory* (the `cez/<id8>` branch is kept). Presence means "materialized
   *  dir gone, recoverable via `git worktree add`"; it excludes the run from the
   *  retention budget until the dir is re-materialized (resume clears it). */
  worktreeReclaimedAt: z.string().optional(),
  /** Parallel variants (spec 010): tasks sharing a groupId are one group. */
  groupId: z.string().optional(),
  /** Variant letter within the group — 'A' | 'B' | 'C' (kept as a string). */
  variant: z.string().optional(),
  /** Peak resident memory (bytes) / process count observed across the run's
   *  agent process trees (#348) — written when a session's telemetry ends.
   *  Optional: old runs.json files and `ps`-less platforms have neither. */
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  archived: z.boolean().default(false),
  archivedAt: z.string().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
  /** Full workflow definition, persisted so a `queued` run can be re-enqueued
   *  after a restart (#367) — including ad-hoc "(planned)" chains that exist
   *  nowhere else. Kept loose here to avoid an upward import; the run manager
   *  validates the shape before reviving it. */
  workflowDef: z.record(z.string(), z.unknown()).optional(),
});

export type StepState = z.infer<typeof stepStateSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

/** One persisted event line; `type` mirrors AgentEvent plus engine lifecycle. */
export interface RunEvent {
  seq: number;
  ts: string;
  stepId?: string;
  type: string;
  [key: string]: unknown;
}

const MAX_RUNS_KEPT = 300;
const MAX_ARCHIVED_KEPT = 500;

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const ISSUE_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
// The transcript auto-link is convenience only (the cockpit's own `gh pr create` path sets the
// URL authoritatively). Adopt a PR URL ONLY when the agent actually CREATED one — a task that
// reviews or merely references an existing PR must not get mislabeled with its number (#fake-pr).
const CREATED_PR_RE =
  /\b(?:gh\s+pr\s+create|pull\s*request\s+created|created\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull\s*request)|opened\s+(?:a\s+)?(?:draft\s+)?pull\s*request)\b/i;

/** Referenced-tier working-set cap (spec 2026-07-16-pr-autodiscovery): past
 *  this many distinct PRs the conversation is a survey, not a subject. */
const MAX_PR_CANDIDATES = 8;

/**
 * Every scannable string of one persisted event: the v1 top-level fields plus
 * the protocol-v2 `item.*` content (nested — the reason v2 streams were
 * invisible to the janitor, #407). Reasoning items are skipped: thinking text
 * speculates about PRs the task never touches.
 */
function eventTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result', 'message'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object' && (item as Record<string, unknown>).kind !== 'reasoning') {
    const it = item as Record<string, unknown>;
    for (const key of ['text', 'title', 'output'] as const) {
      const value = it[key];
      if (typeof value === 'string') fragments.push(value);
    }
    if (typeof it.input === 'string') {
      fragments.push(it.input);
    } else if (it.input !== undefined) {
      try {
        fragments.push(JSON.stringify(it.input));
      } catch {
        // circular input — skip it
      }
    }
  }
  return fragments;
}

/** Agent-authored event text, matching the trust boundary used by task markers.
 * Tool titles, inputs, and outputs remain visible to the referenced-URL tier,
 * but must never promote an issue into the shared `issueNumber` field (#538). */
function eventAgentTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (it.kind === 'message' && it.role === 'assistant' && typeof it.text === 'string') {
      fragments.push(it.text);
    }
  }
  return fragments;
}

/**
 * The referenced tier's resolution rule, shared by the PR and issue janitors:
 * a marker-declared number (spec 2026-07-18-task-ref-markers) owns the answer
 * outright — only a candidate URL ending in that number resolves, and a
 * contradiction clears the chip. Without a declaration: one distinct URL is
 * the subject; among several, the one whose number the task prompt names (and
 * only when exactly one matches); otherwise ambiguous — no chip beats a wrong
 * chip.
 */
function resolveReferencedRef(candidates: string[], task: string, declared?: number): string | undefined {
  if (declared !== undefined) return candidates.find((url) => url.endsWith(`/${declared}`));
  if (candidates.length === 1) return candidates[0];
  const named = candidates.filter((url) => {
    const num = url.split('/').pop() ?? '';
    // `\d` boundaries only: they reject `170` inside `4170` yet still match a
    // number written as `#4170`, ` 4170`, or inside a pasted `…/pull/4170`.
    return num !== '' && new RegExp(`(?<!\\d)#?${num}(?!\\d)`).test(task);
  });
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The PR URL a creation phrase *introduces*, or undefined. The created URL is
 * the first one at or after the `CREATED_PR_RE` phrase — a PR the same event
 * merely referenced *earlier* (e.g. the issue's own linked `…/pull/1`) must not
 * be mistaken for the one just created (#495). Falls back to the last URL
 * *before* the phrase for `gh` orderings that print the URL first. Selection
 * only — the caller decides whether creation phrasing is present.
 */
function createdPrUrl(haystack: string): string | undefined {
  const phrase = CREATED_PR_RE.exec(haystack);
  if (!phrase) return undefined;
  const after = PR_URL_RE.exec(haystack.slice(phrase.index));
  if (after) return after[0];
  let before: string | undefined;
  for (const m of haystack.slice(0, phrase.index).matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
    before = m[0];
  }
  return before;
}

/**
 * File-backed run store: `runs.json` index (atomic tmp+rename writes, the
 * pattern from @cezar/core's IssueStore) plus one append-only NDJSON event
 * file per run. Also the in-process event bus the SSE endpoints subscribe to:
 * emits `('run', RunRecord)` and `('event', { runId, event: RunEvent })`.
 */
export class RunStore extends EventEmitter {
  private runs = new Map<string, RunRecord>();
  private saveTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly dataDir: string) {
    super();
    this.setMaxListeners(100);
  }

  /**
   * `keepLive` (#367): leave `queued`/`running`/`waiting` statuses untouched
   * so the caller can recover them (RunManager.recover re-queues queued runs,
   * resumes interrupted ones). Without it — one-shot CLI paths that never
   * recover — live-looking runs are marked failed so no ghost stays behind.
   */
  static open(dataDir: string, opts?: { keepLive?: boolean }): RunStore {
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const store = new RunStore(dataDir);
    const indexPath = join(dataDir, 'runs.json');
    if (existsSync(indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
        const parsed = z.array(runRecordSchema).safeParse(raw);
        if (parsed.success) {
          for (const run of parsed.data) {
            // A run that was live when the previous process exited can never
            // finish — surface that instead of a forever-"running" ghost.
            // `review` survives restarts on purpose: the gate is pure data
            // (worktree + branch + record) with no live process, so the diff
            // panel, Send back (resume) and Draft PR all still work.
            if (
              !opts?.keepLive &&
              (run.status === 'running' ||
                run.status === 'queued' ||
                run.status === 'waiting')
            ) {
              run.status = 'failed';
              run.error = 'interrupted — cezar process exited during the run';
              run.finishedAt = run.finishedAt ?? new Date().toISOString();
              for (const step of run.steps) {
                if (step.status === 'running' || step.status === 'waiting') step.status = 'failed';
              }
            }
            if (!['running', 'waiting', 'queued'].includes(run.status)) {
              run.activity = undefined;
              run.monitoringWakeAt = undefined;
            }
            // The wake counter is intentionally process-local, so a restarted
            // process starts a fresh epoch instead of displaying a stale cap.
            run.monitoringWakeCapReached = undefined;
            store.runs.set(run.id, run);
          }
        }
      } catch {
        // corrupt index — start fresh; event files stay on disk untouched
      }
    }
    return store;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  createRun(input: {
    title: string;
    workflow: string;
    task: string;
    model?: string;
    runner?: 'claude' | 'codex' | 'opencode';
    generateFollowups?: boolean;
    autonomous?: boolean;
    groupId?: string;
    variant?: string;
    steps: Array<Pick<StepState, 'id' | 'name' | 'kind'>>;
  }): RunRecord {
    const run: RunRecord = {
      id: randomUUID(),
      // Scrubbed on the way in, exactly as `updateRun` scrubs it on the way
      // through (#456 review) — a token pasted into the prompt otherwise sat
      // verbatim in `runs.json` from creation. `task` is deliberately NOT
      // scrubbed: it is the user's own prompt and is replayed into `{{task}}`
      // when a queued run is revived after a restart (#367), so redacting it
      // would corrupt the revived run.
      title: this.redactText(input.title),
      workflow: input.workflow,
      task: input.task,
      model: input.model,
      runner: input.runner,
      generateFollowups: input.generateFollowups,
      autonomous: input.autonomous,
      groupId: input.groupId,
      variant: input.variant,
      status: 'queued',
      createdAt: new Date().toISOString(),
      tokensUsed: 0,
      archived: false,
      steps: input.steps.map((s) => ({
        ...s,
        status: 'pending',
        iterations: 0,
        tokensUsed: 0,
      })),
    };
    // A prompt that pastes a PR or issue URL is already about that item — seed
    // both referenced tiers so queued runs can expose the reference before the
    // first agent event (#407, #554).
    this.trackReferencedPrs(run, input.task);
    this.trackReferencedIssues(run, input.task);
    this.runs.set(run.id, run);
    this.pruneOldRuns();
    this.touch(run);
    return run;
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'steps'>>): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (Object.prototype.hasOwnProperty.call(patch, 'issueNumber')) {
      delete run.referencedIssueNumberSeeded;
    }
    const normalized = { ...patch };
    if (normalized.status && !['running', 'waiting', 'queued'].includes(normalized.status)) {
      normalized.activity = undefined;
      normalized.monitoringWakeAt = undefined;
      normalized.monitoringWakeCapReached = undefined;
    }
    Object.assign(run, this.redactPatch(normalized));
    this.touch(run);
    return run;
  }

  /**
   * Scrub the free-text fields of a record patch (#427 review). Redacting only
   * events left a hole: `titleSummary` is derived from the RAW first agent turn
   * and `error` from raw process output, so a token the agent echoed was
   * `[REDACTED]` in the NDJSON yet verbatim in `runs.json` — the file the "no
   * secrets in state files" rule names explicitly. These three are the only
   * patch fields carrying agent/process text; the rest are ids, enums, counters
   * and URLs, and running the scrubber over them would only risk mangling them.
   *
   * `StepState.error` is the step-level counterpart and is scrubbed the same
   * way in `updateStep` — `run.ts` feeds the SAME `err.message` string to both
   * calls, so redacting only the run-level copy left the token verbatim one
   * field away (#456 review).
   */
  private redactPatch(
    patch: Partial<Omit<RunRecord, 'id' | 'steps'>>,
  ): Partial<Omit<RunRecord, 'id' | 'steps'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    const out = { ...patch };
    for (const field of ['title', 'titleSummary', 'error'] as const) {
      const value = out[field];
      if (typeof value === 'string') out[field] = this.redactText(value);
    }
    return out;
  }

  /**
   * Step-level counterpart of `redactPatch` (#456 review). `error` is the only
   * free-text `StepState` field — it is set from raw `err.message` /process
   * output (`run.ts` `finishStep`), and `touch()` fans the whole record out
   * over SSE, so an unscrubbed copy leaked to `runs.json` AND to the browser.
   * The remaining fields are ids, enums, counters and timestamps.
   */
  private redactStepPatch(patch: Partial<Omit<StepState, 'id'>>): Partial<Omit<StepState, 'id'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    if (typeof patch.error !== 'string') return patch;
    return { ...patch, error: this.redactText(patch.error) };
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind'>): void {
    const run = this.runs.get(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    run.steps.push({ ...step, status: 'pending', iterations: 0, tokensUsed: 0 });
    this.touch(run);
  }

  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.runs.get(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    Object.assign(step, this.redactStepPatch(patch));
    run.tokensUsed = run.steps.reduce((sum, s) => sum + s.tokensUsed, 0);
    const cost = run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    run.costUsd = cost > 0 ? cost : undefined;
    this.touch(run);
  }

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.archived = archived;
    run.archivedAt = archived ? new Date().toISOString() : undefined;
    this.touch(run);
    return run;
  }

  /** Bulk-archive every finished run; returns how many were archived. */
  archiveFinished(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!run.archived && ['done', 'failed', 'cancelled'].includes(run.status)) {
        run.archived = true;
        run.archivedAt = new Date().toISOString();
        this.touch(run);
        count++;
      }
    }
    return count;
  }

  appendEvent(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const seq = this.nextSeq(runId);
    // Scrub credentials before the event touches disk or the live wire (#427):
    // tool-result output is persisted verbatim and served back over the API, so
    // a secret in an agent's command output would otherwise land in `.ai/cezar/`.
    const full: RunEvent = this.redact({ ...event, seq, ts: new Date().toISOString() });
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    appendFileSync(this.eventsPath(runId), `${JSON.stringify(full)}\n`, 'utf8');
    this.emit('event', { runId, event: full });

    // The janitor trick: agents print the PR URL after `gh pr create` — the
    // first one spotted in the transcript becomes the run's PR link. Scans v1
    // fields AND nested v2 `item.*` content (#407). A URL without the created
    // phrasing still feeds the referenced tier (the PR the task is about).
    const haystack = eventTextFragments(full).join(' ');
    const agentHaystack = eventAgentTextFragments(full).join(' ');
    if (haystack.length > 0) {
      let changed = false;
      if (!run.pullRequestUrl) {
        const created = createdPrUrl(haystack);
        if (created) {
          this.updateRun(runId, { pullRequestUrl: created });
        } else if (PR_URL_RE.test(haystack) && this.trackReferencedPrs(run, haystack)) {
          changed = true;
        }
      }
      // Issue links feed their own referenced tier regardless of PR state —
      // a task that created a PR can still be ABOUT an issue
      // (spec 2026-07-21-report-ref-discovery).
      if (
        ISSUE_URL_RE.test(haystack) &&
        this.trackReferencedIssues(run, haystack, agentHaystack)
      ) {
        changed = true;
      }
      if (changed) this.touch(run);
    }
    return full;
  }

  /**
   * Fold every PR URL in `haystack` into the run's referenced-tier working
   * set and re-resolve `referencedPullRequestUrl` (spec
   * 2026-07-16-pr-autodiscovery). Mutates the record in place — the caller
   * owns persistence/fan-out — and reports whether anything changed.
   */
  private trackReferencedPrs(run: RunRecord, haystack: string): boolean {
    const seen = new Set(run.referencedPrCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    if (seen.size === before) return false;
    run.referencedPrCandidates = [...seen];
    run.referencedPullRequestUrl = resolveReferencedRef(
      run.referencedPrCandidates,
      run.task,
      run.markerRefs?.pr,
    );
    return true;
  }

  /**
   * The issue-side mirror of `trackReferencedPrs` (spec
   * 2026-07-21-report-ref-discovery): fold every issue URL in `haystack` into
   * the working set and re-resolve `referencedIssueUrl`. An unambiguous
   * resolution also seeds `issueNumber` when nothing owns that field yet —
   * marker and namer both outrank this janitor and overwrite it freely.
   */
  private trackReferencedIssues(
    run: RunRecord,
    haystack: string,
    seedHaystack = haystack,
  ): boolean {
    const seen = new Set(run.referencedIssueCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(ISSUE_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    const candidatesChanged = seen.size !== before;
    if (candidatesChanged) run.referencedIssueCandidates = [...seen];
    const prev = run.referencedIssueUrl;
    run.referencedIssueUrl = resolveReferencedRef(
      run.referencedIssueCandidates ?? [],
      run.task,
      run.markerRefs?.issue,
    );
    let numberChanged = false;
    if (run.markerRefs?.issue === undefined && ISSUE_URL_RE.test(seedHaystack)) {
      if (run.referencedIssueUrl && run.issueNumber === undefined) {
        const n = Number(run.referencedIssueUrl.split('/').pop());
        if (Number.isInteger(n) && n > 0) {
          run.issueNumber = n;
          run.referencedIssueNumberSeeded = true;
          numberChanged = true;
        }
      } else if (!run.referencedIssueUrl && prev && run.referencedIssueNumberSeeded) {
        // Ambiguity revoked the resolution — take back the number this janitor
        // seeded from it. No chip beats a wrong chip.
        delete run.issueNumber;
        delete run.referencedIssueNumberSeeded;
        numberChanged = true;
      }
    }
    return candidatesChanged || run.referencedIssueUrl !== prev || numberChanged;
  }

  /**
   * Apply agent-declared reference markers (spec 2026-07-18-task-ref-markers).
   * Marker values are authoritative for the display tier: they overwrite the
   * regex/namer numbers, and a declared PR re-resolves the referenced URL
   * against the candidate working set — including down to `undefined` when no
   * candidate matches (a wrong chip is worse than no chip). The created tier
   * (`pullRequestUrl`) is deliberately untouched.
   */
  applyMarkerRefs(runId: string, refs: { pr?: number; issue?: number }): RunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run || (refs.pr === undefined && refs.issue === undefined)) return run;
    run.markerRefs = {
      ...run.markerRefs,
      ...(refs.pr !== undefined ? { pr: refs.pr } : {}),
      ...(refs.issue !== undefined ? { issue: refs.issue } : {}),
    };
    if (refs.pr !== undefined) run.prNumber = refs.pr;
    if (refs.issue !== undefined) {
      run.issueNumber = refs.issue;
      delete run.referencedIssueNumberSeeded;
    }
    if (run.markerRefs.pr !== undefined) {
      run.referencedPullRequestUrl = resolveReferencedRef(
        run.referencedPrCandidates ?? [],
        run.task,
        run.markerRefs.pr,
      );
    }
    if (run.markerRefs.issue !== undefined) {
      run.referencedIssueUrl = resolveReferencedRef(
        run.referencedIssueCandidates ?? [],
        run.task,
        run.markerRefs.issue,
      );
    }
    this.touch(run);
    return run;
  }

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis; the seq simply never appears in a replay
   * (gaps are fine — dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const full: RunEvent = this.redact({ ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() });
    this.emit('event', { runId, event: full });
    return full;
  }

  /** Lazily-collected concrete secret values from the host env (#427). */
  private secretValues: readonly string[] | null = null;

  /**
   * Scrub known credential values / token shapes from an event before it is
   * persisted or fanned out. On by default; `CEZ_REDACT_SECRETS=0` opts out.
   */
  private redact(event: RunEvent): RunEvent {
    if (process.env.CEZ_REDACT_SECRETS === '0') return event;
    return redactDeep(event, this.hostSecrets());
  }

  /** Best-effort scrub of one free-text string bound for `runs.json`. Honors
   *  the `CEZ_REDACT_SECRETS=0` opt-out itself so every caller inherits it. */
  private redactText(text: string): string {
    if (process.env.CEZ_REDACT_SECRETS === '0') return text;
    return redactSecrets(text, this.hostSecrets());
  }

  private hostSecrets(): readonly string[] {
    if (this.secretValues === null) this.secretValues = collectSecretValues();
    return this.secretValues;
  }

  readEvents(runId: string): RunEvent[] {
    try {
      const raw = readFileSync(this.eventsPath(runId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as RunEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is RunEvent => e !== null);
    } catch {
      return [];
    }
  }

  deleteRun(id: string): boolean {
    const existed = this.runs.delete(id);
    if (existed) {
      try {
        rmSync(this.eventsPath(id), { force: true });
        rmSync(this.handoffPath(id), { force: true }); // spec 007: the journal goes with the task
        rmSync(this.imagesDir(id), { recursive: true, force: true }); // agent screenshots
      } catch {
        // best effort — the index is authoritative
      }
      this.seqs.delete(id);
      this.scheduleSave();
      this.emit('deleted', id);
    }
    return existed;
  }

  /** Write the index out now (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? this.rehydrateSeq(runId)) + 1;
    this.seqs.set(runId, next);
    return next;
  }

  /** After a restart the in-memory counter is empty while the run's NDJSON file
   *  keeps the history. Restarting from 1 would collide with the seqs a client
   *  already replayed — its `seq > maxSeq` dedup then silently drops every
   *  resumed event, even across a reload (the frozen-transcript symptom class
   *  of #424). One file read on the first post-restart append per run. */
  private rehydrateSeq(runId: string): number {
    let max = 0;
    for (const event of this.readEvents(runId)) {
      if (typeof event.seq === 'number' && event.seq > max) max = event.seq;
    }
    return max;
  }

  private eventsPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.ndjson`);
  }

  /** Same location `handoffPath()` in handoff.ts produces — inlined to keep
   *  the store free of upward imports. */
  private handoffPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.handoff.md`);
  }

  /** Agent screenshots persisted by the run manager (see persistImage). */
  private imagesDir(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}-images`);
  }

  private touch(run: RunRecord): void {
    this.scheduleSave();
    this.emit('run', run);
  }

  private pruneOldRuns(): void {
    const all = this.listRuns();
    const stalePool = [
      ...all.filter((r) => !r.archived).slice(MAX_RUNS_KEPT),
      ...all.filter((r) => r.archived).slice(MAX_ARCHIVED_KEPT),
    ];
    for (const stale of stalePool) {
      this.runs.delete(stale.id);
      try {
        rmSync(this.eventsPath(stale.id), { force: true });
        rmSync(this.handoffPath(stale.id), { force: true });
        rmSync(this.imagesDir(stale.id), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  /** Debounced so token-usage updates don't rewrite the index per event. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    const indexPath = join(this.dataDir, 'runs.json');
    const tmpPath = `${indexPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.listRuns(), null, 2), 'utf8');
      renameSync(tmpPath, indexPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cez] failed to save runs.json: ${message}`);
    }
  }
}
