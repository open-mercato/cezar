import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { webhookFormatSchema, webhookDeliveryStatusSchema, webhookEventTypeSchema, webhookProfileSchema, type WebhookHealth } from '@open-mercato/cezar-contract';
import { webhookSourceSchema, type WebhookSource } from './source.ts';
import { WebhookStateError, type PrivateReceiver } from './endpoints.ts';
import { selected } from './lifecycle.ts';
import { renderPayload } from './payload.ts';
import { maskDestination } from './destination.ts';
import { assertNoSymlink, atomicWrite, readState, statePath, StateIntegrityError, syncDirectory } from './storage.ts';

const time = z.iso.datetime();
export const deliveryRecordSchema = z.strictObject({
  id: z.string().uuid(), receiverId: z.string().uuid(), deliveryRevision: z.number().int().positive(), admittedRevision: z.number().int().positive(),
  format: webhookFormatSchema.optional(), receiverName: z.string().max(100).optional(),
  profile: webhookProfileSchema, eventType: webhookEventTypeSchema, destination: z.string().max(300),
  createdAt: time, notBefore: time, expiresAt: time, status: webhookDeliveryStatusSchema, attempts: z.number().int().nonnegative(),
  body: z.string().max(65536).optional(), completedAt: time.optional(), reason: z.string().max(500).optional(), nextAttemptAt: time.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(), response: z.string().max(4096).optional(),
  claim: z.strictObject({ token: z.string().uuid(), revision: z.number().int().positive(), until: time }).optional(),
  frozen: z.discriminatedUnion('disposition', [z.strictObject({ disposition: z.literal('manual') }), z.strictObject({ disposition: z.literal('scheduled'), autoResumeAt: time })]).optional(),
  historyPending: z.boolean().optional(),
  resultEffects: z.strictObject({ token: z.string().uuid(), revision: z.number().int().positive(), at: time,
    outcome: z.enum(['success', 'transient', 'permanent', 'gone', 'rate_limited', 'policy']),
  }).optional(),
  operationId: z.string().max(128).optional(),
});
export const operationReceiptSchema = z.strictObject({ operationId: z.string().max(128), fingerprint: z.string().max(1024), receiverId: z.string().uuid(), expectedRevision: z.number().int().positive(), deliveryId: z.string().uuid(), action: z.enum(['test', 'retry', 'replay']), applied: z.boolean() });
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export const admissionSchema = z.strictObject({
  version: z.literal(1), id: z.string().regex(/^evt_[0-9a-f-]{36}$/), createdAt: time,
  source: webhookSourceSchema.optional(), sourceSequence: z.number().int().positive().optional(), deliveries: z.array(deliveryRecordSchema), control: z.boolean(),
  taskId: z.string().max(128).optional(),
  capacityNeed: z.strictObject({ retainedBytes: z.number().nonnegative(), retainedObjects: z.number().nonnegative(), pendingBytes: z.number().nonnegative(), pendingCount: z.number().nonnegative(), fileBytes: z.number().nonnegative().optional() }).optional(),
  decision: z.enum(['empty', 'expired', 'capacity', 'pending_capacity', 'retained_capacity']).optional(), operations: z.array(operationReceiptSchema).optional(),
});
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;
const DELIVERY_METADATA_BYTES = 8192;
const ADMISSION_PAYLOAD_BYTES = 8 * 1024 * 1024;
const DEFERRED_BODY_BYTES = 131074;
const metadataBytes = (delivery: DeliveryRecord): number => Buffer.byteLength(JSON.stringify({ ...delivery, body: undefined }));
export type Admission = z.infer<typeof admissionSchema>;
export const terminalDelivery = (status: DeliveryRecord['status']): boolean => ['delivered', 'failed', 'superseded', 'cancelled', 'dropped'].includes(status);
/** The visible result lifetime belongs to a cycle, never to its replay chain. */
export const historyVisible = (delivery: { completedAt?: string }, now: number): boolean =>
  !delivery.completedAt || Date.parse(delivery.completedAt) + 30 * 86400000 > now;
export interface AdmissionLimits { retainedBytes: number; retainedObjects: number; controlBytes: number; controlObjects: number; pendingBytes: number; pendingCount: number }
const defaults: AdmissionLimits = { retainedBytes: 128 * 1024 * 1024, retainedObjects: 50000, controlBytes: 4 * 1024 * 1024, controlObjects: 5000, pendingBytes: 50 * 1024 * 1024, pendingCount: 10000 };
interface Dependencies {
  now(): number; limits?: Partial<AdmissionLimits>; repository?: string; secrets?: () => readonly string[]; assertOwner?: () => void;
  /** Runs once, before the first unreadable admission is moved aside: the caller makes its safe reset durable first. */
  beforeQuarantine?: () => Promise<void>;
}
const ADMISSION_FILE = /^evt_[0-9a-f-]{36}\.json$/;
/** A decision that selected nobody: once its source is compacted away, nothing can re-evaluate it. */
const emptyDecision = (record: Admission): boolean =>
  record.control && !record.deliveries.length && !record.operations?.length && (record.decision === 'empty' || record.decision === 'expired');
