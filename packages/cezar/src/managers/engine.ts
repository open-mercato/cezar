import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  MANAGER_DEFAULT_CRON_MINUTES,
  type CreateManagerInput,
  type Manager,
  type ManagerActionRequest,
  type ManagerActionStatus,
  type ManagerCommand,
  type ManagerCreateTaskInput,
  type ManagerJob,
  type ManagerMessage,
  type ManagerMessagesResponse,
  type ManagerProposeActionInput,
  type ManagerSnapshot,
  type ManagerSummary,
  type ManagerTaskDetail,
  type ManagerTaskMessageInput,
  type ManagerTurnKind,
  type UpdateManagerInput,
} from '@open-mercato/cezar-contract';
import type { AutomationDefinition } from '@open-mercato/cezar-contract';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { isRunnerId, type AgentEvent, type AgentRunner, type AgentRunSpec, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { supportsProfiles } from '../core/agent-profiles.ts';
import { createRunner } from '../core/runner-factory.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { assertCezarHomeWriteIsSandboxed, managersDir } from '../paths.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { chatPrompt, jobPrompt, managerSystemPrompt, MANAGER_QUIET, recapPrompt, watchPrompt } from './prompts.ts';
import { buildSnapshot, gateAttention, taskDetailRows, type ManagerGithubFacts, type ManagerProjectSource } from './snapshot.ts';
import type { ManagerStore } from './store.ts';

/**
 * The manager turn engine (spec 2026-10-31-managers § Turns, § Watching, § Safety). One turn per
 * manager at a time, each a single resumed agent session, so a manager costs nothing while idle.
 */

export type ManagerRefusal = { error: string; status: 400 | 403 | 404 | 409 | 502 };

type LoopbackRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface ManagerEngineDeps {
  store: ManagerStore;
  emit: (event: 'manager-change' | 'manager-message', data: unknown) => void;
  /** Every project this cockpit can see, read without building contexts. */
  projects: () => Promise<ManagerProjectSource[]>;
  github: ManagerGithubFacts;
  defaultRunner: () => Promise<RunnerId>;
  /** Why this account cannot be picked, as `POST /runs` would say it. */
  accountError: (runner: RunnerId, agentProfile: string) => Promise<string | null>;
  /** The cockpit's own routes, in process: POST /runs, merge, enable have exactly one implementation. */
  request: LoopbackRequest;
  costVisible: () => boolean;
  runnerFor?: (runner: RunnerId) => AgentRunner;
  now?: () => number;
}

type QueueItem =
  | { kind: 'chat'; text: string }
  | { kind: 'watch'; forced: boolean }
  | { kind: 'job'; jobId: string };

interface ActiveTurn {
  kind: ManagerTurnKind;
  /** False while a watch check is still deciding whether a model call is needed at all. */
  started: boolean;
  stopped: boolean;
  session?: AgentSession;
  stopTimer?: NodeJS.Timeout;
}

interface Runtime {
  queue: QueueItem[];
  active?: ActiveTurn;
  retry?: NodeJS.Timeout;
  retries: number;
  deleted?: boolean;
}

interface DriveResult {
  text: string;
  commands: ManagerCommand[];
  costUsd: number;
  error?: string;
}

const STREAM_THROTTLE_MS = 100;
const STOP_GRACE_MS = 5_000;
const LEASE_STALE_MS = 30_000;
const LEASE_RETRY_MS = 5_000;
const LEASE_RETRY_LIMIT = 24;
const TICK_FLOOR_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_WATCH_BACKOFF = 4;
const OUTPUT_LIMIT = 4_000;
const TAIL_BYTES = 256 * 1024;
const PREVIEW_LIMIT = 120;

export const MANAGER_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
export const MANAGER_BASH_ALLOWLIST = [
  'cez-manager',
  'gh pr view', 'gh pr list', 'gh pr diff', 'gh pr checks', 'gh issue view', 'gh issue list', 'gh run view', 'gh run list', 'gh repo view',
];

/** A task keeps a task's full shell, so this is a request, not a fence (spec, Safety). */
const MANAGER_TASK_SYSTEM_PROMPT = 'A cezar manager started this task. Do not merge pull requests or enable automations: leave that to the user.';

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
  if (process.platform === 'win32') write('cez-manager.cmd', `@"${process.execPath}" %CEZ_BIN% manager %*\r\n`);
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
  private started = false;
  private disposed = false;

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
      const release = this.tryLease(manager.id);
      if (!release) {
        complete = false;
        continue;
      }
      try {
        const messages = this.deps.store.messages(manager.id);
        for (const message of messages) {
          if (message.kind === 'assistant' && message.streaming) {
            this.publish(manager.id, { ...message, streaming: false, stopped: true }, true);
            this.addNotice(manager.id, 'cezar restarted during this reply.');
          } else if (message.kind === 'action' && message.status === 'running') {
            this.publish(manager.id, { ...message, status: 'failed', result: 'cezar restarted before this finished. Check it before trying again.' }, true);
          }
        }
        if (messages.at(-1)?.kind === 'user') this.addNotice(manager.id, 'cezar restarted before answering this. Send it again if you still need it.');
      } finally {
        release();
      }
    }
    return complete;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
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

  private async sources(manager: Manager): Promise<ManagerProjectSource[]> {
    const all = await this.deps.projects();
    return manager.projects === 'all' ? all : all.filter((source) => (manager.projects as string[]).includes(source.id));
  }

  private checkDueAt(manager: Manager, state: { lastCheckAt?: string; watchFailures: number }): number {
    const last = Date.parse(state.lastCheckAt ?? manager.createdAt);
    return last + manager.cronMinutes * 60_000 * 2 ** Math.min(state.watchFailures, MAX_WATCH_BACKOFF);
  }

  private async summarize(manager: Manager): Promise<ManagerSummary> {
    const runtime = this.runtimes.get(manager.id);
    const state = this.deps.store.state(manager.id);
    const messages = this.deps.store.messages(manager.id);
    const last = messages.at(-1);
    const newestFirst = [...messages].reverse();
    const lastTalk = newestFirst.find((message) => message.kind !== 'action' && (message.kind !== 'assistant' || message.text));
    const lastAssistant = newestFirst.find((message) => message.kind === 'assistant');
    const working = runtime?.active?.started === true || (runtime?.queue.length ?? 0) > 0;
    const preview = lastTalk && 'text' in lastTalk ? onePlainLine(lastTalk.text) : '';
    const dueAt = this.checkDueAt(manager, state);
    return {
      ...manager,
      status: working ? 'working' : lastAssistant?.kind === 'assistant' && lastAssistant.error ? 'error' : 'idle',
      connectedProjectIds: (await this.sources(manager)).map((source) => source.id),
      ...(last ? { lastActivityAt: last.at } : {}),
      ...(preview ? { preview } : {}),
      unread: messages.filter((message) => message.seq > state.readSeq && message.kind !== 'user' && !(message.kind === 'assistant' && message.streaming)).length,
      pendingActions: messages.filter((message) => message.kind === 'action' && message.status === 'pending').length,
      ...(state.lastCheckAt ? { lastCheckAt: state.lastCheckAt } : {}),
      ...(manager.cronMinutes > 0 ? { nextCheckAt: new Date(Math.max(dueAt, this.now())).toISOString() } : {}),
      costUsd: this.deps.costVisible() ? state.costUsd : 0,
    };
  }

  async list(): Promise<ManagerSummary[]> {
    const managers = this.deps.store.list();
    const summaries = await Promise.all(managers.map((manager) => this.summarize(manager)));
    return summaries.sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
  }

  async summary(id: string): Promise<ManagerSummary | undefined> {
    const manager = this.deps.store.get(id);
    return manager ? this.summarize(manager) : undefined;
  }

  messages(id: string, query: { before?: number; limit?: number }): ManagerMessagesResponse {
    const limit = query.limit ?? 100;
    const all = this.deps.store.messages(id).filter((message) => query.before === undefined || message.seq < query.before);
    return { messages: all.slice(-limit), hasMore: all.length > limit };
  }

  async snapshot(id: string): Promise<ManagerSnapshot | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    return buildSnapshot(await this.sources(manager), this.deps.github, this.now());
  }

  private emitChange(id: string): void {
    void this.summary(id).then(
      (manager) => { if (manager) this.deps.emit('manager-change', { id, manager }); },
      () => undefined,
    );
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

  async create(input: CreateManagerInput): Promise<ManagerSummary | ManagerRefusal> {
    const issue = await this.accountIssue(input.runner, input.agentProfile);
    if (issue) return issue;
    const id = randomUUID();
    const at = this.iso();
    const manager: Manager = {
      id,
      name: input.name ?? 'Manager',
      instructions: input.instructions,
      avatar: input.avatar ?? (parseInt(id.slice(0, 8), 16) % 64),
      projects: input.projects,
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
    this.reschedule();
    const summary = await this.summarize(manager);
    this.deps.emit('manager-change', { id, manager: summary });
    return summary;
  }

  async update(id: string, input: UpdateManagerInput): Promise<ManagerSummary | ManagerRefusal> {
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
      ...(input.cronMinutes !== undefined ? { cronMinutes: input.cronMinutes } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      ...(input.jobs
        ? {
            jobs: input.jobs.map((job): ManagerJob => {
              const jobId = job.id ?? randomUUID();
              const lastRunAt = previousJobs.get(jobId)?.lastRunAt;
              return { ...job, id: jobId, ...(lastRunAt ? { lastRunAt } : {}) };
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
    if (JSON.stringify(current.projects) !== JSON.stringify(updated.projects)) {
      const names = (await this.sources(updated)).map((source) => source.name);
      this.addNotice(id, names.length > 0 ? `Connected to ${names.join(', ')}` : 'No projects connected');
    }
    this.reschedule();
    const summary = await this.summarize(updated);
    this.deps.emit('manager-change', { id, manager: summary });
    return summary;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.deps.store.get(id)) return false;
    const runtime = this.runtime(id);
    runtime.deleted = true;
    runtime.queue = [];
    if (runtime.retry) clearTimeout(runtime.retry);
    this.interrupt(runtime);
    this.deps.store.mutate((managers) => managers.filter((manager) => manager.id !== id));
    const session = runtime.active?.session;
    if (session) await Promise.race([session.result.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS * 2).unref?.())]);
    this.leases.get(id)?.();
    this.deps.store.removeFiles(id);
    this.runtimes.delete(id);
    this.deps.emit('manager-change', { id, deleted: true });
    this.reschedule();
    return true;
  }

  // ---- chat --------------------------------------------------------------------------------

  send(id: string, text: string): boolean {
    if (!this.deps.store.get(id)) return false;
    this.publish(id, { id: randomUUID(), seq: this.deps.store.nextSeq(id), at: this.iso(), kind: 'user', text }, true);
    this.enqueue(id, { kind: 'chat', text });
    return true;
  }

  /** Interrupts the running turn. A message queued behind it still runs: it was never stopped. */
  stop(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const runtime = this.runtime(id);
    this.interrupt(runtime);
    return true;
  }

  read(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const top = this.deps.store.messages(id).at(-1)?.seq ?? -1;
    if (this.deps.store.state(id).readSeq !== top) {
      this.deps.store.updateState(id, (state) => ({ ...state, readSeq: top }));
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
      return { kind: 'chat', text: chats.map((item) => item.text).join('\n\n') };
    }
    return runtime.queue.shift();
  }

  private pump(id: string): void {
    const runtime = this.runtime(id);
    if (this.disposed || runtime.deleted || runtime.active || runtime.queue.length === 0) return;
    const release = this.tryLease(id);
    if (!release) {
      // A watch is the other cockpit's to fire; the user's own message waits for it.
      runtime.queue = runtime.queue.filter((item) => item.kind === 'chat');
      if (runtime.retry || runtime.queue.length === 0) return;
      if (runtime.retries >= LEASE_RETRY_LIMIT) {
        runtime.queue = [];
        runtime.retries = 0;
        this.addNotice(id, 'Another cezar on this machine kept this manager busy. Send that again.');
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
    const turn: ActiveTurn = { kind: item.kind, started: false, stopped: false };
    runtime.active = turn;
    const running = this.runTurn(id, item, turn)
      .catch((error) => console.warn(`[cezar] manager ${id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (turn.stopTimer) clearTimeout(turn.stopTimer);
        release();
        if (runtime.active === turn) runtime.active = undefined;
        this.settling.delete(running);
        if (runtime.deleted) return;
        this.emitChange(id);
        this.pump(id);
        this.reschedule();
      });
    this.settling.add(running);
  }

  // ---- one turn ----------------------------------------------------------------------------

  private async runTurn(id: string, item: QueueItem, turn: ActiveTurn): Promise<void> {
    const manager = this.deps.store.get(id);
    if (!manager) return;
    const { store } = this.deps;
    if (item.kind === 'watch') {
      // Stamped first: a snapshot that throws must wait for the next tick, not retry in a loop.
      store.updateState(id, (state) => ({ ...state, lastCheckAt: this.iso() }));
      const snapshot = await this.snapshot(id);
      if (!snapshot) return;
      const { fresh, kept } = gateAttention(snapshot, store.state(id).reported);
      store.updateState(id, (state) => ({ ...state, reported: kept }));
      // The brake that makes a 15-minute default affordable: a quiet repository costs nothing.
      if (fresh.length === 0 && !item.forced) {
        this.emitChange(id);
        return;
      }
      await this.watchTurn(id, manager, snapshot, fresh, item.forced, turn);
      return;
    }
    const notes = this.takeNotes(id);
    if (item.kind === 'chat') {
      await this.visibleTurn(id, manager, chatPrompt(item.text, notes), 'chat', turn);
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
    await this.visibleTurn(id, manager, jobPrompt(job.name, job.prompt, notes), 'job', turn, job.name);
  }

  private takeNotes(id: string): string[] {
    const { notes } = this.deps.store.state(id);
    if (notes.length > 0) this.deps.store.updateState(id, (state) => ({ ...state, notes: [] }));
    return notes;
  }

  private async visibleTurn(id: string, manager: Manager, prompt: string, kind: ManagerTurnKind, turn: ActiveTurn, jobName?: string): Promise<void> {
    const { store } = this.deps;
    const base = { id: randomUUID(), seq: store.nextSeq(id), at: this.iso(), kind: 'assistant' as const, turn: kind, ...(jobName ? { jobName } : {}) };
    this.publish(id, { ...base, text: '', streaming: true, commands: [] }, true);
    let throttle: NodeJS.Timeout | undefined;
    let latest: { text: string; commands: ManagerCommand[] } = { text: '', commands: [] };
    const flush = () => {
      throttle = undefined;
      // Output stays for the final frame: every open tab parses these ten times a second.
      this.publish(id, { ...base, text: latest.text, commands: latest.commands.map(({ output: _output, ...command }) => command), streaming: true }, false);
    };
    const result = await this.drive(id, manager, prompt, turn, (progress) => {
      latest = progress;
      if (!throttle) {
        throttle = setTimeout(flush, STREAM_THROTTLE_MS);
        throttle.unref?.();
      }
    });
    if (throttle) clearTimeout(throttle);
    if (!store.get(id)) return;
    this.addCost(id, result.costUsd);
    const text = result.text.replace(QUIET_LINE, '').trim();
    this.publish(id, {
      ...base,
      text,
      streaming: false,
      commands: result.commands,
      ...(turn.stopped ? { stopped: true } : {}),
      ...(result.error && !turn.stopped ? { error: result.error } : {}),
      ...(this.deps.costVisible() && result.costUsd > 0 ? { costUsd: result.costUsd } : {}),
    }, true);
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
    const result = await this.drive(id, manager, watchPrompt(snapshot, fresh, this.takeNotes(id)), turn, () => undefined);
    if (!store.get(id)) return;
    this.addCost(id, result.costUsd);
    if (turn.stopped) return;
    const lastMessage = store.messages(id).at(-1);
    if (result.error) {
      store.updateState(id, (state) => ({ ...state, watchFailures: state.watchFailures + 1 }));
      // One line for a run of failures: a dead login must not add a message every 15 minutes.
      const repeat = lastMessage?.kind === 'assistant' && lastMessage.turn === 'watch' && lastMessage.error ? lastMessage : undefined;
      this.publish(id, {
        id: repeat?.id ?? randomUUID(),
        seq: repeat?.seq ?? store.nextSeq(id),
        at: this.iso(),
        kind: 'assistant',
        turn: 'watch',
        text: '',
        streaming: false,
        commands: [],
        error: result.error,
      }, true);
      return;
    }
    const reportedAt = this.iso();
    store.updateState(id, (state) => ({
      ...state,
      watchFailures: 0,
      reported: { ...state.reported, ...Object.fromEntries(snapshot.attention.map((item) => [item.key, reportedAt])) },
    }));
    const text = result.text.trim();
    if (!text || QUIET_LINE.test(text)) {
      if (forced) this.addNotice(id, 'Checked: nothing needs you right now.');
      return;
    }
    this.publish(id, {
      id: randomUUID(),
      seq: store.nextSeq(id),
      at: this.iso(),
      kind: 'assistant',
      turn: 'watch',
      text,
      streaming: false,
      commands: result.commands,
      ...(this.deps.costVisible() && result.costUsd > 0 ? { costUsd: result.costUsd } : {}),
    }, true);
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
    onProgress: (progress: { text: string; commands: ManagerCommand[] }) => void,
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
    const apiUrl = process.env.CEZ_API_URL;
    let shimDir: string | undefined;
    try {
      shimDir = ensureManagerShim();
    } catch (error) {
      console.warn(`[cezar] manager shim: ${error instanceof Error ? error.message : String(error)}`);
    }
    const locked = agentModelsLocked();
    const base: AgentRunSpec = {
      systemPrompt: managerSystemPrompt(manager, sources.map((source) => ({ id: source.id, name: source.name }))),
      userPrompt: prompt,
      cwd: store.workdir(id),
      allowedTools: MANAGER_ALLOWED_TOOLS,
      bashAllowlist: MANAGER_BASH_ALLOWLIST,
      additionalDirectories: sources.filter((source) => source.available).map((source) => source.root),
      env: {
        ...profile.env,
        CEZ_MANAGER_ID: id,
        CEZ_MANAGER_TURN: turn.kind,
        ...(apiUrl ? { CEZ_API_URL: apiUrl } : {}),
        ...(process.env.CEZ_BIN ? { CEZ_BIN: process.env.CEZ_BIN } : {}),
        ...(shimDir ? { PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
      },
      ...(manager.model && !locked ? { model: manager.model } : {}),
      ...(manager.effort ? { effort: manager.effort } : {}),
    };
    const first = await this.session(id, base, sessionKey, runner, resumeId, turn, onProgress);
    const silent = !first.text && first.commands.length === 0;
    if (!resumable || !first.error || !silent || turn.stopped) return first;
    // Only a chat gets the transcript back: it holds what watches read.
    const recap = turn.kind === 'chat'
      ? recapPrompt(store.messages(id).filter((message) => !(message.kind === 'assistant' && message.streaming)))
      : '';
    const fresh = await this.session(id, { ...base, userPrompt: `${recap}${prompt}` }, sessionKey, runner, undefined, turn, onProgress);
    return { ...fresh, costUsd: fresh.costUsd + first.costUsd };
  }

  private async session(
    id: string,
    base: AgentRunSpec,
    sessionKey: string,
    runnerId: RunnerId,
    resumeId: string | undefined,
    turn: ActiveTurn,
    onProgress: (progress: { text: string; commands: ManagerCommand[] }) => void,
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
    const progress = () => onProgress({ text: text(), commands: [...commands] });
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
        case 'error':
          error = event.message;
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
    const dues = manager.jobs.filter((job) => job.enabled).map((job) => Date.parse(job.lastRunAt ?? manager.createdAt) + job.everyMinutes * 60_000);
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
      const state = this.deps.store.state(manager.id);
      if (manager.cronMinutes > 0 && this.checkDueAt(manager, state) <= now) {
        this.enqueue(manager.id, { kind: 'watch', forced: false });
      }
      for (const job of manager.jobs) {
        if (!job.enabled || Date.parse(job.lastRunAt ?? manager.createdAt) + job.everyMinutes * 60_000 > now) continue;
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

  async createTask(id: string, input: ManagerCreateTaskInput): Promise<{ projectId: string; runId: string } | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const prefix = `/p/${encodeURIComponent(input.projectId)}`;
    const response = await this.forward(`${prefix}/runs`, {
      method: 'POST',
      body: {
        workflow: input.workflow ?? 'quick-task',
        task: input.task,
        systemPrompt: MANAGER_TASK_SYSTEM_PROMPT,
        ...(input.runner ? { runner: input.runner } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.dispatch ? { dispatch: {} } : {}),
      },
    });
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const run = (await response.json()) as { id: string };
    if (input.title) {
      await this.forward(`${prefix}/runs/${encodeURIComponent(run.id)}`, { method: 'PATCH', body: { title: input.title } }).catch(() => undefined);
    }
    return { projectId: input.projectId, runId: run.id };
  }

  /** A live task takes the message; a finished one is continued with it. */
  async taskMessage(id: string, input: ManagerTaskMessageInput): Promise<{ ok: true } | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const path = `/p/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(input.runId)}`;
    const delivered = await this.forward(`${path}/messages`, { method: 'POST', body: { text: input.text } });
    if (delivered.ok) return { ok: true as const };
    if (delivered.status !== 409) return ManagerEngine.refusalOf(delivered);
    const continued = await this.forward(`${path}/continue`, { method: 'POST', body: { text: input.text } });
    return continued.ok ? { ok: true as const } : ManagerEngine.refusalOf(continued);
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
      return { ...action, title: body.mergeState.title, headSha: body.mergeState.headSha };
    }
    const response = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}`);
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const { automation } = (await response.json()) as { automation?: AutomationDefinition };
    if (!automation) return { error: 'automation not found', status: 404 };
    if (automation.enabled) return { error: 'that automation is already enabled', status: 409 };
    const { id: _id, revision: _revision, enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = automation;
    return { ...action, name: automation.name, revision: automation.revision, summary: clipSummary(JSON.stringify(definition)) };
  }

  async propose(id: string, input: ManagerProposeActionInput): Promise<{ actionId: string; status: ManagerActionStatus } | ManagerRefusal> {
    const scope = await this.toolScope(id, actionProject(input.action), true);
    if ('error' in scope) return scope;
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
    this.emitChange(id);
    return { actionId: message.id, status: 'pending' };
  }

  /** The only path to a merge or an enabled automation; the agent's tools cannot reach it. */
  async decide(id: string, actionId: string, decision: 'approve' | 'reject'): Promise<{ ok: true } | ManagerRefusal> {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    const message = this.deps.store.message(id, actionId);
    if (message?.kind !== 'action') return { error: 'action not found', status: 404 };
    if (message.status !== 'pending') return { error: `this action is already ${message.status}`, status: 409 };
    const settle = (status: ManagerActionStatus, result: string) => {
      this.publish(id, { ...message, status, result }, true);
      this.deps.store.updateState(id, (state) => ({ ...state, notes: [...state.notes, `${describe(message.action)}: ${result}`].slice(-20) }));
      this.emitChange(id);
    };
    if (decision === 'reject') {
      settle('rejected', 'Rejected');
      return { ok: true as const };
    }
    this.publish(id, { ...message, status: 'running' }, true);
    const projectId = actionProject(message.action);
    const connected = projectId === undefined || (await this.sources(manager)).some((source) => source.id === projectId);
    const outcome = connected
      ? await this.perform(id, message.action)
      : { ok: false as const, result: `This manager is no longer connected to ${projectId}.` };
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

const SUMMARY_LIMIT = 8_000;

/** Long on purpose: the end of a definition is its prompt, and a card must not hide that. */
const clipSummary = (text: string): string =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}… (cut, open the automation to read it all)` : text;

const actionProject = (action: ManagerActionRequest): string | undefined =>
  action.type === 'add-job' ? undefined : action.projectId;

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
