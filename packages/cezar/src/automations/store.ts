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
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import { join } from 'node:path';
import {
  automationDefinitionSchema,
  automationDefinitionsFileSchema,
  automationLogRecordSchema,
  automationReceiptSchema,
  automationStateFileSchema,
  type AutomationDefinition,
  type AutomationLogRecord,
  type AutomationReceipt,
  type AutomationRuntimeState,
} from './types.ts';
import type { GithubCandidate } from './github-poller.ts';
import type { TrackerAutomationCandidate } from './tracker-poller.ts';

const DEFINITIONS = 'automations.json';
const STATE = 'automation-state.json';
const RECEIPTS = 'automation-receipts.ndjson';
const LOG = 'automation-log.ndjson';
const POLL_LOCK = 'automation-poll.lock';
const MUTATION_LOCK = 'automation-mutation.lock';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
/** How many times one `acquireLease` call may reclaim an abandoned lock and retry. */
const LEASE_RECLAIM_ATTEMPTS = 1;

type DefinitionsFile = ReturnType<typeof automationDefinitionsFileSchema.parse>;
type StateFile = ReturnType<typeof automationStateFileSchema.parse>;

export interface AutomationStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  /** Liveness probe for the pid recorded in the poll lock. Injected by tests only. */
  processAlive?: (pid: number) => boolean;
}

export class AutomationStore {
  private definitionsFile: DefinitionsFile = { version: 1, automations: [] };
  private stateFile: StateFile = { version: 1, states: {} };
  private definitions = new Map<string, AutomationDefinition>();
  private warned = new Set<string>();
  private logSeq = 0;
  private readonly now: () => Date;
  private readonly secrets = collectSecretValues();

  static open(dataDir: string, options: AutomationStoreOptions = {}): AutomationStore {
    const store = new AutomationStore(dataDir, options);
    store.load();
    return store;
  }