export class AdmissionRepository {
  private records = new Map<string, Admission>();
  private usage: AdmissionLimits = { retainedBytes: 0, retainedObjects: 0, controlBytes: 0, controlObjects: 0, pendingBytes: 0, pendingCount: 0 };
  private account(record: Admission): AdmissionLimits {
    let bytes = Buffer.byteLength(JSON.stringify(record)) + 1, pendingBytes = 0, pendingCount = 0;
    if (!record.control) for (const delivery of record.deliveries) {
      // Reserved metadata covers claims, failure diagnostics and terminal state even at saturation.
      // A terminal failure can never render a deferred body, including after payload expiry.
      bytes += Math.max(0, DELIVERY_METADATA_BYTES - metadataBytes(delivery));
      if (!delivery.body && delivery.eventType === 'task.failed' && !terminalDelivery(delivery.status)) bytes += DEFERRED_BODY_BYTES;
    }
    for (const delivery of record.deliveries) if (!terminalDelivery(delivery.status)) {
      pendingCount++; pendingBytes += delivery.body ? Buffer.byteLength(delivery.body) : 65536;
    }
    const objects = 1 + record.deliveries.length + (record.operations?.length ?? 0);
    return { retainedBytes: record.control ? 0 : bytes, retainedObjects: record.control ? 0 : objects,
      controlBytes: record.control ? bytes : 0, controlObjects: record.control ? objects : 0, pendingBytes, pendingCount };
  }
  /** The single-record budget excludes metadata already reserved by account(). Physical
   * bytes remain bounded by the aggregate retained/control limits (including metadata).
   * Charging deferred bodies here prevents failure rendering from discovering a full file.
   */
  private fileBytes(record: Admission): number {
    let bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (!record.control) for (const delivery of record.deliveries) {
      bytes -= metadataBytes(delivery);
      if (!delivery.body && delivery.eventType === 'task.failed' && !terminalDelivery(delivery.status)) bytes += DEFERRED_BODY_BYTES;
    }
    return bytes;
  }
  private charge(record: Admission, sign: 1 | -1): void {
    const cost = this.account(record);
    for (const key of Object.keys(cost) as (keyof AdmissionLimits)[]) this.usage[key] += sign * cost[key];
  }
  private readonly limits: AdmissionLimits;
  private constructor(private readonly directory: string, private readonly deps: Dependencies) { this.limits = { ...defaults, ...deps.limits }; }
  static async open(root: string, deps: Dependencies): Promise<AdmissionRepository> {
    const directory = join(root, 'events'); assertNoSymlink(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    const repository = new AdmissionRepository(directory, deps);
    // Anything else here (a .DS_Store, an editor backup, an earlier quarantine, an interrupted
    // *.tmp that cleanupInterruptedWrites owns) is not an admission and must never brick the project.
    const names = (await readdir(directory)).filter(name => ADMISSION_FILE.test(name));
    if (names.length > repository.limits.retainedObjects + repository.limits.controlObjects) throw new Error('Webhook admissions exceed object limit');
    for (const name of names) {
      const admission = await readState(directory, name, admissionSchema).catch(error => {
        if (error instanceof StateIntegrityError) return null;
        throw error;
      });
      if (admission === undefined) continue;
      if (admission && name === `${admission.id}.json`) { repository.records.set(admission.id, admission); repository.charge(admission, 1); continue; }
      // Lost admission integrity follows the spec's safe reset, which the caller makes durable
      // BEFORE the evidence moves: a crash in between can never forget that a reset is owed.
      // The bytes are kept beside the original for inspection, as history quarantines do.
      if (!repository.quarantinedCount) await deps.beforeQuarantine?.();
      const quarantine = statePath(directory, `${name}.corrupt-${randomUUID()}`);
      deps.assertOwner?.(); await rename(statePath(directory, name), quarantine);
      repository.quarantinedCount++;
      console.warn(`Webhook admission ${name} was unreadable and has been quarantined as ${quarantine}; receivers require activation.`);
    }
    if (repository.quarantinedCount) await syncDirectory(directory);
    if ((Object.keys(repository.usage) as (keyof AdmissionLimits)[]).some(key => repository.usage[key] > repository.limits[key])) throw new Error('Webhook retained capacity exceeded');
    return repository;
  }
  private quarantinedCount = 0;
  /** Unreadable admissions moved aside by this open. */
  get quarantined(): number { return this.quarantinedCount; }
  /** Bounded by the repository's load limits; only dirty metadata is republished. */
  async clearLegacyResponses(): Promise<void> {
    for (const record of this.records.values()) {
      if (!record.deliveries.some(delivery => delivery.response !== undefined)) continue;
      await this.update(record.id, next => { for (const delivery of next.deliveries) delete delivery.response; });
    }
  }
  get(id: string): Admission | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  all(): Admission[] { return structuredClone([...this.records.values()]); }
  saturation(): NonNullable<WebhookHealth['saturation']> {
    let pending = false, retained = false, dropped = 0;
    for (const record of this.records.values()) {
      dropped += record.deliveries.filter(delivery => delivery.status === 'dropped').length;
      const need = record.capacityNeed; if (!need) continue;
      pending ||= this.usage.pendingBytes + need.pendingBytes > this.limits.pendingBytes || this.usage.pendingCount + need.pendingCount > this.limits.pendingCount;
      // Legacy drops lack fileBytes; pending bytes are a conservative lower bound
      // on the frozen fanout that could not fit in a single admission.
      retained ||= (need.fileBytes ?? need.pendingBytes) > ADMISSION_PAYLOAD_BYTES || this.usage.retainedBytes + need.retainedBytes > this.limits.retainedBytes || this.usage.retainedObjects + need.retainedObjects > this.limits.retainedObjects;
    }
    return { pending, retained, control: this.controlBlocked, dropped };
  }
  private controlBlocked = false;
  private fits(candidate: Admission): boolean {
    const cost = this.account(candidate), old = this.records.get(candidate.id), previous = old ? this.account(old) : undefined;
    // Legacy records may already reserve more deferred payload than today's file
    // budget. Allow that reservation to drain, without permitting further growth.
    if (this.fileBytes(candidate) > Math.max(ADMISSION_PAYLOAD_BYTES, old ? this.fileBytes(old) : 0)) return false;
    return (Object.keys(cost) as (keyof AdmissionLimits)[]).every(key => this.usage[key] - (previous?.[key] ?? 0) + cost[key] <= this.limits[key]);
  }

  /** One owner mutation queue must serialize admission, claims, updates and retention. */
  async admit(source: WebhookSource, receivers: readonly PrivateReceiver[]): Promise<Admission | undefined> {
    const existing = this.records.get(source.id); if (existing) return structuredClone(existing);
    const now = this.deps.now(), expires = Date.parse(source.occurredAt) + 72 * 3600000;
    const targets = expires <= now ? [] : receivers.filter(receiver =>
      ['active', 'suspended'].includes(receiver.state) && receiver.activation?.installationId === source.installationId &&
      source.sequence > receiver.activation.sequence && selected(receiver, source.type, source.snapshot));
    const deliveries: DeliveryRecord[] = targets.map(receiver => ({
      id: randomUUID(), receiverId: receiver.id, deliveryRevision: receiver.deliveryRevision, admittedRevision: receiver.revision,
      format: receiver.format, profile: receiver.profile, eventType: source.type, destination: maskDestination(receiver.url), createdAt: new Date(now).toISOString(),
      notBefore: new Date(Date.parse(source.occurredAt) + (source.type === 'task.failed' ? 30 : ['task.attention_required', 'task.review_ready'].includes(source.type) ? receiver.graceSeconds : 0) * 1000).toISOString(),
      expiresAt: new Date(expires).toISOString(), status: 'pending', attempts: 0,
      ...(source.type === 'task.failed' ? {} : { body: renderPayload(source, receiver.profile, this.deps.secrets?.() ?? [], undefined, this.deps.repository) }),
    }));
    let admission: Admission = { version: 1, id: source.id, createdAt: new Date(now).toISOString(), source, sourceSequence: source.sequence, deliveries, control: !deliveries.length,
      ...(!deliveries.length ? { decision: expires <= now ? 'expired' as const : 'empty' as const } : {}) };
    if (!deliveries.length) admission.source = undefined;
    if (!this.fits(admission)) {
      const cost = this.account(admission), fileBytes = this.fileBytes(admission);
      const reason = fileBytes > ADMISSION_PAYLOAD_BYTES || this.usage.retainedBytes + cost.retainedBytes > this.limits.retainedBytes || this.usage.retainedObjects + cost.retainedObjects > this.limits.retainedObjects ? 'retained_capacity' as const : 'pending_capacity' as const;
      const capacityNeed = { ...(fileBytes > ADMISSION_PAYLOAD_BYTES ? { fileBytes } : {}), retainedBytes: cost.retainedBytes, retainedObjects: cost.retainedObjects, pendingBytes: cost.pendingBytes, pendingCount: cost.pendingCount };
      admission = { ...admission, control: true, source: undefined, taskId: source.snapshot.id, capacityNeed, decision: reason, deliveries: deliveries.map(delivery => ({
        ...delivery, body: undefined, historyPending: true, status: 'dropped', completedAt: new Date(now).toISOString(), reason,
      })) };
      if (!this.fits(admission)) { this.controlBlocked = true; return undefined; } // Preserve source and cursor; control space is exhausted.
    }
    this.controlBlocked = false;
    await this.save(admission);
    return structuredClone(admission);
  }
  async update(id: string, mutate: (record: Admission) => void): Promise<Admission> {
    const old = this.records.get(id); if (!old) throw new Error('Webhook admission not found');
    const next = structuredClone(old); mutate(next);
    // Raw response bytes can expand sixfold in JSON. Optional diagnostics must
    // never consume the reservation needed to publish a result and its effects.
    for (const delivery of next.deliveries) {
      if (delivery.response !== undefined && metadataBytes(delivery) > DELIVERY_METADATA_BYTES) delete delivery.response;
    }
    for (const previous of old.deliveries) {
      const updated = next.deliveries.find(delivery => delivery.id === previous.id);
      if (previous.body && updated?.body !== previous.body) throw new Error('Frozen webhook bytes cannot change');
    }
    if (!this.fits(next)) throw new WebhookStateError(503, 'Webhook retained capacity exhausted; wait for retention to release space');
    await this.save(next); return structuredClone(next);
  }
  async insert(value: Admission): Promise<Admission> {
    if (this.records.has(value.id)) throw new Error('Duplicate admission');
    if (!this.fits(value)) throw new WebhookStateError(503, 'Webhook retained capacity exhausted; wait for retention to release space');
    await this.save(value); return structuredClone(value);
  }
  private async save(value: Admission): Promise<void> {
    this.deps.assertOwner?.(); const next = admissionSchema.parse(value);
    await atomicWrite(this.directory, `${next.id}.json`, next);
    const previous = this.records.get(next.id); if (previous) this.charge(previous, -1);
    this.records.set(next.id, next); this.charge(next, 1);
  }
  /** After durable source compaction, expire each settled payload independently of its history. */
  async prune(compactedThrough: number): Promise<void> {
    for (let record of this.records.values()) {
      if (record.sourceSequence !== undefined && record.sourceSequence > compactedThrough) continue;
      // An empty decision only guards its source against re-evaluation. Retiring it with the source
      // keeps 7 days of non-selected transitions from filling control space and stopping admission.
      if (emptyDecision(record)) { await this.remove(record); continue; }
      // Operation receipts and source acknowledgement outlive display metadata.
      // Never retire a cycle whose result publication or operation recovery is pending.
      if (record.operations?.some(operation => !operation.applied)) continue;
      const now = this.deps.now();
      const unsettled = (delivery: DeliveryRecord): boolean =>
        !terminalDelivery(delivery.status) || !!delivery.historyPending || !!delivery.resultEffects || !!delivery.claim;
      const payloadRequired = (delivery: DeliveryRecord): boolean =>
        unsettled(delivery) || !delivery.completedAt || Date.parse(delivery.completedAt) + 7 * 86400000 > now;
      let changed = false;
      const retained = record.deliveries.filter(delivery => historyVisible(delivery, now) || unsettled(delivery)).map(delivery => {
        if (delivery.body === undefined || payloadRequired(delivery)) return delivery;
        // Only retention may discard frozen bytes. Keep the cycle's compact metadata,
        // newer replay bytes, and shared source evidence needed by other deliveries.
        const { body: _, ...metadata } = delivery; changed = true; return metadata;
      });
      if (changed || retained.length !== record.deliveries.length) {
        record = { ...record, deliveries: retained };
        await this.save(record);
      }
      if (record.deliveries.some(payloadRequired)) continue;
      if (!record.deliveries.length && Date.parse(record.createdAt) + 7 * 86400000 > this.deps.now()) continue;
      await this.remove(record);
    }
  }
  private async remove(record: Admission): Promise<void> {
    this.deps.assertOwner?.(); await rm(statePath(this.directory, `${record.id}.json`)); this.records.delete(record.id); this.charge(record, -1);
  }
}
