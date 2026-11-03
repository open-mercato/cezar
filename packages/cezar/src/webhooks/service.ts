import { validWebhookDestinationHost } from '@open-mercato/cezar-contract';
import { renderSlackMessage } from './slack.ts';
import { renderDiscordMessage } from './discord.ts';
import { readTrackerAssociation } from '../tracker-association.ts';
import { canonicalTrackerLink } from './links.ts';
import { WebhookHistory, pageRecords } from './history.ts';
import { ManualOperations } from './operations.ts';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { updateWebhookSchema, WebhookOperation, WebhookDelivery, WebhookDeliveriesPage, WebhookActivityPage, WebhookHistoryPage } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { runLifecycleSnapshot, type RunLifecycleObserver } from '../runs/lifecycle.ts';
import { readRunIndexDiagnostic } from '../runs/run-index.ts';
import { prepareStorage, atomicWrite, readState, discardCopiedState, cleanupInterruptedWrites, statePath, StateIntegrityError } from './storage.ts';
import { acquireOwnership, OwnershipCleanupError, type WebhookOwnership } from './ownership.ts';
import { EndpointRegistry, receiverSecretValues, WebhookStateError, type PrivateReceiver } from './endpoints.ts';
import { Outbox, OutboxIntegrityError } from './outbox.ts';
import { AdmissionRepository, terminalDelivery, historyVisible, type Admission, type AdmissionLimits, type DeliveryRecord } from './admission.ts';
import { freshness, transitionType, type FailureDisposition } from './lifecycle.ts';
import { redactSource, renderPayload } from './payload.ts';
import type { WebhookSource } from './source.ts';
import { ProjectLimits } from './limits.ts';
import { WebhookScheduler } from './scheduler.ts';
import { sendWebhook, retryAt, redactWebhookDiagnostics, type SendResult, type WebhookSend } from './transport.ts';

const identitySchema = z.strictObject({ version: z.literal(1), instanceId: z.string(), root: z.string(), highWater: z.number().int().nonnegative(), resetReason: z.enum(['copied_state', 'integrity_reset']).optional(), resetPending: z.boolean().optional() });
const failureIndexSchema = z.strictObject({ version: z.literal(1), identityGap: z.boolean().optional(), episodes: z.record(z.string(), z.strictObject({
  episodeId: z.string(), sequence: z.number().int().positive(), continuation: z.number().int().nonnegative(), since: z.string(),
  decisions: z.record(z.string(), z.strictObject({ manual: z.string().optional(), scheduled: z.string().optional() })),
})) });
type FailureIndex = z.infer<typeof failureIndexSchema>;
interface ManagerReadiness { isActive(id: string): boolean; hasScheduledAutoResume?(id: string): boolean }
export interface WebhookServiceOptions {
  root: string; dataDir: string; projectId: string; mode: 'local' | 'hosted'; serverPorts(): readonly number[];
  cockpitLink?: (projectId: string, taskId: string) => string | undefined;
  repository?: string; scheduler: WebhookScheduler; dryRun?: boolean; now?: () => number; send?: (input: WebhookSend) => Promise<SendResult>;
  /** Test seam only: the shipped capacities are the pinned defaults in admission.ts. */
  admissionLimits?: Partial<AdmissionLimits>;
}
interface Candidate { admissionId: string; deliveryId: string }
interface Claim extends Candidate { token: string; revision: number; diagnosticSequence: number; request: WebhookSend }
function deliveryDue(delivery: DeliveryRecord, receiver: PrivateReceiver, now: number): boolean {
  return Date.parse(delivery.notBefore) <= now
    && (!delivery.nextAttemptAt || Date.parse(delivery.nextAttemptAt) <= now)
    && (receiver.state !== 'suspended' || delivery.eventType === 'webhook.test'
      || !receiver.nextProbeAt || Date.parse(receiver.nextProbeAt) <= now);
}
export const webhooksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.CEZ_WEBHOOKS === '1';

