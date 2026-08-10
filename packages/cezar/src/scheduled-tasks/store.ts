import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  scheduledTaskDefinitionSchema,
  scheduledTaskDefinitionsFileSchema,
  scheduledTaskOccurrenceSchema,
  scheduledTaskStateFileSchema,
  type ScheduledTaskDefinition,
  type ScheduledTaskOccurrence,
  type ScheduledTaskRuntimeState,
  type ScheduledTaskTrigger,
} from './types.ts';

const DEFINITIONS = 'scheduled-tasks.json';
const STATE = 'scheduled-task-state.json';
const OCCURRENCES = 'scheduled-task-occurrences.ndjson';
const LOCK = 'scheduled-task.lock';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const OCCURRENCE_COMPACT_THRESHOLD = 20_000;
const OCCURRENCE_TERMINAL_KEEP = 10_000;

type DefinitionsFile = ReturnType<typeof scheduledTaskDefinitionsFileSchema.parse>;
type StateFile = ReturnType<typeof scheduledTaskStateFileSchema.parse>;

/** Thrown when a mutation cannot take the cross-process project lease. Routes answer 409. */
export class ScheduledTaskLeaseBusyError extends Error {
  constructor() {
    super('scheduled-task lease is held by another process');
    this.name = 'ScheduledTaskLeaseBusyError';
  }
}

export interface ScheduledTaskStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
}

export class ScheduledTaskStore {
  private definitionsFile: DefinitionsFile = { version: 1, scheduledTasks: [] };
  private stateFile: StateFile = { version: 1, states: {} };
  private definitions = new Map<string, ScheduledTaskDefinition>();
  private warned = new Set<string>();
  private occurrenceSeq = 0;
  private readonly now: () => Date;

  static open(dataDir: string, options: ScheduledTaskStoreOptions = {}): ScheduledTaskStore {
    const store = new ScheduledTaskStore(dataDir, options);
    store.load();
    return store;
  }

