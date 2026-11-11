import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  isImageMediaType,
  managerAccessOf,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BASE64,
  runnerSupportsReasoningEffort,
  MANAGER_DEFAULT_CRON_MINUTES,
  type CreateManagerInput,
  type Manager,
  type AttachmentInput,
  type ManagerActionRequest,
  type ManagerAsk,
  type ManagerActionStatus,
  type ManagerCommand,
  type ManagerCreateTaskInput,
  type ManagerCreateTaskResponse,
  type ManagerForwarded,
  type ManagerJob,
  type ManagerMessage,
  type ManagerMessagesResponse,
  type ManagerProposeActionInput,
  type ManagerSnapshot,
  type ManagerSummary,
  type ManagerTaskDetail,
  type ManagerTaskMessageInput,
  type ManagerTaskMessageResponse,
  type ManagerTurnKind,
  type UpdateManagerInput,
} from '@open-mercato/cezar-contract';
import type { AutomationDefinition } from '@open-mercato/cezar-contract';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { parseAskMarker, stripAskMarker } from '../core/ask.ts';
import { isRunnerId, type AgentEvent, type AgentRunner, type AgentRunSpec, type AgentSession, type ContentBlock, type RunnerId } from '../core/agent-runner.ts';
import { supportsProfiles } from '../core/agent-profiles.ts';
import { readOnlyEnv } from '../core/read-only-env.ts';
import { canEnforceReadOnly, createRunner } from '../core/runner-factory.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { assertCezarHomeWriteIsSandboxed, managersDir } from '../paths.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import {
  changedSettingFields,
  managerActionLabel,
  managerAgeLabel,
  managerCreatedLabel,
  MANAGER_TURN_TRIGGER,
  managerWorkflowLabel,
  type ManagerTelemetry,
  type ManagerTelemetryContext,
} from './telemetry.ts';
import { classifyManagerFailure, failureCause, managerFailureMessage, retryPlan, type ManagerFailureKind } from './failure.ts';
import { placeholderIn, placeholderRefusal, withForwarded } from './forward.ts';
import { chatPrompt, jobPrompt, MANAGER_IMPORTANT, managerSystemPrompt, MANAGER_QUIET, recapPrompt, watchPrompt } from './prompts.ts';
import { buildSnapshot, gateAttention, taskDetailRows, type ManagerGithubFacts, type ManagerProjectSource } from './snapshot.ts';
import type { ManagerState, ManagerStore } from './store.ts';

/**
 * The manager turn engine (spec 2026-10-31-managers § Turns, § Watching, § Safety). One turn per
 * manager at a time, each a single resumed agent session, so a manager costs nothing while idle.
 */

export type ManagerRefusal = { error: string; status: 400 | 403 | 404 | 409 | 502 };

type LoopbackRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface ManagerEngineDeps {
  store: ManagerStore;
  emit: (event: 'manager-change' | 'manager-message' | 'manager-delta', data: unknown) => void;
  /** Every project this cockpit can see, read without building contexts. */
  projects: () => Promise<ManagerProjectSource[]>;
  github: ManagerGithubFacts;
  defaultRunner: () => Promise<RunnerId>;
  /** Why this account cannot be picked, as `POST /runs` would say it. */
  accountError: (runner: RunnerId, agentProfile: string) => Promise<string | null>;
  /** The cockpit's own routes, in process: POST /runs, merge, enable have exactly one implementation. */
  request: LoopbackRequest;
  costVisible: () => boolean;
  /** Settings → Resources' auto-resume switch; off keeps a usage limit a plain failure. Absent = on. */
  autoResume?: () => boolean;
  /** Raises the OS notification; absent where there is nobody at the machine. */
  notifySystem?: (title: string, body: string) => void;
  runnerFor?: (runner: RunnerId) => AgentRunner;
  /** Usage telemetry (docs/telemetry.md); absent sends nothing. Consent is the sender's to check. */
  telemetry?: ManagerTelemetry;
  now?: () => number;
  /** Test seam for `TURN_LIMIT_MS`. */
  turnLimitMs?: number;
  /** Test seam for `RETRY_BACKOFF_MS`. */
  retryDelayMs?: number;
}

type QueueItem =
  | { kind: 'chat'; text: string; images: ContentBlock[]; paths: string[]; messageIds: string[] }
  | { kind: 'watch'; forced: boolean }
  | { kind: 'job'; jobId: string }
  /** The chat a usage limit cut off; read from state under the lease, so only one cockpit replays it. */
  | { kind: 'resume' };

interface ActiveTurn {
  kind: ManagerTurnKind;
  /** Screenshots the user sent with this message, for the model to see. */
  images?: ContentBlock[];
  /** The user messages this chat turn answers, oldest first: `fromMessage: 'last'` is the newest. */
  messageIds?: string[];
  /** False while a watch check is still deciding whether a model call is needed at all. */
  started: boolean;
  stopped: boolean;
  session?: AgentSession;
  stopTimer?: NodeJS.Timeout;
  limit?: NodeJS.Timeout;
  /** Interrupted by `TURN_LIMIT_MS`, not by the user. */
  timedOut?: boolean;
  /** The whole turn, gate and setup included: a delete waits for it before removing the files. */
  settled?: Promise<unknown>;
}

interface Runtime {
  queue: QueueItem[];
  active?: ActiveTurn;
  retry?: NodeJS.Timeout;
  retries: number;
  deleted?: boolean;
}

type Progress = () => { text: string; commands: ManagerCommand[] };

interface DriveResult {
  text: string;
  commands: ManagerCommand[];
  costUsd: number;
  error?: string;
  /** Absent when the turn failed before a runner was picked. */
  runner?: RunnerId;
}

const STREAM_THROTTLE_MS = 100;
/** A full frame whenever the reply doubles past this, so the wire stays linear and a lost delta heals. */
const KEYFRAME_FLOOR = 4_096;
const STOP_GRACE_MS = 5_000;
/** A hung agent must not hold a manager forever: watch and job turns have nobody to press Stop. */
const TURN_LIMIT_MS = 30 * 60_000;
const TURN_LIMIT_ERROR = 'Stopped: this turn ran for 30 minutes without finishing.';
const LEASE_STALE_MS = 30_000;
const LEASE_RETRY_MS = 5_000;
const LEASE_RETRY_LIMIT = 24;
const TICK_FLOOR_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_WATCH_BACKOFF = 4;
/** The pause before the one retry a passing failure (network, busy servers) earns. */
const RETRY_BACKOFF_MS = 5_000;
/** Failed watch checks in a row before the chat hears about them; fewer are logged quietly. */
const WATCH_NOTICE_AFTER = 3;
const OUTPUT_LIMIT = 4_000;
const TAIL_BYTES = 256 * 1024;
const PREVIEW_LIMIT = 120;

export const MANAGER_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
/** Claude's absolute-path rule spelling: `//abs/path`, a Windows drive as `//c/…`. */
const claudeAbsolutePath = (path: string): string =>
  `/${path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)}`;

/** Write and Edit inside `files/` only: the workdir itself holds `.claude/`, which would widen the fence. */
export function managerWriteRules(filesDir: string): string[] {
  const scope = `${claudeAbsolutePath(filesDir)}/**`;
  return [`Write(${scope})`, `Edit(${scope})`];
}

export const MANAGER_BASH_ALLOWLIST = [
  'cez-manager',
  'gh pr view', 'gh pr list', 'gh pr diff', 'gh pr checks', 'gh issue view', 'gh issue list', 'gh run view', 'gh run list', 'gh repo view',
];

/** Backends that keep the manager to `MANAGER_BASH_ALLOWLIST` (Pi drops `Bash` instead). */
const ALLOWLIST_FENCED: ReadonlySet<RunnerId> = new Set(['claude', 'pi']);

/** A task keeps a task's full shell, so this is a request, not a fence (spec, Safety). */
const MANAGER_TASK_SYSTEM_PROMPT = 'A cezar manager started this task. Do not merge pull requests or enable automations: leave that to the user.';

/** `attachmentInputSchema`'s per-file bound, and the task text bound of `POST /runs`. */
const ATTACHMENT_BASE64_LIMIT = 7_000_000;
const FORWARD_TEXT_LIMIT = 100_000;

interface Forward {
  text: string;
  images: AttachmentInput[];
  forwarded: ManagerForwarded;
}

const SESSION_FIELD = { chat: 'sessionId', watch: 'watchSessionId', job: 'jobSessionId' } as const;

const WATCH_REFUSAL = 'A watch check is read-only: it may ask the user to act, it may not act. Say what you would do and let the user ask for it.';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** `cez-manager` on the turn's PATH, so `bashAllowlist` can name one word. */
export function ensureManagerShim(): string {
  const dir = join(managersDir(), 'bin');
  assertCezarHomeWriteIsSandboxed(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A dev cockpit runs under tsx: the shim needs the same loader flags to run a .ts entrypoint.
  const flags = process.execArgv.filter((arg) => !arg.startsWith('--inspect'));
  const write = (name: string, body: string) => {
    const path = join(dir, name);
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // first turn
    }
    if (current !== body) writeFileSync(path, body, { mode: 0o755 });
    chmodSync(path, 0o755);
  };
  write('cez-manager', `#!/bin/sh\nexec ${[process.execPath, ...flags].map(shellQuote).join(' ')} "$CEZ_BIN" manager "$@"\n`);
  if (process.platform === 'win32') write('cez-manager.cmd', `@"${process.execPath}" "%CEZ_BIN%" manager %*\r\n`);
  return dir;
}

function commandSummary(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    for (const key of ['command', 'pattern', 'file_path', 'path', 'query']) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) return value.slice(0, 300);
    }
  }
  return '';
}

