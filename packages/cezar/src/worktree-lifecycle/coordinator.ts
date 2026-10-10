import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  lifecycleOperationViewSchema,
  type LifecycleAction, type LifecycleActionInput, type LifecycleOperation,
  type LifecycleOperationView, type LifecyclePendingLaunch, type LifecycleIntent,
  type StartLifecycleRemovalInput, type WorktreeLifecycleRecord,
  type WorktreeLifecycleSummary, type WorktreeLifecycleDetail, type LifecyclePreviewResponse,
} from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createWorktree, createWorktreeWithOutcome, removeWorktree, worktreePathFor, branchFor } from '../git-worktree.ts';
import { seedAgentConfigLocalLayer } from '../agent-config/seed.ts';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { LifecycleStore, LifecycleConflictError, withLifecycleFileLock } from './store.ts';
import { readLifecycleConfig, withLifecycleConfigLock } from './config.ts';
import { renderLifecycleCommand, lifecycleCommandFingerprint, type LifecycleTemplateContext } from './templates.ts';
import { executeLifecycleCommand, probeLifecycleProcess } from './executor.ts';

const execFileAsync = promisify(execFile);
const terminal = new Set(['completed', 'bypassed', 'cancelled', 'kept']);
const attention = new Set(['needs_attention', 'interrupted']);
const now = () => new Date().toISOString();
const bodyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class LifecycleConflict extends Error {}
export class LifecycleNotFound extends Error {}