  private constructor(
    readonly dataDir: string,
    private readonly options: AutomationStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  list(): AutomationDefinition[] {
    this.loadDefinitions();
    return [...this.definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): AutomationDefinition | undefined {
    this.loadDefinitions();
    return this.definitions.get(id);
  }

  create(
    input: Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
    id: string = randomUUID(),
    initializeState?: (definition: AutomationDefinition) => void,
  ): AutomationDefinition {
    const mutation = this.acquireMutationLease();
    if (!mutation) throw new Error('automation mutation conflict: a launch is in progress');
    try {
      this.loadDefinitions();
      if (this.definitions.has(id) || this.isTombstoned(id)) throw new Error('automation id unavailable');
      const now = this.now().toISOString();
      const definition = automationDefinitionSchema.parse({
        ...input,
        id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.definitions.set(id, definition);
      // Baseline and definition publish under one lease; readers snapshot under that lease too.
      initializeState?.(definition);
      this.persistDefinitions();
      return definition;
    } finally { mutation.release(); }
  }

  update(
    id: string,
    expectedRevision: number,
    input: Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
    initializeState?: (definition: AutomationDefinition) => void,
  ): AutomationDefinition {
    const mutation = this.acquireMutationLease();
    if (!mutation) throw new Error('automation mutation conflict: a launch is in progress');
    try {
      this.loadDefinitions();
      const current = this.definitions.get(id);
      if (!current) throw new Error('automation not found');
      if (current.revision !== expectedRevision) throw new Error('automation revision conflict');
      const definition = automationDefinitionSchema.parse({
        ...current,
        ...input,
        id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: this.now().toISOString(),
      });
      this.definitions.set(id, definition);
      if (this.state(id)) this.setState(id, (current) => ({ ...current, revision: definition.revision }));
      // Baseline and definition publish under one lease; readers snapshot under that lease too.
      initializeState?.(definition);
      this.persistDefinitions();
      return definition;
    } finally { mutation.release(); }
  }

  delete(id: string): boolean {
    const mutation = this.acquireMutationLease();
    if (!mutation) throw new Error('automation mutation conflict: a launch is in progress');
    try {
      this.loadDefinitions();
      if (!this.definitions.delete(id)) return false;
      this.definitionsFile.tombstones = {
        ...this.definitionsFile.tombstones,
        [id]: this.now().toISOString(),
      };
      this.persistDefinitions();
      return true;
    } finally { mutation.release(); }
  }

  state(id: string): AutomationRuntimeState | undefined {
    this.stateFile = this.readJson(STATE, automationStateFileSchema, { version: 1, states: {} });
    return this.stateFile.states[id];
  }

  /**
   * Read-modify-write (spec 2026-09-14 § Edge cases): two cockpits on one project each hold their
   * own in-memory copy of the state file, and a write from memory alone would clobber the other's
   * cursor or `nextRunAt`. Re-reading first merges this ONE id over whatever is on disk, so the
   * two converge — the `mergeWriteWorkspaceConfig` pattern.
   *
   * The convergence promise only holds if the write for THIS id is also computed from a fresh
   * disk read, not from the caller's own possibly-stale in-memory snapshot — two processes racing
   * on the SAME automation id (e.g. one holds the poll/schedule lease and launches while the
   * other, having failed to acquire it, still advances its own `nextRunAt`) would otherwise have
   * the loser's write silently revert the winner's `lastRunAt`/`consecutiveFailures`. `update`
   * therefore takes the CURRENT on-disk record (or `{}` when none exists yet) and must return the
   * full next record from it — never close over an outer `state` read from before this call.
   */
  setState(id: string, update: (current: AutomationRuntimeState) => AutomationRuntimeState): AutomationRuntimeState {
    const onDisk = this.readJson(STATE, automationStateFileSchema, { version: 1, states: {} });
    const next = update(onDisk.states[id] ?? {});
    this.stateFile = { ...onDisk, states: { ...onDisk.states, [id]: next } };
    this.atomicJson(STATE, this.stateFile);
    return next;
  }

  receipts(): AutomationReceipt[] {
    return this.readNdjson(RECEIPTS, automationReceiptSchema);
  }

  latestReceipts(): Map<string, AutomationReceipt> {
    const latest = new Map<string, AutomationReceipt>();
    for (const row of this.receipts()) latest.set(row.receiptKey, row);
    return latest;
  }

  appendReceipt(receipt: AutomationReceipt): void {
    this.appendNdjson(RECEIPTS, redactDeep(automationReceiptSchema.parse(receipt), this.secrets));
  }

  reserveReceipt(input: {
    automationId: string;
    revision: number;
    eventId: string;
    candidate?: GithubCandidate;
    trackerCandidate?: TrackerAutomationCandidate;
    /** schedule kind: the occurrence being reserved. */
    occurrenceAt?: string;
  }): AutomationReceipt | undefined {
    const receiptKey = `${input.automationId}:${input.eventId}`;
    if (this.latestReceipts().has(receiptKey)) return undefined;
    const now = this.now().toISOString();
    const receipt = automationReceiptSchema.parse({
      ...input,
      receiptKey,
      receiptId: randomUUID(),
      status: 'reserved',
      observedAt: now,
      updatedAt: now,
    });
    this.appendReceipt(receipt);
    return receipt;
  }

  /** Called under both polling and mutation leases, after run reconciliation. */
  reserveRetry(receiptId: string): AutomationReceipt | undefined {
    const current = [...this.latestReceipts().values()].find(row => row.receiptId === receiptId);
    if (!current || current.status !== 'launch-error' || current.runId) return undefined;
    const reserved: AutomationReceipt = { ...current, status: 'reserved', error: undefined, updatedAt: this.now().toISOString() };
    this.appendReceipt(reserved);
    return reserved;
  }

  appendLog(
    record: Omit<AutomationLogRecord, 'seq' | 'ts'> & Partial<Pick<AutomationLogRecord, 'ts'>>,
  ): AutomationLogRecord {
    const parsed = automationLogRecordSchema.parse({
      ...record,
      seq: ++this.logSeq,
      ts: record.ts ?? this.now().toISOString(),
    });
    this.appendNdjson(LOG, redactDeep(parsed, this.secrets));
    return parsed;
  }

  logs(options: { automationId?: string; result?: AutomationLogRecord['result']; event?: AutomationLogRecord['event']; since?: string; cursor?: number; limit?: number } = {}): AutomationLogRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    return this.readNdjson(LOG, automationLogRecordSchema)
      .filter((row) => !options.automationId || row.automationId === options.automationId)
      .filter((row) => !options.result || row.result === options.result)
      .filter((row) => !options.event || row.event === options.event)
      .filter((row) => !options.since || row.ts >= options.since)
      .filter((row) => !options.cursor || row.seq < options.cursor)
      .slice(-limit)
      .reverse();
  }

  compact(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    const latest = [...this.latestReceipts().values()].filter(
      (row) => Date.parse(row.updatedAt) >= cutoff || (this.get(row.automationId)?.kind === 'tracker'),
    );
    this.rewriteNdjson(RECEIPTS, latest);
    const logs = this.readNdjson(LOG, automationLogRecordSchema);
    this.rewriteNdjson(LOG, logs.slice(-10_000));
  }

  maybeCompact(): void {
    if (this.receipts().length > 20_000 || this.readNdjson(LOG, automationLogRecordSchema).length > 10_500) {
      this.compact();
    }
  }

  acquireMutationLease(): AutomationLease | undefined {
    return this.acquireLease(10 * 60_000, MUTATION_LOCK);
  }

  /**
   * Take the project's poll lock, reclaiming one nobody is holding any more (#983). A cockpit
   * killed mid-poll leaves the lock behind with its own pid inside; consulting that pid makes the
   * crash case instant instead of a ten-minute, workspace-wide outage. `staleAfterMs` stays as the
   * fallback for a lock whose pid we cannot read or trust.
   */
  acquireLease(staleAfterMs = 10 * 60_000, filename = POLL_LOCK): AutomationLease | undefined {
    mkdirSync(this.dataDir, { recursive: true });
    return this.tryAcquireLease(join(this.dataDir, filename), staleAfterMs, 0);
  }

  private tryAcquireLease(path: string, staleAfterMs: number, attempt: number): AutomationLease | undefined {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      return new AutomationLease(path, fd);
    } catch {
      // One reclaim per call: if the lock is back a moment later, a live contender took it.
      if (attempt >= LEASE_RECLAIM_ATTEMPTS) return undefined;
      try {
        if (this.isLeaseAbandoned(path, staleAfterMs)) {
          unlinkSync(path);
          return this.tryAcquireLease(path, staleAfterMs, attempt + 1);
        }
      } catch {
        // A contender removed the lock or the directory is read-only.
      }
      return undefined;
    }
  }

  /** Abandoned = the process that wrote the lock is gone, or nobody released it in `staleAfterMs`. */
  private isLeaseAbandoned(path: string, staleAfterMs: number): boolean {
    // Clamp to zero and compare with >=: `mtimeMs` carries sub-millisecond precision that
    // `Date.now()` does not, so a lock written a moment ago can read as zero or even slightly
    // negative age. Without the clamp, `staleAfterMs = 0` ("reclaim on age alone") would only
    // fire when the surrounding work happened to cross a millisecond boundary.
    const ageMs = Math.max(0, this.now().getTime() - statSync(path).mtimeMs);
    if (ageMs >= staleAfterMs) return true;
    const pid = readLeasePid(path);
    // An unreadable pid (an empty or half-written lock) leaves only the age rule above.
    if (pid === undefined || pid === process.pid) return false;
    return !(this.options.processAlive ?? isProcessAlive)(pid);
  }

  private load(): void {
    mkdirSync(this.dataDir, { recursive: true });
    this.loadDefinitions();
    this.stateFile = this.readJson(STATE, automationStateFileSchema, {
      version: 1,
      states: {},
    });
    const logs = this.readNdjson(LOG, automationLogRecordSchema);
    this.logSeq = logs.at(-1)?.seq ?? 0;
  }

  private loadDefinitions(): void {
    this.definitions.clear();
    this.definitionsFile = this.readJson(DEFINITIONS, automationDefinitionsFileSchema, {
      version: 1,
      automations: [],
    });
    for (const raw of this.definitionsFile.automations) {
      const parsed = automationDefinitionSchema.safeParse(raw);
      if (parsed.success) this.definitions.set(parsed.data.id, parsed.data);
      else this.warnOnce('definitions', 'Ignored an invalid GitHub automation definition.');
    }
  }

  private persistDefinitions(): void {
    this.pruneTombstones();
    this.definitionsFile.automations = [...this.definitions.values()];
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
    this.warnOnce(filename, `Ignored corrupt automation state in ${filename}.`);
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

/** The pid `acquireLease` wrote into the lock, or `undefined` for a lock we cannot read. */
function readLeasePid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown } | null;
    const pid = parsed?.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signal 0 probes a pid without touching the process. `EPERM` means it exists and belongs to
 * somebody else — alive, as far as the lock is concerned. A recycled pid, or a pid from a
 * namespace we do not share, reads as alive and degrades to the age rule: never worse than not
 * looking at all.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class AutomationLease {
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