const onePlainLine = (text: string): string =>
  text.replace(/\[\[task:[^\]]*\]\]/g, 'a task').replace(/\[\[pr:[^\]]*\/(\d+)\]\]/g, 'PR $1')
    .replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT);

const QUIET_LINE = new RegExp(`(^|\\n)\\s*${MANAGER_QUIET}\\s*$`);
const IMPORTANT_LINE = new RegExp(`^\\s*${MANAGER_IMPORTANT}\\b[ \\t:]*(.*)(?:\\n|$)`, 'm');
const HEADLINE_LIMIT = 140;
/** Long enough for an open tab to mark the message read, so nobody is told what they are reading. */
const SYSTEM_NOTIFY_DELAY_MS = 3_000;
const READ_STREAMING_LIMIT = 20;

/** Not opened yet. A reply read mid-stream keeps its seq (its place) and stays new until read settled. */
const unseen = (state: ManagerState, message: { id: string; seq: number }): boolean =>
  message.seq > state.readSeq || state.readStreaming.includes(message.id);

/** A hand-edited date reads as long past: one early check, then a real stamp. Never `NaN`. */
const msOf = (iso: string): number => Date.parse(iso) || 0;

/** Claude prints its limit as the reply and exits 1: only a short, tool-free reply is read as one. */
const LIMIT_REPLY_MAX = 500;

type TurnOutcome = 'heard' | 'failed' | 'limited';

const turnFailure = (cause: unknown): DriveResult => ({ text: '', commands: [], costUsd: 0, error: cause instanceof Error ? cause.message : String(cause) });

/** A half-streamed `CEZ:ASK` line is not text yet: parsing it waits for the final frame. */
const STREAMING_ASK = /^[ \t]*CEZ:ASK\b[\s\S]*$/m;

interface Judged {
  text: string;
  important: boolean;
  headline?: string;
  ask?: ManagerAsk;
}

function judged(raw: string): Judged {
  const ask = parseAskMarker(raw) ?? undefined;
  const body = ask ? stripAskMarker(raw) : raw;
  const match = IMPORTANT_LINE.exec(body);
  const headline = (match?.[1] ?? '').trim().slice(0, HEADLINE_LIMIT);
  return {
    text: (match ? body.replace(IMPORTANT_LINE, '') : body).trim(),
    important: match !== null,
    ...(headline ? { headline } : {}),
    ...(ask ? { ask } : {}),
  };
}

const judgedFields = ({ important, headline, ask }: Judged) => ({
  ...(important ? { important } : {}),
  ...(headline ? { headline } : {}),
  ...(ask ? { ask } : {}),
});

/** A question always waits on the user, so it interrupts like an approval does. */
const alertBody = ({ important, headline, ask, text }: Judged): string | undefined =>
  important ? headline ?? onePlainLine(text) : ask ? 'Has a question for you' : undefined;

