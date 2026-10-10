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
import lockfile from 'proper-lockfile';
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
const GUARD_SUFFIX = '.guard';
/**
 * Keep a contending process from reclaiming a live guard while its owner's event loop is stalled.
 *
 * The 2s proper-lockfile minimum is too short for a busy cockpit: a contender can replace the
 * guard during a stall, then the live-pid check rejects that contender and leaves the owner
 * compromised. Fifteen seconds is a deliberate bounded trade-off: it covers the multi-second
 * stall we protect against, while keeping SIGKILL recovery finite and tested below.
 */
const GUARD_STALE_MS = 15_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

type DefinitionsFile = ReturnType<typeof automationDefinitionsFileSchema.parse>;
type StateFile = ReturnType<typeof automationStateFileSchema.parse>;

export interface AutomationStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  /** Liveness probe for the pid recorded in the poll lock. Injected by tests only. */
  processAlive?: (pid: number) => boolean;
  /** Test-only hook for exercising a replacement between metadata validation and creation. */
  beforeLeaseMetadataWrite?: (path: string) => void;
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
      // `pinnedCursor` records that a cursor was unescapable *under the previous definition*, and the
      // pinned poll log tells the operator to narrow the filter to escape it. Carrying the marker across
      // an edit would skip the widening re-poll that makes the narrowed filter take effect, so the very
      // remediation the log prescribes would silently do nothing (#982).
      if (this.state(id)) {
        this.setState(id, (current) => ({ ...current, revision: definition.revision, pinnedCursor: undefined }));
      }
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
    // receiptKey is redundant with the durable identity.  Normalize from the identity rather
    // than trusting the persisted spelling so imported or otherwise legacy rows cannot split
    // deduplication across equivalent event identities.
    for (const row of this.receipts()) latest.set(receiptKeyFor(row.automationId, row.eventId), row);
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
    const receiptKey = receiptKeyFor(input.automationId, input.eventId);
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
    return this.tryAcquireLease(join(this.dataDir, filename), staleAfterMs);
  }

  private tryAcquireLease(path: string, staleAfterMs: number): AutomationLease | undefined {
    try {
      return this.createLease(path, staleAfterMs);
    } catch {
      // A held, live, malformed, or unrecoverable guard reports busy. The lock primitive owns
      // stale recovery and performs it under its cross-platform atomic mkdir protocol (#998).
      return undefined;
    }
  }

  private createLease(path: string, staleAfterMs: number): AutomationLease {
    let compromised = false;
    const releaseGuard = lockfile.lockSync(path, {
      lockfilePath: `${path}${GUARD_SUFFIX}`,
      realpath: false,
      stale: GUARD_STALE_MS,
      // proper-lockfile's default throws from its heartbeat timer. Never take the
      // cockpit down for a lost guard; callers check validity before launching or
      // publishing after an asynchronous compromise notification.
      onCompromised: () => { compromised = true; },
    });
    try {
      const existed = existsSync(path);
      const previous = existed ? readLeaseMetadata(path) : undefined;
      const ageMs = existed ? Math.max(0, this.now().getTime() - statSync(path).mtimeMs) : 0;
      if (previous?.pid === process.pid || (previous?.pid && (this.options.processAlive ?? isProcessAlive)(previous.pid))) {
        throw new Error('lease is held by a live process');
      }
      if (existed && !previous?.pid && ageMs < staleAfterMs) {
        throw new Error('lease metadata is not stale');
      }
      const token = randomUUID();
      if (existed) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      this.options.beforeLeaseMetadataWrite?.(path);
      writeLeaseMetadataExclusive(path, JSON.stringify({ pid: process.pid, token, startedAt: this.now().toISOString() }));
      return new AutomationLease(path, token, releaseGuard, () => !compromised);
    } catch (error) {
      try { releaseGuard(); } catch { /* guard was already recovered */ }
      throw error;
    }
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

function receiptKeyFor(automationId: string, eventId: string): string {
  return `${automationId}:${eventId}`;
}

/**
 * Create metadata without ever truncating a pathname that appeared after the
 * stale check. EEXIST is deliberately surfaced as busy to the lease caller.
 */
function writeLeaseMetadataExclusive(path: string, contents: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

/** Metadata written by `acquireLease`, or an empty object for malformed state. */
function readLeaseMetadata(path: string): { pid?: number; token?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; token?: unknown } | null;
    return {
      pid: typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined,
      token: typeof parsed?.token === 'string' ? parsed.token : undefined,
    };
  } catch {
    return {};
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
    private readonly token: string,
    private readonly releaseGuard: () => void,
    private readonly guardIsHealthy: () => boolean = () => true,
  ) {}

  /** False after the lock primitive reports that another owner replaced this guard. */
  isValid(): boolean { return !this.released && this.guardIsHealthy(); }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      const owner = JSON.parse(readFileSync(this.path, 'utf8')) as { token?: unknown };
      if (owner.token === this.token) unlinkSync(this.path);
    } catch {
      // Already removed, malformed, or replaced during shutdown cleanup.
    }
    try { this.releaseGuard(); } catch { /* already released or recovered during shutdown */ }
  }
}