/** Owns one canonical project only. Network waits never hold the mutation queue. */
export class WebhookService extends EventEmitter {
  // Reserve before acquiring: even a burst of failed constructions cannot overflow or
  // evict a token-authorized cleanup handle. Undefined means construction/release in flight.
  private static constructionOwners = new Map<string, WebhookOwnership | undefined>();
  private store?: RunStore;
  private manager?: ManagerReadiness;
  private ready = false;
  private stopped = false;
  private broken = false;
  private inFlight = false;
  private timer?: ReturnType<typeof setInterval>;
  private tail: Promise<unknown> = Promise.resolve();
  private attempts = new Set<Promise<void>>();
  private abort = new AbortController();
  private episodes = new Map<string, string>();
  private failures: FailureIndex;
  private failureDirty = false;
  private operations: ManualOperations;
  private adminActions: { action: string; receiverId: string; revision: number; fields: string[] }[] = [];
  private currentAttempt?: { receiverId: string; controller: AbortController };
  private captureFailed = false;
  private captureFailureActive = false;
  private captureWarningPending = false;
  private lastCaptureHealth = '[false,false,false]';
  private nextMaintenance = 0;
  private lastSaturation = '';
  private admissionsQuarantined = false;
  private diskIndex?: { key: string; runs: Map<string, RunRecord>; state: 'complete' | 'partial' | 'unavailable'; omittedRuns: number };
  private readonly now: () => number;
  private readonly send: (input: WebhookSend) => Promise<SendResult>;
  private constructor(
    private readonly options: WebhookServiceOptions, private readonly directory: string,
    private readonly identity: z.infer<typeof identitySchema>, private readonly ownership: WebhookOwnership,
    readonly endpoints: EndpointRegistry, private readonly outbox: Outbox,
    private readonly admissions: AdmissionRepository, private readonly limits: ProjectLimits, private readonly history: WebhookHistory, failures: FailureIndex,
  ) {
    super();
    this.operations = new ManualOperations(endpoints, admissions, options.now ?? Date.now, (record, id) => record.source ? this.stateFor(record.source, record.deliveries.find(item => item.id === id)?.frozen) : { kind: 'ready' }, async (receiver, action, record) => {
      if (!validWebhookDestinationHost(receiver.url)) throw new WebhookStateError(409, 'Invalid destination host; update the receiver address');
      const host = new URL(receiver.url).hostname;
      if (action === 'test') {
        const queued = this.admissions.all().flatMap(record => record.deliveries).filter(delivery => delivery.eventType === 'webhook.test' && !terminalDelivery(delivery.status) && new URL(delivery.destination).hostname === host);
        if (queued.length >= 3) throw new WebhookStateError(429, 'Three tests are already queued for this host; wait for them to finish', this.now() + 60000);
      }
      const limit = await this.limits.take({ host, test: action === 'test', manualFailure: record?.source?.type === 'task.failed', preview: true }, this.now());
      if (!limit.allowed) throw new WebhookStateError(429, 'Webhook rate limit reached; try again after the cooldown', limit.retryAt);
    });
    this.now = options.now ?? Date.now; this.send = options.send ?? sendWebhook; this.failures = failures; this.lastSaturation = JSON.stringify(admissions.saturation());
    this.captureWarningPending = this.captureFailureActive = outbox.captureGap;
    const sources = [...admissions.all().flatMap(record => record.source ? [record.source] : []), ...outbox.sources()].sort((a, b) => a.sequence - b.sequence);
    for (const source of sources) if (source.installationId === identity.instanceId) this.restoreEpisode(source);
    for (const record of admissions.all()) {
      const source = record.source;
      if (source?.type !== 'task.failed' || source.installationId !== identity.instanceId) continue;
      const episode = failures.episodes[source.snapshot.id];
      if (!episode || episode.episodeId !== source.episodeId) continue;
      for (const delivery of record.deliveries) {
        if (!delivery.frozen || !delivery.attempts) continue;
        const decisions = episode.decisions[delivery.receiverId] ??= {};
        if (!decisions[delivery.frozen.disposition]) {
          decisions[delivery.frozen.disposition] = delivery.id; this.failureDirty = true;
        }
      }
    }
    for (const [id, episode] of Object.entries(failures.episodes)) this.episodes.set(id, episode.episodeId);
  }
  static async open(options: WebhookServiceOptions): Promise<WebhookService | undefined> {
    if (!webhooksEnabled()) return;
    if (!options.projectId || options.projectId === 'default') throw new WebhookStateError(503, 'Webhook project identity is unavailable');
    const directory = await prepareStorage(options.root, options.dataDir, options.dryRun === true);
    const root = realpathSync(options.root);
    const binding = await readState(directory, 'identity.json', identitySchema).catch(error => { if (error instanceof StateIntegrityError) return undefined; throw error; });
    const copied = binding !== undefined && binding.root !== root;
    const pending = this.constructionOwners.get(directory);
    if ((this.constructionOwners.has(directory) && !pending) || (!pending && this.constructionOwners.size >= 64)) {
      throw new WebhookStateError(503, 'Webhooks are still starting. Try again in a moment.');
    }
    this.constructionOwners.set(directory, undefined);
    let owner: WebhookOwnership | undefined;
    try {
      if (pending) {
        try { await pending.release(); }
        catch (error) { this.constructionOwners.set(directory, pending); throw error; }
      }
      owner = await acquireOwnership(directory, copied);
    } catch (error) {
      if (error instanceof OwnershipCleanupError) this.constructionOwners.set(directory, error.ownership);
      if (!this.constructionOwners.get(directory)) this.constructionOwners.delete(directory);
      throw error;
    }
    if (!owner) this.constructionOwners.delete(directory);
    if (!owner) throw new WebhookStateError(503, 'Another process owns this project’s webhooks');
    try {
      if (copied) await discardCopiedState(directory);
      await cleanupInterruptedWrites(directory);
      const lostIdentity = !copied && !binding && existsSync(statePath(directory, 'endpoints.json'));
      const identity: z.infer<typeof identitySchema> = (copied ? undefined : binding) ?? { version: 1 as const, instanceId: `inst_${randomUUID()}`, root, highWater: 0, ...(copied ? { resetReason: 'copied_state' as const } : lostIdentity ? { resetReason: 'integrity_reset' as const, resetPending: true } : {}) };
      if (identity.root !== root) throw new WebhookStateError(503, 'Webhook state belongs to a different project root');
      await atomicWrite(directory, 'identity.json', identity);
      let service: WebhookService | undefined;
      const assertOwner = () => { if (!owner.valid()) throw new WebhookStateError(503, 'Webhook ownership is unavailable'); };
      const registry = await EndpointRegistry.open(directory, { get installationId() { return identity.instanceId; }, mode: options.mode,
        reserve: (bytes, definitionBytes, receiverCount) => {
          // Keep the 1MiB definition/history budget, with operational space that
          // definitions cannot consume. 4KiB per receiver covers even JSON-escaped
          // keys/operation ids plus receipts, counters and activation metadata;
          // 8KiB covers the notice and global counters. Receiver count is itself
          // bounded by the definition budget (each definition includes its UUID).
          if (definitionBytes > 1024 * 1024 || bytes > 1024 * 1024 + receiverCount * 4096 + 8192) {
            throw new WebhookStateError(503, 'Receiver storage capacity exhausted');
          }
        },
        highWater: () => service?.outbox.highWater ?? identity.highWater, now: options.now ?? Date.now, assertOwner,
        changed: (action, receiverId, revision, fields) => { if (service) { service.adminActions.push({ action, receiverId, revision, fields }); service.emit('change', service.endpoints.list().changeSequence); } },
      });
      const markReset = async () => {
        assertOwner();
        if (!identity.resetPending) identity.instanceId = `inst_${randomUUID()}`;
        identity.resetPending = true; identity.resetReason = 'integrity_reset';
        await atomicWrite(directory, 'identity.json', identity);
      };
      const admissions = await AdmissionRepository.open(directory, { now: options.now ?? Date.now, assertOwner, repository: options.repository,
        limits: options.admissionLimits, beforeQuarantine: markReset,
        secrets: () => registry.live().flatMap(receiverSecretValues) });
      // Provenance of persisted diagnostics is not retained (and receivers can be
      // deleted or reconfigured). Conservatively remove them before result recovery.
      await admissions.clearLegacyResponses();
      const highWater = Math.max(identity.highWater, ...registry.live().map(receiver => receiver.activation?.sequence ?? 0), ...admissions.all().map(record => record.sourceSequence ?? 0));
      const reset = async () => {
        await markReset();
        await registry.resetIntegrity();
        for (const record of admissions.all()) await admissions.update(record.id, next => {
          for (const delivery of next.deliveries) {
            if (!terminalDelivery(delivery.status)) {
              delivery.status = 'cancelled'; delivery.reason = 'integrity_reset'; delivery.claim = undefined;
              delivery.nextAttemptAt = undefined; delivery.completedAt = new Date((options.now ?? Date.now)()).toISOString(); delivery.historyPending = true;
            }
          }
          for (const operation of next.operations ?? []) operation.applied = true;
        });
        for (const name of ['outbox.ndjson', 'cursor.json', 'failure-episodes.json']) { assertOwner(); await rm(statePath(directory, name), { force: true }); }
        // Retire the old sequence space as well as its sources. The admission fence
        // includes source-less capacity decisions and survives every resetPending retry.
        identity.highWater = highWater;
        const fresh = await Outbox.open(directory, identity.instanceId, highWater);
        identity.resetPending = undefined; await atomicWrite(directory, 'identity.json', identity);
        return fresh;
      };
      let outbox: Outbox;
      // A quarantined admission already persisted resetPending; the check keeps that explicit.
      if (identity.resetPending || admissions.quarantined || (binding && !existsSync(statePath(directory, 'outbox.ndjson')))) outbox = await reset();
      else try { outbox = await Outbox.open(directory, identity.instanceId, highWater); }
      catch (error) { if (!(error instanceof OutboxIntegrityError)) throw error; outbox = await reset(); }
      const savedFailures = await readState(directory, 'failure-episodes.json', failureIndexSchema).catch(error => {
        if (error instanceof StateIntegrityError) return undefined;
        throw error;
      });
      // A retained source can prove an episode, but a compacted sequence cannot prove
      // that no other current failure existed. Keep that uncertainty across restarts.
      const failures: FailureIndex = savedFailures ?? { version: 1, episodes: {}, ...(outbox.highWater > 0 ? { identityGap: true } : {}) };
      const limits = await ProjectLimits.open(directory, options.now ?? Date.now);
      const history = await WebhookHistory.open(directory, options.now ?? Date.now);
      await history.clearLegacyResponses(assertOwner);
      service = new WebhookService(options, directory, identity, owner, registry, outbox, admissions, limits, history, failures);
      service.admissionsQuarantined = admissions.quarantined > 0;
      if (!savedFailures) service.failureDirty = true;
      await service.persistFailures();
      await service.operations.recover();
      await service.recoverResults();
      await service.flushActions();
      this.constructionOwners.delete(directory);
      return service;
    } catch (error) {
      try { await owner.release(); this.constructionOwners.delete(directory); }
      catch { this.constructionOwners.set(directory, owner); }
      throw error;
    }
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      try {
        this.assertUsable();
        const value = await work();
        const saturation = JSON.stringify(this.admissions.saturation());
        if (this.lastSaturation && this.lastSaturation !== saturation) await this.endpoints.invalidate();
        this.lastSaturation = saturation;
        await this.flushActions(); return value;
      }
      catch (error) { if (!(error instanceof WebhookStateError) && !(error instanceof z.ZodError)) this.broken = true; throw error; }
      finally { this.publishCaptureHealth(); } });
    this.tail = result.catch(() => undefined); return result;
  }
  get needsRecovery(): boolean { return this.broken || this.outbox.needsRecovery || !this.ownership.valid(); }
  get projectId(): string { return this.options.projectId; }
  markCaptureGap(): void {
    this.captureFailed = true;
    if (!this.captureFailureActive) this.captureWarningPending = true;
    this.captureFailureActive = true;
  }
  /** Called by queued/timer work, never by the synchronous lifecycle observer. */
  private publishCaptureHealth(): void {
    const fingerprint = JSON.stringify([this.captureFailed || this.outbox.captureGap, this.outbox.needsRecovery, this.broken]);
    if (fingerprint !== this.lastCaptureHealth) {
      this.lastCaptureHealth = fingerprint;
      this.emit('change', this.endpoints.list().changeSequence);
    }
    if (this.captureWarningPending) {
      this.captureWarningPending = false;
      console.warn('Webhook capture lost task changes; inspect webhook health. Task execution is unaffected.');
    }
  }
  private assertUsable(): void {
    if (this.stopped || this.needsRecovery) throw new WebhookStateError(503, 'Webhook service is unavailable');
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => { this.broken = true; this.emit('change', this.endpoints.list().changeSequence); }); }, 5000);
    this.timer.unref();
    void this.tick().catch(() => { this.broken = true; });
  }
  attach(store: RunStore, manager: ManagerReadiness, ready = false): void {
    this.store?.setLifecycleObserver(undefined); this.store = store; this.manager = manager; this.ready = ready;
    store.setLifecycleObserver(this.capture);
    this.retireEndedFailures();
  }
  /** Drop only this attachment; ownership and durable delivery remain live. */
  detach(store: RunStore, manager: ManagerReadiness): void {
    if (this.store !== store || this.manager !== manager) return;
    store.setLifecycleObserver(undefined);
    this.store = undefined; this.manager = undefined; this.ready = false;
  }
  setProjectId(id: string): void { if (id && id !== 'default') this.options.projectId = id; }
  markReady(): void { this.ready = true; }
  private restoreEpisode(source: WebhookSource): void {
    if (['task.attention_required', 'task.review_ready', 'task.failed'].includes(source.type)) this.episodes.set(source.snapshot.id, source.episodeId);
    if (source.type === 'task.failed' && (!this.failures.episodes[source.snapshot.id] || this.failures.episodes[source.snapshot.id]!.sequence < source.sequence && this.failures.episodes[source.snapshot.id]!.episodeId !== source.episodeId)) {
      this.failures.episodes[source.snapshot.id] = { episodeId: source.episodeId, sequence: source.sequence, continuation: source.snapshot.continuation, since: source.occurredAt, decisions: {} };
      this.failureDirty = true;
    }
  }
  private capture: RunLifecycleObserver = (before, after, cause) => {
    if (this.stopped || this.broken) return;
    const id = after?.id ?? before?.id;
    if (id && (!after || after.archived || after.status !== before?.status)) {
      this.episodes.delete(id);
      if ((!after || after.archived || after.status !== 'failed') && this.failures.episodes[id]) { delete this.failures.episodes[id]; this.failureDirty = true; }
    }
    if (cause === 'reconcile' || !before || !after || !this.endpoints.hasCapturingReceivers()) return;
    const type = transitionType(before, after); if (!type) return;
    try {
      this.assertUsable();
      const sequence = this.outbox.highWater + 1;
      const episodeId = type === 'task.failed' && before.status === 'failed' ? this.failures.episodes[after.id]?.episodeId : `${after.id}-${sequence}`;
      // A never-captured failure cannot acquire an invented historical episode on metadata clear.
      if (!episodeId) return;
      const secrets = this.endpoints.live().flatMap(receiverSecretValues);
      const source = redactSource({ cockpitUrl: this.options.mode === 'hosted' ? this.options.cockpitLink?.(this.options.projectId, after.id) : undefined, version: 1, id: `evt_${randomUUID()}`, sequence, installationId: this.identity.instanceId,
        projectId: this.options.projectId, previousStatus: before.status, episodeId, type, occurredAt: new Date(this.now()).toISOString(), mode: this.options.mode, snapshot: after }, secrets);
      if (this.outbox.append(source)) { this.restoreEpisode(source); this.captureFailureActive = false; }
      else this.markCaptureGap();
    } catch { this.markCaptureGap(); /* Task execution never depends on webhook persistence. */ }
  };
  private retireEndedFailures(): void {
    // The shared diagnostic reader treats ENOENT as an empty project. Missing
    // persisted evidence cannot prove that a captured failure episode ended.
    if (!this.store && !existsSync(join(this.options.dataDir, 'runs.json'))) return;
    const disk = this.store ? undefined : this.diskRuns();
    if (this.store ? this.store.getIndexReadHealth().state !== 'complete' : !disk || disk.state === 'unavailable' || disk.omittedRuns > 0) return;
    for (const [id, episode] of Object.entries(this.failures.episodes)) {
      const run = this.store ? this.store.getRun(id) : disk?.runs.get(id);
      if (!run || run.archived || run.status !== 'failed' || runLifecycleSnapshot(run).continuation !== episode.continuation) {
        delete this.failures.episodes[id]; this.episodes.delete(id); this.failureDirty = true;
      }
    }
  }
  private async persistFailures(): Promise<void> {
    if (!this.failureDirty) return;
    // Restored outbox evidence can exceed the cap before startup can attach a
    // store. Reconcile trustworthy task evidence first so saturation can recover.
    this.retireEndedFailures();
    // Capture can run while the async write prepares: only clear dirtiness for the same snapshot.
    const snapshot = JSON.stringify(this.failures);
    if (Buffer.byteLength(snapshot) > 2 * 1024 * 1024) throw new Error('Webhook failure identity capacity exhausted');
    await atomicWrite(this.directory, 'failure-episodes.json', this.failures);
    this.failureDirty = JSON.stringify(this.failures) !== snapshot;
  }
  /**
   * The run index of a project this process has not opened, re-parsed only when runs.json changes.
   * A held backlog used to read and parse the whole index once per delivery per tick.
   */
  private diskRuns(): NonNullable<WebhookService['diskIndex']> {
    let key = '';
    try {
      const stat = statSync(join(this.options.dataDir, 'runs.json'), { bigint: true });
      key = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') key = 'missing'; }
    if (key && this.diskIndex?.key === key) return this.diskIndex;
    const disk = readRunIndexDiagnostic(this.options.dataDir, this.options.root);
    const index = { key, runs: new Map(disk.runs.map(run => [run.id, run])), state: disk.state, omittedRuns: disk.omittedRuns };
    // Transient read failures can leave metadata unchanged; retry them on the next observation.
    // An index we could not stat is likewise never reused.
    this.diskIndex = key && disk.state !== 'unavailable' ? index : undefined;
    return index;
  }
  private stateFor(source: WebhookSource, frozen?: FailureDisposition) {
    if (this.store) {
      const run = this.store.getRun(source.snapshot.id);
      return freshness(source, { current: run ? runLifecycleSnapshot(run) : undefined, now: this.now(), active: this.manager?.isActive(source.snapshot.id) ?? true,
        resumeScheduled: this.manager?.hasScheduledAutoResume?.(source.snapshot.id) === true,
        context: this.ready ? 'ready' : 'recovering', currentEpisodeId: this.episodes.get(source.snapshot.id) ?? '', ...(frozen ? { frozen } : {}) });
    }
    const disk = this.diskRuns();
    const run = disk.runs.get(source.snapshot.id);
    // Rows left live by a previous process describe an UNOPENED project: webhook ownership is
    // exclusive, and a non-owner process's task changes are not captured anyway, so the spec's
    // disk-only rules apply (a second cockpit can produce one stale alert, the accepted
    // limitation). Only an index we could not fully read keeps us from asserting anything (a
    // missing row could be the unreadable one, never proof of deletion).
    const readable = disk.state !== 'unavailable' && disk.omittedRuns === 0;
    return freshness(source, { current: run ? runLifecycleSnapshot(run) : undefined, now: this.now(), active: false,
      context: run || readable ? 'unopened' : 'recovering', ...(frozen ? { frozen } : {}) });
  }
  private async status(admission: Admission, id: string, status: DeliveryRecord['status'], reason: string): Promise<void> {
    await this.settle([{ admission, ids: [id] }], status, reason);
  }
  /** One commit per admission file, one history write and one registry commit, however many deliveries settle. */
  private async settle(targets: readonly { admission: Admission; ids: readonly string[] }[], status: DeliveryRecord['status'], reason: string): Promise<void> {
    for (const { admission, ids } of targets) await this.admissions.update(admission.id, record => {
      for (const delivery of record.deliveries) {
        if (!ids.includes(delivery.id)) continue;
        delivery.status = status; delivery.historyPending = true; delivery.reason = reason; delivery.claim = undefined;
        if (terminalDelivery(status)) { delivery.completedAt = new Date(this.now()).toISOString(); delivery.nextAttemptAt = undefined; }
      }
    });
    await this.recordHistories(targets.flatMap(({ admission, ids }) => ids.map(id => ({ eventId: admission.id, deliveryId: id }))));
    await this.endpoints.invalidate();
  }
  private async maintain(force = false): Promise<void> {
    if (!force && this.nextMaintenance > this.now()) return;
    this.nextMaintenance = this.now() + 30000;
    this.retireEndedFailures();
    await this.persistFailures();
    // Every step below writes only when it has something to drop: an idle project used to
    // rewrite and fsync its outbox, cursor, identity and both history logs every window.
    if (this.outbox.consumed) {
      if (!await this.outbox.compact()) return;
      this.identity.highWater = this.outbox.highWater;
      await atomicWrite(this.directory, 'identity.json', this.identity);
    }
    await this.admissions.prune(this.outbox.compactedThrough);
    await this.history.prune();
    const retained = this.history.receiverIds();
    for (const record of this.admissions.all()) for (const delivery of record.deliveries) retained.add(delivery.receiverId);
    await this.endpoints.pruneHistory(retained);
  }
  private async choose(): Promise<Candidate | undefined> {
    // A lease bounds recovery after a crash, not a live transport. Scheduler/DNS waits
    // can outlast it; only complete() may settle our outstanding attempt.
    if (this.inFlight) return undefined;
    await this.persistFailures();
    let reclaimed = false;
    for (let count = 0; count < 100; count++) {
      const entry = this.outbox.peek(); if (!entry) break;
      const tracker = entry.source.snapshot.automationTracker;
      const trackerIssueUrl = tracker ? canonicalTrackerLink(tracker, await readTrackerAssociation(this.options.dataDir)) : undefined;
      const source = { ...entry.source, ...(trackerIssueUrl ? { trackerIssueUrl } : {}) };
      const admitted = await this.admissions.admit(source, this.endpoints.live());
      if (!admitted) {
        // Full control space: compact the consumed prefix now so its empty decisions retire, rather
        // than holding this source (and every selected alert behind it) until the next window.
        // Compaction renumbers byte offsets, so the source is peeked again.
        if (reclaimed) break;
        reclaimed = true; await this.maintain(true); continue;
      }
      await this.persistFailures(); await this.outbox.advance(entry.end);
      for (const delivery of admitted.deliveries) if (terminalDelivery(delivery.status)) await this.recordHistory(admitted.id, delivery.id);
      await this.endpoints.invalidate();
    }
    await this.maintain();
    // Admission files load in UUID order. Probe by delivery age and source sequence,
    // including same-timestamp captures, rather than whichever file was read first.
    const pending = this.admissions.all().flatMap(admission => admission.deliveries.map(delivery => ({ admission, delivery })))
      .sort((a, b) => a.delivery.createdAt.localeCompare(b.delivery.createdAt) ||
        (a.admission.sourceSequence ?? Number.MAX_SAFE_INTEGER) - (b.admission.sourceSequence ?? Number.MAX_SAFE_INTEGER) ||
        a.delivery.id.localeCompare(b.delivery.id));
    for (const { admission, delivery } of pending) {
      if (terminalDelivery(delivery.status)) continue;
      if (delivery.eventType === 'webhook.test' && delivery.attempts > 0) {
        if (delivery.claim && Date.parse(delivery.claim.until) > this.now()) continue;
        await this.status(admission, delivery.id, 'failed', delivery.claim ? 'outcome_unknown' : delivery.reason ?? 'delivery_failed'); continue;
      }
      if (Date.parse(delivery.expiresAt) <= this.now()) { await this.status(admission, delivery.id, 'failed', 'expired'); continue; }
      const receiver = this.endpoints.privateReceiver(delivery.receiverId);
      if (!receiver || receiver.deliveryRevision !== delivery.deliveryRevision || delivery.admittedRevision < (receiver.activation?.revision ?? 0) || (delivery.eventType !== 'webhook.test' && ['inactive', 'paused', 'disabled'].includes(receiver.state))) {
        await this.status(admission, delivery.id, 'cancelled', 'receiver_changed'); continue;
      }
      if (delivery.claim && Date.parse(delivery.claim.until) > this.now()) continue;
      // Legacy endpoints must not reach the scheduler/limits with an invalid host.
      // Finish this admission locally and continue scanning so healthy receivers drain.
      if (!validWebhookDestinationHost(receiver.url)) {
        await this.status(admission, delivery.id, 'failed', 'invalid_destination_host'); continue;
      }
      if (admission.source) {
        const current = this.stateFor(admission.source, delivery.frozen);
        if (current.kind === 'superseded') { await this.status(admission, delivery.id, 'superseded', current.reason); continue; }
        if (current.kind === 'defer') continue;
      }
      if (!deliveryDue(delivery, receiver, this.now())) continue;
      if (!this.inFlight) return { admissionId: admission.id, deliveryId: delivery.id };
    }
    return undefined;
  }
  private async claim(candidate: Candidate): Promise<Claim | undefined> {
    const admission = this.admissions.get(candidate.admissionId); const delivery = admission?.deliveries.find(item => item.id === candidate.deliveryId);
    if (!admission || !delivery || terminalDelivery(delivery.status)) return;
    if (Date.parse(delivery.expiresAt) <= this.now()) { await this.status(admission, delivery.id, 'failed', 'expired'); return; }
    if ((admission.operations ?? []).some(operation => !operation.applied)) return;
    const receiver = this.endpoints.privateReceiver(delivery.receiverId);
    if (!receiver || receiver.deliveryRevision !== delivery.deliveryRevision || delivery.admittedRevision < (receiver.activation?.revision ?? 0) || (delivery.eventType !== 'webhook.test' && !['active', 'suspended'].includes(receiver.state))) return;
    // A scheduler wait can span a wall-clock correction. Recheck under the
    // mutation queue before recording failure decisions, spending budgets or claiming.
    if (!deliveryDue(delivery, receiver, this.now())) return;
    let disposition: FailureDisposition | undefined;
    if (admission.source) {
      const current = this.stateFor(admission.source, delivery.frozen);
      if (current.kind === 'defer') return;
      if (current.kind === 'superseded') { await this.status(admission, delivery.id, 'superseded', current.reason); return; }
      if (admission.source.type === 'task.failed') {
        disposition = current.disposition === 'scheduled' && 'autoResumeAt' in current && current.autoResumeAt
          ? { disposition: 'scheduled', autoResumeAt: current.autoResumeAt } : { disposition: 'manual' };
        if (disposition.disposition === 'scheduled' && receiver.preset !== 'all' && !receiver.includeScheduledFailures) { await this.status(admission, delivery.id, 'superseded', 'auto_resume_scheduled'); return; }
        const episode = this.failures.episodes[admission.source.snapshot.id];
        if (!episode || episode.episodeId !== admission.source.episodeId) { await this.status(admission, delivery.id, 'superseded', 'episode_changed'); return; }
        const decisions = episode.decisions[receiver.id] ?? {};
        const existing = decisions[disposition.disposition];
        if (existing && existing !== delivery.id && !admission.operations?.some(operation => operation.action === 'replay' && operation.deliveryId === delivery.id)) { await this.status(admission, delivery.id, 'superseded', 'duplicate_failure_disposition'); return; }
        episode.decisions[receiver.id] = { ...decisions, [disposition.disposition]: delivery.id }; this.failureDirty = true; await this.persistFailures();
      }
    }
    const limit = await this.limits.take({ host: new URL(receiver.url).hostname, test: delivery.eventType === 'webhook.test', manualFailure: disposition?.disposition === 'manual' }, this.now());
    if (!limit.allowed) {
      await this.admissions.update(admission.id, record => { const item = record.deliveries.find(item => item.id === delivery.id)!; item.nextAttemptAt = new Date(limit.retryAt).toISOString(); item.reason = 'rate_limited'; }); return;
    }
    const body = delivery.body ?? (admission.source ? renderPayload(admission.source, delivery.profile, this.endpoints.live().flatMap(receiverSecretValues), disposition, this.options.repository) : undefined);
    if (!body) { await this.status(admission, delivery.id, 'failed', 'payload_invalid'); return; }
    let wireBody: string;
    try {
      wireBody = delivery.format === 'slack.v1' ? renderSlackMessage(body, { receiverName: delivery.receiverName })
        : delivery.format === 'discord.v1' ? renderDiscordMessage(body, { receiverName: delivery.receiverName }) : body;
    } catch {
      await this.status(admission, delivery.id, 'failed', 'payload_invalid'); return;
    }
    const token = randomUUID();
    await this.admissions.update(admission.id, record => {
      const item = record.deliveries.find(item => item.id === delivery.id)!;
      item.body = body; item.frozen = disposition; item.status = 'in_flight'; item.attempts++;
      item.claim = { token, revision: receiver.revision, until: new Date(this.now() + 10000).toISOString() };
    });
    return { ...candidate, token, revision: receiver.revision, diagnosticSequence: this.endpoints.list().changeSequence, request: { url: receiver.url, format: delivery.format ?? 'cezar.json.v1',
      body: wireBody, eventId: admission.id, secrets: this.endpoints.signingKeys(receiver.id), diagnosticSecrets: this.diagnosticSecrets(),
      policy: { mode: admission.source?.mode === 'hosted' || receiver.activation?.mode === 'hosted' ? 'hosted' : this.options.mode, allowLocalNetwork: receiver.allowLocalNetwork, serverPorts: this.options.serverPorts() }, signal: this.abort.signal } };
  }
  private diagnosticSecrets(): string[] {
    return this.endpoints.live().flatMap(receiverSecretValues);
  }
  private async complete(claim: Claim, result: SendResult): Promise<void> {
    const admission = this.admissions.get(claim.admissionId); const delivery = admission?.deliveries.find(item => item.id === claim.deliveryId);
    if (!admission || !delivery || delivery.claim?.token !== claim.token) return;
    // The monotonic registry sequence covers intermediate create/delete/update
    // states as well as rotation, without retaining any per-mutation secrets.
    // Any change makes snapshot coverage uncertain: omit diagnostic text. This
    // check and completion share the mutation queue, so no change can slip in.
    const omitText = !Number.isSafeInteger(claim.diagnosticSequence)
      || claim.diagnosticSequence !== this.endpoints.list().changeSequence;
    result = redactWebhookDiagnostics(result, [...(claim.request.diagnosticSecrets ?? []), ...this.diagnosticSecrets()], omitText);
    const success = result.kind === 'http' && result.status >= 200 && result.status < 300;
    const gone = result.kind === 'http' && (result.status === 410
      || (claim.request.format === 'discord.v1' && (
        (result.status === 404 && result.providerCode === 10015)
        || (result.status === 401 && result.providerCode === 50027))));
    const outcome = success ? 'success' : result.kind === 'policy' ? 'policy' : gone ? 'gone'
      : result.kind === 'http' && result.status === 429 ? 'rate_limited' : result.kind === 'transient' || (result.kind === 'http' && (result.status === 408 || result.status >= 500)) ? 'transient' : 'permanent';
    await this.admissions.update(admission.id, record => {
      const item = record.deliveries.find(item => item.id === delivery.id)!; item.claim = undefined; item.nextAttemptAt = undefined;
      item.resultEffects = { token: claim.token, revision: claim.revision, at: new Date(this.now()).toISOString(), outcome };
      if (result.kind === 'http') { item.httpStatus = result.status; item.response = result.response; }
      if (success) { item.status = 'delivered'; item.completedAt = new Date(this.now()).toISOString(); item.reason = this.options.dryRun ? 'dry-run' : undefined; }
      else if (item.eventType === 'webhook.test') {
        item.status = 'failed'; item.completedAt = new Date(this.now()).toISOString(); item.nextAttemptAt = undefined;
        item.reason = result.kind === 'http' ? `http_${result.status}` : result.reason;
      }
      else if (outcome === 'transient' || outcome === 'rate_limited' || outcome === 'policy') {
        item.status = outcome === 'policy' ? 'blocked_policy' : 'retrying';
        const next = outcome === 'policy' ? this.now() + 900000 : retryAt(item.attempts, this.now(), result.kind === 'http' ? result.retryAfter : undefined);
        item.reason = result.kind === 'http' ? `http_${result.status}` : result.reason;
        if (next >= Date.parse(item.expiresAt)) { item.status = 'failed'; item.completedAt = new Date(this.now()).toISOString(); item.nextAttemptAt = undefined; item.reason = 'expired'; }
        else item.nextAttemptAt = new Date(next).toISOString();
      } else { item.status = 'failed'; item.completedAt = new Date(this.now()).toISOString(); item.reason = result.kind === 'http' ? `http_${result.status}` : 'delivery_failed'; }
    });
    await this.applyResultEffects(admission.id, delivery.id);
    this.emit('change', this.endpoints.list().changeSequence);
  }
  /** Results and their recovery intent share the admission's atomic publication. */
  private async applyResultEffects(eventId: string, deliveryId: string): Promise<void> {
    const delivery = this.admissions.get(eventId)!.deliveries.find(item => item.id === deliveryId)!;
    const effect = delivery.resultEffects;
    await this.recordHistory(eventId, deliveryId);
    if (!effect) return;
    await this.endpoints.deliveryResult(delivery.receiverId, effect.revision, delivery.deliveryRevision, effect.outcome, delivery.eventType === 'webhook.test', effect);
    await this.admissions.update(eventId, record => { record.deliveries.find(item => item.id === deliveryId)!.resultEffects = undefined; });
  }
  private async recoverResults(): Promise<void> {
    // Before pruning or admitting/sending more work. History upserts by delivery ID;
    // endpoint effects carry a receipt so a crash after publication cannot count twice.
    for (const record of this.admissions.all()) for (const delivery of record.deliveries) {
      if (delivery.resultEffects || delivery.historyPending) await this.applyResultEffects(record.id, delivery.id);
    }
  }
  /**
   * Drains every delivery that is ready now, one at a time: claim() still spends the project
   * budget and the scheduler still enforces its caps, so a limit stops the drain, not the timer.
   */
  async tick(): Promise<void> {
    for (let count = 0; count < 100 && !this.stopped; count++) if (!await this.attempt()) return;
  }
  /** Whether a claimed request was sent, so another ready delivery may follow immediately. */
  private async attempt(): Promise<boolean> {
    const candidate = await this.serialize(async () => { const value = await this.choose(); if (value) this.inFlight = true; return value; });
    if (!candidate) return false;
    let sent = false;
    const work = (async () => {
      let release: (() => void) | undefined;
      try {
        const record = this.admissions.get(candidate.admissionId)!.deliveries.find(item => item.id === candidate.deliveryId)!;
        const receiver = this.endpoints.privateReceiver(record.receiverId); if (!receiver) return;
        release = await this.options.scheduler.acquire(this.options.dataDir, new URL(receiver.url).hostname, this.abort.signal); if (!release) return;
        const claim = await this.serialize(() => this.claim(candidate)); if (!claim) return;
        const controller = new AbortController(); this.currentAttempt = { receiverId: record.receiverId, controller };
        claim.request.signal = AbortSignal.any([this.abort.signal, controller.signal]);
        const result = this.options.dryRun ? { kind: 'http' as const, status: 204 } : await this.send(claim.request).catch(() => ({ kind: 'transient' as const, reason: 'transport_failed' }));
        await this.serialize(() => this.complete(claim, result)); sent = true;
      } finally { this.currentAttempt = undefined; release?.(); this.inFlight = false; }
    })();
    this.attempts.add(work); try { await work; } finally { this.attempts.delete(work); }
    return sent;
  }
  create(input: unknown) { return this.serialize(() => this.endpoints.create(input)); }
  activate(id: string, revision: number) { return this.serialize(() => this.endpoints.activate(id, revision)); }
  resume(id: string, revision: number) { return this.serialize(() => this.endpoints.resume(id, revision)); }
  pause(id: string, revision: number, reason: 'user' | 'project_removal' = 'user') { return this.serialize(async () => { const receiver = await this.endpoints.pause(id, revision, reason); await this.cancelUnsent(id); return receiver; }); }
  update(id: string, input: z.input<typeof updateWebhookSchema>) { return this.serialize(async () => { const before = this.endpoints.privateReceiver(id); const receiver = await this.endpoints.update(id, input); if (before?.deliveryRevision !== receiver.deliveryRevision) await this.cancelUnsent(id); return receiver; }); }
  delete(id: string, revision: number) { return this.serialize(async () => { await this.endpoints.delete(id, revision); await this.cancelUnsent(id); for (const episode of Object.values(this.failures.episodes)) delete episode.decisions[id]; this.failureDirty = true; await this.persistFailures(); }); }
  rotate(id: string, revision: number, mode: 'graceful' | 'revoke_now') { return this.serialize(() => this.endpoints.rotate(id, revision, mode)); }
  acknowledge(sequence: number) { return this.serialize(() => this.endpoints.acknowledge(sequence)); }
  test(id: string, input: WebhookOperation) { return this.serialize(() => this.operations.test(id, input)); }
  retry(id: string, input: WebhookOperation) { return this.serialize(() => this.operations.delivery('retry', id, input)); }
  replay(id: string, input: WebhookOperation) { return this.serialize(() => this.operations.delivery('replay', id, input)); }
  private async cancelUnsent(id: string): Promise<void> {
    if (this.currentAttempt?.receiverId === id) this.currentAttempt.controller.abort();
    const targets = this.admissions.all().map(admission => ({ admission,
      ids: admission.deliveries.filter(delivery => delivery.receiverId === id && !terminalDelivery(delivery.status)).map(delivery => delivery.id) }))
      .filter(target => target.ids.length);
    if (targets.length) await this.settle(targets, 'cancelled', 'receiver_changed');
  }
  private async flushActions(): Promise<void> {
    const system = new Set(['delivery_result', 'test_result', 'delivery_changed', 'history_pruned']);
    while (this.adminActions.length) {
      const next = this.adminActions[0]!;
      // Individual transport results are in delivery history, not repeated in the admin log.
      if (!['delivery_result', 'delivery_changed'].includes(next.action)) await this.history.activity(next.receiverId, {
        id: randomUUID(), at: new Date(this.now()).toISOString(), action: next.action,
        source: system.has(next.action) ? 'system' : 'cockpit/api', fields: next.fields, ...(next.revision > 0 ? { revision: next.revision } : {}),
      }, this.endpoints.live().flatMap(receiverSecretValues));
      this.adminActions.shift();
    }
  }
  private taskAvailability(taskId?: string): NonNullable<WebhookDelivery['taskAvailability']> {
    if (!taskId) return 'not_applicable';
    if (this.store) {
      if (!this.ready || this.store.getIndexReadHealth().state !== 'complete') return 'unknown';
      return this.store.getRun(taskId) ? 'available' : 'deleted';
    }
    const disk = this.diskRuns();
    return disk.state !== 'complete' ? 'unknown' : disk.runs.has(taskId) ? 'available' : 'deleted';
  }
  private display(record: Admission, item: DeliveryRecord, history?: WebhookDelivery): WebhookDelivery {
    const receiver = this.endpoints.privateReceiver(item.receiverId);
    const active = receiver?.state === 'active' && receiver.deliveryRevision === item.deliveryRevision;
    const fresh = !record.source || this.stateFor(record.source, item.frozen).kind === 'ready';
    const taskId = record.source?.snapshot.id ?? record.taskId;
    const taskAvailability = this.taskAvailability(taskId);
    // Claims freeze bytes before incrementing attempts; history also proves creation for
    // unsent cycles (for example a cancelled review notice). Terminal status alone does
    // not: a deferred task.failed can expire without ever rendering a body.
    const payloadCreated = !!item.body || item.attempts > 0 || history?.payloadAvailability === 'retained'
      || history?.payloadAvailability === 'expired' || !!history?.payloadRetainedUntil;
    const payloadRetainedUntil = payloadCreated && item.completedAt ? new Date(Date.parse(item.completedAt) + 7 * 86400000).toISOString() : undefined;
    const payloadAvailability = !payloadCreated ? 'not_created' : !item.body ? 'expired' : payloadRetainedUntil && Date.parse(payloadRetainedUntil) <= this.now() ? 'expired' : 'retained';
    const replayUnavailableReason: WebhookDelivery['replayUnavailableReason'] =
      !receiver ? 'receiver_deleted' : receiver.state !== 'active' ? 'receiver_inactive' : receiver.deliveryRevision !== item.deliveryRevision ? 'configuration_changed'
      : item.eventType === 'webhook.test' ? 'synthetic_test' : !['delivered', 'failed'].includes(item.status) ? 'not_terminal'
      : payloadAvailability === 'expired' ? 'payload_expired' : !item.body || !item.completedAt ? 'payload_unavailable'
      : !fresh ? taskAvailability === 'deleted' || taskAvailability === 'unknown' ? 'task_unavailable' : 'not_fresh' : undefined;
    return { deliveryId: item.id, eventId: record.id, receiverId: item.receiverId, deliveryRevision: item.deliveryRevision,
      eventType: item.eventType, ...(taskId ? { taskId } : {}), taskAvailability, payloadAvailability,
      ...(payloadRetainedUntil ? { payloadRetainedUntil } : {}),
      ...(item.completedAt ? { historyRetainedUntil: new Date(Date.parse(item.completedAt) + 30 * 86400000).toISOString() } : {}),
      ...(replayUnavailableReason ? { replayUnavailableReason } : {}), status: item.status,
      createdAt: item.createdAt, expiresAt: item.expiresAt, attempts: item.attempts, destination: item.destination,
      ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}),
      ...(item.httpStatus !== undefined ? { httpStatus: item.httpStatus } : {}), ...(item.reason ? { reason: item.reason } : {}), ...(item.response ? { response: item.response } : {}),
      retryAllowed: !!active && fresh && ['pending', 'retrying'].includes(item.status) && Date.parse(item.expiresAt) > this.now() && Date.parse(item.notBefore) <= this.now() && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= this.now()),
      replayAllowed: replayUnavailableReason === undefined,
    };
  }
  private async recordHistory(eventId: string, deliveryId: string): Promise<void> {
    await this.recordHistories([{ eventId, deliveryId }]);
  }
  private async recordHistories(items: readonly { eventId: string; deliveryId: string }[]): Promise<void> {
    const rows = items.map(({ eventId, deliveryId }) => {
      const record = this.admissions.get(eventId)!;
      return { record, delivery: record.deliveries.find(item => item.id === deliveryId)! };
    });
    await this.history.upsert(rows.map(({ record, delivery }) => this.display(record, delivery)));
    const pending = new Map<string, Set<string>>();
    for (const { record, delivery } of rows) if (delivery.historyPending) pending.set(record.id, (pending.get(record.id) ?? new Set()).add(delivery.id));
    for (const [eventId, ids] of pending) await this.admissions.update(eventId, next => {
      for (const delivery of next.deliveries) if (ids.has(delivery.id)) delivery.historyPending = undefined;
    });
  }
  private receiverIdentity(id: string) {
    const receiver = this.list().receivers.find(receiver => receiver.id === id) ?? this.endpoints.historical().find(receiver => receiver.id === id);
    if (!receiver) throw new WebhookStateError(404, 'Receiver not found'); return receiver;
  }
  historyPage(query: { limit: number; cursor?: string }): WebhookHistoryPage {
    const page = pageRecords(this.endpoints.historical().map(receiver => ({ ...receiver, at: receiver.deletedAt })), JSON.stringify([this.options.projectId, 'history']), query);
    return { ...page, items: page.items.map(({ at: _, ...item }) => item) };
  }
  deliveryPage(id: string, query: { limit: number; cursor?: string; taskId?: string }): WebhookDeliveriesPage {
    const receiver = this.receiverIdentity(id);
    const rows = new Map<string, WebhookDelivery>(this.history.results(id).map(row => {
      const expired = row.payloadAvailability === 'retained' || row.payloadAvailability === 'expired' || !!row.payloadRetainedUntil;
      return [row.deliveryId, { ...row, retryAllowed: false, replayAllowed: false,
        taskAvailability: this.taskAvailability(row.taskId), payloadAvailability: expired ? 'expired' : row.payloadAvailability ?? 'unknown',
        replayUnavailableReason: receiver.kind === 'history' ? 'receiver_deleted' : expired ? 'payload_expired' : 'payload_unavailable' }];
    }));
    for (const record of this.admissions.all()) for (const item of record.deliveries) if (item.receiverId === id) rows.set(item.id, this.display(record, item, rows.get(item.id)));
    const page = pageRecords([...rows.values()].filter(row => historyVisible(row, this.now()) && (!query.taskId || row.taskId === query.taskId)).map(row => ({ ...row, id: row.deliveryId, at: row.createdAt })), JSON.stringify([this.options.projectId, id, query.taskId ?? '']), query);
    return { ...page, receiver, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, items: page.items.map(({ id: _, at: __, ...row }) => row) };
  }
  activityPage(id: string): WebhookActivityPage {
    const receiver = this.receiverIdentity(id), rows = this.history.activities(id).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    return { receiver, items: rows.slice(0, 100), total: rows.length, hasMore: rows.length > 100, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  list() {
    const result = this.endpoints.list();
    const deliveries = this.admissions.all().flatMap(record => record.deliveries);
    for (const receiver of result.receivers) {
      const items = deliveries.filter(item => item.receiverId === receiver.id);
      receiver.pendingCount = items.filter(item => !terminalDelivery(item.status)).length;
      receiver.inFlightCount = items.filter(item => item.status === 'in_flight').length;
    }
    if (this.needsRecovery) result.webhookHealth = { status: 'unavailable', reason: 'Webhook service is unavailable' };
    else if (this.admissionsQuarantined) result.webhookHealth = { status: 'degraded', reason: 'A webhook admission was unreadable and was quarantined; queued deliveries were cancelled and receivers were deactivated.' };
    else if (this.identity.resetReason && !result.receivers.length) result.webhookHealth = { status: 'degraded', reason: 'Untrusted copied webhook state was reset. Configure receivers for this project.' };
    else if (this.identity.resetReason === 'integrity_reset' && result.receivers.some(receiver => receiver.state === 'inactive')) result.webhookHealth = { status: 'degraded', reason: 'Webhook integrity was reset; receivers require activation. No historical changes were captured.' };
    else if (this.limits.wasReset) result.webhookHealth = {
      status: 'degraded', reason: 'Webhook rate-limit state was unreadable and was quarantined; delivery budgets restarted empty and tests received a one-minute cooldown.',
    };
    else if (deliveries.some(item => item.status === 'blocked_policy')) result.webhookHealth = {
      status: 'degraded', reason: 'Webhook deliveries are blocked by destination policy. Check the receiver address, local-network consent and server mode.',
    };
    else if (this.failures.identityGap) result.webhookHealth = { status: 'degraded', reason: 'Webhook failure identity evidence was lost; some later failure alerts may be unavailable.' };
    else if (this.outbox.captureGap || this.captureFailed) result.webhookHealth = { status: 'degraded', reason: 'Some task changes could not be captured' };
    else if (this.history.wasReset) result.webhookHealth = { status: 'degraded', reason: 'Webhook delivery or activity history was unreadable and was quarantined; earlier records are unavailable' };
    const saturation = this.admissions.saturation();
    result.webhookHealth.saturation = saturation;
    if (result.webhookHealth.status === 'ready' && (saturation.pending || saturation.retained || saturation.control)) result.webhookHealth = {
      status: 'degraded', reason: saturation.control ? 'Webhook control storage is full; admission is paused' : saturation.retained ? 'Webhook retained storage is saturated' : 'Webhook pending queue is saturated', saturation,
    };
    return result;
  }
  deliveries(receiverId: string): DeliveryRecord[] { return this.admissions.all().flatMap(record => record.deliveries).filter(delivery => delivery.receiverId === receiverId); }
  async dispose(): Promise<void> {
    if (this.stopped) { await this.ownership.release(); return; }
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); this.store?.setLifecycleObserver(undefined); this.abort.abort();
    await Promise.allSettled([...this.attempts]); await this.tail;
    try { await this.ownership.release(); } finally { this.emit('dispose'); this.removeAllListeners(); }
  }
}