  private constructor(
    readonly dataDir: string,
    private readonly options: ScheduledTaskStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ---- reads ---------------------------------------------------------------

  list(): ScheduledTaskDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.timing.at.localeCompare(b.timing.at));
  }

  get(id: string): ScheduledTaskDefinition | undefined {
    return this.definitions.get(id);
  }

  state(id: string): ScheduledTaskRuntimeState | undefined {
    return this.stateFile.states[id];
  }

  /** Best-effort probe: can this process create/rename files in the data dir? A read-only
   *  project lists its definitions but disables every mutation and launch. */
  isWritable(): boolean {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const probe = join(this.dataDir, `.write-probe-${process.pid}`);
      writeFileSync(probe, '', { mode: 0o600 });
      unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  // ---- lease-serialized exclusive sections ---------------------------------

  /** Run `fn` while holding the cross-process lease, re-reading the latest files first so a
   *  mutation always merges onto another process's committed changes. Throws on lease contention. */
  runExclusive<T>(fn: () => T): T {
    const lease = this.acquireLease();
    if (!lease) throw new ScheduledTaskLeaseBusyError();
    try {
      this.reload();
      return fn();
    } finally {
      lease.release();
    }
  }

  /** The async twin, used by the launch path which must hold the lease across `RunManager`. */
  async runExclusiveAsync<T>(fn: () => Promise<T>): Promise<T> {
    const lease = this.acquireLease();
    if (!lease) throw new ScheduledTaskLeaseBusyError();
    try {
      this.reload();
      return await fn();
    } finally {
      lease.release();
    }
  }

  // ---- definition mutations (call under runExclusive) ----------------------

  create(
    input: Omit<ScheduledTaskDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
    id: string = randomUUID(),
  ): ScheduledTaskDefinition {
    if (this.definitions.has(id) || this.isTombstoned(id)) throw new Error('scheduled task id unavailable');
    const now = this.now().toISOString();
    const definition = scheduledTaskDefinitionSchema.parse({
      ...input,
      id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.definitions.set(id, definition);
    this.persistDefinitions();
    return definition;
  }

  update(
    id: string,
    expectedRevision: number,
    input: Omit<ScheduledTaskDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): ScheduledTaskDefinition {
    const current = this.definitions.get(id);
    if (!current) throw new Error('scheduled task not found');
    if (current.revision !== expectedRevision) throw new Error('scheduled task revision conflict');
    const definition = scheduledTaskDefinitionSchema.parse({
      ...current,
      ...input,
      id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    });
    this.definitions.set(id, definition);
    const state = this.state(id);
    if (state) this.setState(id, { ...state, revision: definition.revision });
    this.persistDefinitions();
    return definition;
  }

  delete(id: string): boolean {
    if (!this.definitions.delete(id)) return false;
    this.definitionsFile.tombstones = {
      ...this.definitionsFile.tombstones,
      [id]: this.now().toISOString(),
    };
    this.persistDefinitions();
    return true;
  }

  setState(id: string, state: ScheduledTaskRuntimeState): void {
    this.stateFile.states = { ...this.stateFile.states, [id]: state };
    this.atomicJson(STATE, this.stateFile);
  }

  // ---- occurrences ---------------------------------------------------------

  occurrences(): ScheduledTaskOccurrence[] {
    return this.readNdjson(OCCURRENCES, scheduledTaskOccurrenceSchema);
  }

  /** Latest row per occurrence KEY (the reservation identity). */
  latestOccurrencesByKey(): Map<string, ScheduledTaskOccurrence> {
    const latest = new Map<string, ScheduledTaskOccurrence>();
    for (const row of this.occurrences()) latest.set(row.occurrenceKey, row);
    return latest;
  }

  /** Latest row per occurrence ID (what retry and the detail view look up). */
  latestOccurrencesById(): Map<string, ScheduledTaskOccurrence> {
    const latest = new Map<string, ScheduledTaskOccurrence>();
    for (const row of this.occurrences()) latest.set(row.occurrenceId, row);
    return latest;
  }

  appendOccurrence(row: Omit<ScheduledTaskOccurrence, 'seq'> & { seq?: number }): ScheduledTaskOccurrence {
    const parsed = scheduledTaskOccurrenceSchema.parse({ ...row, seq: row.seq ?? ++this.occurrenceSeq });
    if (parsed.seq > this.occurrenceSeq) this.occurrenceSeq = parsed.seq;
    this.appendNdjson(OCCURRENCES, parsed);
    return parsed;
  }

  /**
   * Reserve one occurrence with an immutable key. Returns undefined when a live reservation with
   * that key already exists — the exactly-one-intent guard. A prior `config-error`/`launch-error`
   * key is NOT re-reservable here; retry re-uses the same occurrence id explicitly.
   */
  reserveOccurrence(input: {
    scheduledTaskId: string;
    revision: number;
    scheduledFor: string;
    trigger: ScheduledTaskTrigger;
    key: string;
  }): ScheduledTaskOccurrence | undefined {
    const existing = this.latestOccurrencesByKey().get(input.key);
    if (existing) return undefined;
    const now = this.now().toISOString();
    return this.appendOccurrence({
      occurrenceId: randomUUID(),
      occurrenceKey: input.key,
      scheduledTaskId: input.scheduledTaskId,
      revision: input.revision,
      scheduledFor: input.scheduledFor,
      observedAt: now,
      trigger: input.trigger,
      status: 'reserved',
      updatedAt: now,
    });
  }

  occurrencesList(
    options: {
      scheduledTaskId?: string;
      status?: ScheduledTaskOccurrence['status'];
      cursor?: number;
      limit?: number;
    } = {},
  ): ScheduledTaskOccurrence[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    // Latest row per id, so a finalized occurrence shows its terminal state, not its reservation.
    return [...this.latestOccurrencesById().values()]
      .filter((row) => !options.scheduledTaskId || row.scheduledTaskId === options.scheduledTaskId)
      .filter((row) => !options.status || row.status === options.status)
      .sort((a, b) => b.seq - a.seq)
      .filter((row) => !options.cursor || row.seq < options.cursor)
      .slice(0, limit);
  }

  /** Compact beyond the threshold, retaining unresolved rows plus the latest terminal ones. */
  compact(): void {
    const latest = [...this.latestOccurrencesById().values()];
    const unresolved = latest.filter((row) => row.status === 'reserved');
    const terminal = latest
      .filter((row) => row.status !== 'reserved')
      .sort((a, b) => a.seq - b.seq)
      .slice(-OCCURRENCE_TERMINAL_KEEP);
    const keep = [...unresolved, ...terminal].sort((a, b) => a.seq - b.seq);
    this.rewriteNdjson(OCCURRENCES, keep);
  }

  maybeCompact(): void {
    if (this.occurrences().length > OCCURRENCE_COMPACT_THRESHOLD) this.compact();
  }

  // ---- lease ---------------------------------------------------------------

  acquireLease(staleAfterMs = 10 * 60_000): ScheduledTaskLease | undefined {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, LOCK);
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      return new ScheduledTaskLease(path, fd);
    } catch {
      try {
        if (this.now().getTime() - statSync(path).mtimeMs > staleAfterMs) {
          unlinkSync(path);
          return this.acquireLease(staleAfterMs);
        }
      } catch {
        // A contender removed the lock or the directory is read-only.
      }
      return undefined;
    }
  }

  // ---- loading -------------------------------------------------------------

  reload(): void {
    this.loadDefinitions();
    this.stateFile = this.readJson(STATE, scheduledTaskStateFileSchema, { version: 1, states: {} });
  }

  private load(): void {
    mkdirSync(this.dataDir, { recursive: true });
    this.reload();
    const rows = this.occurrences();
    this.occurrenceSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0);
  }

  private loadDefinitions(): void {
    this.definitionsFile = this.readJson(DEFINITIONS, scheduledTaskDefinitionsFileSchema, {
      version: 1,
      scheduledTasks: [],
    });
    this.definitions = new Map();
    for (const raw of this.definitionsFile.scheduledTasks) {
      const parsed = scheduledTaskDefinitionSchema.safeParse(raw);
      if (parsed.success) this.definitions.set(parsed.data.id, parsed.data);
      else this.warnOnce('definitions', 'Ignored an invalid scheduled-task definition.');
    }
  }

  private persistDefinitions(): void {
    this.pruneTombstones();
    this.definitionsFile.scheduledTasks = [...this.definitions.values()];
    this.atomicJson(DEFINITIONS, this.definitionsFile);
  }

  private isTombstoned(id: string): boolean {
    const deletedAt = this.definitionsFile.tombstones?.[id];
    return Boolean(deletedAt && Date.parse(deletedAt) >= this.now().getTime() - RETENTION_MS);
  }

  private pruneTombstones(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    this.definitionsFile.tombstones = Object.fromEntries(
      Object.entries(this.definitionsFile.tombstones ?? {}).filter(
        ([, timestamp]) => Date.parse(timestamp) >= cutoff,
      ),
    );
  }

  // ---- io primitives -------------------------------------------------------

  private readJson<T>(
    filename: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    fallback: T,
  ): T {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return fallback;
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data as T;
    } catch {
      // Warn once below.
    }
    this.warnOnce(filename, `Ignored corrupt scheduled-task state in ${filename}.`);
    return fallback;
  }

  private readNdjson<T>(
    filename: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  ): T[] {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return [];
    const rows: T[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data as T);
        else this.warnOnce(filename, `Skipped a malformed row in ${filename}.`);
      } catch {
        this.warnOnce(filename, `Skipped a malformed row in ${filename}.`);
      }
    }
    return rows;
  }

  private atomicJson(filename: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, filename);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private appendNdjson(filename: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, filename);
    const fd = openSync(path, 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  private rewriteNdjson(filename: string, rows: unknown[]): void {
    const path = join(this.dataDir, filename);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.warn?.(message);
  }
}

export class ScheduledTaskLease {
  private released = false;

  constructor(
    private readonly path: string,
    private readonly fd: number,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup.
    }
  }
}
