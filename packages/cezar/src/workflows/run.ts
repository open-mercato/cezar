import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseAskMarker, stripAskMarker, type AskRequest } from '../core/ask.ts';
import { type AgentSession } from '../core/claude-cli-runner.ts';
import { onUsage, registerRunProcess, unregisterRunProcess, type ProcessUsage } from '../core/process-usage.ts';
import { createRunner } from '../core/runner-factory.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import {
  ModelIdentityError,
  formatModelIdentity,
  normalizeModelForBackend,
} from '../core/model-identity.ts';
import {
  HANDOFF_ONLY_INSTRUCTIONS,
  HANDOFF_INSTRUCTIONS,
  appendHandoffHeartbeat,
  followupsEnabled,
  handoffPath,
  seedHandoffFile,
} from '../handoff.ts';
import { todosPath } from '../todos.ts';
import type { AgentEvent, ContentBlock } from '../core/agent-runner.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { materializeSkillDir } from '../skills-remote.ts';
import { seedAgentConfigLocalLayer } from '../agent-config/seed.ts';
import { readAgentModelProvider } from '../agent-config/models.ts';
import { loadConfig, resolveWorktreeRetention } from '../config.ts';
import { autosaveCommit, createWorktree, resolveBaseRef, worktreeDiff, worktreeShortstat } from '../git-worktree.ts';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';
import { loadWorkflows } from './load.ts';
import type { QueuedMessage, RunRecord, RunStore, StepState } from '../runs/store.ts';
import { reclaimWorktrees, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { extractTaskRefs, refineTaskRefs, titleRefNumber } from '../runs/task-refs.ts';
import { parseTaskMarkers, stripTaskMarkers } from '../runs/task-markers.ts';
import { autoNamingActive, generateRunName, liveTitleUpdatesEnabled, postValidateTitle } from '../runs/auto-name.ts';
import { reviewGateEnabled } from '../runs/review-gate.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { chainStepNote, DEFAULT_ALLOWED_TOOLS, stepKind, type WorkflowDef, type WorkflowStepDef } from './types.ts';

const CHECK_OUTPUT_CAP = 20_000;

async function configuredModelProvider(
  backend: RunnerId,
  repoRoot: string,
): Promise<string | undefined> {
  return readAgentModelProvider(backend, repoRoot).catch(() => undefined);
}
/** An interactive session that hears nothing from the user closes itself. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;
/**
 * Task-completion marker from the agent contract (HANDOFF_INSTRUCTIONS): a
 * turn whose text ends with `CEZ:DONE` means "goal achieved, nothing to ask" —
 * the session is closed right away instead of parking at `waiting` (#347).
 * Detection runs on the accumulated turn text so delta-streaming backends
 * (codex, opencode) can't split the marker across text events.
 */
const DONE_MARKER_RE = /CEZ:DONE\s*$/;
/**
 * Still-working marker from the agent contract (spec
 * 2026-07-18-subagent-monitoring-status, #490): a turn whose text ends with
 * `CEZ:MONITORING` means "I ended this turn but I'm still working on my own
 * downstream work (a sub-agent / a command I'm monitoring), not waiting on the
 * user" — cezar parks it as `running`/`activity:'monitoring'` instead of
 * `waiting`, so the cockpit shows a non-attention state. `CEZ:DONE` wins if both
 * appear. Detected on accumulated turn text (like `CEZ:DONE`) so delta-streaming
 * backends can't split the marker across text events.
 */
const MONITORING_MARKER_RE = /CEZ:MONITORING\s*$/;
/**
 * Preserve boundaries between complete assistant text blocks while a turn is
 * accumulated for marker parsing. The runners join these same v1 blocks with
 * newlines in `AgentRunResult`; matching that contract here prevents a
 * trailing `CEZ:TITLE=` block from absorbing later commentary (#623).
 */
export function appendTurnText(current: string, next: string): string {
  if (!current) return next;
  if (!next) return current;
  return `${current}\n${next}`;
}
/** Strip a trailing marker from one text event so transcripts stay free of
 *  protocol noise. Delta backends may split the marker across events — then
 *  it stays visible; detection above is unaffected. */
function stripDoneMarker(text: string): string {
  return text.replace(/\s*CEZ:DONE\s*$/, '');
}
/** Strip a trailing `CEZ:MONITORING` marker from one text event (see
 *  `stripDoneMarker`; same delta-backend caveat). */
function stripMonitoringMarker(text: string): string {
  return text.replace(/\s*CEZ:MONITORING\s*$/, '');
}
/** Emit the v2 `ask.requested` event for a parsed marker (the cockpit renders
 *  it as an ask card, #473). Returns the minted request id. */
function emitAskRequested(sink: UiEventSink, ask: AskRequest): string {
  const requestId = randomUUID();
  sink.handle({ type: 'ask.requested', requestId, questions: ask.questions });
  return requestId;
}
/** Periodic "cezar autosave" commit in the task worktree (spec 006). */
export const AUTOSAVE_INTERVAL_MS = 90_000;

/** The periodic autosave timer is opt-in (#471): off, a task branch carries only the
 *  agent's own commits plus the turn-end/pre-PR flushes — no mid-run "cezar autosave"
 *  noise interleaving PR history. The flushes (`autosaveCommit` at turn end and before
 *  a draft PR) are NOT gated: the branch must still end holding the finished state. */
export function periodicAutosaveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTOSAVE === '1';
}

interface ActiveRun {
  cancelled: boolean;
  interrupt: () => void;
  /** Where this run's steps execute: the task worktree, or the repo root. */
  cwd: string;
  /** Live claude session of the currently running agent step, if any. */
  session?: AgentSession;
  currentStepId?: string;
  idleTimer?: NodeJS.Timeout;
  monitoringWakeTimer?: NodeJS.Timeout;
  monitoringWakeIntervalMinutes?: number;
  monitoringWakeups?: number;
  autosaveTimer?: NodeJS.Timeout;
  /* The screenshot counter lives on `RunManager.queuedImageSeq` (#472), keyed by
   * run id — a queued run persists attachments with no `ActiveRun` at all. */
  /** Has a session EVER opened on this run (#472)? `session` alone cannot answer
   *  it — teardown sets it back to `undefined`, so a closed session and one that
   *  never opened look identical. This distinguishes "still starting up, buffer
   *  the message" from "genuinely closed, 409". */
  sessionEverOpened?: boolean;
  /** Autonomous mode (#autonomous): never park at `waiting` — auto-nudge the agent to keep
   *  going until it signals done or the safety cap is hit. */
  autonomous?: boolean;
  autoContinues?: number;
  /** Registry snapshot used to expand `/skill` follow-ups before a backend can
   *  mistake them for its own slash commands (#676). */
  skills?: Skill[];
  /** Release for exclusive execution in the user's repository working tree.
   *  Worktree-backed runs never need it; every degradation/opt-out path does. */
  releaseRepoRoot?: () => void;
  /** Durable directional-usage accounting state for the current runner
   * invocation. Provider-local turn ids are unique only within this epoch. */
  usageInvocation?: {
    stepId: string;
    epoch: number;
    observed: boolean;
    startedTurns: Set<string>;
    recordedTurns: Set<string>;
  };
}

/** Safety cap on autonomous auto-continues per run — stops a stuck agent from nudging forever. */
const MAX_AUTO_CONTINUES = 40;
const AUTONOMOUS_NUDGE =
  'Continue working autonomously until the task is fully complete. Do not ask me for confirmation or clarification — make reasonable assumptions and proceed. When everything is done, end the session with your done signal.';
const MONITORING_WAKE_NUDGE =
  'Re-check the downstream work you were monitoring. Continue toward the task goal; emit CEZ:MONITORING again only if it is still pending.';

export interface StartRunInput {
  task: string;
  model?: string;
  /** Agent backend chosen for this task (GUI). Unset = the config default. */
  runner?: RunnerId;
  /** Screenshots pasted into the new-task form — persisted when the run is
   *  created and delivered once, with the first agent step's opening message. */
  images?: ContentBlock[];
  /** Per-run system-prompt override (`POST /api/runs`, programmatic callers).
   *  Replaces the `config.json` default for this run — see
   *  `resolveExtraSystemPrompt` for the precedence contract. */
  systemPrompt?: string;
  /** Composer opt-out (#worktree-toggle): `false` runs the task in the repo
   *  working tree instead of an isolated worktree. Undefined/`true` keeps the
   *  default per-task worktree. Ignored for variants (they always isolate). */
  worktree?: boolean;
  /** Autonomous mode (#autonomous): the run never parks at `waiting` for the
   *  user — turn-ends auto-continue until the agent signals done or the safety
   *  cap is hit. No "needs you" is ever raised. */
  autonomous?: boolean;
  /** Follow-up inbox generation (spec 007, #444). Omitted means enabled for
   *  compatibility; the handoff journal runs either way. */
  generateFollowups?: boolean;
  /** Attachments from the queued prompt stack (#472), re-encoded from disk by
   *  `hydrateQueuedInput` at dequeue. Kept separate from `images` because those
   *  are persisted into `taskImages` by `startRun()` — folding
   *  the stack's (already-persisted) files in there would write duplicate files
   *  and make the task bubble render the stack's images as its own. In-memory
   *  only: rebuilt from the record on every hydration, never persisted. */
  stackedImages?: ContentBlock[];
}

/**
 * The effective "extra" system prompt for a run (spec §protocol v2, R2 2.3):
 * the per-run override (`POST /api/runs` `systemPrompt`) REPLACES the
 * `config.json` default — they are the same knob at two scopes, so the more
 * specific one wins outright; they never concatenate. Whichever wins is
 * ADDITIVE to the skill body and the handoff contract, which always ride
 * along (see `composeSystemPrompt`). Blank strings count as unset.
 */
export function resolveExtraSystemPrompt(
  override: string | undefined,
  configDefault: string | undefined,
): string | undefined {
  return override?.trim() || configDefault?.trim() || undefined;
}

/**
 * Joins the parts of one agent step's system prompt in fixed order — skill
 * body (most task-specific), then the run's extra prompt (user guidance, can
 * amend the skill), then the handoff contract (always last, never optional in
 * practice). Blank parts drop out; survivors join with the same `\n\n---\n\n`
 * divider the skill+handoff composition has always used.
 */
export function composeSystemPrompt(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join('\n\n---\n\n');
}

/**
 * Materialized pasted attachment: the on-disk name/serving-URL pair the
 * transcript already used, plus the absolute path that lets the agent
 * operate on the file itself — save it, `cp` it, attach it to a GitHub
 * issue/PR (#357). `path` is only ever an absolute path under
 * `.ai/cezar/runs/<runId>-images/` (see `RunManager.persistImage`).
 */
/** Inverse of `persistImage`'s extension mapping (#472) — a persisted attachment
 *  is re-encoded from disk at dequeue and needs its media type back. */
export function mediaTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'jpg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/png';
}

/** Highest `<prefix>-<n>.<ext>` suffix already present in a run's image dir (#472).
 *  `screenshot-*` and `pasted-*` share one numbering space, so this scans both and
 *  returns 0 for a missing/empty directory. */