/** The end of a task's assistant text, off its event file. Best effort: a task may have none. */
function lastAssistantText(root: string, runId: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(join(root, '.ai', 'cezar', 'runs', `${runId}.ndjson`), 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.includes('"type":"text"')) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown; text?: unknown };
        if (event.type === 'text' && typeof event.text === 'string') return event.text.slice(-2_000);
      } catch {
        // a torn first line of the window
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export class ManagerEngine {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly leases = new Map<string, () => void>();
  private readonly settling = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  /** Managers `recover` could not lease: swept by whichever lease this process takes first. */
  private readonly unrecovered = new Set<string>();
  private started = false;
  private disposed = false;

  private readonly alerts = new Set<NodeJS.Timeout>();
  /** Per manager, the newest `manager-change` asked for: summaries resolve out of order. */
  private readonly changes = new Map<string, number>();

  constructor(private readonly deps: ManagerEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = { queue: [], retries: 0 };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Arms nothing when no manager exists. Recovery first: a turn cannot survive its process. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // A SIGKILL leaves the lease until it goes stale, so a quick restart has to look again.
    if (!this.recover()) {
      this.recoveryTimer = setTimeout(() => this.recover(), LEASE_STALE_MS + 5_000);
      this.recoveryTimer.unref?.();
    }
    this.reschedule();
  }

  /** A `streaming` message at boot is a turn that died with its process — unless a second cockpit
   *  still holds that manager's lease, in which case the turn is alive over there. False when a
   *  lease kept it from looking at every manager. */
  recover(): boolean {
    let complete = true;
    for (const manager of this.deps.store.list()) {
      // Our own lease is a turn alive in this process, not one to recover.
      if (this.leases.has(manager.id)) continue;
      const release = this.tryLease(manager.id);
      if (!release) {
        this.unrecovered.add(manager.id);
        complete = false;
        continue;
      }
      try {
        this.sweep(manager.id, false);
      } finally {
        release();
      }
    }
    return complete;
  }

  /** Under the lease. `answering`: the last user message is the one this turn takes up. */
  private sweep(id: string, answering: boolean): void {
    this.unrecovered.delete(id);
    const messages = this.deps.store.messages(id);
    for (const message of messages) {
      if (message.kind === 'assistant' && message.streaming) {
        this.publish(id, { ...message, streaming: false, stopped: true }, true);
        this.addNotice(id, 'cezar restarted during this reply.');
      } else if (message.kind === 'action' && message.status === 'running') {
        this.publish(id, { ...message, status: 'failed', result: 'cezar restarted before this finished. Check it before trying again.' }, true);
      }
    }
    if (!answering && messages.at(-1)?.kind === 'user') this.addNotice(id, 'cezar restarted before answering this. Send it again if you still need it.');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    for (const timer of this.alerts) clearTimeout(timer);
    this.alerts.clear();
    this.timer = undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.retry) clearTimeout(runtime.retry);
      runtime.queue = [];
      this.interrupt(runtime);
    }
  }

  /** `dispose`, then wait for the in-flight turns to write their final message. */
  async shutdown(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.settling]);
  }

  /** Turns and checks in flight, the silent gate phase included. */
  inFlight(): number {
    return this.settling.size;
  }

  private interrupt(runtime: Runtime): void {
    const turn = runtime.active;
    if (!turn || turn.stopped) return;
    turn.stopped = true;
    if (!turn.session) return;
    try {
      turn.session.interrupt();
    } catch {
      // already tearing down
    }
    const session = turn.session;
    turn.stopTimer = setTimeout(() => (session.hardStop ? session.hardStop() : session.end()), STOP_GRACE_MS);
    turn.stopTimer.unref?.();
  }

  // ---- lease -------------------------------------------------------------------------------

  /** Two cockpits on one home must not both run a manager (spec § Watching). */
  private tryLease(id: string): (() => void) | undefined {
    const held = this.leases.get(id);
    if (held) return undefined;
    const dir = this.deps.store.dir(id);
    assertCezarHomeWriteIsSandboxed(dir);
    try {
      // Inside the try: a timer and the boot path call this, and a read-only home must not throw.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const release = lockfile.lockSync(join(dir, 'lease'), {
        realpath: false,
        stale: LEASE_STALE_MS,
        update: 10_000,
        // A compromised lease only risks a duplicate reply; it must not throw from a timer.
        onCompromised: () => this.leases.delete(id),
      });
      const free = () => {
        if (this.leases.get(id) !== free) return;
        this.leases.delete(id);
        try {
          release();
        } catch {
          // already gone with the directory
        }
      };
      this.leases.set(id, free);
      return free;
    } catch {
      return undefined;
    }
  }

  // ---- reads -------------------------------------------------------------------------------

  private async sources(manager: Manager, known?: ManagerProjectSource[]): Promise<ManagerProjectSource[]> {
    const all = known ?? await this.deps.projects();
    return manager.projects === 'all' ? all : all.filter((source) => (manager.projects as string[]).includes(source.id));
  }

  private checkDueAt(manager: Manager, state: { lastCheckAt?: string; watchFailures: number }): number {
    return msOf(state.lastCheckAt ?? manager.createdAt) + manager.cronMinutes * 60_000 * 2 ** Math.min(state.watchFailures, MAX_WATCH_BACKOFF);
  }

  private async summarize(manager: Manager, projects?: ManagerProjectSource[]): Promise<ManagerSummary> {
    const runtime = this.runtimes.get(manager.id);
    const state = this.deps.store.state(manager.id);
    const messages = this.deps.store.messages(manager.id);
    const last = messages.at(-1);
    const newestFirst = [...messages].reverse();
    const lastTalk = newestFirst.find((message) => message.kind !== 'action' && (message.kind !== 'assistant' || message.text));
    const lastAssistant = newestFirst.find((message) => message.kind === 'assistant');
    const working = runtime?.active?.started === true || (runtime?.queue.length ?? 0) > 0;
    const preview = lastTalk && 'text' in lastTalk
      ? onePlainLine(lastTalk.text) || (lastTalk.kind === 'user' ? 'Sent attachments' : '')
      : '';
    const dueAt = this.checkDueAt(manager, state);
    const important = messages.flatMap((message) =>
      message.kind === 'assistant' && message.important && !message.streaming && unseen(state, message) ? [message] : []);
    return {
      ...manager,
      status: working ? 'working' : lastAssistant?.kind === 'assistant' && lastAssistant.error ? 'error' : 'idle',
      connectedProjectIds: (await this.sources(manager, projects)).map((source) => source.id),
      ...(last ? { lastActivityAt: last.at } : {}),
      ...(preview ? { preview } : {}),
      unread: messages.filter((message) => unseen(state, message) && message.kind !== 'user' && !(message.kind === 'assistant' && message.streaming)).length,
      important: important.length,
      ...(important.at(-1)?.headline ? { headline: important.at(-1)!.headline } : {}),
      pendingActions: messages.filter(pendingAction).length,
      pendingQuestions: messages.filter(openAsk).length,
      ...(state.lastCheckAt ? { lastCheckAt: state.lastCheckAt } : {}),
      ...(manager.cronMinutes > 0 ? { nextCheckAt: new Date(Math.max(dueAt, this.now())).toISOString() } : {}),
      costUsd: this.deps.costVisible() ? state.costUsd : 0,
    };
  }

  async list(): Promise<ManagerSummary[]> {
    const managers = this.deps.store.list();
    // One registry read for the whole list, not one per manager.
    const projects = managers.length > 0 ? await this.deps.projects() : [];
    const summaries = await Promise.all(managers.map((manager) => this.summarize(manager, projects)));
    // A delete that finished while this read was in flight already told the client: don't undo it.
    const alive = new Set(this.deps.store.list().map((manager) => manager.id));
    return summaries.filter((summary) => alive.has(summary.id)).sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
  }

  async summary(id: string): Promise<ManagerSummary | undefined> {
    const manager = this.deps.store.get(id);
    return manager ? this.summarize(manager) : undefined;
  }

  messages(id: string, query: { before?: number; limit?: number; pending?: '1' }): ManagerMessagesResponse {
    const limit = query.limit ?? 100;
    const all = this.deps.store.messages(id).filter((message) =>
      (query.before === undefined || message.seq < query.before) && (query.pending === undefined || pendingAction(message)));
    return { messages: all.slice(-limit), hasMore: all.length > limit };
  }

  async snapshot(id: string): Promise<ManagerSnapshot | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    return buildSnapshot(await this.sources(manager), this.deps.github, this.now());
  }

  private nextChange(id: string): number {
    const generation = (this.changes.get(id) ?? 0) + 1;
    this.changes.set(id, generation);
    return generation;
  }

  /** Only the newest summary is sent: an older one landing last would undo it (a row stuck working). */
  private emitSummary(id: string, generation: number, manager: ManagerSummary | undefined): void {
    if (manager && this.changes.get(id) === generation) this.deps.emit('manager-change', { id, manager });
  }

  private emitChange(id: string): void {
    const generation = this.nextChange(id);
    void this.summary(id).then((manager) => this.emitSummary(id, generation, manager), () => undefined);
  }

  private publish(id: string, message: ManagerMessage, persist: boolean): ManagerMessage {
    const written = persist ? this.deps.store.persistMessage(id, message) : this.deps.store.setLiveMessage(id, message);
    this.deps.emit('manager-message', { managerId: id, message: written });
    return written;
  }

  private addNotice(id: string, text: string): void {
    this.publish(id, { id: randomUUID(), seq: this.deps.store.nextSeq(id), at: this.iso(), kind: 'notice', text }, true);
    this.emitChange(id);
  }

  // ---- definitions -------------------------------------------------------------------------

  private async accountIssue(runner: string | undefined, agentProfile: string | undefined): Promise<ManagerRefusal | undefined> {
    if (runner !== undefined && !isRunnerId(runner)) return { error: `unknown runner: ${runner}`, status: 400 };
    if (agentProfile === undefined) return undefined;
    const provider = runner !== undefined && isRunnerId(runner) ? runner : await this.deps.defaultRunner();
    const error = await this.deps.accountError(provider, agentProfile);
    return error ? { error, status: 400 } : undefined;
  }

  async create(input: CreateManagerInput, ctx: ManagerTelemetryContext = {}): Promise<ManagerSummary | ManagerRefusal> {
    const issue = await this.accountIssue(input.runner, input.agentProfile);
    if (issue) return issue;
    const first = this.deps.store.list().length === 0;
    const id = randomUUID();
    const at = this.iso();
    const manager: Manager = {
      id,
      name: input.name ?? 'Manager',
      instructions: input.instructions,
      // The first character nobody wears: two managers must never look alike by accident.
      avatar: input.avatar ?? firstFreeAvatar(this.deps.store.list()),
      mascot: input.mascot ?? 'base',
      projects: input.projects,
      ...(input.access !== undefined ? { access: input.access } : {}),
      ...(input.projectAccess !== undefined ? { projectAccess: input.projectAccess } : {}),
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.agentProfile !== undefined ? { agentProfile: input.agentProfile } : {}),
      cronMinutes: input.cronMinutes ?? MANAGER_DEFAULT_CRON_MINUTES,
      jobs: [],
      createdAt: at,
      updatedAt: at,
    };
    this.deps.store.mutate((managers) => [...managers, manager]);
    this.deps.telemetry?.track('manager_created', managerCreatedLabel(manager, first), ctx);
    this.reschedule();
    const generation = this.nextChange(id);
    const summary = await this.summarize(manager);
    this.emitSummary(id, generation, summary);
    return summary;
  }

  async update(id: string, input: UpdateManagerInput, ctx: ManagerTelemetryContext = {}): Promise<ManagerSummary | ManagerRefusal> {
    const current = this.deps.store.get(id);
    if (!current) return { error: 'manager not found', status: 404 };
    const issue = await this.accountIssue(
      input.runner === null ? undefined : (input.runner ?? current.runner),
      input.agentProfile === null ? undefined : input.agentProfile,
    );
    if (issue) return issue;
    const optional = <K extends 'runner' | 'model' | 'effort' | 'agentProfile'>(key: K): Partial<Pick<Manager, K>> => {
      const value = input[key];
      if (value === null) return {};
      const kept = value ?? current[key];
      return kept === undefined ? {} : ({ [key]: kept } as Partial<Pick<Manager, K>>);
    };
    const { runner: _runner, model: _model, effort: _effort, agentProfile: _agentProfile, ...base } = current;
    const previousJobs = new Map(current.jobs.map((job) => [job.id, job]));
    const next: Manager = {
      ...base,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.projects !== undefined ? { projects: input.projects } : {}),
      ...(input.access !== undefined ? { access: input.access } : {}),
      ...(input.projectAccess !== undefined ? { projectAccess: input.projectAccess } : {}),
      ...(input.cronMinutes !== undefined ? { cronMinutes: input.cronMinutes } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      ...(input.mascot !== undefined ? { mascot: input.mascot } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      ...(input.jobs
        ? {
            jobs: input.jobs.map((job): ManagerJob => {
              const jobId = job.id ?? randomUUID();
              // Counted from the save, as an approved job is: a new one must not fire on the next tick.
              return { ...job, id: jobId, lastRunAt: previousJobs.get(jobId)?.lastRunAt ?? this.iso() };
            }),
          }
        : {}),
      ...optional('runner'),
      ...optional('model'),
      ...optional('effort'),
      ...optional('agentProfile'),
      updatedAt: this.iso(),
    };
    const updated = this.deps.store.update(id, () => next);
    if (!updated) return { error: 'manager not found', status: 404 };
    for (const field of changedSettingFields(current, updated)) this.deps.telemetry?.track('manager_settings_changed', field, ctx);
    if (JSON.stringify(current.projects) !== JSON.stringify(updated.projects)) {
      const names = (await this.sources(updated)).map((source) => source.name);
      this.addNotice(id, names.length > 0 ? `Connected to ${names.join(', ')}` : 'No projects connected');
    }
    this.reschedule();
    const generation = this.nextChange(id);
    const summary = await this.summarize(updated);
    this.emitSummary(id, generation, summary);
    return summary;
  }

  async remove(id: string, ctx: ManagerTelemetryContext = {}): Promise<boolean> {
    const existing = this.deps.store.get(id);
    if (!existing) return false;
    const runtime = this.runtime(id);
    runtime.deleted = true;
    runtime.queue = [];
    if (runtime.retry) clearTimeout(runtime.retry);
    this.interrupt(runtime);
    this.deps.store.mutate((managers) => managers.filter((manager) => manager.id !== id));
    this.unrecovered.delete(id);
    // The whole turn, not just its session: one still in its watch gate or setup writes state after.
    const pending = runtime.active?.settled;
    if (pending) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS * 2).unref?.())]);
    this.leases.get(id)?.();
    this.deps.store.removeFiles(id);
    this.runtimes.delete(id);
    // A summary still in flight must not bring the row back.
    this.changes.delete(id);
    this.deps.emit('manager-change', { id, deleted: true });
    this.deps.telemetry?.track('manager_deleted', managerAgeLabel(existing.createdAt, this.now()), ctx);
    this.reschedule();
    return true;
  }

  // ---- chat --------------------------------------------------------------------------------

  send(id: string, text: string, attachments: AttachmentInput[] = []): boolean {
    if (!this.deps.store.get(id)) return false;
    // Picked on the card or typed in the composer: either way the card has its answer.
    for (const message of this.deps.store.messages(id).filter(openAsk)) {
      this.publish(id, { ...message, askAnswer: text || 'Sent attachments' }, true);
      // Asked from a session the chat never saw: `Header: choice` alone answers nothing.
      if (message.turn !== 'chat') this.addNote(id, askNote(message));
    }
    const seq = this.deps.store.nextSeq(id);
    const files = attachments.map((attachment) => this.deps.store.saveAttachment(id, attachment, seq));
    const messageId = randomUUID();
    this.publish(id, {
      id: messageId,
      seq,
      at: this.iso(),
      kind: 'user',
      text,
      ...(files.length > 0 ? { attachments: files.map((file) => file.saved) } : {}),
    }, true);
    const images: ContentBlock[] = attachments.flatMap((attachment) => (isImageMediaType(attachment.mediaType)
      ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: attachment.mediaType, data: attachment.data } }]
      : []));
    const item: QueueItem = { kind: 'chat', text, images, paths: files.map((file) => file.path), messageIds: [messageId] };
    // A message typed while a limit holds carries the one waiting for it, and runs now.
    const pending = this.deps.store.state(id).resume?.chat;
    if (pending) {
      this.clearResume(id, true);
      item.text = [pending.text, text].filter(Boolean).join('\n\n');
      item.paths = [...pending.paths, ...item.paths];
      item.messageIds = [...pending.messageIds, ...item.messageIds];
    }
    this.enqueue(id, item);
    return true;
  }

  /** Interrupts the running turn. A message queued behind it still runs: it was never stopped. */
  stop(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const runtime = this.runtime(id);
    this.interrupt(runtime);
    // Also "Don't resume": the limit still holds, but nothing replays when it lifts.
    this.clearResume(id, true);
    return true;
  }

  /** Drops the hints; `keepWindow` keeps watches and jobs waiting out the limit. */
  private clearResume(id: string, keepWindow: boolean): void {
    const { store } = this.deps;
    const resume = store.state(id).resume;
    if (!resume) return;
    store.updateState(id, (state) => ({ ...state, resume: keepWindow ? { at: resume.at, messageIds: [] } : undefined }));
    for (const message of store.messages(id)) {
      if (message.kind !== 'assistant' || !resume.messageIds.includes(message.id) || !message.resumeAt) continue;
      const { resumeAt: _resumeAt, ...rest } = message;
      this.publish(id, rest, true);
    }
  }

  /** The reset of a usage limit that ended this turn, when the provider named one (spec 2026-08-03-auto-resume-after-usage-limit). */
  private usageLimit(result: DriveResult, turn: ActiveTurn): Date | undefined {
    if (!result.error || turn.stopped || turn.timedOut || this.deps.autoResume?.() === false) return undefined;
    const now = this.now();
    const quiet = result.commands.length === 0 && result.text.length <= LIMIT_REPLY_MAX;
    return (parseUsageLimit(result.error, now) ?? (quiet ? parseUsageLimit(result.text, now) : null))?.resetAt;
  }

  /** Holds every turn until `resetAt`, then replays the chat the limit cut off. */
  private armResume(id: string, resetAt: Date, messageId: string, chat?: Extract<QueueItem, { kind: 'chat' }>): void {
    this.deps.store.updateState(id, (state) => {
      const prior = state.resume;
      const at = prior && msOf(prior.at) > resetAt.getTime() ? prior.at : resetAt.toISOString();
      const merged = chat
        ? {
            text: [prior?.chat?.text, chat.text].filter(Boolean).join('\n\n'),
            paths: [...(prior?.chat?.paths ?? []), ...chat.paths],
            messageIds: [...(prior?.chat?.messageIds ?? []), ...chat.messageIds],
          }
        : prior?.chat;
      return { ...state, resume: { at, messageIds: [...new Set([...(prior?.messageIds ?? []), messageId])], ...(merged ? { chat: merged } : {}) } };
    });
  }

  read(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const messages = this.deps.store.messages(id);
    const top = messages.at(-1)?.seq ?? -1;
    const streaming = messages.flatMap((message) => (message.kind === 'assistant' && message.streaming ? [message.id] : [])).slice(-READ_STREAMING_LIMIT);
    const state = this.deps.store.state(id);
    if (state.readSeq !== top || state.readStreaming.join() !== streaming.join()) {
      this.deps.store.updateState(id, (current) => ({ ...current, readSeq: top, readStreaming: streaming }));
    }
    this.emitChange(id);
    return true;
  }

  /** `Check now`: ignores the key gate, and queues behind a running turn rather than being lost. */
  check(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const runtime = this.runtime(id);
    if (!runtime.queue.some((item) => item.kind === 'watch' && item.forced)) this.enqueue(id, { kind: 'watch', forced: true });
    return true;
  }

  private enqueue(id: string, item: QueueItem): void {
    const runtime = this.runtime(id);
    runtime.queue.push(item);
    this.emitChange(id);
    this.pump(id);
  }

  /** Chat outranks timers, and everything the user typed meanwhile folds into one turn. */
  private takeNext(runtime: Runtime): QueueItem | undefined {
    const chats = runtime.queue.filter((item): item is Extract<QueueItem, { kind: 'chat' }> => item.kind === 'chat');
    if (chats.length > 0) {
      runtime.queue = runtime.queue.filter((item) => item.kind !== 'chat');
      return {
        kind: 'chat',
        text: chats.map((item) => item.text).filter(Boolean).join('\n\n'),
        images: chats.flatMap((item) => item.images),
        paths: chats.flatMap((item) => item.paths),
        messageIds: chats.flatMap((item) => item.messageIds),
      };
    }
    return runtime.queue.shift();
  }

  private pump(id: string): void {
    const runtime = this.runtime(id);
    if (this.disposed || runtime.deleted || runtime.active || runtime.queue.length === 0) return;
    const release = this.tryLease(id);
    if (!release) {
      // A timed watch is the other cockpit's to fire; a message or a Check now the user asked for here waits.
      runtime.queue = runtime.queue.filter((item) => item.kind === 'chat' || (item.kind === 'watch' && item.forced));
      if (runtime.retry || runtime.queue.length === 0) return;
      if (runtime.retries >= LEASE_RETRY_LIMIT) {
        const sent = runtime.queue.some((item) => item.kind === 'chat');
        runtime.queue = [];
        runtime.retries = 0;
        this.addNotice(id, `Another cezar on this machine kept this manager busy. ${sent ? 'Send that again.' : 'Check again later.'}`);
        return;
      }
      runtime.retries += 1;
      runtime.retry = setTimeout(() => {
        runtime.retry = undefined;
        this.pump(id);
      }, LEASE_RETRY_MS);
      runtime.retry.unref?.();
      return;
    }
    runtime.retries = 0;
    const item = this.takeNext(runtime);
    if (!item) {
      release();
      return;
    }
    // A turn that died with its process holds no lease: a fresh one here finds its reply still streaming.
    if (this.unrecovered.has(id)) this.sweep(id, item.kind === 'chat' || item.kind === 'resume');
    const turn: ActiveTurn = {
      kind: item.kind === 'resume' ? 'chat' : item.kind,
      started: false,
      stopped: false,
      ...(item.kind === 'chat' && item.images.length > 0 ? { images: item.images } : {}),
      ...(item.kind === 'chat' ? { messageIds: item.messageIds } : {}),
    };
    runtime.active = turn;
    turn.limit = setTimeout(() => {
      turn.timedOut = true;
      if (runtime.active === turn) this.interrupt(runtime);
    }, this.deps.turnLimitMs ?? TURN_LIMIT_MS);
    turn.limit.unref?.();
    const running = this.runTurn(id, item, turn)
      .catch((error) => console.warn(`[cezar] manager ${id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (turn.stopTimer) clearTimeout(turn.stopTimer);
        clearTimeout(turn.limit);
        release();
        if (runtime.active === turn) runtime.active = undefined;
        this.settling.delete(running);
        if (runtime.deleted) return;
        this.emitChange(id);
        this.pump(id);
        this.reschedule();
      });
    turn.settled = running;
    this.settling.add(running);
  }

  // ---- one turn ----------------------------------------------------------------------------

  private async runTurn(id: string, item: QueueItem, turn: ActiveTurn): Promise<void> {
    const manager = this.deps.store.get(id);
    if (!manager) return;
    const { store } = this.deps;
    if (item.kind === 'resume') {
      const resume = store.state(id).resume;
      if (!resume || msOf(resume.at) > this.now()) return;
      this.clearResume(id, false);
      if (!resume.chat) return;
      // Pasted images are not kept as blocks; their saved paths still reach the prompt.
      item = { kind: 'chat', ...resume.chat, images: [] };
      turn.messageIds = item.messageIds;
    }
    if (item.kind === 'watch') {
      // Stamped first: a snapshot that throws must wait for the next tick, not retry in a loop.
      store.updateState(id, (state) => ({ ...state, lastCheckAt: this.iso() }));
      const snapshot = await this.snapshot(id);
      // Deleted meanwhile: writing the gate's state would bring the directory back.
      if (!snapshot || !store.get(id)) return;
      const { fresh, kept } = gateAttention(snapshot, store.state(id).reported);
      // Keys a failed turn could not report stay fresh, so none left means the failure is over.
      store.updateState(id, (state) => ({ ...state, reported: kept, ...(fresh.length === 0 ? { watchFailures: 0 } : {}) }));
      // The brake that makes a 15-minute default affordable: a quiet repository costs nothing.
      if (fresh.length === 0 && !item.forced) {
        this.emitChange(id);
        return;
      }
      await this.watchTurn(id, manager, snapshot, fresh, item.forced, turn);
      return;
    }
    if (item.kind === 'chat') {
      // Only the session the user talks to needs them, and only a turn that landed has heard them.
      const { notes } = store.state(id);
      const heard = (await this.visibleTurn(id, manager, chatPrompt(item.text, notes, item.paths, item.messageIds), 'chat', turn, undefined, item)) === 'heard';
      if (heard && notes.length > 0) store.updateState(id, (state) => ({ ...state, notes: state.notes.slice(notes.length) }));
      return;
    }
    const job = manager.jobs.find((candidate) => candidate.id === item.jobId);
    if (!job) return;
    // Stamped here, under the lease: a cockpit that lost the race must not eat the interval.
    const lastRunAt = this.iso();
    store.update(id, (current) => ({
      ...current,
      jobs: current.jobs.map((candidate) => (candidate.id === job.id ? { ...candidate, lastRunAt } : candidate)),
    }));
    const outcome = await this.visibleTurn(id, manager, jobPrompt(job.name, job.prompt), 'job', turn, job.name);
    // Due again, so it runs as soon as the limit lifts.
    if (outcome === 'limited') {
      store.update(id, (current) => ({
        ...current,
        jobs: current.jobs.map((candidate) => (candidate.id === job.id ? { ...candidate, lastRunAt: job.lastRunAt } : candidate)),
      }));
    }
  }

  private addNote(id: string, note: string): void {
    this.deps.store.updateState(id, (state) => ({ ...state, notes: [...state.notes, note].slice(-20) }));
  }

  /** `heard` when the agent really took the turn. */
  private async visibleTurn(
    id: string,
    manager: Manager,
    prompt: string,
    kind: ManagerTurnKind,
    turn: ActiveTurn,
    jobName?: string,
    chat?: Extract<QueueItem, { kind: 'chat' }>,
  ): Promise<TurnOutcome> {
    const { store } = this.deps;
    const base = { id: randomUUID(), seq: store.nextSeq(id), at: this.iso(), kind: 'assistant' as const, turn: kind, ...(jobName ? { jobName } : {}) };
    let sent = this.publish(id, { ...base, text: '', streaming: true, commands: [] }, true);
    let keyframe = 0;
    let throttle: NodeJS.Timeout | undefined;
    let read: Progress = () => ({ text: '', commands: [] });
    const flush = () => {
      throttle = undefined;
      const latest = read();
      // Output stays for the final frame: every open tab parses these ten times a second. A task
      // start keeps its line, so the card appears while the turn is still running.
      const commands = latest.commands.map((command) => {
        if (/\btask create\b/.test(command.summary)) return command;
        const { output: _output, ...rest } = command;
        return rest;
      });
      const text = judged(latest.text).text.replace(STREAMING_ASK, '').trim();
      // Diffed after redaction: a secret completing mid-stream rewrites the prefix, a full frame.
      const live = store.setLiveMessage(id, { ...base, text, commands, streaming: true });
      if (live.kind !== 'assistant' || sent.kind !== 'assistant') return;
      const before = sent;
      sent = live;
      if (!live.text.startsWith(before.text) || live.text.length >= Math.max(keyframe * 2, KEYFRAME_FLOOR)) {
        keyframe = live.text.length;
        this.deps.emit('manager-message', { managerId: id, message: live });
        return;
      }
      const sameCommands = JSON.stringify(before.commands) === JSON.stringify(live.commands);
      if (sameCommands && live.text.length === before.text.length) return;
      this.deps.emit('manager-delta', {
        managerId: id,
        messageId: base.id,
        offset: before.text.length,
        append: live.text.slice(before.text.length),
        ...(sameCommands ? {} : { commands: live.commands }),
      });
    };
    const startedAt = this.now();
    const result = await this.drive(id, manager, prompt, turn, (progress) => {
      read = progress;
      if (!throttle) {
        throttle = setTimeout(flush, STREAM_THROTTLE_MS);
        throttle.unref?.();
      }
    }).catch(turnFailure);
    this.reportTurn(manager, turn, startedAt, result);
    if (throttle) clearTimeout(throttle);
    if (!store.get(id)) return 'failed';
    this.addCost(id, result.costUsd);
    const resetAt = this.usageLimit(result, turn);
    const cause = result.error ? failureCause(result.error, result.text) : undefined;
    const failed = cause && !turn.stopped && !resetAt ? this.recordFailure(id, kind, cause, result.runner) : undefined;
    // The CLI's own error line, echoed as the reply, is the cause the human line replaces.
    const reply = failed && result.text.trim() === cause?.trim() ? '' : result.text;
    const judgement = judged(reply.replace(QUIET_LINE, '').trim());
    this.publish(id, {
      ...base,
      text: judgement.text,
      ...judgedFields(judgement),
      streaming: false,
      commands: result.commands,
      ...(turn.timedOut ? { error: TURN_LIMIT_ERROR } : turn.stopped ? { stopped: true } : {}),
      ...(resetAt ? { resumeAt: resetAt.toISOString() } : failed ? { error: failed } : {}),
      ...(this.deps.costVisible() && result.costUsd > 0 ? { costUsd: result.costUsd } : {}),
    }, true);
    if (resetAt) {
      this.armResume(id, resetAt, base.id, chat);
      return 'limited';
    }
    const body = alertBody(judgement);
    if (body) this.alert(id, base, body);
    const heard = !result.error && !turn.stopped;
    // A turn that got through proves the limit lifted (or the account changed).
    if (heard && kind === 'chat') this.clearResume(id, false);
    return heard ? 'heard' : 'failed';
  }

  /** Delayed, then skipped if the chat was read meanwhile: an open tab needs no interruption. */
  private alert(id: string, message: { id: string; seq: number }, body: string): void {
    const { notifySystem, store } = this.deps;
    if (!notifySystem) return;
    const timer = setTimeout(() => {
      this.alerts.delete(timer);
      const manager = store.get(id);
      if (!manager || manager.notify === false || !unseen(store.state(id), message)) return;
      notifySystem(manager.name, body);
    }, SYSTEM_NOTIFY_DELAY_MS);
    timer.unref?.();
    this.alerts.add(timer);
  }

  private async watchTurn(
    id: string,
    manager: Manager,
    snapshot: ManagerSnapshot,
    fresh: ManagerSnapshot['attention'],
    forced: boolean,
    turn: ActiveTurn,
  ): Promise<void> {
    const { store } = this.deps;
    const startedAt = this.now();
    const result = await this.drive(id, manager, watchPrompt(snapshot, fresh), turn, () => undefined).catch(turnFailure);
    this.reportTurn(manager, turn, startedAt, result);
    if (!store.get(id)) return;
    this.addCost(id, result.costUsd);
    // A user's Stop leaves the keys fresh for the next check; a hung backend is a failure the chat shows.
    if (turn.stopped && !turn.timedOut) return;
    const error = turn.timedOut ? TURN_LIMIT_ERROR : result.error;
    const lastMessage = store.messages(id).at(-1);
    const resetAt = this.usageLimit(result, turn);
    if (resetAt) {
      // Not a failure: no backoff, and its keys stay fresh for the check after the reset.
      const repeat = lastMessage?.kind === 'assistant' && lastMessage.turn === 'watch' && lastMessage.resumeAt ? lastMessage : undefined;
      const messageId = repeat?.id ?? randomUUID();
      this.publish(id, {
        id: messageId,
        seq: repeat?.seq ?? store.nextSeq(id),
        at: this.iso(),
        kind: 'assistant',
        turn: 'watch',
        text: result.commands.length === 0 ? result.text.trim() : '',
        streaming: false,
        commands: [],
        resumeAt: resetAt.toISOString(),
      }, true);
      this.armResume(id, resetAt, messageId);
      return;
    }
    if (error) {
      // Nobody asked for this turn: the cause goes to diagnostics, and the chat hears only of a streak.
      const advice = turn.timedOut ? TURN_LIMIT_ERROR : this.recordFailure(id, 'watch', failureCause(error, result.text), result.runner);
      const failures = store.updateState(id, (state) => ({ ...state, watchFailures: state.watchFailures + 1 })).watchFailures;
      if (failures < WATCH_NOTICE_AFTER) return;
      const text = `Background checks keep failing. ${advice}`;
      // One line for the whole streak: a dead login must not add a message every check.
      const noticeId = store.state(id).watchNoticeId;
      const repeat = lastMessage?.kind === 'notice' && lastMessage.id === noticeId ? lastMessage : undefined;
      if (repeat?.text === text) return;
      const notice = { id: repeat?.id ?? randomUUID(), seq: repeat?.seq ?? store.nextSeq(id), at: this.iso(), kind: 'notice' as const, text };
      this.publish(id, notice, true);
      store.updateState(id, (state) => ({ ...state, watchNoticeId: notice.id }));
      return;
    }
    const reportedAt = this.iso();
    store.updateState(id, (state) => ({
      ...state,
      watchFailures: 0,
      watchNoticeId: undefined,
      reported: { ...state.reported, ...Object.fromEntries(snapshot.attention.map((item) => [item.key, reportedAt])) },
    }));
    const raw = result.text.trim();
    if (!raw || QUIET_LINE.test(raw)) {
      if (forced) this.addNotice(id, 'Checked: nothing needs you right now.');
      return;
    }
    const judgement = judged(raw);
    const written = this.publish(id, {
      id: randomUUID(),
      seq: store.nextSeq(id),
      at: this.iso(),
      kind: 'assistant',
      turn: 'watch',
      text: judgement.text,
      ...judgedFields(judgement),
      streaming: false,
      commands: result.commands,
      ...(this.deps.costVisible() && result.costUsd > 0 ? { costUsd: result.costUsd } : {}),
    }, true);
    const body = alertBody(judgement);
    if (body) this.alert(id, written, body);
  }

  /** `manager_turn_completed`, and the turn's duration as a timing (stopped turns time nothing). */
  private reportTurn(manager: Manager, turn: ActiveTurn, startedAt: number, result: DriveResult): void {
    const { telemetry } = this.deps;
    if (!telemetry) return;
    const trigger = MANAGER_TURN_TRIGGER[turn.kind];
    const outcome = turn.timedOut || (result.error && !turn.stopped) ? 'error' : turn.stopped ? 'stopped' : 'ok';
    telemetry.track('manager_turn_completed', `${trigger}:${outcome}`);
    if (outcome === 'stopped') return;
    telemetry.timing('manager_turn', this.now() - startedAt, {
      operation: trigger,
      target: manager.runner !== undefined && isRunnerId(manager.runner) ? manager.runner : 'default',
      outcome: turn.timedOut ? 'timeout' : outcome === 'error' ? 'error' : 'ok',
    });
  }

  /** Keeps a failed turn's real cause in the cockpit log and the manager's state; returns the line a user may see. */
  private recordFailure(id: string, turn: ManagerTurnKind, cause: string, runner: RunnerId | undefined): string {
    const kind: ManagerFailureKind = classifyManagerFailure(cause);
    console.warn(`[cezar] manager ${id}: ${turn} turn failed (${kind}): ${cause}`);
    this.deps.store.updateState(id, (state) => ({ ...state, lastFailure: { at: this.iso(), turn, kind, cause: cause.slice(0, OUTPUT_LIMIT) } }));
    return managerFailureMessage(kind, cause, runner, kind === 'usage-limit' ? parseUsageLimit(cause, this.now())?.resetAt : undefined);
  }

  private addCost(id: string, usd: number): void {
    if (usd > 0) this.deps.store.updateState(id, (state) => ({ ...state, costUsd: state.costUsd + usd }));
  }

  /** One agent session, resumed when there is one; a failed resume restarts from a recap once. */
  private async drive(
    id: string,
    manager: Manager,
    prompt: string,
    turn: ActiveTurn,
    onProgress: (progress: Progress) => void,
  ): Promise<DriveResult> {
    const { store } = this.deps;
    const configured = manager.runner !== undefined && isRunnerId(manager.runner) ? manager.runner : undefined;
    const runner = configured ?? (await this.deps.defaultRunner());
    const sessionKey = `${runner}|${manager.agentProfile ?? ''}`;
    const state = store.state(id);
    const field = SESSION_FIELD[turn.kind];
    const resumeId = state.sessionKey === sessionKey ? state[field] : undefined;
    const resumable = resumeId !== undefined;
    const sources = await this.sources(manager);
    const profile = supportsProfiles(runner) ? await resolveProfileEnvForRoot(undefined, runner, manager.agentProfile) : { env: {} };
    // Stopped or deleted during setup: building the spec would recreate the workdir.
    if (turn.stopped) return { text: '', commands: [], costUsd: 0 };
    const apiUrl = process.env.CEZ_API_URL;
    let shimDir: string | undefined;
    try {
      shimDir = ensureManagerShim();
    } catch (error) {
      console.warn(`[cezar] manager shim: ${error instanceof Error ? error.message : String(error)}`);
    }
    const locked = agentModelsLocked();
    let writable: string | undefined;
    if (runner === 'claude' && turn.kind !== 'watch') {
      try {
        // Real path: Claude matches the resolved one, and a symlinked home would never match.
        writable = realpathSync(store.filesDir(id));
      } catch {
        // a read-only home: the turn still runs, it just cannot Write
      }
    }
    // An unattended watch reads untrusted PR text; where `bashAllowlist` is no fence, the backend's
    // own read-only mode is. The snapshot is already in the prompt.
    const readOnlyWatch = turn.kind === 'watch' && !ALLOWLIST_FENCED.has(runner) && canEnforceReadOnly(runner);
    const base: AgentRunSpec = {
      systemPrompt: managerSystemPrompt(manager, sources.map((source) => ({ id: source.id, name: source.name, access: managerAccessOf(manager, source.id) }))),
      userPrompt: prompt,
      cwd: store.workdir(id),
      allowedTools: writable ? [...MANAGER_ALLOWED_TOOLS, ...managerWriteRules(writable)] : MANAGER_ALLOWED_TOOLS,
      bashAllowlist: MANAGER_BASH_ALLOWLIST,
      // Attachments stay readable: "that screenshot" can come a few turns later.
      additionalDirectories: [
        ...sources.filter((source) => source.available).map((source) => source.root),
        ...(existsSync(store.attachmentsDir(id)) ? [store.attachmentsDir(id)] : []),
      ],
      ...(turn.images ? { images: turn.images } : {}),
      env: {
        ...profile.env,
        CEZ_MANAGER_ID: id,
        CEZ_MANAGER_TURN: turn.kind,
        ...(apiUrl ? { CEZ_API_URL: apiUrl } : {}),
        ...(process.env.CEZ_BIN ? { CEZ_BIN: process.env.CEZ_BIN } : {}),
        ...(shimDir ? { PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
        ...(readOnlyWatch ? readOnlyEnv() : {}),
      },
      ...(readOnlyWatch ? { enforceReadOnly: true } : {}),
      ...(manager.model && !locked ? { model: manager.model } : {}),
      // Another backend refuses an explicit effort, so a manager moved off one drops it.
      ...(manager.effort && runnerSupportsReasoningEffort(runner) ? { reasoningEffort: manager.effort } : {}),
    };
    const first = await this.session(id, base, sessionKey, runner, resumeId, turn, onProgress);
    // A turn that ran a command may have acted: running it twice could act twice.
    if (!first.error || turn.stopped || turn.timedOut || first.commands.length > 0) return { ...first, runner };
    const plan = retryPlan(classifyManagerFailure(failureCause(first.error, first.text)), resumable);
    if (plan === 'none') return { ...first, runner };
    if (plan === 'again') {
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? RETRY_BACKOFF_MS).unref?.());
      if (turn.stopped || !store.get(id)) return { ...first, runner };
      const again = await this.session(id, base, sessionKey, runner, resumeId, turn, onProgress);
      return { ...again, costUsd: again.costUsd + first.costUsd, runner };
    }
    // Only a chat gets the transcript back: it holds what watches read.
    const recap = turn.kind === 'chat'
      ? recapPrompt(store.messages(id).filter((message) => !(message.kind === 'assistant' && message.streaming)))
      : '';
    const fresh = await this.session(id, { ...base, userPrompt: `${recap}${prompt}` }, sessionKey, runner, undefined, turn, onProgress);
    return { ...fresh, costUsd: fresh.costUsd + first.costUsd, runner };
  }

  private async session(
    id: string,
    base: AgentRunSpec,
    sessionKey: string,
    runnerId: RunnerId,
    resumeId: string | undefined,
    turn: ActiveTurn,
    onProgress: (progress: Progress) => void,
  ): Promise<DriveResult> {
    const { store } = this.deps;
    // Claude takes an id we mint; every other backend mints its own and reports it (`session`).
    const sessionId = resumeId ?? (runnerId === 'claude' ? randomUUID() : undefined);
    const spec: AgentRunSpec = { ...base, ...(sessionId ? { sessionId } : {}), ...(resumeId ? { resume: true } : {}) };
    let committed = '';
    let draft = '';
    let costUsd = 0;
    let error: string | undefined;
    let saved = false;
    const commands: ManagerCommand[] = [];
    const text = () => [committed, draft].filter(Boolean).join('\n\n');
    // Read when the throttle flushes, not per token: re-joining a long reply per delta is quadratic.
    const snapshot: Progress = () => ({ text: text(), commands: [...commands] });
    const progress = () => onProgress(snapshot);
    const saveSession = (value: string) => {
      if (saved || !store.get(id)) return;
      saved = true;
      const field = SESSION_FIELD[turn.kind];
      store.updateState(id, (state) => ({
        ...state,
        // A transcript does not follow a runner or account change: drop its siblings with it.
        ...(state.sessionKey === sessionKey ? {} : { sessionId: undefined, watchSessionId: undefined, jobSessionId: undefined }),
        [field]: value,
        sessionKey,
      }));
    };
    const onEvent = (event: AgentEvent) => {
      // An error first means no transcript exists; resuming it would only fail again.
      if (sessionId && event.type !== 'error') saveSession(sessionId);
      switch (event.type) {
        case 'session':
          saved = false;
          saveSession(event.sessionId);
          break;
        case 'text':
          committed = [committed, event.text].filter(Boolean).join('\n\n');
          draft = '';
          progress();
          break;
        case 'tool-call':
          commands.push({ id: event.id, tool: event.tool, summary: commandSummary(event.input) || event.tool });
          progress();
          break;
        case 'tool-result': {
          const index = commands.findIndex((command) => command.id === event.toolCallId);
          const command = commands[index];
          if (command) {
            commands[index] = { ...command, output: event.result.slice(0, OUTPUT_LIMIT), ...(event.isError ? { isError: true } : {}) };
            progress();
          }
          break;
        }
        case 'cost':
          costUsd += event.usd;
          break;
        // The first is the cause; the CLI's "exited with code 1" that follows it is only the effect.
        case 'error':
          error ??= event.message;
          break;
        default:
          break;
      }
    };
    const onUiEvent = (event: UiEvent) => {
      if (event.type === 'item.delta' && event.field === 'text') {
        draft += event.delta;
        progress();
      }
    };
    if (turn.stopped) return { text: '', commands, costUsd };
    turn.started = true;
    this.emitChange(id);
    try {
      const runner = (this.deps.runnerFor ?? createRunner)(runnerId);
      const session = runner.startSession(spec, onEvent, { autoEndAfterFirstTurn: true, onUiEvent });
      turn.session = session;
      if (turn.stopped) session.interrupt();
      await session.result;
    } catch (cause) {
      error ??= cause instanceof Error ? cause.message : String(cause);
    }
    return { text: committed || draft, commands, costUsd, ...(error ? { error } : {}) };
  }

  // ---- the timer ---------------------------------------------------------------------------

  private nextDue(manager: Manager, now: number): number | undefined {
    const resume = this.deps.store.state(manager.id).resume;
    if (resume) return Math.max(msOf(resume.at), now);
    const dues = manager.jobs.filter((job) => job.enabled).map((job) => msOf(job.lastRunAt ?? manager.createdAt) + job.everyMinutes * 60_000);
    if (manager.cronMinutes > 0) dues.push(this.checkDueAt(manager, this.deps.store.state(manager.id)));
    return dues.length > 0 ? Math.max(Math.min(...dues), now) : undefined;
  }

  /** Armed for the earliest due manager, never for none. Missed ticks collapse into one. */
  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.disposed) return;
    const now = this.now();
    const dues = this.deps.store.list().flatMap((manager) => this.nextDue(manager, now) ?? []);
    if (dues.length === 0) return;
    const delay = Math.min(Math.max(Math.min(...dues) - now, TICK_FLOOR_MS), MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.tick();
      this.reschedule();
    }, delay);
    this.timer.unref?.();
  }

  /** Public for tests; the timer is its only production caller. */
  tick(): void {
    const now = this.now();
    for (const manager of this.deps.store.list()) {
      const runtime = this.runtime(manager.id);
      if (runtime.active || runtime.queue.length > 0) continue;
      const resume = this.deps.store.state(manager.id).resume;
      if (resume) {
        if (msOf(resume.at) > now) continue;
        // Claimed in `runTurn`: a cockpit that loses the lease drops it, as it does a timed watch.
        this.enqueue(manager.id, { kind: 'resume' });
      }
      const state = this.deps.store.state(manager.id);
      if (manager.cronMinutes > 0 && this.checkDueAt(manager, state) <= now) {
        this.enqueue(manager.id, { kind: 'watch', forced: false });
      }
      for (const job of manager.jobs) {
        if (!job.enabled || msOf(job.lastRunAt ?? manager.createdAt) + job.everyMinutes * 60_000 > now) continue;
        this.enqueue(manager.id, { kind: 'job', jobId: job.id });
      }
    }
  }

  // ---- the agent's tools -------------------------------------------------------------------

  private async toolScope(id: string, projectId: string | undefined, write: boolean): Promise<{ manager: Manager; source?: ManagerProjectSource } | ManagerRefusal> {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    if (write && this.runtimes.get(id)?.active?.kind === 'watch') return { error: WATCH_REFUSAL, status: 409 };
    if (projectId === undefined) return { manager };
    const source = (await this.sources(manager)).find((candidate) => candidate.id === projectId);
    if (!source) return { error: `this manager is not connected to project ${projectId}`, status: 403 };
    return { manager, source };
  }

  private async forward(path: string, init?: { method: string; body?: unknown }): Promise<Response> {
    return this.deps.request(`/api/v1${path}`, {
      method: init?.method ?? 'GET',
      headers: { host: '127.0.0.1', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  private static async refusalOf(response: Response): Promise<ManagerRefusal> {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    const status = response.status;
    return {
      error: typeof body.error === 'string' ? body.error : `${status} ${response.statusText}`,
      status: status === 400 || status === 403 || status === 404 || status === 409 ? status : 502,
    };
  }

  async taskDetail(id: string, projectId: string, runId: string): Promise<ManagerTaskDetail | ManagerRefusal> {
    const scope = await this.toolScope(id, projectId, false);
    if ('error' in scope) return scope;
    const source = scope.source;
    const rows = source ? taskDetailRows(source.runs(), runId) : undefined;
    if (!source || !rows) return { error: 'task not found', status: 404 };
    const lastMessage = lastAssistantText(source.root, runId);
    return { ...rows, ...(lastMessage ? { lastMessage } : {}) };
  }

  /** The user's own chat message, read off the log: `fromMessage` copies it verbatim, attachments too. */
  private forwardOf(id: string, ref: string): Forward | ManagerRefusal {
    const { store } = this.deps;
    const newestFirst = [...store.messages(id)].reverse();
    const wanted = ref === 'last' ? this.runtimes.get(id)?.active?.messageIds?.at(-1) : ref;
    const message = wanted ? newestFirst.find((candidate) => candidate.id === wanted) : newestFirst.find((candidate) => candidate.kind === 'user');
    if (message?.kind !== 'user') return { error: ref === 'last' ? 'there is no user message to forward' : `no user message ${ref} in this chat`, status: 404 };
    const images: AttachmentInput[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const attachment of message.attachments ?? []) {
      const label = attachment.name ?? attachment.file;
      let data: string;
      try {
        data = readFileSync(join(store.attachmentsDir(id), attachment.file)).toString('base64');
      } catch {
        skipped.push(label);
        continue;
      }
      // The bounds `POST /runs` and `/messages` hold an attachment list to (`attachmentInputSchema`).
      if (data.length > ATTACHMENT_BASE64_LIMIT || total + data.length > MAX_ATTACHMENTS_TOTAL_BASE64 || images.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        skipped.push(label);
        continue;
      }
      total += data.length;
      images.push({ mediaType: attachment.mediaType, data, ...(attachment.name ? { name: attachment.name } : {}) });
    }
    return {
      text: message.text,
      images,
      forwarded: { messageId: message.id, chars: message.text.length, attachments: images.length, ...(skipped.length > 0 ? { skipped } : {}) },
    };
  }

  /** The text a task receives: the model's words, then the forwarded message. Placeholders refused. */
  private composed(id: string, written: string | undefined, input: { fromMessage?: string; allowPlaceholder?: boolean }): { text: string; forward?: Forward } | ManagerRefusal {
    const forward = input.fromMessage !== undefined ? this.forwardOf(id, input.fromMessage) : undefined;
    if (forward && 'error' in forward) return forward;
    // A forward brings the content itself, so only bare text can have lost it to a placeholder.
    const marker = forward || input.allowPlaceholder ? undefined : placeholderIn(written);
    if (marker) return { error: placeholderRefusal(marker), status: 400 };
    const text = forward ? withForwarded(written, forward.text, forward.images.length) : written ?? '';
    if (text.length > FORWARD_TEXT_LIMIT) {
      return { error: `the text and the forwarded message come to ${text.length} characters; a task takes at most ${FORWARD_TEXT_LIMIT}. Shorten your part, or forward without one.`, status: 400 };
    }
    return { text, ...(forward ? { forward } : {}) };
  }

  async createTask(id: string, input: ManagerCreateTaskInput): Promise<ManagerCreateTaskResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const readOnly = managerAccessOf(scope.manager, input.projectId) === 'read';
    if (readOnly) {
      if (input.dispatch || (input.workflow && input.workflow !== 'quick-task')) {
        return { error: `${input.projectId} is read-only for this manager: only a plain read-only task can start there`, status: 403 };
      }
    }
    const composed = this.composed(id, input.task, input);
    if ('error' in composed) return composed;
    const { forward } = composed;
    const prefix = `/p/${encodeURIComponent(input.projectId)}`;
    const response = await this.forward(`${prefix}/runs`, {
      method: 'POST',
      body: {
        workflow: input.workflow ?? 'quick-task',
        task: composed.text,
        ...(forward && forward.images.length > 0 ? { images: forward.images } : {}),
        systemPrompt: MANAGER_TASK_SYSTEM_PROMPT,
        ...(readOnly ? { readOnly: true, enforceReadOnly: true } : {}),
        ...(input.runner ? { runner: input.runner } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.dispatch ? { dispatch: {} } : {}),
      },
    });
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const run = (await response.json()) as { id: string };
    this.deps.telemetry?.track('manager_task_started', managerWorkflowLabel(input.workflow));
    if (input.title) {
      await this.forward(`${prefix}/runs/${encodeURIComponent(run.id)}`, { method: 'PATCH', body: { title: input.title } }).catch(() => undefined);
    }
    return { projectId: input.projectId, runId: run.id, ...(forward ? { forwarded: forward.forwarded } : {}) };
  }

  /** A live task takes the message; a finished one is continued with it. */
  async taskMessage(id: string, input: ManagerTaskMessageInput): Promise<ManagerTaskMessageResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    // A write task told what to do next would be write access by proxy; so would an Ask task,
    // whose read-only tools some backends ignore.
    if (managerAccessOf(scope.manager, input.projectId) === 'read' && !scope.source?.runs().find((run) => run.id === input.runId)?.enforceReadOnly) {
      return { error: `${input.projectId} is read-only for this manager: it can only message read-only tasks`, status: 403 };
    }
    const composed = this.composed(id, input.text, input);
    if ('error' in composed) return composed;
    const { forward } = composed;
    const body = { text: composed.text, ...(forward && forward.images.length > 0 ? { images: forward.images } : {}) };
    const sent = { ok: true as const, ...(forward ? { forwarded: forward.forwarded } : {}) };
    const path = `/p/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(input.runId)}`;
    const delivered = await this.forward(`${path}/messages`, { method: 'POST', body });
    if (delivered.ok) return sent;
    if (delivered.status !== 409) return ManagerEngine.refusalOf(delivered);
    const continued = await this.forward(`${path}/continue`, { method: 'POST', body });
    return continued.ok ? sent : ManagerEngine.refusalOf(continued);
  }

  /** Checked against the forge now, so a card never offers a merge that was already impossible. */
  private async stampAction(action: ManagerActionRequest): Promise<ManagerActionRequest | ManagerRefusal> {
    if (action.type === 'add-job') return action;
    const prefix = `/p/${encodeURIComponent(action.projectId)}`;
    if (action.type === 'merge-pr') {
      const response = await this.forward(`${prefix}/github/prs/${action.number}/merge-state`);
      if (!response.ok) return ManagerEngine.refusalOf(response);
      const body = (await response.json()) as { available: boolean; reason?: string; mergeState?: { title: string; state: string; headSha: string } };
      if (!body.available || !body.mergeState) return { error: body.reason ?? 'GitHub merge is unavailable', status: 409 };
      if (body.mergeState.state !== 'open') return { error: `#${action.number} is already ${body.mergeState.state}`, status: 409 };
      // The forge's title, never the agent's: the card is what the user decides on.
      return { ...action, title: body.mergeState.title.slice(0, 1000), headSha: body.mergeState.headSha };
    }
    const response = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}`);
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const { automation } = (await response.json()) as { automation?: AutomationDefinition };
    if (!automation) return { error: 'automation not found', status: 404 };
    if (automation.enabled) return { error: 'that automation is already enabled', status: 409 };
    const { id: _id, revision: _revision, enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = automation;
    return { ...action, name: automation.name.slice(0, 1000), revision: automation.revision, summary: clipSummary(JSON.stringify(definition)) };
  }

  async propose(id: string, input: ManagerProposeActionInput): Promise<{ actionId: string; status: ManagerActionStatus } | ManagerRefusal> {
    const scope = await this.toolScope(id, actionProject(input.action), true);
    if ('error' in scope) return scope;
    const refused = accessRefusal(scope.manager, input.action);
    if (refused) return { error: refused, status: 403 };
    const action = await this.stampAction(input.action);
    if ('error' in action) return action;
    const same = (other: ManagerActionRequest) => actionKey(other) === actionKey(action);
    const pending = this.deps.store.messages(id).find((message) => message.kind === 'action' && message.status === 'pending' && same(message.action));
    if (pending) return { actionId: pending.id, status: 'pending' };
    const message: ManagerMessage = {
      id: randomUUID(),
      seq: this.deps.store.nextSeq(id),
      at: this.iso(),
      kind: 'action',
      action,
      ...(input.reason ? { reason: input.reason } : {}),
      status: 'pending',
    };
    this.publish(id, message, true);
    this.deps.telemetry?.track('manager_action_proposed', managerActionLabel(action));
    this.emitChange(id);
    // An approval always waits on the user, so it never needs the agent's judgement.
    this.alert(id, message, `Needs your approval: ${describe(action)}`);
    return { actionId: message.id, status: 'pending' };
  }

  /** The only path to a merge or an enabled automation; the agent's tools cannot reach it. */
  async decide(id: string, actionId: string, decision: 'approve' | 'reject', ctx: ManagerTelemetryContext = {}): Promise<{ ok: true } | ManagerRefusal> {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    const message = this.deps.store.message(id, actionId);
    if (message?.kind !== 'action') return { error: 'action not found', status: 404 };
    if (message.status !== 'pending') return { error: `this action is already ${message.status}`, status: 409 };
    const type = managerActionLabel(message.action);
    this.deps.telemetry?.track('manager_action_decided', `${type}:${decision}`, ctx);
    const proposedAt = Date.parse(message.at);
    if (Number.isFinite(proposedAt)) this.deps.telemetry?.timing('manager_action_decision', Math.max(0, this.now() - proposedAt), { operation: type, target: decision, outcome: 'ok' });
    const settle = (status: ManagerActionStatus, result: string) => {
      // Deleted while the action ran: writing the result would recreate its directory.
      if (!this.deps.store.get(id)) return;
      this.publish(id, { ...message, status, result }, true);
      this.addNote(id, `${describe(message.action)}: ${result}`);
      this.emitChange(id);
    };
    if (decision === 'reject') {
      settle('rejected', 'Rejected');
      return { ok: true as const };
    }
    this.publish(id, { ...message, status: 'running' }, true);
    const projectId = actionProject(message.action);
    let outcome: { ok: boolean; result: string };
    try {
      const connected = projectId === undefined || (await this.sources(manager)).some((source) => source.id === projectId);
      // Read fresh: access may have been lowered while the card waited.
      const refused = accessRefusal(this.deps.store.get(id) ?? manager, message.action);
      outcome = !connected
        ? { ok: false, result: `This manager is no longer connected to ${projectId}.` }
        : refused
          ? { ok: false, result: refused }
          : await this.perform(id, message.action);
    } catch (cause) {
      // `running` has no other exit but a restart.
      outcome = { ok: false, result: cause instanceof Error ? cause.message : String(cause) };
    }
    settle(outcome.ok ? 'done' : 'failed', outcome.result);
    return { ok: true as const };
  }

  private async perform(id: string, action: ManagerActionRequest): Promise<{ ok: boolean; result: string }> {
    if (action.type === 'add-job') {
      // Counted from now: an approved job must not fire seconds after the click.
      const added = this.addJob(id, { name: action.name, prompt: action.prompt, everyMinutes: action.everyMinutes, enabled: true, lastRunAt: this.iso() });
      return 'error' in added ? { ok: false, result: added.error } : { ok: true, result: `Added job ${action.name}` };
    }
    const prefix = `/p/${encodeURIComponent(action.projectId)}`;
    if (action.type === 'enable-automation') {
      const current = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}`);
      if (!current.ok) return { ok: false, result: (await ManagerEngine.refusalOf(current)).error };
      const { automation } = (await current.json()) as { automation?: { revision?: number } };
      if (automation?.revision !== action.revision) return { ok: false, result: 'This automation changed after the proposal. Ask for a new one.' };
      const response = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}/enable`, { method: 'POST' });
      if (response.ok) return { ok: true, result: `Enabled ${action.name ?? action.automationId}` };
      return { ok: false, result: (await ManagerEngine.refusalOf(response)).error };
    }
    const state = await this.forward(`${prefix}/github/prs/${action.number}/merge-state?refresh=1`);
    const body = (await state.json().catch(() => ({}))) as { available?: boolean; reason?: string; mergeState?: { headSha: string; defaultMethod: 'merge' | 'squash' | 'rebase' | null; methods: Array<'merge' | 'squash' | 'rebase'> } };
    if (!body.available || !body.mergeState) return { ok: false, result: body.reason ?? 'GitHub merge is unavailable' };
    const method = action.method ?? body.mergeState.defaultMethod ?? body.mergeState.methods[0];
    if (!method) return { ok: false, result: 'This repository allows no merge method.' };
    // The head the user was shown: a push after the proposal refuses instead of merging unseen code.
    const merged = await this.forward(`${prefix}/github/prs/${action.number}/merge`, {
      method: 'POST',
      body: { method, expectedHeadSha: action.headSha ?? body.mergeState.headSha },
    });
    if (merged.ok) return { ok: true, result: `Merged #${action.number}` };
    return { ok: false, result: (await ManagerEngine.refusalOf(merged)).error };
  }

  /** Reached only from an approved `add-job`; the cockpit edits jobs through `update`. */
  private addJob(id: string, input: Omit<ManagerJob, 'id'>): ManagerJob | ManagerRefusal {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    if (manager.jobs.length >= 32) return { error: 'a manager holds at most 32 jobs', status: 409 };
    const job: ManagerJob = { ...input, id: randomUUID() };
    this.deps.store.update(id, (manager) => ({ ...manager, jobs: [...manager.jobs.filter((other) => other.id !== job.id), job], updatedAt: this.iso() }));
    this.reschedule();
    this.emitChange(id);
    return job;
  }

  async removeJob(id: string, jobId: string): Promise<{ ok: true } | ManagerRefusal> {
    const scope = await this.toolScope(id, undefined, true);
    if ('error' in scope) return scope;
    if (!scope.manager.jobs.some((job) => job.id === jobId)) return { error: 'job not found', status: 404 };
    this.deps.store.update(id, (manager) => ({ ...manager, jobs: manager.jobs.filter((job) => job.id !== jobId), updatedAt: this.iso() }));
    this.reschedule();
    this.emitChange(id);
    return { ok: true as const };
  }
}