/** The coordinator is project-local and deliberately knows nothing about HTTP. */
export class WorktreeLifecycleCoordinator {
  readonly store: LifecycleStore;
  private readonly listeners = new Set<(event: {worktreeId: string; operationId?: string; revision: number}) => void>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly ownedDiscardReservations = new Set<string>();
  private readonly executing = new Set<string>();
  private readonly liveOperations = new Map<string, LifecycleOperation>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly queue = new Map<string, number>();
  private readonly offSemaphore: () => void;
  private disposed = false;
  private cleanupStarted = false;
  constructor(private readonly root: string, private readonly runs: RunStore, private readonly options: {
    semaphore: WorkspaceSemaphore;
    deferCleanup?: boolean;
    busySlots: () => number;
    isActive: (runId: string) => boolean;
    cancelAndWait: (runId: string) => Promise<boolean>;
    cancelPending?: (runId: string) => void;
    resume: (runId: string, launch: LifecyclePendingLaunch | undefined) => Promise<void>;
  }) {
    try { this.root = realpathSync(root); } catch { /* missing roots remain a local attention failure */ }
    this.cleanupStarted = !options.deferCleanup;
    this.store = new LifecycleStore(join(this.root, '.ai/cezar'), this.root);
    this.offSemaphore = options.semaphore.register({
      busySlots: () => this.executing.size,
      oldestQueuedAt: () => Math.min(...this.queue.values()) === Infinity ? null : Math.min(...this.queue.values()),
      pump: () => this.pump(),
    });
  }
  onChange(listener: (event: {worktreeId: string; operationId?: string; revision: number}) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private changed(record: WorktreeLifecycleRecord, operation?: LifecycleOperation): void {
    if (this.runs.getRun(record.runId)) this.runs.updateRun(record.runId, {
      worktreeLifecycle: {
        worktreeId: record.worktreeId, generation: record.generation,
        ...(record.activeOperationId ? {activeOperationId: record.activeOperationId} : {}),
        ...(operation ? {phase: operation.phase, state: operation.state} : {}),
        needsAttention: operation ? attention.has(operation.state) : false,
      },
    });
    for (const listener of this.listeners) listener({worktreeId: record.worktreeId, ...(operation ? {operationId: operation.id} : {}), revision: operation?.revision ?? 0});
  }
  isBlocked(runId: string): boolean {
    const gate = this.runs.getRun(runId)?.worktreeLifecycle;
    return gate?.needsAttention === true || (!!gate?.activeOperationId && !!gate.state && !terminal.has(gate.state));
  }
  async requiresGate(runId: string): Promise<boolean> {
    const record = await this.store.readWorktree(runId);
    if (record) return true;
    const run = this.runs.getRun(runId);
    if (run && !run.worktreePath) return false;
    const config = await readLifecycleConfig(this.root);
    return config.config.afterCreate.length > 0 || config.config.beforeRemove.length > 0;
  }
  private context(record: WorktreeLifecycleRecord): LifecycleTemplateContext {
    const expected = resolve(worktreePathFor(this.root, record.runId));
    if (record.branch && record.branch !== branchFor(record.runId)) throw new LifecycleConflict('Lifecycle branch is not the managed task branch');
    if (resolve(record.projectRoot) !== resolve(this.root) || resolve(record.worktreePath) !== expected) throw new LifecycleConflict('Worktree context does not belong to this project');
    if (existsSync(expected) && realpathSync(expected) !== expected) throw new LifecycleConflict('Worktree path resolves outside its managed location');
    return {root_path: this.root, worktree_path: expected, worktree_id: `cez-${record.worktreeId}`, task_id: record.runId};
  }
  private async recordById(id: string): Promise<WorktreeLifecycleRecord> {
    const { records } = await this.store.listWorktrees();
    const record = records.find(item => item.worktreeId === id);
    if (!record) throw new LifecycleNotFound('Unknown worktree lifecycle identity');
    this.context(record); return record;
  }
  private async save(record: WorktreeLifecycleRecord, operation: LifecycleOperation): Promise<void> {
    const expected = operation.revision;
    operation.revision++; operation.updatedAt = now(); record.updatedAt = operation.updatedAt;
    await this.store.writeOperation(operation, expected);
    await this.store.writeWorktree(record);
    this.changed(record, operation);
  }
  private makeOperation(record: WorktreeLifecycleRecord, intent: LifecycleIntent, launch?: LifecyclePendingLaunch): LifecycleOperation {
    return {schemaVersion: 1, id: randomUUID(), worktreeId: record.worktreeId, generation: record.generation,
      intent, phase: intent === 'create' || intent === 'recreate' ? 'setup' : 'teardown', state: 'queued', revision: 0,
      createdAt: now(), updatedAt: now(), executions: [], successfulEntries: [], requests: [],
      ...(launch ? {pendingLaunch: launch} : {}),
    };
  }
  private async enroll(runId: string): Promise<WorktreeLifecycleRecord> {
    const prior = await this.store.readWorktree(runId);
    if (prior) { this.context(prior); return prior; }
    const run = this.runs.getRun(runId);
    if (!run) throw new LifecycleNotFound('Unknown task');
    if (!run.worktreePath) throw new LifecycleConflict('Task has no managed worktree');
    const record: WorktreeLifecycleRecord = {schemaVersion: 1, worktreeId: randomUUID(), runId,
      projectRoot: this.root, worktreePath: run.worktreePath, ...(run.branch ? {branch: run.branch} : {}),
      generation: 1, preparedBy: 'completed', autoCleanupSuppressed: false, createdAt: now(), updatedAt: now()};
    this.context(record); await this.store.writeWorktree(record); return record;
  }
  /** Caller already holds normal task admission. No second slot is acquired for setup. */
  async prepare(runId: string, base: string, pendingLaunch: LifecyclePendingLaunch, signal?: AbortSignal): Promise<{ready: boolean; path: string; branch: string; baseBranch: string; operationId?: string}> {
    this.runs.flush();
    const prior = await this.store.readWorktree(runId);
    let configured: Awaited<ReturnType<typeof readLifecycleConfig>>;
    try { configured = await readLifecycleConfig(this.root); }
    catch (error) {
      return this.store.withWorktreeLock(runId, async () => {
        const record: WorktreeLifecycleRecord = prior ?? {schemaVersion: 1, worktreeId: randomUUID(), runId, projectRoot: this.root,
          worktreePath: worktreePathFor(this.root, runId), branch: branchFor(runId), generation: 1,
          autoCleanupSuppressed: false, createdAt: now(), updatedAt: now()};
        const existing = record.activeOperationId ? await this.store.readOperation(record.activeOperationId) : null;
        const operation = existing ?? this.makeOperation(record, prior ? 'recreate' : 'create', pendingLaunch);
        record.activeOperationId = operation.id;
        if (!existing) await this.store.writeOperation(operation);
        await this.store.writeWorktree(record);
        await this.fail(record, operation, error, 'config');
        return {ready: false, path: record.worktreePath, branch: record.branch ?? branchFor(runId), baseBranch: base, operationId: operation.id};
      });
    }
    if (!prior && !configured.config.afterCreate.length && !configured.config.beforeRemove.length) {
      const wt = await createWorktree(this.root, runId, base);
      await seedAgentConfigLocalLayer(this.root, wt.path).catch(() => []);
      return {ready: true, ...wt};
    }
    return this.store.withWorktreeLock(runId, async () => {
      let record = await this.store.readWorktree(runId);
      const materialized = existsSync(join(worktreePathFor(this.root, runId), '.git'));
      if (record?.preparedBy && materialized && !record.activeOperationId) return {ready: true, path: record.worktreePath, branch: record.branch ?? branchFor(runId), baseBranch: base};
      if (!record) record = {schemaVersion: 1, worktreeId: randomUUID(), runId, projectRoot: this.root,
        worktreePath: worktreePathFor(this.root, runId), branch: branchFor(runId), generation: 1,
        autoCleanupSuppressed: false, createdAt: now(), updatedAt: now()};
      this.context(record);
      let operation = record.activeOperationId ? await this.store.readOperation(record.activeOperationId) : undefined;
      if (operation && operation.state !== 'queued' && !terminal.has(operation.state)) {
        return {ready: false, path: record.worktreePath, branch: record.branch ?? branchFor(runId), baseBranch: base, operationId: operation.id};
      }
      if (!operation || terminal.has(operation.state)) {
        if (!materialized && prior) record.generation++;
        delete record.preparedBy; record.autoCleanupSuppressed = false;
        operation = this.makeOperation(record, prior && !materialized ? 'recreate' : 'create', pendingLaunch);
        record.activeOperationId = operation.id;
        await this.store.writeOperation(operation); await this.store.writeWorktree(record);
        this.changed(record, operation);
      }
      try {
        if (signal?.aborted) throw new Error('Preparation cancelled before materialization');
        if (process.env.CEZ_DRY_RUN !== '1') {
          const wt = await createWorktreeWithOutcome(this.root, runId, base);
          record.worktreePath = wt.path; record.branch = wt.branch;
          this.runs.updateRun(runId, {worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, worktreeReclaimedAt: undefined});
          await seedAgentConfigLocalLayer(this.root, wt.path).catch(() => []);
          if (!prior && !wt.materialized && materialized) {
            // Enroll a legacy already-prepared directory for future teardown;
            // enabling hooks is not itself a creation event.
            record.preparedBy = 'completed'; delete record.activeOperationId;
            operation.state = 'completed'; operation.finishedAt = now();
            await this.save(record, operation);
            return {ready: true, path: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, operationId: operation.id};
          }
        }
        await this.runCommands(record, operation, signal);
      } catch (error) { await this.fail(record, operation, error, 'context'); }
      if (signal?.aborted && !record.preparedBy) {
        operation.state = 'cancelled'; operation.finishedAt = now(); record.autoCleanupSuppressed = true; delete record.activeOperationId;
        await this.save(record, operation);
      }
      return {ready: record.preparedBy !== undefined, path: record.worktreePath, branch: record.branch ?? branchFor(runId), baseBranch: base, operationId: operation.id};
    });
  }
  async reopenSetup(runId: string): Promise<void> {
    await this.store.withWorktreeLock(runId, async () => {
      const record = await this.store.readWorktree(runId);
      if (!record || record.preparedBy || record.activeOperationId) throw new LifecycleConflict('No cancelled preparation to reopen');
      const operation = this.makeOperation(record, 'create', {kind: 'initial', runId});
      operation.state = 'needs_attention'; operation.error = 'Setup was cancelled. Retry current scripts or explicitly start the task anyway.';
      record.activeOperationId = operation.id;
      await this.store.writeOperation(operation); await this.store.writeWorktree(record);
      this.runs.updateRun(runId, {status: 'waiting', finishedAt: undefined});
      this.changed(record, operation);
    });
  }
  private async fail(record: WorktreeLifecycleRecord, operation: LifecycleOperation, error: unknown, stage: LifecycleOperation['failureStage']): Promise<void> {
    operation.state = 'needs_attention'; operation.failureStage = stage;
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error), collectSecretValues(process.env));
    await this.save(record, operation);
  }
  private async runCommands(record: WorktreeLifecycleRecord, operation: LifecycleOperation, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController(); this.controllers.set(operation.id, controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) controller.abort();
    this.liveOperations.set(operation.id, operation);
    let outputNotification: ReturnType<typeof setTimeout> | undefined;
    let complete!: () => void;
    this.completions.set(operation.id, new Promise<void>(resolve => { complete = resolve; }));
    try {
      const context = this.context(record);
      if (operation.decision?.action === 'force-delete' || operation.decision?.action === 'start-anyway') {
        try {
          const current = await readLifecycleConfig(this.root);
          const entries = operation.phase === 'setup' ? current.config.afterCreate : current.config.beforeRemove;
          operation.decision.skippedEntryIds = entries.filter(entry => {
            try { return !operation.successfulEntries.some(success => success.entryId === entry.id && success.fingerprint === lifecycleCommandFingerprint(entry.command, context)); }
            catch { return true; }
          }).map(entry => entry.id);
        } catch { operation.decision.skippedEntryIds = operation.executions.filter(entry => entry.state !== 'succeeded').map(entry => entry.entryId); }
        await withLifecycleConfigLock(this.root, () => this.commit(record, operation));
        return;
      }
      let changes = 0; let revision: string | null | undefined;
      for (;;) {
        if (this.disposed || controller.signal.aborted) { await this.fail(record, operation, 'Scripts stopped; choose Retry to continue', 'command'); return; }
        const snapshot = await readLifecycleConfig(this.root);
        if (revision !== undefined && revision !== snapshot.revision && ++changes > 10) { await this.fail(record, operation, 'Configuration kept changing; retry when edits are finished.', 'config'); return; }
        revision = snapshot.revision; operation.configRevision = snapshot.revision;
        const entries = operation.phase === 'setup' ? snapshot.config.afterCreate : snapshot.config.beforeRemove;
        const planned = entries.map((entry, ordinal) => ({entry, ordinal, rendered: renderLifecycleCommand(entry.command, context), fingerprint: lifecycleCommandFingerprint(entry.command, context)}));
        const pending = planned.find(({entry, fingerprint}) => !operation.successfulEntries.some(success => success.entryId === entry.id && success.fingerprint === fingerprint));
        if (!pending) {
          const committed = await withLifecycleConfigLock(this.root, async () => {
            const latest = await readLifecycleConfig(this.root);
            if (latest.revision !== revision) return false;
            await this.commit(record, operation); return true;
          });
          if (committed) return;
          continue;
        }
        if (process.env.CEZ_DRY_RUN !== '1' && !existsSync(context.worktree_path)) { await this.fail(record, operation, 'Worktree directory is missing; scripts cannot run in the project root', 'context'); return; }
        const {entry, ordinal, rendered, fingerprint} = pending;
        const execution = {id: randomUUID(), operationId: operation.id, entryId: entry.id, fingerprint, ordinal,
          label: redactSecrets(entry.name || `Command ${ordinal + 1}`, collectSecretValues(process.env)),
          commandPreview: redactSecrets(rendered, collectSecretValues(process.env)),
          attempt: operation.executions.filter(item => item.entryId === entry.id).length + 1,
          state: 'running' as const, startedAt: now()};
        operation.executions.push(execution); operation.executions = operation.executions.slice(-100);
        operation.state = 'running'; delete operation.error; delete operation.failureStage;
        await this.save(record, operation); // Failure here MUST prevent spawn.
        const result = await executeLifecycleCommand({command: rendered, cwd: context.worktree_path,
          ...(entry.timeoutSeconds ? {timeoutSeconds: entry.timeoutSeconds} : {}), signal: controller.signal,
          dryRun: process.env.CEZ_DRY_RUN === '1',
          onStart: async identity => {
            const current = operation.executions.at(-1)!;
            current.process = identity; await this.save(record, operation);
          },
          onOutput: async frame => {
            await this.store.appendOutput(operation.id, {executionId: execution.id, stream: frame.stream, text: frame.text, time: now()});
            if (!outputNotification) outputNotification = setTimeout(() => {
              outputNotification = undefined; this.changed(record, operation);
            }, 100);
          },
        });
        const current = operation.executions.at(-1)!;
        current.state = result.state; current.finishedAt = now();
        if (result.exitCode !== undefined) current.exitCode = result.exitCode;
        if (result.signal !== undefined) current.signal = result.signal;
        if (result.reason) current.reason = result.reason;
        if (current.process) current.process.quiescent = result.quiescent;
        current.outputTruncated = result.truncated;
        if (result.state !== 'succeeded' || !result.quiescent) {
          operation.state = result.quiescent ? 'needs_attention' : 'interrupted'; operation.failureStage = 'command';
          operation.error = result.reason ?? 'Command failed; edit scripts or choose a recovery action';
          await this.save(record, operation); return;
        }
        operation.successfulEntries.push({entryId: entry.id, fingerprint});
        await this.save(record, operation);
      }
    } finally { if (outputNotification) clearTimeout(outputNotification); signal?.removeEventListener('abort', abort); this.controllers.delete(operation.id); this.liveOperations.delete(operation.id); this.changed(record, operation); complete(); this.completions.delete(operation.id); }
  }
  private async commit(record: WorktreeLifecycleRecord, operation: LifecycleOperation): Promise<void> {
    operation.state = 'committing'; await this.save(record, operation);
    try {
      if (operation.phase === 'setup') {
        record.preparedBy = operation.decision?.action === 'start-anyway' ? 'bypassed' : 'completed';
      } else {
        if (this.options.isActive(record.runId)) throw new LifecycleConflict('Task is still active; directory retained');
        this.context(record);
        if (process.env.CEZ_DRY_RUN !== '1') {
          await removeWorktree(this.root, record.worktreePath, operation.intent === 'reclaim' ? undefined : record.branch);
          if (existsSync(record.worktreePath)) throw new Error('Scripts completed but the worktree directory could not be removed');
          if (operation.intent !== 'reclaim' && record.branch) {
            const remains = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], {cwd: this.root}).then(() => true, error => {
              if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false;
              throw error;
            });
            if (remains) throw new Error('Worktree directory is gone but its managed branch could not be removed');
          }
          if (operation.intent === 'delete-task') this.runs.deleteRun(record.runId);
          else if (this.runs.getRun(record.runId)) this.runs.updateRun(record.runId, operation.intent === 'reclaim'
            ? {worktreeReclaimedAt: now()} : {worktreePath: undefined, branch: undefined});
        }
        delete record.preparedBy;
      }
      operation.state = operation.phase === 'setup' && operation.decision?.action === 'start-anyway' ? 'bypassed' : 'completed';
      operation.finishedAt = now(); delete operation.error; delete operation.failureStage; delete record.activeOperationId;
      await this.save(record, operation);
    } catch (error) { await this.fail(record, operation, error, 'commit'); }
  }
  /** Keep cross-process directory ownership until the provider really exits. */
  async acquireAgentLease(runId: string): Promise<() => void> {
    if (!await this.requiresGate(runId)) return () => undefined;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let acquired!: () => void;
    let rejectAcquired!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; rejectAcquired = reject; });
    void this.withWorktreeMutation(runId, async () => {
      const record = await this.store.readWorktree(runId);
      if (!record?.preparedBy || !existsSync(join(record.worktreePath, '.git'))) {
        throw new LifecycleConflict('Prepared worktree is no longer available; retry preparation before starting the agent');
      }
      this.context(record);
      acquired(); await released;
    }).catch(rejectAcquired);
    await ready;
    return release;
  }
  async withWorktreeMutation<T>(runId: string, mutate: () => Promise<T>): Promise<T> {
    if (!await this.requiresGate(runId)) return mutate();
    return this.store.withWorktreeLock(runId, async () => {
      const record = await this.store.readWorktree(runId);
      const operation = record?.activeOperationId ? await this.store.readOperation(record.activeOperationId) : undefined;
      if (operation && !terminal.has(operation.state)) throw new LifecycleConflict('Worktree lifecycle operation is pending; resolve it first');
      return mutate();
    });
  }
  private requestLock<T>(callback: () => Promise<T>): Promise<T> {
    return withLifecycleFileLock(join(this.store.directory, 'locks', 'requests.lock'), callback);
  }
  async startRemoval(input: StartLifecycleRemovalInput): Promise<LifecycleOperationView> {
    return this.requestLock(async () => {
      const hash = bodyHash(input);
      for (const prior of await this.store.listOperations()) {
        const request = prior.requests.find(item => item.requestId === input.requestId);
        if (request) {
          if (request.bodyHash !== hash) throw new LifecycleConflict('Request ID was already used for a different action');
          return this.operation(prior.id);
        }
      }
      return this.startRemovalLocked(input);
    });
  }
  private async startRemovalLocked(input: StartLifecycleRemovalInput): Promise<LifecycleOperationView> {
    const record = 'runId' in input ? await this.enroll(input.runId) : await this.recordById(input.worktreeId);
    return this.startRecordRemoval(record, input.intent, input.requestId, bodyHash(input));
  }
  private async startRecordRemoval(record: WorktreeLifecycleRecord, intent: LifecycleIntent, requestId: string, hash: string): Promise<LifecycleOperationView> {
    return this.store.withWorktreeLock(record.runId, async () => {
      const operations = await this.store.listOperations(record.worktreeId);
      for (const prior of operations) {
        const request = prior.requests.find(item => item.requestId === requestId);
        if (request) {
          if (request.bodyHash !== hash) throw new LifecycleConflict('Request ID was already used for a different action');
          return this.view(prior, record);
        }
      }
      record = await this.store.readWorktree(record.runId) ?? record;
      if (record.activeOperationId) {
        const existing = await this.store.readOperation(record.activeOperationId);
        if (existing && !terminal.has(existing.state)) throw new LifecycleConflict('Worktree already has a pending lifecycle operation');
      }
      if (this.options.isActive(record.runId)) throw new LifecycleConflict('Task is active; cancel it before removing its worktree');
      const operation = this.makeOperation(record, intent);
      operation.requests.push({requestId, bodyHash: hash}); record.activeOperationId = operation.id;
      await this.store.writeOperation(operation); await this.store.writeWorktree(record); this.changed(record, operation);
      this.queue.set(operation.id, Date.now()); queueMicrotask(() => { void this.pump(); });
      return this.view(operation, record);
    });
  }
  /** Reservations serialize with retention without waiting on the agent's lifetime worktree lease. */
  private variantIntentLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    return withLifecycleFileLock(join(this.store.directory, 'locks', `variant-${runId}.lock`), action);
  }
  async reclaim(runId: string): Promise<boolean> {
    try {
      if (!await this.requiresGate(runId)) return false;
      await this.variantIntentLock(runId, async () => {
        const record = await this.enroll(runId);
        if (record.autoCleanupSuppressed || record.activeOperationId) return;
        // A discard intent is durable before cancellation can trigger terminal retention.
        // It may briefly precede the active pointer while an owned setup child is stopping.
        const operations = await this.store.listOperations(record.worktreeId);
        if (operations.some(operation => operation.intent === 'discard-variant' && !terminal.has(operation.state))) return;
        await this.startRecordRemoval(record, 'reclaim', randomUUID(), bodyHash({runId, intent: 'reclaim'}));
      });
    } catch { /* automatic cleanup preserves ambiguous context */ }
    return false; // Queued removal is never reported as reclaimed.
  }
  async discardVariant(runId: string): Promise<LifecycleOperationView | null> {
    const known = await this.store.readWorktree(runId);
    if (!known && !this.runs.getRun(runId)?.worktreePath) {
      if (!await this.options.cancelAndWait(runId)) throw new LifecycleConflict('Variant process has not exited; worktree retained');
      return null;
    }
    // Even a hook-free materialized variant is enrolled before cancellation: otherwise
    // dropActive's retention can remove its directory and retain the branch first.
    const reservation = await this.variantIntentLock(runId, async () => {
      const record = await this.enroll(runId);
      const active = record.activeOperationId ? await this.store.readOperation(record.activeOperationId) : null;
      if (record.activeOperationId && !active) throw new LifecycleConflict('Variant lifecycle metadata is missing; worktree retained');
      if (active?.phase === 'teardown' && !terminal.has(active.state) && active.intent !== 'discard-variant') {
        throw new LifecycleConflict('Variant already has a pending teardown; resolve that operation first');
      }
      if (active?.agentQuiescencePending && !this.ownedDiscardReservations.has(active.id)) {
        throw new LifecycleConflict('Cannot verify that the previous variant agent exited; worktree retained for manual recovery');
      }
      if (active?.intent === 'discard-variant' && active.state !== 'committing') return {record, operation: active, existing: true};
      const pending = (await this.store.listOperations(record.worktreeId)).find(operation =>
        operation.generation === record.generation && operation.intent === 'discard-variant' && operation.state === 'committing');
      if (pending?.agentQuiescencePending && !this.ownedDiscardReservations.has(pending.id)) {
        throw new LifecycleConflict('Cannot verify that the previous variant agent exited; worktree retained for manual recovery');
      }
      const operation = pending ?? this.makeOperation(record, 'discard-variant');
      if (!pending) {
        operation.state = 'committing'; // No recovery actions while the old executor could still own the directory.
        operation.error = 'Stopping the variant before cleanup can begin';
        operation.failureStage = 'process';
        operation.agentQuiescencePending = true;
        operation.requests.push({requestId: randomUUID(), bodyHash: bodyHash({runId, intent: 'discard-variant'})});
        await this.store.writeOperation(operation, null);
        this.ownedDiscardReservations.add(operation.id);
      }
      record.autoCleanupSuppressed = true;
      const setupId = active?.phase === 'setup' && !terminal.has(active.state) ? active.id : undefined;
      if (!setupId) record.activeOperationId = operation.id;
      // Persist the exclusion before cancelAndWait, but defer its run projection: the
      // ordinary manager cancellation guard must still be able to stop its agent.
      await this.store.writeWorktree(record);
      return {record, operation, existing: false, setupId};
    });
    if (reservation.existing) return this.view(reservation.operation, reservation.record);
    const {operation, setupId} = reservation;
    if (setupId) {
      const completion = this.completions.get(setupId);
      this.controllers.get(setupId)?.abort();
      if (completion) await completion;
      await this.store.withWorktreeLock(runId, async () => {
        const record = await this.store.readWorktree(runId);
        if (!record) throw new LifecycleConflict('Variant context disappeared; worktree retained');
        if (record.activeOperationId && record.activeOperationId !== setupId && record.activeOperationId !== operation.id) {
          throw new LifecycleConflict('Variant lifecycle changed while stopping; worktree retained');
        }
        const setup = await this.store.readOperation(setupId);
        if (!setup || !await this.processQuiescent(setup) || setup.executions.some(execution =>
          (execution.state === 'running' || execution.state === 'interrupted') && !execution.process)) {
          throw new LifecycleConflict('Previous setup process may still be running; worktree retained');
        }
        record.autoCleanupSuppressed = true;
        if (!terminal.has(setup.state)) {
          setup.state = 'cancelled'; setup.finishedAt = now(); delete record.activeOperationId;
          await this.save(record, setup);
        }
        record.activeOperationId = operation.id;
        await this.store.writeWorktree(record);
      });
    }
    this.options.cancelPending?.(runId);
    if (!await this.options.cancelAndWait(runId)) {
      throw new LifecycleConflict('Variant process has not exited; its cleanup intent and worktree are retained');
    }
    return this.store.withWorktreeLock(runId, async () => {
      const record = await this.store.readWorktree(runId);
      const current = await this.store.readOperation(operation.id);
      if (!record || !current || record.activeOperationId !== operation.id) throw new LifecycleConflict('Variant cleanup context changed; worktree retained');
      if (current.state !== 'committing') return this.view(current, record);
      if (this.options.isActive(runId)) throw new LifecycleConflict('Variant is still active; worktree retained');
      current.state = 'queued'; delete current.error; delete current.failureStage; delete current.agentQuiescencePending;
      await this.save(record, current);
      this.ownedDiscardReservations.delete(current.id);
      this.queue.set(current.id, Date.now()); queueMicrotask(() => { void this.pump(); });
      return this.view(current, record);
    });
  }
  private async pump(): Promise<void> {
    if (this.disposed || !this.cleanupStarted) return;
    for (const [id] of this.queue) {
      if (this.options.semaphore.busy() >= this.options.semaphore.maxParallel() || this.executing.size + this.options.busySlots() >= this.options.semaphore.projectMaxParallel(this.root)) break;
      this.queue.delete(id); this.executing.add(id);
      void this.activate(id).finally(() => { this.executing.delete(id); void this.options.semaphore.release(); });
    }
  }
  private async activate(id: string): Promise<void> {
    try {
      const operation = await this.store.readOperation(id);
      if (!operation || operation.state !== 'queued') return;
      const record = await this.recordById(operation.worktreeId);
      await this.store.withWorktreeLock(record.runId, async () => {
        const latest = await this.store.readOperation(id);
        if (!latest || latest.state !== 'queued') return;
        try { await this.runCommands(record, latest); }
        catch (error) { await this.fail(record, latest, error, 'config'); }
      });
    } catch { /* durable queued operation remains visible if storage is unavailable */ }
  }
  private async processQuiescent(operation: LifecycleOperation): Promise<boolean> {
    if (operation.agentQuiescencePending) return false;
    if (this.controllers.has(operation.id)) return false;
    for (const execution of operation.executions) {
      if (!execution.process || execution.process.quiescent) continue;
      if (await probeLifecycleProcess(execution.process) !== 'quiescent') return false;
    }
    return true;
  }
  async action(id: string, input: LifecycleActionInput): Promise<LifecycleOperationView> {
    return this.requestLock(async () => {
      const hash = bodyHash(input);
      for (const prior of await this.store.listOperations()) {
        const request = prior.requests.find(item => item.requestId === input.requestId);
        if (request) {
          if (prior.id !== id || request.bodyHash !== hash) throw new LifecycleConflict('Request ID was already used for a different action');
          return this.operation(prior.id);
        }
      }
      return this.actionLocked(id, input);
    });
  }
  private async actionLocked(id: string, input: LifecycleActionInput): Promise<LifecycleOperationView> {
    const operation = await this.store.readOperation(id);
    if (!operation) throw new LifecycleNotFound('Unknown lifecycle operation');
    const record = await this.recordById(operation.worktreeId);
    // Stop cannot wait for the executor's worktree lease: it must first terminate it.
    if (input.action === 'stop' && this.controllers.has(id)) {
      if (operation.revision !== input.expectedRevision) throw new LifecycleConflict('Operation changed; refresh and try again');
      const live = this.liveOperations.get(id)!;
      live.requests.push({requestId: input.requestId, bodyHash: bodyHash(input)});
      live.decision = {action: 'stop', actor: 'local-user', at: now()};
      this.controllers.get(id)!.abort();
      await this.completions.get(id);
      return this.operation(id);
    }
    return this.store.withWorktreeLock(record.runId, async () => {
      const current = await this.store.readOperation(id);
      if (!current) throw new LifecycleNotFound('Unknown lifecycle operation');
      const hash = bodyHash(input);
      const prior = current.requests.find(item => item.requestId === input.requestId);
      if (prior) {
        if (prior.bodyHash !== hash) throw new LifecycleConflict('Request ID was already used for a different action');
        return this.view(current, record);
      }
      if (current.revision !== input.expectedRevision) throw new LifecycleConflict('Operation changed; refresh and try again');
      const view = await this.view(current, record);
      if (!view.allowedActions.includes(input.action)) throw new LifecycleConflict('Action is not available for this operation');
      if (!await this.processQuiescent(current)) throw new LifecycleConflict('Previous script may still be running; stop that process before retrying');
      current.requests.push({requestId: input.requestId, bodyHash: hash});
      current.decision = {action: input.action, actor: 'local-user', at: now()};
      if (input.action === 'stop') {
        this.queue.delete(id); current.state = 'needs_attention'; current.error = 'Scripts stopped; choose Retry to continue';
      } else if (input.action === 'cancel-task' || input.action === 'keep-worktree') {
        current.state = input.action === 'cancel-task' ? 'cancelled' : 'kept'; current.finishedAt = now();
        record.autoCleanupSuppressed = true; delete record.activeOperationId;
        if (input.action === 'cancel-task') {
          this.options.cancelPending?.(record.runId);
          if (this.runs.getRun(record.runId)) this.runs.updateRun(record.runId, {status: 'cancelled', finishedAt: now()});
        }
      } else {
        current.state = 'queued'; delete current.error; delete current.failureStage;
        if (input.action === 'retry') delete current.decision;
      }
      await this.save(record, current);
      if (current.state === 'queued') {
        if (current.phase === 'setup') queueMicrotask(() => { void this.options.resume(record.runId, current.pendingLaunch).catch(error => this.fail(record, current, error, 'context')); });
        else { this.queue.set(id, Date.now()); queueMicrotask(() => { void this.pump(); }); }
      }
      return this.view(current, record);
    });
  }
  private async view(operation: LifecycleOperation, record: WorktreeLifecycleRecord): Promise<LifecycleOperationView> {
    let entries: LifecycleOperationView['entries'] = [];
    try {
      const config = await readLifecycleConfig(this.root);
      const current = operation.phase === 'setup' ? config.config.afterCreate : config.config.beforeRemove;
      entries = current.map((entry, index) => {
        const fingerprint = lifecycleCommandFingerprint(entry.command, this.context(record));
        const latest = [...operation.executions].reverse().find(item => item.entryId === entry.id && item.fingerprint === fingerprint);
        const succeeded = operation.successfulEntries.some(item => item.entryId === entry.id && item.fingerprint === fingerprint);
        const skipped = (operation.state === 'bypassed' || operation.state === 'completed')
          && operation.decision?.skippedEntryIds?.includes(entry.id);
        return {entryId: entry.id, label: redactSecrets(entry.name || `Command ${index + 1}`, collectSecretValues(process.env)),
          commandPreview: redactSecrets(renderLifecycleCommand(entry.command, this.context(record)), collectSecretValues(process.env)),
          state: succeeded ? 'already-completed' : skipped ? 'skipped' : latest?.state ?? 'pending', attempt: latest?.attempt ?? 0};
      });
      const present = new Set(current.map(entry => entry.id));
      for (const execution of operation.executions) if (!present.has(execution.entryId)) {
        entries.push({entryId: execution.entryId, label: execution.label, commandPreview: execution.commandPreview, state: 'removed', attempt: execution.attempt}); present.add(execution.entryId);
      }
    } catch { /* config failure is represented by operation.error; historical output stays readable */ }
    let allowedActions: LifecycleAction[] = [];
    if (operation.state === 'queued' || operation.state === 'running') allowedActions = ['stop'];
    if (attention.has(operation.state) && await this.processQuiescent(operation)) allowedActions = operation.phase === 'setup'
      ? ['retry', 'start-anyway', 'cancel-task'] : ['retry', 'keep-worktree', 'force-delete'];
    if (!existsSync(record.worktreePath) && process.env.CEZ_DRY_RUN !== '1') allowedActions = allowedActions.filter(action => action !== 'start-anyway');
    return lifecycleOperationViewSchema.parse({...operation, history: operation.executions, entries, allowedActions});
  }
  async operation(id: string): Promise<LifecycleOperationView> {
    const operation = await this.store.readOperation(id);
    if (!operation) throw new LifecycleNotFound('Unknown lifecycle operation');
    return this.view(operation, await this.recordById(operation.worktreeId));
  }
  output(id: string, query: {afterSeq?: number; limit?: number} = {}) {
    return this.store.readOutput(id, query.afterSeq ?? 0, query.limit ?? 100);
  }
  private async summary(record: WorktreeLifecycleRecord): Promise<WorktreeLifecycleSummary> {
    const run = this.runs.getRun(record.runId);
    const operation = record.activeOperationId ? await this.store.readOperation(record.activeOperationId) : undefined;
    if (record.activeOperationId && !operation) throw new LifecycleConflict('Lifecycle operation metadata is missing; worktree retained');
    return {worktreeId: record.worktreeId, runId: record.runId, task: run ? {id: run.id, title: run.title ?? run.task} : null,
      worktreePath: record.worktreePath, generation: record.generation, onDisk: existsSync(record.worktreePath),
      prepared: record.preparedBy !== undefined, needsAttention: operation ? attention.has(operation.state) : false,
      autoCleanupSuppressed: record.autoCleanupSuppressed, ...(operation ? {operation: await this.view(operation, record)} : {})};
  }
  private attentionSummary(runId: string, error: string, worktreeId?: string): WorktreeLifecycleSummary {
    const hash = bodyHash({root: this.root, runId});
    const identity = worktreeId ?? `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const run = this.runs.getRun(runId);
    return {worktreeId: identity, runId, task: run ? {id: run.id, title: run.title} : null,
      worktreePath: worktreePathFor(this.root, runId), generation: 1, onDisk: existsSync(worktreePathFor(this.root, runId)),
      prepared: false, needsAttention: true, autoCleanupSuppressed: true, error};
  }
  async list(query: {attentionOnly?: boolean; cursor?: string; limit?: number} = {}): Promise<{worktrees: WorktreeLifecycleSummary[]; nextCursor?: string}> {
    const {records, errors} = await this.store.listWorktrees();
    const summariesById = await Promise.all(records.map(async record => {
      try { return await this.summary(record); }
      catch { return this.attentionSummary(record.runId, 'Lifecycle operation metadata is invalid or missing; worktree retained', record.worktreeId); }
    }));
    let summaries = [...summariesById, ...errors.map(item => this.attentionSummary(item.id, item.error))];
    try {
      const config = await readLifecycleConfig(this.root);
      if (config.config.afterCreate.length || config.config.beforeRemove.length) {
        const known = new Set(summaries.map(item => item.runId));
        for (const entry of await readdir(join(this.root, '.ai/cezar/worktrees'), {withFileTypes: true}).catch(() => [])) {
          if (entry.isDirectory() && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.name) && !known.has(entry.name) && !this.runs.getRun(entry.name)) {
            summaries.push(this.attentionSummary(entry.name, 'Managed-path orphan has no lifecycle context; retained for manual recovery'));
          }
        }
      }
    } catch { /* existing metadata errors remain visible even when config is corrupt */ }
    if (query.attentionOnly) summaries = summaries.filter(record => record.needsAttention);
    summaries.sort((a,b) => a.worktreeId.localeCompare(b.worktreeId));
    if (query.cursor) summaries = summaries.filter(record => record.worktreeId > query.cursor!);
    const worktrees = summaries.slice(0, query.limit ?? 50);
    return {worktrees, ...(summaries.length > worktrees.length ? {nextCursor: worktrees.at(-1)!.worktreeId} : {})};
  }
  async detail(id: string): Promise<WorktreeLifecycleDetail> {
    const record = await this.recordById(id);
    const history = await this.store.listOperations(id);
    return {...await this.summary(record), history: await Promise.all(history.slice(0, 20).map(operation => this.view(operation, record)))};
  }
  async preview(input: {command: string; worktreeId?: string}): Promise<LifecyclePreviewResponse> {
    const variables: LifecycleTemplateContext = input.worktreeId ? this.context(await this.recordById(input.worktreeId))
      : {root_path: '/example/project', worktree_path: '/example/project/.ai/cezar/worktrees/example-task', worktree_id: 'cez-00000000-0000-4000-8000-000000000000', task_id: '00000000-0000-4000-8000-000000000000'};
    const secrets = collectSecretValues(process.env);
    return {renderedCommand: redactSecrets(renderLifecycleCommand(input.command, variables), secrets),
      variables: Object.fromEntries(Object.entries(variables).map(([key,value]) => [key,redactSecrets(value,secrets)])) as LifecycleTemplateContext,
      cwd: redactSecrets(variables.worktree_path, secrets), illustrative: !input.worktreeId};
  }
  /** Reconcile metadata only. Never execute scripts on the boot critical path. */
  async reconcile(): Promise<void> {
    const {records, errors} = await this.store.listWorktrees().catch(() => ({records: [] as WorktreeLifecycleRecord[],
      errors: this.runs.listRuns().filter(run => run.worktreePath).map(run => ({id: run.id, error: 'Lifecycle storage is unreadable; worktree retained'}))}));
    for (const item of errors) {
      if (!this.runs.getRun(item.id)) continue;
      const summary = this.attentionSummary(item.id, item.error);
      this.runs.updateRun(item.id, {status: 'waiting', error: item.error, worktreeLifecycle: {worktreeId: summary.worktreeId, generation: 1, needsAttention: true}});
    }
    for (const candidate of records) {
      try {
        // A peer may still own setup/teardown. Startup neither waits for that
        // command nor rewrites its checkpoint; only an abandoned lease is recovered.
        await this.store.withWorktreeLock(candidate.runId, async () => {
          const record = await this.store.readWorktree(candidate.runId);
          if (!record) return;
          if (!record.activeOperationId) { this.changed(record); return; }
          const operation = await this.store.readOperation(record.activeOperationId);
          if (!operation) throw new Error('Lifecycle operation is missing');
          if (operation.state === 'running' || operation.state === 'committing') {
            operation.state = 'interrupted'; operation.error = operation.agentQuiescencePending
              ? 'Variant cancellation was interrupted. Cezar cannot verify that its previous agent exited; worktree retained for manual recovery.'
              : 'Cezar stopped before completion was recorded; choose an explicit recovery action';
            for (const execution of operation.executions) if (execution.state === 'running') execution.state = 'interrupted';
            await this.save(record, operation);
          } else this.changed(record, operation);
          if (operation.state === 'queued' && operation.phase === 'teardown') this.queue.set(operation.id, Date.parse(operation.createdAt));
        }, {wait: false});
      } catch (error) {
        if (error instanceof LifecycleConflictError) continue;
        if (this.runs.getRun(candidate.runId)) this.runs.updateRun(candidate.runId, {status: 'waiting', error: 'Lifecycle context is incomplete; worktree retained',
          worktreeLifecycle: {worktreeId: candidate.worktreeId, generation: candidate.generation, needsAttention: true}});
      }
    }
  }
  async allowOrphanPrune(runId: string): Promise<boolean> {
    try { return !await this.requiresGate(runId); } catch { return false; }
  }
  start(): void {
    this.cleanupStarted = true;
    void this.enqueueOrphans().finally(() => this.pump());
  }
  private async enqueueOrphans(): Promise<void> {
    try {
      const {records} = await this.store.listWorktrees();
      for (const record of records) {
        if (this.runs.getRun(record.runId) || !existsSync(record.worktreePath) || record.activeOperationId || record.autoCleanupSuppressed) continue;
        await this.startRecordRemoval(record, 'orphan', randomUUID(), bodyHash({worktreeId: record.worktreeId, intent: 'orphan'})).catch(() => undefined);
      }
      await this.store.pruneHistory(id => !!this.runs.getRun(id));
    } catch { /* no boot dependency on lifecycle storage */ }
  }
  /** Stop admitting scripts and wait for owned children and their durable results. */
  async shutdown(): Promise<void> {
    this.dispose();
    await Promise.all([...this.completions.values()]);
    this.runs.flush({throwOnError: true});
  }
  dispose(): void { this.disposed = true; this.offSemaphore(); this.queue.clear(); for (const controller of this.controllers.values()) controller.abort(); }
}