export function highestImageSeq(dir: string): number {
  try {
    return readdirSync(dir).reduce((max, name) => {
      const m = /^(?:screenshot|pasted)-(\d+)\./.exec(name);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  } catch {
    return 0;
  }
}

export interface PersistedAttachment {
  name: string;
  url: string;
  path: string;
}

/**
 * Plain-text note listing the absolute paths of pasted attachments, appended
 * to the message that carries them (#357). The base64 image blocks stay in
 * the message for the model to *view*; this note is what lets it *use* the
 * files as files — and the only usable reference on backends (codex,
 * opencode) whose `textOf()` drops image blocks before reaching the model.
 */
export function pastedAttachmentsText(attachments: PersistedAttachment[]): string {
  const list = attachments.map((a) => `- ${a.path}`).join('\n');
  return (
    `The user attached ${attachments.length} pasted file${attachments.length > 1 ? 's' : ''}, ` +
    `also saved on disk at:\n${list}\n` +
    `When the task involves saving, uploading, attaching, or transforming the pasted content ` +
    `(e.g. attaching to a GitHub issue/PR, copying into the repo), operate on these files — do ` +
    `not attempt to reconstruct them from the conversation.`
  );
}

/** Same note as `pastedAttachmentsText`, wrapped as a trailing `ContentBlock`
 *  ready to append to a message's content array. */
export function pastedAttachmentsNote(attachments: PersistedAttachment[]): ContentBlock {
  return { type: 'text', text: pastedAttachmentsText(attachments) };
}

/** Variant letters + the fixed diversification hints (spec 010). A runs the
 *  task verbatim; B/C get one constant sentence each — zero configuration. */
export const VARIANT_LETTERS = ['A', 'B', 'C'] as const;
const VARIANT_HINTS: Record<string, string | undefined> = {
  A: undefined,
  B: 'Approach hint: prefer the minimal, surgical change.',
  C: 'Approach hint: prefer a thorough, structural approach.',
};

const RESTART_CONTINUATION_PROMPT =
  'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';

interface PendingContinuation {
  stepId: string;
  sessionId: string | undefined;
  backend: RunnerId;
  prompt: string;
  images: ContentBlock[];
}

interface PersistedImages {
  blocks: ContentBlock[];
  attachments: PersistedAttachment[];
}

/**
 * The mini workflow engine: executes a `WorkflowDef` against a repo, one step
 * at a time, persisting every event to the RunStore (which the SSE endpoints
 * relay live to the GUI). No GitHub choreography — agent steps and shell
 * checks with bounded retry loops, plus live sessions: the last agent step
 * stays open for follow-ups (`waiting`) until "finish", idle timeout, or
 * cancel. Runs queue behind the workspace-wide `maxParallel` slots (the shared
 * `WorkspaceSemaphore`, spec 2026-07-20 step 2.5) and each run executes in its
 * own git worktree on a `cez/<id8>` branch (spec 006), autosave-committed at
 * turn end and before a draft PR — plus every 90 s when opted in via
 * CEZ_AUTOSAVE=1 (#471). Each autosave records its trigger in the commit
 * subject, so the always-on flushes are not mistaken for the opt-in timer.
 * The user's working tree is never touched.
 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  // Queue + `starting` set (spec 006, janitor's pump() pattern): `starting`
  // covers the window between shifting a run off the queue and the run
  // registering in `active`, so parallel-slot counting is never racy.
  private readonly queue: string[] = [];
  private readonly starting = new Set<string>();
  // Runs parked at `waiting` (open session, ball in the user's court). They
  // don't consume a `maxParallel` slot (#347) — an idle claude process costs
  // memory but no tokens, queued work progressing matters more, and the idle
  // timeout already bounds how long a session can sit open. Invariant:
  // `waiting ⊆ active` — always cleared together via dropActive().
  private readonly waiting = new Set<string>();
  /** Durable monitoring subset. Only the configured number receives the waiting-slot exemption. */
  private readonly monitoring = new Set<string>();
  private readonly pendingJobs = new Map<string, { workflow: WorkflowDef; input: StartRunInput }>();
  /** Interrupted agent turns recovered after a process restart. Unlike an
   *  explicit user Continue, these are bulk scheduler work and must re-enter
   *  through `pump()` so both workspace and per-project caps are honored. */
  private readonly pendingContinuations = new Map<string, PendingContinuation>();
  /** Per-run image counter behind `pasted-<n>` / `screenshot-<n>` (#472). Lives on
   *  the manager rather than the `ActiveRun` so a *queued* run — which has no
   *  `ActiveRun` at all — can persist attachments. Seeded lazily from disk. */
  private readonly queuedImageSeq = new Map<string, number>();
  /** Messages that landed in the dequeue → session-open gap (#472), flushed as
   *  ordinary follow-up turns the moment the session opens. In-memory only. */
  private readonly deferredMessages = new Map<string, ContentBlock[][]>();
  private pumping = false;
  /** A pump that arrived while one was in flight — replayed by `pump()`'s own
   *  loop so a slot freed mid-sweep is never a lost wakeup. */
  private pumpAgain = false;
  /**
   * Runs normally isolate in worktrees and may execute in parallel. When that
   * isolation is unavailable (or explicitly disabled), serialize access to
   * `repoRoot` so two agents can never edit/revert the same files (#438).
   */
  private repoRootTail: Promise<void> = Promise.resolve();

  /** `.ai/cezar` — where the per-task handoff files and todos.json live. */
  private readonly dataDir: string;

  /** Runs currently being paused by the memory guard — dedupes the ~2 s samples so one breach
   *  triggers one pause, not a burst. Cleared in dropActive when the run leaves the registry. */
  private readonly memoryPausing = new Set<string>();

  /** Unsubscribe handle for the constructor's `onUsage` subscription — released
   *  by dispose() so a torn-down manager stops receiving sampler ticks. */
  private readonly offUsage: () => void;

  /** The workspace-wide parallel-cap semaphore + cached resource config
   *  (spec 2026-07-20, step 2.5). Boot constructs ONE and every manager shares
   *  it; the private fallback keeps single-manager callers and tests working. */
  private readonly semaphore: WorkspaceSemaphore;

  /** Unregister handle for this manager's semaphore membership — released by
   *  dispose() so a torn-down project stops counting against the cap. */
  private readonly offSemaphore: () => void;

  constructor(
    private readonly store: RunStore,
    private readonly repoRoot: string,
    options: { semaphore?: WorkspaceSemaphore } = {},
  ) {
    this.dataDir = join(repoRoot, '.ai/cezar');
    this.semaphore = options.semaphore ?? new WorkspaceSemaphore();
    this.offSemaphore = this.semaphore.register({
      busySlots: () => this.busySlots(),
      pump: () => this.pump(),
      oldestQueuedAt: () => this.oldestQueuedAt(),
    });
    // Memory guard (#memory-guard): the shared process-tree sampler already ticks ~every 2 s for
    // the runs table; piggyback on it to enforce the per-task memory ceiling.
    this.offUsage = onUsage((snapshot) => void this.enforceMemoryLimit(snapshot));
  }

  /**
   * Release everything this manager owns without touching run records
   * (multi-project workspace, spec 2026-07-20: a removed project's context is
   * torn down while the process lives on). Unsubscribes the shared usage
   * sampler — before dispose() existed that subscription lived for the whole
   * process — clears every per-run idle/autosave timer, releases any held
   * repo-root locks, and empties the queued state so nothing fires later.
   * Live sessions are NOT ended here: run lifecycle stays the caller's policy;
   * dispose only guarantees the manager makes no further moves on its own.
   */
  dispose(): void {
    this.offUsage();
    this.offSemaphore();
    for (const [runId, state] of this.active) {
      this.clearIdleTimer(state);
      this.clearMonitoringWakeTimer(state, runId);
      this.clearAutosaveTimer(state);
      state.releaseRepoRoot?.();
      state.releaseRepoRoot = undefined;
    }
    this.active.clear();
    this.waiting.clear();
    this.starting.clear();
    this.queue.length = 0;
    this.pendingJobs.clear();
    this.pendingContinuations.clear();
    this.memoryPausing.clear();
    this.lastNamerKey.clear();
  }

  /**
   * Pause any active run whose whole process tree exceeds the WORKSPACE
   * `resources.memoryLimitMb`, freeing its slot so the queue advances
   * (#memory-guard). "Pause" closes the session — freeing the tree's
   * memory — and leaves the run resumable via Continue; a loud warning explains why. No-op when
   * no limit is set or the sampler has no data (e.g. `ps`/PowerShell unavailable).
   */
  private async enforceMemoryLimit(snapshot: Record<string, ProcessUsage>): Promise<void> {
    // The sampler is module-global (one `ps` for the whole process), so with
    // multiple projects a snapshot carries EVERY project's runs. Act only on
    // rows this manager owns (multi-project spec, step 2.4).
    const runIds = Object.keys(snapshot).filter((runId) => this.active.has(runId));
    if (runIds.length === 0) return;
    // Workspace limit from the shared semaphore's in-memory cache (step 2.5:
    // refreshed at boot and on PUT /api/workspace/config — never N per-tick
    // file reads across N projects). Legacy per-repo `memoryLimitMb` keys are
    // ignored post-migration.
    const limitMb = this.semaphore.memoryLimitMb();
    if (!limitMb || limitMb <= 0) return;
    const limitBytes = limitMb * 1024 * 1024;
    for (const runId of runIds) {
      const usage = snapshot[runId];
      if (!usage || usage.rssBytes <= limitBytes) continue;
      if (this.memoryPausing.has(runId)) continue;
      const state = this.active.get(runId);
      if (!state?.session?.open || state.cancelled) continue;
      this.memoryPausing.add(runId);
      const usedMb = Math.round(usage.rssBytes / (1024 * 1024));
      this.store.appendEvent(runId, {
        type: 'note',
        message: `⚠ memory limit exceeded — this task's process tree is using ${usedMb} MiB (limit ${limitMb} MiB). Pausing it and letting the next queued task run; resume it with Continue.`,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: `paused — memory limit exceeded (${usedMb} MiB > ${limitMb} MiB)`,
      });
      // Closing the session frees the tree and lets the normal exit path settle the run and
      // pump the queue. Suppress autonomous auto-continue so the pause actually holds.
      state.autonomous = false;
      this.clearIdleTimer(state);
      state.session.end();
    }
  }

  /** Env the spawned claude gets so the agent can find its handoff file and
   *  the global inbox (spec 007; the inbox only when the run opted in).
   *
   *  `CEZ_TODOS_FILE` is set to `''` rather than omitted when follow-ups are
   *  off: runners spawn with `{ ...process.env, ...spec.env }`, so omitting the
   *  key would let a value inherited from *this* process through — a nested
   *  cezar (an agent running `cez serve`/`cez run`/the test suite) would then
   *  write follow-ups into the parent's inbox despite the opt-out. Empty is the
   *  established "absent" spelling — consumers guard with `if (todosFile)`. */
  private agentEnv(runId: string, generateFollowups = true): Record<string, string> {
    return {
      CEZ_HANDOFF_FILE: handoffPath(this.dataDir, runId),
      CEZ_TASK_ID: runId,
      CEZ_TODOS_FILE: generateFollowups ? todosPath(this.dataDir) : '',
    };
  }

  startRun(
    workflow: WorkflowDef,
    input: StartRunInput,
    group?: { groupId: string; variant: string },
  ): RunRecord {
    // Sanitize at the manager boundary so CLI runs, workflows, variants, and
    // direct callers cannot bypass the HTTP policy.
    const effectiveInput = agentModelsLocked(this.repoRoot)
      ? { ...input, model: undefined }
      : input;
    const run = this.store.createRun({
      title: makeRunTitle(input.task, workflow) + (group ? ` (${group.variant})` : ''),
      workflow: workflow.name,
      task: input.task,
      model: effectiveInput.model,
      runner: input.runner,
      // The global inbox is the ceiling on the per-run flag (#471). Enforced here rather than
      // at the HTTP route because `cezar run`, the inbox's own "▶ Run" and variants all reach
      // startRun directly — a route-level gate would leave those writing todos.json.
      generateFollowups: followupsEnabled() ? input.generateFollowups : false,
      // Persist autonomy on the record (#489) so the terminal review gate
      // (`settleSuccess`) and the group-pick winner-park can honor it — mid-run
      // auto-nudge reads `input.autonomous` (`execute`), but the record is the
      // only source those after-the-fact consumers have.
      autonomous: input.autonomous === true,
      // Persist the explicit opt-out so queued-run restart recovery and the
      // session Git routes can distinguish it from a removed isolated worktree.
      worktree: !group && input.worktree === false ? false : undefined,
      groupId: group?.groupId,
      variant: group?.variant,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: stepKind(s) })),
    });
    // Persist the full definition so a queued run survives a restart (#367) —
    // ad-hoc "(planned)" chains exist nowhere else to re-resolve from.
    this.store.updateRun(run.id, { workflowDef: workflow });
    // Initial pasted images must be visible while the run is still queued (#612),
    // and must survive a restart before a slot opens. Persist them before the job
    // enters `pendingJobs`; `hydrateQueuedInput` reconstructs their content blocks
    // from these URLs when a recovered run eventually starts.
    if (input.images?.length) {
      const persisted = input.images
        .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
        .map((b) => this.persistImage(run.id, b.source.media_type, b.source.data, 'pasted'))
        .filter((saved): saved is PersistedAttachment => saved !== null);
      if (persisted.length) {
        this.store.updateRun(run.id, { taskImages: persisted.map((saved) => saved.url) });
      }
    }
    // Step-0 reference extraction (task auto-naming spec): the regex layer's
    // numbers persist immediately; the namer may add the kind it verified later.
    const skillHint = workflow.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(input.task), skillHint);
    if (refs.prNumber !== undefined || refs.issueNumber !== undefined) {
      this.store.updateRun(run.id, {
        ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
        ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
      });
    }
    // Fire-and-forget LLM naming (task auto-naming spec): the heuristic title
    // above shows instantly; the namer's short title replaces it when (and if)
    // the model answers. Never awaited, never fails the run.
    void this.autoNameRun(run.id, skillHint, input.task);
    this.pendingJobs.set(run.id, { workflow, input: effectiveInput });
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * Parallel variants (spec 010): N runs of the same workflow on the same
   * task, sharing a groupId. Variant A gets the task verbatim; B and C get a
   * fixed one-line approach hint appended to the *task input* (not the step
   * template), so diversification works with any workflow. The normal queue
   * applies — with maxParallel=2 a third variant simply waits.
   */
  startVariants(workflow: WorkflowDef, input: StartRunInput, count: number): RunRecord[] {
    const groupId = randomUUID();
    return VARIANT_LETTERS.slice(0, Math.min(Math.max(count, 1), VARIANT_LETTERS.length)).map(
      (variant) => {
        const hint = VARIANT_HINTS[variant];
        const task = hint ? `${input.task}\n\n${hint}` : input.task;
        return this.startRun(workflow, { ...input, task, worktree: undefined }, { groupId, variant });
      },
    );
  }

  /**
   * Slots this manager holds against the workspace-wide cap. `waiting` runs
   * don't hold a slot (#347): an idle claude process costs memory but no
   * tokens, queued work progressing matters more, and the idle timeout already
   * bounds how long a session can sit open. Because the exemption lives HERE —
   * in the count, not in any acquire path — a message into a `waiting` run
   * (sendMessage) resumes it immediately even when that momentarily exceeds
   * `maxParallel`, including when other projects saturate the cap.
   */
  private busySlots(): number {
    const ordinaryWaiting = this.waiting.size - this.monitoring.size;
    const exemptMonitoring = Math.min(this.monitoring.size, this.semaphore.maxMonitoringSessions());
    return this.active.size + this.starting.size - ordinaryWaiting - exemptMonitoring;
  }

  /** Epoch ms of this manager's oldest queued run (the semaphore's fairness
   *  key when a freed slot is broadcast), or null when nothing is queued.
   *  `queue` is FIFO — `startRun` pushes and `recover()` re-queues by
   *  `createdAt` — so the head is the oldest. */
  private oldestQueuedAt(): number | null {
    const head = this.queue[0];
    if (!head) return null;
    const createdAt = this.store.getRun(head)?.createdAt;
    const ms = createdAt ? Date.parse(createdAt) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  /**
   * A slot this manager held just came free. Pump the whole WORKSPACE, not
   * just this manager: `maxParallel` is counted across every project, so the
   * run that should take the slot is the workspace's oldest queued one — which
   * usually sits in another project's queue. Pumping only `this` is what left
   * a queued run in project B stuck at `queued` while project A's runs came
   * and went. `release()` pumps this manager too, so it replaces the local
   * `pump()` at every slot-freeing transition.
   */
  private releaseSlot(): void {
    void this.semaphore.release();
  }

  /**
   * Start queued runs while parallel slots are free. A run starts only under
   * BOTH ceilings: the WORKSPACE `resources.maxParallel` (default 2, counted
   * across every manager — spec 2026-07-20, step 2.5) AND this project's own
   * per-project `maxParallel` when the registry sets one (spec 2026-07-22,
   * inherits the workspace cap when unset). Legacy per-repo `maxParallel` keys
   * are ignored. A non-git directory degrades to 1 sequential run in the repo
   * root (spec 006 degradation rule), which is always the tighter bound.
   */
  private async pump(): Promise<void> {
    this.reconcileMonitoringWakeTimers();
    // A pump requested while one is in flight can't just be dropped: the
    // in-flight pass may already have read capacity (it awaits `getRepoInfo`
    // before the first check), so a slot freed in that window would be lost
    // until the next unrelated event. Re-run the sweep instead.
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const repo = await getRepoInfo(this.repoRoot);
        const maxParallel = this.semaphore.maxParallel();
        // Per-project ceiling (spec 2026-07-22-per-project-concurrency): this
        // project never runs more than its own configured `maxParallel`; absent
        // an override it equals the workspace cap, so behavior is unchanged.
        const projectMax = this.semaphore.projectMaxParallel(this.repoRoot);
        // `waiting` runs don't hold a slot (#347) — see busySlots(). The check
        // below is the only slot gate: resumes never pass through it. A run
        // starts only under BOTH the workspace cap and this project's ceiling.
        const capacity = () =>
          this.semaphore.busy() < maxParallel &&
          this.busySlots() < projectMax &&
          (repo !== null || this.busySlots() < 1);
        while (this.queue.length > 0 && capacity()) {
          const runId = this.queue.shift();
          if (!runId) break;
          const job = this.pendingJobs.get(runId);
          const continuation = this.pendingContinuations.get(runId);
          this.pendingJobs.delete(runId);
          this.pendingContinuations.delete(runId);
          if (!job && !continuation) continue;
          this.starting.add(runId);
          if (continuation) {
            const hydrated = this.hydrateQueuedContinuation(runId, continuation);
            void this.runContinuation(
              runId,
              hydrated.stepId,
              hydrated.sessionId,
              hydrated.backend,
              hydrated.prompt,
              hydrated.images,
              hydrated.persistedImages,
              hydrated.persistedAttachments,
            ).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              this.store.updateRun(runId, {
                status: 'failed',
                error: `continue crashed: ${message}`,
                finishedAt: new Date().toISOString(),
              });
              this.starting.delete(runId);
              this.dropActive(runId);
            });
            continue;
          }
          if (!job) continue;
          // Rebuild the prompt from the store at the last instant (#472), so an edit
          // or a stacked message that landed while the run waited is honored. Entered
          // in the same synchronous tick as the `pendingJobs.delete` above, so no
          // handler can observe a half-dequeued run.
          const input = this.hydrateQueuedInput(runId, job.input);
          void this.execute(runId, job.workflow, input).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.store.updateRun(runId, {
              status: 'failed',
              error: `engine crashed: ${message}`,
              finishedAt: new Date().toISOString(),
            });
            const state = this.active.get(runId);
            if (state) {
              this.clearIdleTimer(state);
              this.clearAutosaveTimer(state);
            }
            this.starting.delete(runId);
            this.dropActive(runId);
          });
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Startup recovery (#367) — re-adopt runs that were live when the previous
   * cezar process exited (requires the store opened with `keepLive`):
   *  - `queued`  → back into the queue (FIFO by createdAt), from the persisted
   *    workflowDef (or the catalog by name for older records);
   *  - `waiting` → the turn was over and the ball was in the user's court —
   *    settle exactly like a closed session (review/done, Continue still works);
   *  - `running` → mark interrupted, then immediately resume the last agent
   *    session via the Continue path, pointing the agent at its handoff file.
   * Call once, before the server starts taking requests.
   */
  async recover(): Promise<void> {
    const live = this.store
      .listRuns()
      .filter((r) => ['queued', 'waiting', 'running'].includes(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const run of live) {
      if (run.status === 'queued') {
        // A second restart can find a continuation that the first restart put
        // behind a capacity gate. Its executable details are process-local,
        // but the queued continue step and preceding provider session are
        // durable, so reconstruct that job before considering workflow revival.
        const queuedContinuation = [...run.steps]
          .reverse()
          .find((step) => step.status === 'pending' && step.id.startsWith('continue-'));
        const sessionStep = queuedContinuation
          ? [...run.steps]
              .reverse()
              .find((step) => step.id !== queuedContinuation.id && step.sessionId)
          : undefined;
        if (queuedContinuation && sessionStep?.sessionId) {
          const backend = run.runner ?? 'claude';
          const sessionBackend = sessionStep.backend ?? backend;
          this.pendingContinuations.set(run.id, {
            stepId: queuedContinuation.id,
            sessionId: sessionBackend === backend ? sessionStep.sessionId : undefined,
            backend,
            prompt: RESTART_CONTINUATION_PROMPT,
            images: [],
          });
          this.queue.push(run.id);
          this.store.appendEvent(run.id, {
            type: 'lifecycle',
            message: 'cezar restarted — interrupted continuation re-queued',
          });
          continue;
        }
        const workflow = await this.reviveWorkflow(run);
        if (workflow) {
          // Re-apply the inbox ceiling (#471). `execute()` gates again at spawn time, so the
          // agent is safe either way — but a run queued while the inbox was on and recovered
          // after it was switched off would otherwise keep echoing `generateFollowups: true`
          // on a run that demonstrably produced none. Normalize the record, the way startRun
          // does, so the stored answer matches what actually happens.
          const generateFollowups = followupsEnabled() ? run.generateFollowups : false;
          if (generateFollowups !== run.generateFollowups) {
            this.store.updateRun(run.id, { generateFollowups });
          }
          this.pendingJobs.set(run.id, {
            workflow,
            // Folded through the same helper `pump()` uses (#472) so a restart
            // carries the stack. Idempotent: hydration always composes from
            // `run.task` + the stack, never from an already-folded `input.task`,
            // so re-hydrating at dequeue yields the same string, not a doubled one.
            input: this.hydrateQueuedInput(run.id, {
              task: run.task,
              model: run.model,
              runner: run.runner,
              generateFollowups,
              // Re-thread autonomy (#489): the rebuilt input feeds `execute`,
              // whose mid-run auto-nudge reads `input.autonomous`. Without this a
              // recovered queued autonomous run would run non-autonomously (no
              // auto-nudge) and later wrongly park at `review`.
              autonomous: run.autonomous,
              // Preserve an explicit worktree opt-out across a queued restart.
              // Missing on older records means the default isolated mode.
              worktree: run.worktree,
            }),
          });
          this.queue.push(run.id);
          this.store.appendEvent(run.id, { type: 'lifecycle', message: 'cezar restarted — task re-queued' });
        } else {
          this.store.updateRun(run.id, {
            status: 'failed',
            error: 'interrupted — workflow definition not recoverable after a restart',
            finishedAt: new Date().toISOString(),
          });
          this.store.appendEvent(run.id, {
            type: 'lifecycle',
            message: 'cezar restarted — workflow definition not recoverable, task failed',
          });
        }
        continue;
      }
      if (run.status === 'waiting') {
        for (const step of run.steps) {
          if (step.status === 'waiting' || step.status === 'running') {
            this.store.updateStep(run.id, step.id, { status: 'done', finishedAt: new Date().toISOString() });
          }
        }
        this.store.appendEvent(run.id, {
          type: 'lifecycle',
          message: 'cezar restarted — the open session was settled',
        });
        await this.settleSuccess(run.id);
        continue;
      }
      // `running`: the process died mid-turn. Mark it interrupted (the state
      // continueRun expects), then pick the work back up from the last session.
      const finishedAt = new Date().toISOString();
      for (const step of run.steps) {
        if (step.status === 'running' || step.status === 'waiting') {
          this.store.updateStep(run.id, step.id, { status: 'failed', finishedAt });
        }
      }
      this.store.updateRun(run.id, {
        status: 'failed',
        error: 'interrupted — cezar process exited during the run',
        finishedAt,
        currentStepId: undefined,
      });
      const resumed = this.continueRun(
        run.id,
        {
          text: RESTART_CONTINUATION_PROMPT,
        },
        true,
      );
      this.store.appendEvent(run.id, {
        type: 'lifecycle',
        message: resumed.ok
          ? 'cezar restarted — resuming the interrupted task from its last session'
          : `cezar restarted — could not resume the interrupted task (${resumed.error ?? 'unknown'})`,
      });
    }
    void this.pump();
  }

  /** The persisted definition when it looks sane, else the catalog by name. */
  private async reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null> {
    // "Looks sane" is the STORE's job now: it parses `workflowDef` against the definition schema
    // and `.catch`es a def that no longer fits to `undefined`, so anything present here already
    // has the `steps` array the old inline `Array.isArray` check was asking for.
    const def = run.workflowDef;
    if (def) return def;
    const { workflows } = await loadWorkflows(this.repoRoot);
    return workflows.find((w) => w.name === run.workflow) ?? null;
  }

  /** Remove a run from the live registries — keeps `waiting ⊆ active`. */
  private dropActive(runId: string): void {
    const state = this.active.get(runId);
    state?.releaseRepoRoot?.();
    if (state) state.releaseRepoRoot = undefined;
    this.waiting.delete(runId);
    this.monitoring.delete(runId);
    if (state) this.clearMonitoringWakeTimer(state, runId);
    this.active.delete(runId);
    this.memoryPausing.delete(runId);
    this.lastNamerKey.delete(runId);
    // The run's slot is gone from busySlots() as of the deletes above — hand it
    // to the workspace's oldest queued run, in ANY project. Every terminal path
    // funnels through here, so this one call covers them all.
    this.releaseSlot();
    // A run leaving the active registry is a terminal transition (done/review/
    // failed/cancelled) — the one moment the finished-worktree count can grow.
    // Enforce count-based retention (#483) here so a single hook covers every
    // terminal path. Fire-and-forget: retention must never delay or throw into
    // the lifecycle.
    void this.enforceRetention();
  }

  /** Reclaim finished worktrees beyond the keep-limit (#483) — directory only,
   *  `cez/<id8>` branch kept. Best-effort; a failure never affects run
   *  lifecycle. `review`/live runs are excluded by the selector. */
  private async enforceRetention(): Promise<void> {
    try {
      const keep = await resolveWorktreeRetention(this.repoRoot);
      await reclaimWorktrees(this.repoRoot, this.store, keep);
    } catch {
      // retention is best-effort; swallow so terminal transitions never break.
    }
  }

  /** Last live-refresh namer inputs per run — unchanged inputs skip the call. */
  private lastNamerKey = new Map<string, string>();

  /**
   * Acquire the one-at-a-time lease for runs executing in `repoRoot`.
   *
   * A lease waiter is idle, so it parks in `waiting` and gives its
   * `maxParallel` slot back (the #347 rule): isolated worktrees keep using
   * every configured slot while root runs line up. The store status stays
   * `running` — only the queue's busy count changes, so the GUI never shows a
   * lease-blocked run as awaiting user input.
   *
   * The lease is held for the run's whole lifetime, including the idle
   * `waiting` parks between agent turns. A parked session is still live and
   * writes to the working tree the moment it resumes, so handing the tree to
   * another run there would reintroduce the concurrent-edit bug (#438) this
   * lease exists to prevent.
   *
   * Returns false when the run was cancelled while waiting: the lease was
   * never granted and the caller must not touch the working tree.
   */
  private async acquireRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    // `cancel()` can land between the run going `running` and reaching here,
    // while `interrupt` is still the default no-op — never enter the chain.
    if (state.cancelled) return false;
    const previous = this.repoRootTail;
    let release: () => void = () => undefined;
    this.repoRootTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Until `previous` resolves this run does not own the tree yet, so a drop
    // during the wait must not hand the tree to the next waiter — chain our
    // release behind `previous` instead of resolving the tail early.
    state.releaseRepoRoot = () => {
      void previous.then(release);
    };
    let abort: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve;
    });
    const parked = state.interrupt;
    state.interrupt = () => {
      parked();
      abort();
    };
    this.waiting.add(runId);
    this.releaseSlot();
    try {
      await Promise.race([previous, cancelled]);
    } finally {
      state.interrupt = parked;
      this.waiting.delete(runId);
    }
    if (state.cancelled) return false;
    state.releaseRepoRoot = release;
    return true;
  }

  cancel(runId: string): boolean {
    // Still waiting in the queue: just drop it there.
    const queuedAt = this.queue.indexOf(runId);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      this.pendingJobs.delete(runId);
      this.pendingContinuations.delete(runId);
      this.store.updateRun(runId, { status: 'cancelled', finishedAt: new Date().toISOString() });
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
      return true;
    }
    const state = this.active.get(runId);
    if (!state) return false;
    state.cancelled = true;
    this.clearIdleTimer(state);
    state.interrupt();
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId) || this.starting.has(runId) || this.queue.includes(runId);
  }

  /**
   * Fold a queued run's persisted prompt — `run.task` plus everything stacked
   * onto it (#472) — into the job input that is about to execute.
   *
   * Called from `pump()` immediately before `execute()`, which makes the RECORD
   * the single source of truth for a queued run's prompt. Before this, the
   * executing copy lived in `pendingJobs` (memory) while the record held a
   * second one, so an edit that PATCHed the record silently did nothing until a
   * restart. `recover()` rebuilds through the same helper, so both paths agree.
   *
   * **Read-only, and that is load-bearing.** It composes into the in-memory
   * `input` and never writes the folded string back to `RunRecord.task`; the
   * task and its stack stay separate on disk for the life of the run. Writing
   * back would re-append the whole stack on every recovery and compound without
   * bound — asserted directly by a test.
   */
  private hydrateQueuedInput(runId: string, input: StartRunInput): StartRunInput {
    const run = this.store.getRun(runId);
    if (!run) return input;
    const stack = run.queuedMessages ?? [];

    const task = [run.task, ...stack.map((m) => m.text)]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');

    // Keep the original in-memory blocks for a live process (including the
    // best-effort case where persistence failed). Recovery has no such copy,
    // so rebuild it from the durable task-image URLs.
    const images = input.images?.length
      ? input.images
      : this.readPersistedImages(runId, run.taskImages ?? [], 'task').blocks;
    const stackedImages = this.readPersistedImages(
      runId,
      stack.flatMap((m) => m.images ?? []),
      'queued',
    ).blocks;

    return {
      ...input,
      task,
      ...(images.length ? { images } : { images: undefined }),
      ...(stackedImages.length ? { stackedImages } : { stackedImages: undefined }),
    };
  }

  /** Apply edits and messages made while a restart continuation waits for
   * capacity. The durable record remains the source of truth, just as it is for
   * an ordinary queued workflow (#472), so a second restart reconstructs and
   * hydrates the same amendments instead of dropping them. */
  private hydrateQueuedContinuation(
    runId: string,
    continuation: PendingContinuation,
  ): PendingContinuation & {
    persistedImages: ContentBlock[];
    persistedAttachments: PersistedAttachment[];
  } {
    const run = this.store.getRun(runId);
    if (!run) {
      return { ...continuation, persistedImages: [], persistedAttachments: [] };
    }
    const stack = run.queuedMessages ?? [];
    const amendedTask = [run.task, ...stack.map((message) => message.text)]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');
    const prompt = amendedTask
      ? `${continuation.prompt}\n\nCurrent task and queued updates:\n\n${amendedTask}`
      : continuation.prompt;
    const persisted = this.readPersistedImages(
      runId,
      stack.flatMap((message) => message.images ?? []),
      'queued',
    );
    return {
      ...continuation,
      prompt,
      persistedImages: persisted.blocks,
      persistedAttachments: persisted.attachments,
    };
  }

  private readPersistedImages(
    runId: string,
    urls: string[],
    kind: 'task' | 'queued',
  ): PersistedImages {
    const blocks: ContentBlock[] = [];
    const attachments: PersistedAttachment[] = [];
    for (const url of urls) {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      const path = join(this.dataDir, 'runs', `${runId}-images`, name);
      try {
        const data = readFileSync(path);
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaTypeFor(name), data: data.toString('base64') },
        });
        attachments.push({ name, url, path });
      } catch {
        // Degrade, never fail the boot (AGENTS.md): the user deleted `.ai/cezar/`
        // or the file is unreadable — start with the text and say which image went.
        this.store.appendEvent(runId, {
          type: 'note',
          message: `${kind} attachment ${name} could not be read — starting without it`,
        });
      }
    }
    return { blocks, attachments };
  }

  /**
   * Still waiting for a slot? Checked against the engine's own queue rather than
   * the record's `status` (#472): the record is written by `execute()` a tick
   * after `pump()` dequeues, so a status read can see `queued` for a run that has
   * already started. The pending maps are deleted synchronously at dequeue, so
   * they are the authoritative answer for "can this prompt still be amended".
   */
  private isQueued(runId: string): boolean {
    return this.pendingJobs.has(runId) || this.pendingContinuations.has(runId);
  }

  /** Split `ContentBlock[]` into the persisted shape a stacked message holds. */
  private toQueuedMessage(runId: string, content: ContentBlock[]): QueuedMessage {
    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const images = content
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, b.source.media_type, b.source.data, 'pasted'))
      .filter((saved): saved is PersistedAttachment => saved !== null)
      .map((saved) => saved.url);
    return {
      id: randomUUID(),
      text,
      ...(images.length ? { images } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Append a prompt message onto a still-queued run (#472). Returns the stored
   * entry, or null when the run has already started — the caller then falls
   * through to `deferMessage`.
   */
  enqueueMessage(runId: string, content: ContentBlock[]): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.store.getRun(runId);
    if (!run) return null;
    const message = this.toQueuedMessage(runId, content);
    this.store.updateRun(runId, { queuedMessages: [...(run.queuedMessages ?? []), message] });
    return message;
  }

  /** Edit a stacked message in place. Omitted fields retain their current value. */
  editQueuedMessage(
    runId: string,
    msgId: string,
    edit: { text?: string; images?: ContentBlock[] },
  ): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return null;
    const at = stack.findIndex((m) => m.id === msgId);
    if (at < 0) return null;
    const current = stack[at]!;
    const replacementImages = edit.images === undefined
      ? current.images
      : this.toQueuedMessage(runId, edit.images).images;
    const replacement: QueuedMessage = {
      id: msgId,
      text: edit.text ?? current.text,
      ...(replacementImages?.length ? { images: replacementImages } : {}),
      createdAt: current.createdAt,
    };
    const next = [...stack];
    next[at] = replacement;
    this.store.updateRun(runId, { queuedMessages: next });
    // Images the edit dropped are now orphans.
    this.dropOrphanImages(runId, stack[at]!.images ?? [], next);
    return replacement;
  }

  /** Remove a stacked message and its now-orphaned attachments. */
  removeQueuedMessage(runId: string, msgId: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return false;
    const target = stack.find((m) => m.id === msgId);
    if (!target) return false;
    const next = stack.filter((m) => m.id !== msgId);
    this.store.updateRun(runId, { queuedMessages: next });
    this.dropOrphanImages(runId, target.images ?? [], next);
    return true;
  }

  /**
   * Delete image files no longer referenced by anything (#472). Best effort — a
   * leftover file is harmless and goes with the run. Never touches a URL still
   * referenced by another stacked entry or by the initial prompt's `taskImages`.
   */
  private dropOrphanImages(runId: string, candidates: string[], stack: QueuedMessage[]): void {
    if (!candidates.length) return;
    const run = this.store.getRun(runId);
    const referenced = new Set([
      ...(run?.taskImages ?? []),
      ...stack.flatMap((m) => m.images ?? []),
    ]);
    for (const url of candidates) {
      if (referenced.has(url)) continue;
      const name = url.split('/').pop();
      // Defend the join against a crafted URL: only a bare file name may be deleted.
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      try {
        rmSync(join(this.dataDir, 'runs', `${runId}-images`, name), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Edit the initial prompt of a still-queued run (#472). Re-derives the
   * heuristic title and the PR/issue chips, but never re-runs the LLM namer —
   * it already fired at creation and a second model call per edit is unjustified.
   */
  editTask(runId: string, task: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.store.getRun(runId);
    if (!run) return false;
    const workflow = this.pendingJobs.get(runId)?.workflow;
    const skillHint = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(task), skillHint);
    // Hand-edited titles always win (#389): `user` beats the heuristic, and a
    // `marker` title the agent declared beats it too.
    const keepTitle = run.titleOrigin === 'user' || run.titleOrigin === 'marker';
    this.store.updateRun(runId, {
      task,
      ...(keepTitle || !workflow ? {} : { title: makeRunTitle(task, workflow) }),
      ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
      ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
    });
    return true;
  }

  /**
   * Buffer a message that arrived in the gap between dequeue and session-open
   * (#472). `pump()` has already folded the stack and `execute()` is spawning the
   * backend, so there is nothing left to amend and no session to deliver into —
   * without this rung the message would 409, a genuinely dropped message in the
   * feature built to stop dropping them. Flushed as an ordinary follow-up turn
   * the instant the session opens; dropped if the run never starts, which the
   * existing error path already surfaces.
   *
   * The buffer lives on the manager rather than the `ActiveRun` because the
   * `ActiveRun` does not exist yet for part of this window.
   */
  deferMessage(runId: string, content: ContentBlock[]): boolean {
    // The window spans two sub-states: `starting` (no `ActiveRun` yet) and the
    // longer stretch where the `ActiveRun` exists but the backend is still being
    // spawned. `execute()` deletes the run from `starting` as soon as it builds
    // the state — seconds before the session opens — so checking `starting`
    // alone would reopen exactly the drop this rung exists to close.
    const state = this.active.get(runId);
    const startingUp = this.starting.has(runId) || (state !== undefined && !state.sessionEverOpened && !state.cancelled);
    if (!startingUp) return false;
    const pending = this.deferredMessages.get(runId) ?? [];
    pending.push(content);
    this.deferredMessages.set(runId, pending);
    return true;
  }

  /** Deliver anything `deferMessage` buffered, once the session is live. */
  private flushDeferred(runId: string): void {
    const pending = this.deferredMessages.get(runId);
    if (!pending?.length) return;
    // Re-buffer whatever the session refused rather than dropping it. `sendMessage`
    // answers false when the session is not open yet — and silently losing a message
    // here would be precisely the failure `deferMessage` exists to prevent. Anything
    // left over is retried by the next session that opens on this run.
    const unsent = pending.filter((content) => !this.sendMessage(runId, content));
    if (unsent.length) this.deferredMessages.set(runId, unsent);
    else this.deferredMessages.delete(runId);
  }

  /**
   * Deliver a user message into the run's live claude session (mid-turn or
   * while `waiting`). Returns false when there is no open session — the GUI
   * then offers "Continue" instead.
   */
  sendMessage(runId: string, content: ContentBlock[]): boolean {
    const delivered = this.deliverMessage(runId, content, true);
    if (delivered) {
      const state = this.active.get(runId);
      if (state) state.monitoringWakeups = 0;
      this.store.updateRun(runId, { monitoringWakeCapReached: undefined });
    }
    return delivered;
  }

  /** Shared live-session delivery. Synthetic scheduler prompts reuse lifecycle
   * bookkeeping without masquerading as user-authored transcript messages. */
  private deliverMessage(runId: string, content: ContentBlock[], userAuthored: boolean): boolean {
    const state = this.active.get(runId);
    if (!state?.session?.open || state.cancelled) return false;

    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Persist the attached images so the thread can render them (not just count them) — the same
    // on-disk store + `/images/` route the agent's own screenshots use. `pasted` prefix marks
    // these as user attachments (vs. agent tool screenshots) on disk (#357).
    const persisted = userAuthored ? content
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, b.source.media_type, b.source.data, 'pasted'))
      .filter((saved): saved is PersistedAttachment => saved !== null) : [];
    const images = persisted.map((saved) => saved.url);
    if (userAuthored) {
      this.store.appendEvent(runId, {
        type: 'user-message',
        stepId: state.currentStepId,
        text,
        imageCount: content.filter((b) => b.type === 'image').length,
        images,
      });
    }

    // Tell the agent where the pasted files live on disk (#357): the base64 blocks below still
    // ride along so the model can *view* them, but a real path is what lets it *operate* on them
    // (save, `cp`, attach to a GitHub issue/PR) — and it's the only usable reference on backends
    // (codex, opencode) that drop image blocks entirely before reaching the model.
    const expanded = userAuthored ? expandRegistrySlashSkill(content, state.skills ?? []) : content;
    const deliverable = persisted.length ? [...expanded, pastedAttachmentsNote(persisted)] : expanded;
    const delivered = state.session.sendMessage(deliverable);
    if (delivered) {
      this.clearIdleTimer(state);
      this.clearMonitoringWakeTimer(state, runId);
      this.waiting.delete(runId); // resumed — the run counts against slots again
      this.monitoring.delete(runId);
      // Clear any `monitoring` activity — the agent is actively working again
      // (spec 2026-07-18-subagent-monitoring-status, #490).
      this.store.updateRun(runId, { status: 'running', activity: undefined });
      if (state.currentStepId) {
        this.store.updateStep(runId, state.currentStepId, { status: 'running' });
      }
    }
    return delivered;
  }

  /** Close the open session gracefully — the run then completes as `done`
   *  (or rests at `review` when the worktree holds changes, spec 009).
   *  On a run already resting at `review` (no session — the engine loop is
   *  over), "Finish" is the third review exit: accept the changes without a
   *  PR and flip straight to `done`. */
  finish(runId: string): boolean {
    const state = this.active.get(runId);
    if (state?.session?.open) {
      this.clearIdleTimer(state);
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'session closed by user' });
      state.session.end();
      return true;
    }
    const run = this.store.getRun(runId);
    if (run?.status === 'review' && !this.isActive(runId)) {
      this.store.updateRun(runId, { status: 'done' });
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'review accepted — finished without a PR' });
      return true;
    }
    return false;
  }

  /**
   * "Continue" (spec 003): reopen a finished run's claude session in-process
   * (`claude --resume <sessionId>`) as a new synthetic step. The session then
   * behaves exactly like an interactive step: `waiting` after each turn,
   * messages via sendMessage, closed by finish/idle/cancel.
   */
  continueRun(
    runId: string,
    opts: { text?: string; images?: ContentBlock[]; runner?: RunnerId; model?: string } = {},
    /** Restart recovery may discover several interrupted tasks at once. Those
     *  continuations are queued; an explicit user Continue remains immediate. */
    deferForCapacity = false,
  ): { ok: boolean; error?: string } {
    if (agentModelsLocked(this.repoRoot) && opts.model?.trim()) {
      return { ok: false, error: AGENT_MODELS_LOCKED_ERROR };
    }
    if (this.active.has(runId)) return { ok: false, error: 'run is still active' };
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    // `review` is continuable too — that's the "Send back" path (spec 009).
    if (!['done', 'failed', 'cancelled', 'review'].includes(run.status)) {
      return { ok: false, error: `cannot continue a ${run.status} run` };
    }
    const sessionStep = [...run.steps].reverse().find((s) => s.sessionId);
    if (!sessionStep?.sessionId) return { ok: false, error: 'no agent session to resume' };
    const targetRunner = opts.runner ?? run.runner ?? 'claude';
    // Session ids are provider-owned opaque values. New records carry explicit
    // affinity; for legacy records, the run's current runner is the conservative
    // owner until a continuation emits a new, attributed session id (#562).
    const sessionBackend = sessionStep.backend ?? run.runner ?? 'claude';
    const resume = sessionBackend === targetRunner;

    // Follow-up runner/model override (#401): the composer lets the user pick which backend and
    // model handle this continuation. Omitted → the run's current backend/model is kept
    // (backward compat). A provided choice is persisted BEFORE scheduling, so it becomes the
    // run's current backend — `runContinuation` reads it off the record, later continuations
    // default to it, and the header reflects the active engine. An empty model ('') clears the
    // pin, letting the runner pick the model (auto).
    if (opts.runner !== undefined || opts.model !== undefined) {
      // Guard the pairing before persisting anything: the model override applies to the runner
      // this continuation will actually use (`opts.runner ?? record.runner ?? 'claude'` — the
      // same resolution `runContinuation` reads off the record). A model that is recognizably
      // another runner's preset would corrupt the run; free-form/custom ids pass untouched.
      if (opts.model && modelConflictsWithRunner(opts.model, targetRunner)) {
        return { ok: false, error: `model '${opts.model}' is not a ${targetRunner} model` };
      }
      // A runner switch that carries NO explicit model must not leave the previous backend's pin
      // on the record: the guard above only sees `opts.model`, so without this an inherited
      // `opus` would survive a switch to codex and `runContinuation` would hand it to the codex
      // runner. Clearing (not rejecting) is right — the pin belonged to the old backend and is
      // meaningless for the new one, which is exactly what the composer already displays (auto).
      // Only a recognizably foreign preset is cleared; a free-form/custom id is left alone.
      const inheritedPinIsForeign =
        opts.model === undefined &&
        run.model !== undefined &&
        modelConflictsWithRunner(run.model, targetRunner);
      this.store.updateRun(runId, {
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        ...(opts.model !== undefined
          ? { model: opts.model === '' ? undefined : opts.model }
          : inheritedPinIsForeign
            ? { model: undefined }
            : {}),
      });
    }

    const continuations = run.steps.filter((s) => s.id.startsWith('continue-')).length;
    const stepId = `continue-${continuations + 1}`;
    this.store.addStep(runId, { id: stepId, name: 'Continue', kind: 'agent' });
    const prompt = opts.text?.trim() || 'Continue.';
    const images = opts.images ?? [];
    if (deferForCapacity) {
      this.pendingContinuations.set(runId, {
        stepId,
        sessionId: resume ? sessionStep.sessionId : undefined,
        backend: targetRunner,
        prompt,
        images,
      });
      this.queue.push(runId);
      this.store.updateRun(runId, {
        status: 'queued',
        error: undefined,
        finishedAt: undefined,
        currentStepId: undefined,
      });
      return { ok: true };
    }
    void this.runContinuation(
      runId,
      stepId,
      resume ? sessionStep.sessionId : undefined,
      targetRunner,
      prompt,
      images,
    ).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.store.updateRun(runId, {
          status: 'failed',
          error: `continue crashed: ${message}`,
          finishedAt: new Date().toISOString(),
        });
        this.dropActive(runId);
      },
    );
    return { ok: true };
  }

  private async runContinuation(
    runId: string,
    stepId: string,
    sessionId: string | undefined,
    backend: RunnerId,
    prompt: string,
    /** Screenshots pasted into the follow-up composer — delivered with the
     *  reopened session's opening message, exactly like a live-session
     *  message's attachments. */
    images: ContentBlock[] = [],
    /** Queued-message screenshots were persisted when they were enqueued and
     *  reconstructed at dequeue. Keep them separate from fresh `images` so
     *  opening a recovered continuation does not persist duplicate files. */
    persistedImages: ContentBlock[] = [],
    persistedAttachments: PersistedAttachment[] = [],
  ): Promise<void> {
    // Continuation runs in the task's worktree when it still exists (spec
    // 006) — the resumed session sees exactly what the original run left.
    // Retention (#483) may have reclaimed this run's worktree directory while
    // keeping its branch and worktreePath. Re-materialize it on resume and clear
    // the stamp so the session regains its isolated tree and the run is eligible
    // for retention again — otherwise it keeps a dir on disk while staying
    // invisible to the enforcer forever. Best-effort; falls back to repoRoot.
    await rematerializeReclaimedWorktree(this.repoRoot, this.store, runId);
    const record = this.store.getRun(runId);
    // The env is a live ceiling: a run created while the inbox was on must not keep writing
    // follow-ups after it is switched off.
    const generateFollowups = followupsEnabled() && record?.generateFollowups !== false;
    const cwd =
      record?.worktreePath && existsSync(record.worktreePath)
        ? record.worktreePath
        : this.repoRoot;
    const state: ActiveRun = { cancelled: false, interrupt: () => undefined, cwd };
    this.active.set(runId, state);
    this.starting.delete(runId);
    if (state.cwd === this.repoRoot) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: 'waiting for exclusive access to the repository working tree',
      });
      if (!(await this.acquireRepoRoot(runId, state))) {
        this.store.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          currentStepId: undefined,
        });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
        this.dropActive(runId);
        return;
      }
    }
    this.armAutosave(state);
    if (record) seedHandoffFile(this.dataDir, record); // idempotent — normally already there

    this.store.updateRun(runId, {
      status: 'running',
      error: undefined,
      finishedAt: undefined,
      currentStepId: stepId,
      activity: undefined, // resuming a monitoring run — it's actively working again (#490)
    });
    this.store.updateStep(runId, stepId, {
      status: 'running',
      iterations: 1,
      startedAt: new Date().toISOString(),
      sessionId,
      backend,
    });
    this.store.appendEvent(runId, { type: 'step-start', stepId, name: 'Continue', kind: 'agent', iteration: 1 });
    // Attachments pasted into the follow-up composer, on the same terms as a live-session
    // message (#357): persisted to the run's own image store so the thread renders the bubble's
    // images rather than a bare count, and handed to the agent BOTH as base64 blocks (so it can
    // view them) and as absolute paths appended to the prompt (so it can operate on them — and
    // because codex/opencode drop image blocks before they reach the model).
    const freshAttachments = images
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, b.source.media_type, b.source.data, 'pasted'))
      .filter((saved): saved is PersistedAttachment => saved !== null);
    const openingImages = [...images, ...persistedImages];
    const attachments = [...freshAttachments, ...persistedAttachments];
    this.store.appendEvent(runId, {
      type: 'user-message',
      stepId,
      text: prompt,
      imageCount: openingImages.filter((b) => b.type === 'image').length,
      ...(attachments.length ? { images: attachments.map((saved) => saved.url) } : {}),
    });

    let stepCost = 0;
    let turnText = '';
    let sessionError: string | undefined;
    const sink = this.makeUiSink(runId, stepId);
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'image') {
        const saved = this.persistImage(runId, event.mediaType, event.data);
        if (saved) this.store.appendEvent(runId, { type: 'image', stepId, ...saved });
        return;
      }
      if (event.type === 'text') {
        turnText = appendTurnText(turnText, event.text);
        const text = stripAskMarker(stripTaskMarkers(stripMonitoringMarker(stripDoneMarker(event.text))));
        if (text) this.store.appendEvent(runId, { type: 'text', text, stepId });
        return;
      }
      this.store.appendEvent(runId, { ...event, stepId });
      if (event.type === 'error') {
        sessionError ??= event.message;
        state.session?.interrupt();
        return;
      }
      if (sessionError) return;
      if (event.type === 'session') {
        this.store.updateStep(runId, stepId, { sessionId: event.sessionId, backend });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, stepId, { tokensUsed: event.tokensUsed });
      }
      if (event.type === 'cost') {
        stepCost += event.usd;
        this.store.updateStep(runId, stepId, { costUsd: stepCost });
      }
      if (event.type === 'turn-end') {
        // Belt-and-braces: v2 `turn.completed` already flushed the delta
        // coalescers; the v1 turn boundary flushes again (idempotent) so no
        // buffered delta can outlive its turn.
        sink.flushAll();
        void this.recordTurnEnd(runId, turnText); // titleSummary + diffStat (#389)
        const sessionOpen = !state.cancelled && state.session?.open;
        const done = sessionOpen && DONE_MARKER_RE.test(turnText.trimEnd());
        // `CEZ:ASK` → the user is genuinely blocked; wins over `CEZ:MONITORING`
        // (a pending question is always attention), loses to `CEZ:DONE` (#473).
        const ask = sessionOpen && !done ? parseAskMarker(turnText) : null;
        const monitoring =
          sessionOpen && !done && !ask && MONITORING_MARKER_RE.test(turnText.trimEnd());
        turnText = '';
        if (done) {
          // Goal achieved (agent contract, #347) — same as in runAgentStep.
          this.store.appendEvent(runId, { type: 'lifecycle', message: 'goal achieved — session closed' });
          appendHandoffHeartbeat(this.dataDir, runId, 'turn complete — goal achieved, session closed');
          state.session?.end();
          return;
        }
        if (sessionOpen) {
          // Autonomous (#autonomous): never hand the ball back to the user. Nudge the agent to
          // keep going (bounded by MAX_AUTO_CONTINUES) instead of parking at `waiting`.
          const autoContinued =
            state.autonomous &&
            (state.autoContinues ?? 0) < MAX_AUTO_CONTINUES &&
            !state.cancelled &&
            (() => {
              const sent = state.session?.sendMessage([{ type: 'text', text: AUTONOMOUS_NUDGE }]);
              if (!sent) return false;
              state.autoContinues = (state.autoContinues ?? 0) + 1;
              this.store.appendEvent(runId, {
                type: 'note',
                message: `autonomous — continuing without pausing (${state.autoContinues}/${MAX_AUTO_CONTINUES})`,
              });
              return true;
            })();
          if (!autoContinued) {
            // `CEZ:ASK` → park `waiting` (attention) AND surface the structured
            // question as an ask card (#473). `CEZ:MONITORING` → non-attention
            // `running`/`activity:'monitoring'` (#490). Both share the waiting
            // lifecycle (free the slot, keep the idle timer); the autonomous
            // nudge above still wins over either.
            if (ask) emitAskRequested(sink, ask);
            if (monitoring) {
              this.store.updateRun(runId, { status: 'running', activity: 'monitoring' });
              this.store.updateStep(runId, stepId, { status: 'running' });
              this.monitoring.add(runId);
              this.clearIdleTimer(state);
              this.armMonitoringWakeTimer(runId, state);
            } else {
              this.store.updateRun(runId, { status: 'waiting', activity: undefined });
              this.store.updateStep(runId, stepId, { status: 'waiting' });
              this.monitoring.delete(runId);
              this.clearMonitoringWakeTimer(state, runId);
            }
            this.waiting.add(runId);
            if (!monitoring) this.armIdleTimer(runId, state);
            this.releaseSlot();
          }
        }
        appendHandoffHeartbeat(
          this.dataDir,
          runId,
          `turn complete — status=${monitoring ? 'monitoring' : sessionOpen ? 'waiting' : 'running'}`,
        );
      }
    };

    // Backend + model come off the record: the run's current backend by default, or the
    // follow-up override that `continueRun` persisted before scheduling (#401).
    const continueBackend = backend;
    // Apply the SAME canonical-identity gate the first spawn applies (#405, review M1).
    // A follow-up may switch both runner and model (#401), so without this the record keeps
    // asserting the identity the run STARTED with while a different model serves the turn —
    // the exact defect this PR exists to remove — and the raw record string reaches the CLI
    // in the un-normalised wire form the first step already converted away (`anthropic/opus`
    // instead of `opus`). Fail loud here too rather than let the backend pick a default.
    let continueModel: string | undefined;
    try {
      const normalized = normalizeModelForBackend(
        continueBackend,
        agentModelsLocked(this.repoRoot) ? undefined : record?.model,
        { configuredProvider: await configuredModelProvider(continueBackend, state.cwd) },
      );
      continueModel = normalized?.backendModel;
      this.store.updateRun(runId, {
        modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined,
      });
    } catch (err) {
      if (!(err instanceof ModelIdentityError)) throw err;
      const failedAt = new Date().toISOString();
      sink.sessionEnded('error', err.message);
      this.store.updateStep(runId, stepId, {
        status: 'failed',
        error: err.message,
        finishedAt: failedAt,
      });
      this.store.updateRun(runId, {
        status: 'failed',
        error: `continue failed: ${err.message}`,
        finishedAt: failedAt,
        currentStepId: undefined,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: `continue failed — ${err.message}`,
      });
      this.dropActive(runId);
      return;
    }
    const runner = createRunner(continueBackend);
    state.currentStepId = stepId;
    this.beginUsageInvocation(runId, state, stepId);
    const session = runner.startSession(
      {
        // The Continue step is a fresh agent session on the same run — the
        // run's extra system prompt (already resolved at execute time and
        // echoed on the record) rides along with the handoff contract.
        systemPrompt: composeSystemPrompt(
          record?.systemPrompt,
          generateFollowups ? HANDOFF_INSTRUCTIONS : HANDOFF_ONLY_INSTRUCTIONS,
        ),
        userPrompt: attachments.length ? `${prompt}\n\n${pastedAttachmentsText(attachments)}` : prompt,
        ...(openingImages.length ? { images: openingImages } : {}),
        cwd: state.cwd,
        allowedTools: DEFAULT_ALLOWED_TOOLS,
        additionalDirectories: [join(this.dataDir, 'runs')],
        env: this.agentEnv(runId, generateFollowups),
        model: continueModel,
        sessionId,
        resume: sessionId !== undefined,
        timeoutMs: 0,
      },
      onEvent,
      { onUiEvent: (event) => this.handleRunnerUiEvent(runId, state, sink, event) },
    );
    state.session = session;
    state.sessionEverOpened = true;
    this.flushDeferred(runId);
    state.interrupt = () => session.interrupt();
    if (session.pid !== undefined) registerRunProcess(runId, session.pid);

    const finishedAt = () => new Date().toISOString();
    try {
      await session.result;
      if (sessionError) throw new Error(sessionError);
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      if (state.cancelled) {
        this.store.updateStep(runId, stepId, { status: 'cancelled', finishedAt: finishedAt() });
        this.store.updateRun(runId, { status: 'cancelled', finishedAt: finishedAt(), currentStepId: undefined });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=cancelled`);
      } else {
        this.store.updateStep(runId, stepId, { status: 'done', finishedAt: finishedAt() });
        this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'done' });
        await this.settleSuccess(runId);
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=done`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink.sessionEnded('error', message);
      this.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt: finishedAt() });
      appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=failed`);
      this.store.updateRun(runId, {
        status: 'failed',
        error: `continue failed: ${message}`,
        finishedAt: finishedAt(),
        currentStepId: undefined,
      });
      this.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${message}` });
    } finally {
      this.recordUsagePeaks(runId);
      this.clearIdleTimer(state);
      this.clearAutosaveTimer(state);
      if (state.cwd !== this.repoRoot) await autosaveCommit(state.cwd, 'turn end');
      this.dropActive(runId);
    }
  }

  // ---- execution -----------------------------------------------------------

  private async execute(runId: string, workflow: WorkflowDef, input: StartRunInput): Promise<void> {
    const state: ActiveRun = {
      cancelled: false,
      interrupt: () => undefined,
      cwd: this.repoRoot,
      autonomous: input.autonomous === true,
      autoContinues: 0,
    };
    this.active.set(runId, state);
    this.starting.delete(runId);
    const emit = (event: { type: string; stepId?: string; [k: string]: unknown }) =>
      this.store.appendEvent(runId, event);

    // Resolve the agent backend for this run: the task choice (GUI) wins over
    // the config default. Per-step `runner` can still override it below.
    const config = await loadConfig(this.repoRoot);
    const taskBackend: RunnerId = input.runner ?? config.defaultRunner;
    // Extra system prompt (R2 2.3): POST override > config default; echoed on
    // the record so the UI/API can show what the run actually used.
    const extraSystemPrompt = resolveExtraSystemPrompt(input.systemPrompt, config.systemPrompt);
    // Canonical provider/model identity (#405) — the normalised `provider/model`
    // the task ran with, persisted for cost attribution / reproducible replay
    // beside the free-text `model`. Best-effort here (a per-step `runner`/`model`
    // can still override below); the authoritative fail-loud gate is at spawn.
    let modelIdentity: string | undefined;
    try {
      const normalized = normalizeModelForBackend(
        taskBackend,
        agentModelsLocked(this.repoRoot) ? undefined : input.model,
        { configuredProvider: await configuredModelProvider(taskBackend, this.repoRoot) },
      );
      modelIdentity = normalized ? formatModelIdentity(normalized.identity) : undefined;
    } catch {
      // An unresolvable task-level model surfaces loudly at the step below; the
      // metadata echo stays absent rather than guessing.
    }
    this.store.updateRun(runId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      runner: taskBackend,
      systemPrompt: extraSystemPrompt,
      modelIdentity,
    });
    emit({ type: 'lifecycle', message: `run started — workflow "${workflow.name}" (runner: ${taskBackend})` });

    // Worktree per task (spec 006): the agent works on its own branch in
    // `.ai/cezar/worktrees/<id>`, never in the user's working tree. A Git task
    // that requests isolation fails closed if the worktree cannot be
    // established; only explicit opt-out and non-Git modes run in place.
    const repo = await getRepoInfo(this.repoRoot);
    if (repo && input.worktree === false) {
      // Composer opt-out: run in the repo working tree, no branch/worktree. The
      // repository-root lease serializes these runs so workflows cannot overlap.
      // Pin the starting commit: the session's Changes and Commits views use it
      // as their stable lower bound while reading the current working copy.
      const startingCommit = await getHeadCommit(repo.root);
      if (startingCommit) this.store.updateRun(runId, { baseBranch: startingCommit });
      emit({ type: 'note', message: 'worktree off — running in the repo working tree' });
    } else if (repo) {
      emit({
        type: 'note',
        message: `worktree on — using an isolated task worktree (${input.worktree === true ? 'explicit request' : 'default'})`,
      });
      // Fork from the configured base branch (config.json `baseBranch`, e.g.
      // `develop`) — also the target of the eventual draft PR. Unresolvable
      // (typo, not fetched) → note + the currently checked-out branch.
      //
      // A task that already recorded a fork point keeps it: its worktree is
      // reused as-is, and re-resolving against a since-changed config would
      // silently re-anchor the `merge-base` every diff/shortstat is measured
      // from, shifting "what did this task change" under an existing task.
      const recorded = this.store.getRun(runId)?.baseBranch;
      let base = recorded ?? repo.branch;
      const configured = recorded ? undefined : config.baseBranch;
      if (configured) {
        const resolved = await resolveBaseRef(this.repoRoot, configured);
        if (resolved) {
          base = resolved;
        } else {
          emit({
            type: 'note',
            message: `configured base branch "${configured}" not found (locally or on origin) — using "${repo.branch}"`,
          });
        }
      }
      try {
        const wt = await createWorktree(this.repoRoot, runId, base);
        state.cwd = wt.path;
        this.store.updateRun(runId, {
          worktreePath: wt.path,
          branch: wt.branch,
          baseBranch: wt.baseBranch,
        });
        emit({ type: 'note', message: `worktree ready — branch ${wt.branch} (base ${wt.baseBranch})` });
        // Seed from this manager's project root: each multi-project context has
        // its own manager/repoRoot and must never copy another project's layer.
        const seededConfig = await seedAgentConfigLocalLayer(this.repoRoot, state.cwd).catch(() => []);
        if (seededConfig.length > 0) {
          emit({ type: 'note', message: `seeded personal agent config: ${seededConfig.join(', ')}` });
        }
        this.armAutosave(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const error = `worktree creation failed: ${message}`;
        emit({ type: 'note', message: `${error} — task stopped before workflow execution` });
        this.store.updateRun(runId, {
          status: 'failed',
          error,
          finishedAt: new Date().toISOString(),
          currentStepId: undefined,
        });
        emit({ type: 'lifecycle', message: `run failed — ${error}` });
        this.dropActive(runId);
        return;
      }
    } else {
      emit({ type: 'note', message: 'not a git repository — running in place, one task at a time' });
    }

    if (state.cwd === this.repoRoot) {
      emit({
        type: 'note',
        message: 'waiting for exclusive access to the repository working tree',
      });
      // A cancel during the wait leaves the lease ungranted; the step loop
      // below breaks on `cancelled` before touching the tree and settles the
      // run through the usual path.
      await this.acquireRepoRoot(runId, state);
    }

    // Handoff journal (spec 007) — seeded after the worktree exists so the
    // header can name the branch. Idempotent: an existing file stays as-is.
    const seeded = this.store.getRun(runId);
    if (seeded) seedHandoffFile(this.dataDir, seeded);

    const skills = await discoverSkills(this.repoRoot);
    state.skills = skills;
    const retriesUsed = new Map<string, number>();
    let checkFailure: string | null = null;
    let runError: string | null = null;
    // `startRun` already persisted task images so a queued bubble can render them
    // (#612). Reuse those files for the agent-facing path note instead of minting
    // duplicate pasted files when execution finally begins.
    let startAttachments: PersistedAttachment[] = (this.store.getRun(runId)?.taskImages ?? [])
      .map((url): PersistedAttachment | null => {
        const name = url.split('/').pop();
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
        const path = join(this.dataDir, 'runs', `${runId}-images`, name);
        return existsSync(path) ? { name, url, path } : null;
      })
      .filter((saved): saved is PersistedAttachment => saved !== null);
    // Task screenshots go with the FIRST agent step's opening message only —
    // later steps and retry loops run in fresh sessions without them. Stacked
    // attachments (#472) ride along too, but are NOT re-persisted above: they
    // already live on disk, and adding them to `taskImages` would both duplicate
    // the files and make the task bubble claim the stack's images as its own.
    let startImages =
      input.stackedImages?.length ? [...(input.images ?? []), ...input.stackedImages] : input.images;

    const lastAgentIdx = findLastAgentStepIndex(workflow);

    let i = 0;
    while (i < workflow.steps.length) {
      if (state.cancelled) break;
      const step = workflow.steps[i] as WorkflowStepDef;
      const kind = stepKind(step);
      const record = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
      const iteration = (record?.iterations ?? 0) + 1;

      this.store.updateRun(runId, { currentStepId: step.id });
      this.store.updateStep(runId, step.id, {
        status: 'running',
        iterations: iteration,
        startedAt: new Date().toISOString(),
        error: undefined,
      });
      emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });

      if (kind === 'agent') {
        // The last agent step of the workflow is interactive: after its turn
        // the session stays open for follow-ups until finish/idle/cancel.
        const interactive = i === lastAgentIdx && i === workflow.steps.length - 1;
        const failure = await this.runAgentStep(
          runId,
          state,
          step,
          input,
          skills,
          checkFailure,
          interactive,
          emit,
          startImages,
          taskBackend,
          extraSystemPrompt,
          chainStepNote(workflow.steps, i),
          startAttachments,
        );
        startImages = undefined;
        startAttachments = [];
        checkFailure = null;
        if (state.cancelled) break;
        if (failure) {
          this.finishStep(runId, step.id, 'failed', failure, emit);
          runError = `step "${step.id}" failed: ${failure}`;
          break;
        }
        this.finishStep(runId, step.id, 'done', undefined, emit);
        i++;
        continue;
      }

      const { ok, output } = await this.runCheckStep(state, step, emit);
      if (state.cancelled) break;
      if (ok) {
        this.finishStep(runId, step.id, 'done', undefined, emit);
        i++;
        continue;
      }

      const used = retriesUsed.get(step.id) ?? 0;
      if (step.onFail && used < step.onFail.max) {
        retriesUsed.set(step.id, used + 1);
        checkFailure = output;
        this.finishStep(runId, step.id, 'failed', 'check failed — looping back', emit);
        const retryIdx = workflow.steps.findIndex((s) => s.id === step.onFail?.retry);
        emit({
          type: 'note',
          stepId: step.id,
          message: `check failed — retrying from "${step.onFail.retry}" (attempt ${used + 1}/${step.onFail.max})`,
        });
        // Steps we're about to re-run go back to pending so the GUI rail
        // reads top-to-bottom truthfully.
        for (const s of workflow.steps.slice(retryIdx, i + 1)) {
          this.store.updateStep(runId, s.id, { status: 'pending' });
        }
        i = retryIdx;
        continue;
      }

      this.finishStep(runId, step.id, 'failed', `\`${step.command}\` exited non-zero`, emit);
      runError = `check "${step.id}" failed${step.onFail ? ` after ${used + 1} attempts` : ''}`;
      break;
    }

    // Final autosave: the branch always ends holding the finished state.
    this.clearAutosaveTimer(state);
    if (state.cwd !== this.repoRoot) await autosaveCommit(state.cwd, 'run finalize');

    const finishedAt = new Date().toISOString();
    if (state.cancelled) {
      const run = this.store.getRun(runId);
      for (const s of run?.steps ?? []) {
        if (s.status === 'running' || s.status === 'waiting') {
          this.store.updateStep(runId, s.id, { status: 'cancelled' });
        }
      }
      this.store.updateRun(runId, { status: 'cancelled', finishedAt, currentStepId: undefined });
      emit({ type: 'lifecycle', message: 'run cancelled' });
    } else if (runError) {
      this.store.updateRun(runId, { status: 'failed', error: runError, finishedAt, currentStepId: undefined });
      emit({ type: 'lifecycle', message: `run failed — ${runError}` });
    } else {
      await this.settleSuccess(runId);
    }
    this.clearIdleTimer(state);
    this.dropActive(runId);
  }

  /** Returns an error message, or null on success. */
  private async runAgentStep(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    input: StartRunInput,
    skills: Skill[],
    checkFailure: string | null,
    interactive: boolean,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    images: ContentBlock[] | undefined,
    taskBackend: RunnerId,
    extraSystemPrompt: string | undefined,
    /** The chain-boundary note for this step (#410), or undefined when the
     *  workflow has a single agent step and there is no boundary to explain. */
    chainNote: string | undefined,
    /** Pasted attachments already materialized to disk (#357) — their absolute
     *  paths are appended to `userPrompt` so the agent can operate on the
     *  real files, not just view the inline image blocks. */
    attachments: PersistedAttachment[] = [],
  ): Promise<string | null> {
    let systemPrompt: string | undefined;
    if (step.skill) {
      const skill = skills.find((s) => s.name === step.skill);
      if (skill) {
        // The body alone often does not identify the selected skill. Keep its
        // name and catalog description in the normalized runner payload so a
        // numeric task such as "432" still gives the model enough context to
        // describe the work — and therefore derive a useful title (#432).
        systemPrompt = skillSystemPrompt(skill);
        // Directory team skills (SKILL.md + references/) get materialized
        // into <cwd>/.claude/skills/<name>/ — the run's worktree when there
        // is one — so claude sees the companion files on disk; the shared
        // info/exclude keeps them out of git (and out of autosave commits).
        if (skill.source === 'team' && skill.team?.dir) {
          const seeded = await materializeSkillDir(state.cwd, skill).catch(() => false);
          if (seeded) {
            emit({
              type: 'note',
              stepId: step.id,
              message: `team skill "${skill.name}" materialized to .claude/skills/${skill.name}/`,
            });
          }
        }
      } else {
        emit({
          type: 'note',
          stepId: step.id,
          message: `skill "${step.skill}" not found in .ai/cezar/skills, .ai/skills or the team skills repo — running with the plain prompt`,
        });
      }
    }

    let userPrompt = applyTemplate(step.prompt ?? '{{task}}', input.task);
    if (chainNote) userPrompt = `${chainNote}\n\n---\n\n${userPrompt}`;
    if (checkFailure) {
      userPrompt += `\n\nA verification command failed after the previous attempt. Fix the cause. Failing output:\n\n${checkFailure}`;
    }
    if (images?.length) {
      emit({
        type: 'note',
        stepId: step.id,
        message: `${images.length} screenshot${images.length > 1 ? 's' : ''} attached to the task`,
      });
      // Point the agent at the on-disk files for the pasted subset (#357) — the
      // base64 blocks above still let it *view* the images; this is what lets it
      // *use* them as files (save, attach to an issue/PR, copy into the repo).
      if (attachments.length) userPrompt += `\n\n${pastedAttachmentsText(attachments)}`;
    }

    const sessionId = randomUUID();
    const backend = step.runner ?? taskBackend;
    this.store.updateStep(runId, step.id, { sessionId, backend });

    const stepRecord = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
    const startTokens = stepRecord?.tokensUsed ?? 0;
    let stepCost = stepRecord?.costUsd ?? 0;
    let turnText = '';
    let sessionError: string | undefined;
    const sink = this.makeUiSink(runId, step.id);
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'image') {
        const saved = this.persistImage(runId, event.mediaType, event.data);
        if (saved) emit({ type: 'image', stepId: step.id, ...saved });
        return;
      }
      if (event.type === 'text') {
        turnText = appendTurnText(turnText, event.text);
        const text = stripAskMarker(stripTaskMarkers(stripMonitoringMarker(stripDoneMarker(event.text))));
        if (text) emit({ type: 'text', text, stepId: step.id });
        return;
      }
      emit({ ...event, stepId: step.id });
      if (event.type === 'error') {
        sessionError ??= event.message;
        state.session?.interrupt();
        return;
      }
      if (sessionError) return;
      if (event.type === 'session') {
        // Codex/OpenCode mint their own session id — persist it so resume works.
        this.store.updateStep(runId, step.id, { sessionId: event.sessionId, backend });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, step.id, { tokensUsed: startTokens + event.tokensUsed });
      }
      if (event.type === 'cost') {
        stepCost += event.usd;
        this.store.updateStep(runId, step.id, { costUsd: stepCost });
      }
      if (event.type === 'turn-end') {
        // v2 `turn.completed` already flushed the coalescers; the v1 turn
        // boundary flushes again (idempotent) as a backstop.
        sink.flushAll();
        void this.recordTurnEnd(runId, turnText); // titleSummary + diffStat (#389)
        const sessionOpen = !state.cancelled && state.session?.open;
        const done = interactive && sessionOpen && DONE_MARKER_RE.test(turnText.trimEnd());
        // `CEZ:ASK` → the user is blocked; wins over `CEZ:MONITORING`, loses to
        // `CEZ:DONE` (#473).
        const ask = interactive && sessionOpen && !done ? parseAskMarker(turnText) : null;
        const monitoring =
          interactive &&
          sessionOpen &&
          !done &&
          !ask &&
          MONITORING_MARKER_RE.test(turnText.trimEnd());
        turnText = '';
        if (done) {
          // Goal achieved (agent contract, #347): close the session instead
          // of parking at `waiting` — the run completes and frees its slot.
          emit({ type: 'lifecycle', message: 'goal achieved — session closed' });
          appendHandoffHeartbeat(this.dataDir, runId, 'turn complete — goal achieved, session closed');
          state.session?.end();
          return;
        }
        const waiting = interactive && sessionOpen;
        if (waiting) {
          // Turn over, session open. Either the ball is in the user's court
          // (`waiting`) — optionally with a structured `CEZ:ASK` question the
          // cockpit renders as an ask card (#473) — or the agent declared it is
          // still working on its own downstream work with `CEZ:MONITORING`, which
          // parks as `running`/`activity:'monitoring'`, a non-attention state,
          // instead of raising "needs you" (#490). Lifecycle is identical: the
          // run frees its slot and keeps the idle timer.
          if (ask) emitAskRequested(sink, ask);
          if (monitoring) {
            this.store.updateRun(runId, { status: 'running', activity: 'monitoring' });
            this.store.updateStep(runId, step.id, { status: 'running' });
            this.monitoring.add(runId);
            this.clearIdleTimer(state);
            this.armMonitoringWakeTimer(runId, state);
          } else {
            this.store.updateRun(runId, { status: 'waiting', activity: undefined });
            this.store.updateStep(runId, step.id, { status: 'waiting' });
            this.monitoring.delete(runId);
            this.clearMonitoringWakeTimer(state, runId);
          }
          this.waiting.add(runId);
          if (!monitoring) this.armIdleTimer(runId, state);
          this.releaseSlot(); // the freed slot can start a queued run right away — in any project
        }
        // Cez's own heartbeat — the handoff stays current even when the
        // agent forgets to write (spec 007).
        appendHandoffHeartbeat(
          this.dataDir,
          runId,
          `turn complete — status=${monitoring ? 'monitoring' : waiting ? 'waiting' : 'running'}`,
        );
      }
    };

    const stepBackend = step.runner ?? taskBackend;
    // Normalise the selected model to canonical `provider/model` and back to the
    // backend's own wire form via the ONE shared mapper (#405). Fail-loud: an
    // unresolvable model (e.g. a bare id on opencode) returns the step error
    // instead of letting the backend silently substitute its default.
    let backendModel: string | undefined;
    try {
      const normalized = normalizeModelForBackend(
        stepBackend,
        agentModelsLocked(this.repoRoot) ? undefined : step.model ?? input.model,
        { configuredProvider: await configuredModelProvider(stepBackend, state.cwd) },
      );
      backendModel = normalized?.backendModel;
      // Persist the identity of what ACTUALLY runs (#405, review M1). The run-start echo
      // (line ~993) is best-effort from `taskBackend`/`input.model`; a per-step `runner`/`model`
      // override makes it assert a model that never ran. Re-write it here, from the resolved
      // step identity, so the record — the product of this PR — is always one that ran.
      this.store.updateRun(runId, {
        modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined,
      });
    } catch (err) {
      if (err instanceof ModelIdentityError) return err.message;
      throw err;
    }
    const runner = createRunner(stepBackend);
    let session: AgentSession;
    state.currentStepId = step.id;
    this.beginUsageInvocation(runId, state, step.id);
    try {
      session = runner.startSession(
        {
          // Skill body, then the run's extra prompt (POST override or config
          // default), then the handoff/todos contract — every agent step.
          systemPrompt: composeSystemPrompt(
            systemPrompt,
            extraSystemPrompt,
            followupsEnabled() && input.generateFollowups !== false
              ? HANDOFF_INSTRUCTIONS
              : HANDOFF_ONLY_INSTRUCTIONS,
          ),
          userPrompt,
          images,
          cwd: state.cwd,
          allowedTools: step.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
          bashAllowlist: step.bashAllowlist,
          // The handoff file lives outside the worktree — grant access.
          additionalDirectories: [join(this.dataDir, 'runs')],
          env: this.agentEnv(runId, followupsEnabled() && input.generateFollowups !== false),
          model: backendModel,
          sessionId,
          // Interactive sessions have no wall clock — the idle timer rules.
          timeoutMs: interactive ? 0 : undefined,
        },
        onEvent,
        {
          autoEndAfterFirstTurn: !interactive,
          onUiEvent: (event) => this.handleRunnerUiEvent(runId, state, sink, event),
        },
      );
    } catch (err) {
      state.currentStepId = undefined;
      return err instanceof Error ? err.message : String(err);
    }
    state.session = session;
    state.sessionEverOpened = true;
    this.flushDeferred(runId);
    state.currentStepId = step.id;
    state.interrupt = () => session.interrupt();
    if (session.pid !== undefined) registerRunProcess(runId, session.pid);

    try {
      const result = await session.result;
      if (sessionError) {
        sink.sessionEnded('error', sessionError);
        return sessionError;
      }
      // v2 counterpart of v1's `done` (spec: the mappers leave session-close
      // events to the RunManager — only it knows how the session settled).
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      this.store.updateStep(runId, step.id, { tokensUsed: startTokens + result.tokensUsed });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink.sessionEnded('error', message); // alongside v1's fatal `error`
      return message;
    } finally {
      this.recordUsagePeaks(runId);
      this.clearIdleTimer(state);
      this.monitoring.delete(runId);
      this.waiting.delete(runId);
      this.clearMonitoringWakeTimer(state, runId);
      state.session = undefined;
      state.currentStepId = undefined;
      state.interrupt = () => undefined;
    }
  }

  /**
   * Protocol-v2 sink for one agent session (R2 step 2.1): the runner's
   * `onUiEvent` stream flows through here. Persisted snapshots ride the same
   * NDJSON file as v1 (the store stamps `seq`/`ts`, `appendEvent` fans them
   * out live too); coalesced `item.delta` flushes go out live-only via
   * `emitEphemeral` — raw deltas never hit disk (spec §performance
   * guardrails). One sink per session: cumulative usage dedup and the
   * item-shape cache are session-scoped, like the mapper state feeding them.
   */
  private makeUiSink(runId: string, stepId: string): UiEventSink {
    return new UiEventSink({
      persist: (event) => this.store.appendEvent(runId, { ...event, stepId }),
      emitLive: (event) => this.store.emitEphemeral(runId, { ...event, stepId }),
    });
  }

  /** Native backend asks arrive before turn-end. Persist and park immediately
   * so the cockpit shows attention and the run releases its workspace slot. */
  private handleRunnerUiEvent(runId: string, state: ActiveRun, sink: UiEventSink, event: UiEvent): void {
    this.recordUsageUiEvent(runId, state, event);
    sink.handle(event);
    if (event.type !== 'ask.requested' || state.cancelled) return;
    this.clearIdleTimer(state);
    this.monitoring.delete(runId);
    this.clearMonitoringWakeTimer(state, runId);
    this.waiting.add(runId);
    this.store.updateRun(runId, { status: 'waiting', activity: undefined });
    if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
    this.releaseSlot();
  }

  /** Persist the invocation checkpoint before launching a runner. A throw or
   * process exit before `turn.started` therefore leaves a durable mismatch. */
  private beginUsageInvocation(runId: string, state: ActiveRun, stepId: string): void {
    const step = this.store.getRun(runId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step) return;
    const epoch = (step.usageInvocationEpoch ?? 0) + 1;
    this.persistUsageCheckpoint(runId, stepId, {
      usageInvocationEpoch: epoch,
      usageInvocationsStarted: (step.usageInvocationsStarted ?? 0) + 1,
    });
    state.usageInvocation = {
      stepId,
      epoch,
      observed: false,
      startedTurns: new Set(),
      recordedTurns: new Set(),
    };
  }

  /** Fold backend-neutral completed-turn usage into the current step exactly
   * once. Invocation/turn counters are written before the event reaches the
   * NDJSON sink so crashes cannot preserve a falsely complete subtotal. */
  private recordUsageUiEvent(runId: string, state: ActiveRun, event: UiEvent): void {
    const invocation = state.usageInvocation;
    if (!invocation) return;
    const step = this.store.getRun(runId)?.steps.find((candidate) => candidate.id === invocation.stepId);
    if (!step) return;

    if (event.type === 'turn.started') {
      if (invocation.startedTurns.has(event.turnId)) return;
      invocation.startedTurns.add(event.turnId);
      const firstObservedTurn = !invocation.observed;
      invocation.observed = true;
      this.persistUsageCheckpoint(runId, invocation.stepId, {
        usageTurnsStarted: (step.usageTurnsStarted ?? 0) + 1,
        ...(firstObservedTurn
          ? { usageInvocationsObserved: (step.usageInvocationsObserved ?? 0) + 1 }
          : {}),
      });
      return;
    }

    if (event.type !== 'turn.completed') return;
    if (!invocation.startedTurns.has(event.turnId) || invocation.recordedTurns.has(event.turnId)) return;
    const input = event.usage?.input;
    const output = event.usage?.output;
    if (
      typeof input !== 'number' ||
      !Number.isFinite(input) ||
      input < 0 ||
      typeof output !== 'number' ||
      !Number.isFinite(output) ||
      output < 0
    ) {
      return;
    }
    invocation.recordedTurns.add(event.turnId);
    this.persistUsageCheckpoint(runId, invocation.stepId, {
      inputTokens: (step.inputTokens ?? 0) + input,
      outputTokens: (step.outputTokens ?? 0) + output,
      usageTurnsRecorded: (step.usageTurnsRecorded ?? 0) + 1,
    });
  }

  /** Usage completeness is a crash boundary, unlike high-frequency token
   * snapshots: the checkpoint must reach `runs.json` before the runner starts
   * or the matching UI event is persisted and forwarded. */
  private persistUsageCheckpoint(
    runId: string,
    stepId: string,
    patch: Partial<Omit<StepState, 'id'>>,
  ): void {
    this.store.updateStep(runId, stepId, patch);
    this.store.flush();
  }

  /**
   * Turn-end bookkeeping (#389), shared by `runAgentStep` and
   * `runContinuation` — called (fire-and-forget) from every `turn-end` event:
   *
   *  - `titleSummary`: derived from the turn's text, set ONCE — only while the
   *    record has none. A user's inline edit also lands in `titleSummary`
   *    (see `PATCH /api/runs/:id`), so an edit is never overwritten either.
   *  - `diffStat`: cheap `git diff --shortstat` vs the base, refreshed every
   *    turn. Async and best-effort — a git failure becomes at most a `note`
   *    event, NEVER a run failure. `updateRun` fans the record out over SSE,
   *    so the list views pick both up with no extra wiring.
   *
   * Not `private` so the integration tests can drive a turn-end directly —
   * a real agent session is the only other way to reach this path.
   */
  /**
   * The namer's apply path (task auto-naming spec). Fire-and-forget: called
   * without await from `startRun` (creation) and `recordTurnEnd` (live
   * refresh). A user-owned title (`titleOrigin: 'user'`) is never overwritten;
   * namer-owned titles may be replaced by fresher namer results.
   */
  private async autoNameRun(
    runId: string,
    skillName: string | undefined,
    task: string,
    live?: { turnText?: string; diffStat?: string },
  ): Promise<void> {
    // CEZ_AUTONAME=0 kills all LLM naming; dry-run skips it too unless
    // CEZ_AUTONAME=1 forces the mock path — see autoNamingActive.
    if (!autoNamingActive()) return;
    try {
      let skillDescription: string | undefined;
      if (skillName) {
        const skills = await discoverSkills(this.repoRoot).catch(() => [] as Skill[]);
        skillDescription = skills.find((s) => s.name === skillName)?.description;
      }
      const result = await generateRunName(this.repoRoot, { task, skillName, skillDescription, ...live });
      if (!result) return;
      const run = this.store.getRun(runId);
      // Marker-owned state outranks the namer (spec 2026-07-18-task-ref-markers):
      // a declared title blocks the whole apply (this call raced the marker),
      // and a declared pr/issue kind blocks that kind field-by-field.
      if (!run || run.titleOrigin === 'user' || run.titleOrigin === 'marker') return;
      this.store.updateRun(runId, {
        titleSummary: result.titleSummary,
        titleOrigin: 'auto',
        ...(result.prNumber !== undefined && run.markerRefs?.pr === undefined
          ? { prNumber: result.prNumber }
          : {}),
        ...(result.issueNumber !== undefined && run.markerRefs?.issue === undefined
          ? { issueNumber: result.issueNumber }
          : {}),
      });
    } catch {
      // Naming is best-effort — nothing here may disturb the run.
    }
  }

  async recordTurnEnd(runId: string, turnText: string): Promise<void> {
    try {
      const run = this.store.getRun(runId);
      if (!run) return;
      this.applyTurnMarkers(runId, run, turnText);
      // Titles are the namer's job (task auto-naming spec) — turn text is
      // deliberately NEVER a title source; see maybeRefreshTitle below. The
      // one exception is an explicit CEZ:TITLE declaration (applied above).
      if (run.worktreePath && existsSync(run.worktreePath)) {
        // `taskBranch` is what keeps this number *this task's* (#751): a review/QA run
        // repoints the worktree onto the branch under review, and without the branch to
        // compare HEAD against, the stat would claim that whole branch's diff.
        const stat = await worktreeShortstat(run.worktreePath, run.baseBranch ?? 'HEAD', {
          taskBranch: run.branch,
        });
        if (stat) this.store.updateRun(runId, { diffStat: stat });
        else this.store.appendEvent(runId, { type: 'note', message: 'diff stat unavailable — git diff --shortstat failed in the worktree' });
      }
      await this.maybeRefreshTitle(runId, turnText);
    } catch {
      // Bookkeeping only — nothing here may disturb the run.
    }
  }

  /**
   * In-band declarations from the finished turn (spec
   * 2026-07-18-task-ref-markers): the main thread's own `CEZ:PR=` /
   * `CEZ:ISSUE=` / `CEZ:TITLE=` lines, parsed from the accumulated turn text
   * like `CEZ:DONE` — never from tool output. Declared numbers overwrite the
   * regex/namer display tier (the store re-resolves the referenced-PR chip);
   * a declared title takes `titleOrigin: 'marker'`, which beats the namer but
   * never a user rename, and silences the live refresh below.
   */
  private applyTurnMarkers(runId: string, run: RunRecord, turnText: string): void {
    const markers = parseTaskMarkers(turnText);
    if (markers.pr !== undefined || markers.issue !== undefined) {
      this.store.applyMarkerRefs(runId, { pr: markers.pr, issue: markers.issue });
    }
    if (markers.title && run.titleOrigin !== 'user') {
      const current = this.store.getRun(runId);
      const refNumber = current?.prNumber ?? current?.issueNumber;
      const validated = postValidateTitle(markers.title, refNumber);
      // Same junk guard as composeNameResult: a declaration that validates to
      // nothing (or to a bare number prefix) must not blank the title.
      if (validated && validated !== `${refNumber}:`) {
        this.store.updateRun(runId, { titleSummary: validated, titleOrigin: 'marker' });
      }
    }
  }

  /**
   * Live title refresh (task auto-naming spec, step 3): re-run the namer with
   * the turn's context. Skips: toggle off (`liveTitleUpdates` config over
   * `CEZ_TITLE_UPDATES` env, default ON), user-owned title, marker-owned title
   * (the agent declares via `CEZ:TITLE` — the token-saving fast path), dry-run
   * mocks (canned answers add nothing), empty turn text, unchanged namer inputs.
   */
  private async maybeRefreshTitle(runId: string, turnText: string): Promise<void> {
    if (!autoNamingActive()) return;
    if (!turnText.trim()) return;
    const config = await loadConfig(this.repoRoot);
    if (!liveTitleUpdatesEnabled(config)) return;
    const run = this.store.getRun(runId);
    if (!run || run.titleOrigin === 'user' || run.titleOrigin === 'marker') return;
    const statText = run.diffStat ? `${run.diffStat.files} files, +${run.diffStat.adds} -${run.diffStat.dels}` : undefined;
    const key = `${turnText.slice(0, 200)}|${statText ?? ''}`;
    if (this.lastNamerKey.get(runId) === key) return;
    this.lastNamerKey.set(runId, key);
    const workflow = await this.reviveWorkflow(run);
    const skillName = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    void this.autoNameRun(runId, skillName, run.task, { turnText, diffStat: statText });
  }

  /**
   * End-of-session telemetry (#348): stop sampling the run's process tree and
   * fold the session's peaks into the run record. `max` with existing values —
   * a run can hold several sessions (multiple agent steps, Continue) and the
   * record keeps the highest water mark across all of them.
   */
  private recordUsagePeaks(runId: string): void {
    const peaks = unregisterRunProcess(runId);
    if (!peaks) return;
    const run = this.store.getRun(runId);
    this.store.updateRun(runId, {
      peakRssBytes: Math.max(run?.peakRssBytes ?? 0, peaks.peakRssBytes),
      peakProcCount: Math.max(run?.peakProcCount ?? 0, peaks.peakProcCount),
    });
  }

  /**
   * Diff-first review gate (spec 009), shared by `execute` and
   * `runContinuation`: a *successful* run whose worktree holds changes rests
   * at `review` instead of `done` — the user inspects the diff first, then
   * sends feedback back, opens a draft PR, or just finishes. Failed/cancelled
   * runs never enter review; no worktree or an empty diff means plain `done`.
   *
   * The gate is opt-in (#489): the review park happens only when it is enabled
   * (`reviewGateEnabled` — config toggle over the `CEZ_REVIEW_GATE` env, default
   * OFF) AND the run is not autonomous. Autonomous runs — and runs with the gate
   * off — settle straight to `done`, leaving the diff in the worktree untouched.
   */
  private async settleSuccess(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    let review = false;
    if (run?.worktreePath && existsSync(run.worktreePath)) {
      const diff = await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD');
      const hasDiff = diff.trim().length > 0 && !diff.startsWith('(diff failed');
      const config = await loadConfig(this.repoRoot);
      review = hasDiff && reviewGateEnabled(config) && run.autonomous !== true;
    }
    this.store.updateRun(runId, {
      status: review ? 'review' : 'done',
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
    });
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: review
        ? 'changes ready for review — send feedback, open a draft PR, or finish'
        : 'run finished',
    });
  }

  /**
   * Agent screenshot (an image block inside a tool result) or a user-pasted
   * attachment: the base64 data never enters the NDJSON event log — it lands
   * as a file under `.ai/cezar/runs/<id>-images/` and the transcript event
   * carries only the name + serving URL. `namePrefix` distinguishes the two
   * origins on disk (`screenshot-<n>.<ext>` for agent tool screenshots,
   * `pasted-<n>.<ext>` for user-pasted attachments, #357) and the absolute
   * `path` lets the agent operate on the file directly (save/attach/upload).
   * Best effort: on failure the attachment is dropped, the transcript still
   * shows the tool result's `[screenshot]` placeholder (or the image count).
   */
  private persistImage(
    runId: string,
    mediaType: string,
    data: string,
    namePrefix: string = 'screenshot',
  ): { name: string; url: string; path: string } | null {
    try {
      const ext =
        /png/.test(mediaType) ? 'png'
        : /jpe?g/.test(mediaType) ? 'jpg'
        : /webp/.test(mediaType) ? 'webp'
        : /gif/.test(mediaType) ? 'gif'
        : 'img';
      const dir = join(this.dataDir, 'runs', `${runId}-images`);
      mkdirSync(dir, { recursive: true });
      // Seed from the highest numeric suffix already on disk, NOT the file count:
      // `screenshot-*` and `pasted-*` share one numbering space, so counting would
      // re-issue a live number after any deletion. Only matters on the first write
      // of a process (restart case) — afterwards the map is authoritative.
      let seq = this.queuedImageSeq.get(runId);
      if (seq === undefined) seq = highestImageSeq(dir);
      // `persistImage` is fully synchronous, so two pastes cannot interleave between
      // the read of the counter and the write. The exclusive-create flag is the
      // belt-and-braces guard for a stale seed: it degrades to a renamed file rather
      // than a silent overwrite.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        seq += 1;
        const name = `${namePrefix}-${seq}.${ext}`;
        const path = join(dir, name);
        try {
          writeFileSync(path, Buffer.from(data, 'base64'), { flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
        this.queuedImageSeq.set(runId, seq);
        // Versioned, because that is the only surface served now. The cockpit still upgrades
        // the unversioned URLs sitting in OLD transcripts when it renders them
        // (`resolveApiUrl`), but a URL minted today must be fetchable as written.
        return { name, url: `/api/v1/runs/${runId}/images/${name}`, path };
      }
      return null;
    } catch {
      return null;
    }
  }

  private armIdleTimer(runId: string, state: ActiveRun): void {
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      if (state.session?.open && !state.cancelled) {
        this.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `session closed after ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m of inactivity`,
        });
        state.session.end();
      }
    }, IDLE_TIMEOUT_MS);
    state.idleTimer.unref?.();
  }

  private clearIdleTimer(state: ActiveRun): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  private reconcileMonitoringWakeTimers(): void {
    for (const runId of this.monitoring) {
      const state = this.active.get(runId);
      if (state) this.armMonitoringWakeTimer(runId, state);
    }
  }

  private armMonitoringWakeTimer(runId: string, state: ActiveRun): void {
    const minutes = this.semaphore.monitoringWakeIntervalMinutes();
    if (minutes === null) {
      this.clearMonitoringWakeTimer(state, runId);
      return;
    }
    if ((state.monitoringWakeups ?? 0) >= MAX_AUTO_CONTINUES) {
      this.clearMonitoringWakeTimer(state, runId);
      if (!this.store.getRun(runId)?.monitoringWakeCapReached) {
        this.store.updateRun(runId, { monitoringWakeCapReached: true });
        this.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); session remains parked`,
        });
      }
      return;
    }
    if (state.monitoringWakeTimer && state.monitoringWakeIntervalMinutes === minutes) return;
    this.clearMonitoringWakeTimer(state, runId);
    state.monitoringWakeIntervalMinutes = minutes;
    this.store.updateRun(runId, { monitoringWakeCapReached: undefined });
    const deadline = Date.now() + minutes * 60_000;
    this.store.updateRun(runId, { monitoringWakeAt: new Date(deadline).toISOString() });
    state.monitoringWakeTimer = setTimeout(() => {
      state.monitoringWakeTimer = undefined;
      this.store.updateRun(runId, { monitoringWakeAt: undefined });
      if (!this.monitoring.has(runId) || !state.session?.open || state.cancelled) return;
      const wakeups = state.monitoringWakeups ?? 0;
      if (wakeups >= MAX_AUTO_CONTINUES) {
        this.store.updateRun(runId, { monitoringWakeCapReached: true });
        this.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); session remains parked`,
        });
        return;
      }
      state.monitoringWakeups = wakeups + 1;
      this.store.appendEvent(runId, {
        type: 'note',
        message: `automatic monitoring wake-up (${state.monitoringWakeups}/${MAX_AUTO_CONTINUES})`,
      });
      this.deliverMessage(runId, [{ type: 'text', text: MONITORING_WAKE_NUDGE }], false);
    }, Math.max(0, deadline - Date.now()));
    state.monitoringWakeTimer.unref?.();
  }

  private clearMonitoringWakeTimer(state: ActiveRun, runId?: string): void {
    if (state.monitoringWakeTimer) clearTimeout(state.monitoringWakeTimer);
    state.monitoringWakeTimer = undefined;
    state.monitoringWakeIntervalMinutes = undefined;
    if (runId) this.store.updateRun(runId, { monitoringWakeAt: undefined });
  }

  /** Autosave-commit the worktree every 90 s while the run lives (spec 006).
   *  Opt-in via CEZ_AUTOSAVE=1 (#471) — see periodicAutosaveEnabled. */
  private armAutosave(state: ActiveRun): void {
    if (!periodicAutosaveEnabled()) return;
    if (state.cwd === this.repoRoot || state.autosaveTimer) return;
    state.autosaveTimer = setInterval(() => {
      void autosaveCommit(state.cwd, 'periodic');
    }, AUTOSAVE_INTERVAL_MS);
    state.autosaveTimer.unref?.();
  }

  private clearAutosaveTimer(state: ActiveRun): void {
    if (state.autosaveTimer) {
      clearInterval(state.autosaveTimer);
      state.autosaveTimer = undefined;
    }
  }

  private runCheckStep(
    state: ActiveRun,
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<{ ok: boolean; output: string }> {
    const command = step.command as string;
    emit({ type: 'note', stepId: step.id, message: `$ ${command}` });
    return new Promise((resolve) => {
      // Check steps run in the same cwd as the agent steps — the worktree.
      const child = spawn('bash', ['-lc', command], { cwd: state.cwd, env: process.env });
      state.interrupt = () => child.kill('SIGTERM');

      let output = '';
      const collect = (chunk: Buffer) => {
        if (output.length < CHECK_OUTPUT_CAP) {
          output += chunk.toString('utf8');
          if (output.length >= CHECK_OUTPUT_CAP) output += '\n… (output truncated)';
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (err) => {
        state.interrupt = () => undefined;
        const message = `failed to spawn: ${err.message}`;
        emit({ type: 'check-output', stepId: step.id, command, text: message, exitCode: -1 });
        resolve({ ok: false, output: message });
      });
      child.on('close', (code) => {
        state.interrupt = () => undefined;
        const trimmed = output.trim() || '(no output)';
        emit({ type: 'check-output', stepId: step.id, command, text: trimmed, exitCode: code ?? -1 });
        resolve({ ok: code === 0, output: trimmed });
      });
    });
  }

  private finishStep(
    runId: string,
    stepId: string,
    status: 'done' | 'failed',
    error: string | undefined,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): void {
    this.store.updateStep(runId, stepId, {
      status,
      error,
      finishedAt: new Date().toISOString(),
    });
    emit({ type: 'step-end', stepId, status, ...(error ? { error } : {}) });
    appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=${status}`);
  }
}

function findLastAgentStepIndex(workflow: WorkflowDef): number {
  for (let i = workflow.steps.length - 1; i >= 0; i--) {
    const step = workflow.steps[i];
    if (step && stepKind(step) === 'agent') return i;
  }
  return -1;
}

function applyTemplate(template: string, task: string): string {
  return template.replaceAll('{{task}}', task);
}

/**
 * Immediate title shown while a run is queued. The namer's `titleSummary`
 * replaces it once the model answers; this is the honest, permanent fallback
 * when no model is available (#432, spec 2026-07-17-task-auto-naming). When
 * the task references a PR/issue, the number leads: `469: /om-auto-review-pr`.
 */
export function makeRunTitle(task: string, workflow: WorkflowDef): string {
  const firstLine = task.trim().split('\n')[0] ?? '';
  const skill = workflow.steps.find((step) => stepKind(step) === 'agent' && step.skill)?.skill?.trim();
  const contextual = skill && !firstLine.startsWith(`/${skill}`)
    ? `/${skill}${firstLine ? ` ${firstLine}` : ''}`
    : firstLine;
  const refNumber = titleRefNumber(refineTaskRefs(extractTaskRefs(task), skill));
  // `469` or `/om-auto-review-pr 469` reads as `469: /om-auto-review-pr` — the
  // number leads so it survives the tasks table's narrow truncation.
  const skillArg = skill && contextual.startsWith(`/${skill}`) ? contextual.slice(skill.length + 1).trim() : null;
  const body = refNumber !== undefined && skill && (skillArg === '' || /^#?\d+$/.test(skillArg ?? ''))
    ? `/${skill}`
    : contextual;
  const prefixed =
    refNumber !== undefined && !body.trimStart().replace(/^#/, '').startsWith(String(refNumber))
      ? `${refNumber}: ${body}`
      : body;
  const chars = [...(prefixed || '(untitled task)')];
  return chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : chars.join('');
}

/**
 * Skill identity is context, while the Markdown body remains instructions.
 *
 * For an on-disk skill we also hand the agent the ABSOLUTE directory of the
 * installed copy. A run executes in an isolated worktree that has no local
 * `.agents/skills` (gitignored, absent in a fresh checkout), so without this
 * the agent cannot read the skill's companion files (`references/*.md`) — or,
 * worse, reads a stale copy materialized from the team-repo cache. The path
 * resolves against the MAIN project root (`discoverSkills(repoRoot)`), i.e. the
 * current `npx skills`-installed copy, so a worktree agent and the main
 * checkout read the exact same, up-to-date files. Team skills are omitted here:
 * they are materialized into the worktree separately (see the call site).
 */
export function skillSystemPrompt(
  skill: Pick<Skill, 'name' | 'description' | 'body'> & Partial<Pick<Skill, 'path' | 'source'>>,
): string {
  const lines = [
    `Selected skill: /${skill.name}`,
    ...(skill.description ? [`Description: ${skill.description}`] : []),
  ];
  if (skill.source && skill.source !== 'team' && skill.path) {
    const dir = dirname(skill.path);
    lines.push(
      '',
      `Skill files are installed on disk at: ${dir}`,
      `Read any file this skill references (for example references/*.md) from that absolute directory. ` +
        `It is the current installed copy — use it even though your working directory is a separate worktree that does not contain the skill.`,
    );
  }
  lines.push('', 'Skill instructions:', skill.body.trim());
  return lines.join('\n');
}

/**
 * Expand a registry-backed slash skill in a live chat message before it reaches
 * a backend. Claude otherwise intercepts an unknown leading slash command, and
 * Codex/OpenCode have no native slash-skill lookup at all (#676).
 *
 * Only the first text block is eligible, only at character zero, and unknown
 * commands pass through byte-for-byte. The caller persists the original user
 * content before applying this delivery-only rewrite.
 */
export function expandRegistrySlashSkill(
  content: ContentBlock[],
  skills: readonly Skill[],
): ContentBlock[] {
  const textIndex = content.findIndex((block) => block.type === 'text');
  if (textIndex < 0) return content;
  const block = content[textIndex];
  if (!block || block.type !== 'text') return content;
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(block.text);
  if (!match) return content;
  const skill = skills.find((candidate) => candidate.name === match[1]);
  if (!skill) return content;

  const request = block.text.slice(match[0].length).trim();
  const replacement: ContentBlock = {
    type: 'text',
    text: request ? `${skillSystemPrompt(skill)}\n\nUser request:\n${request}` : skillSystemPrompt(skill),
  };
  const expanded = [...content];
  expanded[textIndex] = replacement;
  return expanded;
}