const firstFreeAvatar = (managers: readonly Manager[]): number => {
  const taken = new Set(managers.map((manager) => manager.avatar));
  const free = Array.from({ length: 64 }, (_, index) => index).find((index) => !taken.has(index));
  return free ?? managers.length % 64;
};

const SUMMARY_LIMIT = 8_000;

/** Long on purpose: the end of a definition is its prompt, and a card must not hide that. */
const clipSummary = (text: string): string =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}… (cut, open the automation to read it all)` : text;

const pendingAction = (message: ManagerMessage): boolean => message.kind === 'action' && message.status === 'pending';

const openAsk = (message: ManagerMessage): message is Extract<ManagerMessage, { kind: 'assistant' }> =>
  message.kind === 'assistant' && message.ask !== undefined && message.askAnswer === undefined;

/** The question alone: the rest of a watch or job reply stays out of the session that can act. */
const askNote = (message: Extract<ManagerMessage, { kind: 'assistant' }>): string =>
  `Your ${message.turn} turn asked the user, who answers in their next message: ${(message.ask?.questions ?? []).map((question) => `${question.header}: ${question.question}`).join(' / ')}`.slice(0, 2_000);

const actionProject = (action: ManagerActionRequest): string | undefined =>
  action.type === 'add-job' ? undefined : action.projectId;

const accessRefusal = (manager: Manager, action: ManagerActionRequest): string | undefined => {
  const projectId = actionProject(action);
  return projectId !== undefined && managerAccessOf(manager, projectId) === 'read'
    ? `${projectId} is read-only for this manager: it cannot merge or enable anything there.`
    : undefined;
};

const actionKey = (action: ManagerActionRequest): string => {
  // The stamped facts count: a stale card must not stand in for what changed since.
  if (action.type === 'merge-pr') return `merge:${action.projectId}:${action.number}:${action.headSha}`;
  if (action.type === 'enable-automation') return `enable:${action.projectId}:${action.automationId}:${action.revision}`;
  return `job:${action.name}:${action.everyMinutes}:${action.prompt}`;
};

const describe = (action: ManagerActionRequest): string => {
  if (action.type === 'merge-pr') return `Merge of ${action.projectId}#${action.number}`;
  if (action.type === 'enable-automation') return `Enabling automation ${action.name ?? action.automationId}`;
  return `Adding job ${action.name}`;
};
