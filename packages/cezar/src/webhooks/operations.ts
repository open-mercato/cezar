import { randomUUID } from 'node:crypto';
import { webhookOperationSchema, type WebhookOperation } from '@open-mercato/cezar-contract';
import { AdmissionRepository, terminalDelivery, type Admission, type OperationReceipt } from './admission.ts';
import { EndpointRegistry, WebhookStateError, type PrivateReceiver } from './endpoints.ts';
import { maskDestination } from './destination.ts';
import type { Freshness } from './lifecycle.ts';

/** Called only inside the project mutation queue. The admission is the durable operation receipt. */
export class ManualOperations {
  constructor(private readonly endpoints: EndpointRegistry, private readonly admissions: AdmissionRepository,
    private readonly now: () => number, private readonly fresh: (record: Admission, deliveryId: string) => Freshness,
    private readonly beforeCommit?: (receiver: PrivateReceiver, action: 'test' | 'retry' | 'replay', record?: Admission) => Promise<void>) {}
  private fingerprint(action: string, target: string, input: WebhookOperation): string { return JSON.stringify([action, target, input.expectedRevision, input.deliveryRevision]); }
  private async apply(record: Admission, receipt: OperationReceipt): Promise<void> {
    const outcome = await this.endpoints.recordOperation(receipt.receiverId, receipt.expectedRevision, receipt.operationId, receipt.action);
    // Settle supersession and its delivery atomically. The receipt/fingerprint and
    // frozen bytes remain available for lost-response retries; write failures leave
    // the unfinished receipt intact. Existing terminal outcomes must not be erased.
    await this.admissions.update(record.id, next => {
      const index = next.operations!.findIndex(item => item.operationId === receipt.operationId);
      // Retry reuses a delivery. A later receipt for it owns that cycle now; an
      // older unfinished acknowledgement must not cancel the newer operation.
      const replaced = next.operations!.slice(index + 1).some(item => item.deliveryId === receipt.deliveryId);
      if (outcome === 'superseded' && !replaced) {
        const delivery = next.deliveries.find(item => item.id === receipt.deliveryId);
        if (delivery && !terminalDelivery(delivery.status)) {
          delivery.status = 'superseded'; delivery.reason = 'operation_superseded';
          delivery.completedAt = new Date(this.now()).toISOString(); delivery.historyPending = true;
          delivery.claim = undefined; delivery.nextAttemptAt = undefined;
        }
      }
      next.operations![index]!.applied = true;
    });
  }
  async recover(): Promise<void> {
    for (const record of this.admissions.all()) for (const receipt of record.operations ?? []) if (!receipt.applied) await this.apply(record, receipt);
  }
  private async existing(input: WebhookOperation, fingerprint: string): Promise<{ deliveryId: string } | undefined> {
    for (const record of this.admissions.all()) {
      const receipt = record.operations?.find(item => item.operationId === input.operationId);
      if (!receipt) continue;
      if (receipt.fingerprint !== fingerprint) throw new WebhookStateError(409, 'Operation ID was already used for a different request');
      if (!this.endpoints.privateReceiver(receipt.receiverId)) throw new WebhookStateError(404, 'Receiver not found');
      if (!receipt.applied) await this.apply(record, receipt);
      return { deliveryId: receipt.deliveryId };
    }
  }
  private receiver(id: string, input: WebhookOperation) {
    const receiver = this.endpoints.privateReceiver(id);
    if (!receiver) throw new WebhookStateError(404, 'Receiver not found');
    if (receiver.revision !== input.expectedRevision || receiver.deliveryRevision !== input.deliveryRevision) throw new WebhookStateError(409, 'Receiver revision changed; refresh and try again');
    return receiver;
  }
  async test(id: string, raw: WebhookOperation): Promise<{ deliveryId: string }> {
    const input = webhookOperationSchema.parse(raw), fingerprint = this.fingerprint('test', id, input);
    const existing = await this.existing(input, fingerprint); if (existing) return existing;
    const receiver = this.receiver(id, input), eventId = `evt_${randomUUID()}`, deliveryId = randomUUID(), at = new Date(this.now()).toISOString();
    await this.beforeCommit?.(receiver, 'test');
    const operation: OperationReceipt = { operationId: input.operationId, fingerprint, receiverId: id, deliveryId, action: 'test', applied: false, expectedRevision: input.expectedRevision };
    const record = await this.admissions.insert({ version: 1, id: eventId, createdAt: at, control: false, operations: [operation], deliveries: [{
      id: deliveryId, receiverId: id, deliveryRevision: receiver.deliveryRevision, admittedRevision: receiver.revision + 1,
      format: receiver.format, receiverName: receiver.name, profile: 'minimal', eventType: 'webhook.test', destination: maskDestination(receiver.url), createdAt: at, notBefore: at,
      expiresAt: new Date(this.now() + 72 * 3600000).toISOString(), status: 'pending', attempts: 0, operationId: input.operationId,
      body: JSON.stringify({ id: eventId, type: 'webhook.test', schemaVersion: 1, occurredAt: at, data: { test: true, format: 'cezar.json.v1' } }),
    }] });
    await this.apply(record, operation); return { deliveryId };
  }
  async delivery(action: 'retry' | 'replay', id: string, raw: WebhookOperation): Promise<{ deliveryId: string }> {
    const input = webhookOperationSchema.parse(raw), fingerprint = this.fingerprint(action, id, input);
    const existing = await this.existing(input, fingerprint); if (existing) return existing;
    const record = this.admissions.all().find(record => record.deliveries.some(item => item.id === id));
    const old = record?.deliveries.find(item => item.id === id);
    if (!record || !old) throw new WebhookStateError(404, 'Delivery not found');
    const receiver = this.receiver(old.receiverId, input);
    if (receiver.state !== 'active' || old.deliveryRevision !== receiver.deliveryRevision) throw new WebhookStateError(409, 'Delivery configuration or receiver state changed');
    if (this.fresh(record, id).kind !== 'ready') throw new WebhookStateError(409, 'Delivery is no longer eligible');
    if (action === 'retry' && (terminalDelivery(old.status) || old.status === 'in_flight' || old.status === 'blocked_policy' || Date.parse(old.expiresAt) <= this.now() || Date.parse(old.notBefore) > this.now() || (old.nextAttemptAt && Date.parse(old.nextAttemptAt) > this.now()))) throw new WebhookStateError(409, 'Delivery is not eligible for retry yet');
    if (action === 'replay' && (!['delivered', 'failed'].includes(old.status) || !old.body || !old.completedAt || Date.parse(old.completedAt) + 7 * 86400000 <= this.now() || old.eventType === 'webhook.test')) throw new WebhookStateError(409, 'Payload is unavailable for replay');
    await this.beforeCommit?.(receiver, action, record);
    const deliveryId = action === 'retry' ? old.id : randomUUID();
    const operation: OperationReceipt = { operationId: input.operationId, fingerprint, receiverId: receiver.id, expectedRevision: input.expectedRevision, deliveryId, action, applied: false };
    const next = await this.admissions.update(record.id, next => {
      next.operations = [...(next.operations ?? []), operation];
      if (action === 'retry') { const item = next.deliveries.find(item => item.id === id)!; item.status = 'pending'; item.nextAttemptAt = undefined; }
      else {
        const at = new Date(this.now()).toISOString();
        next.deliveries.push({ ...old, id: deliveryId, admittedRevision: receiver.revision + 1, createdAt: at, notBefore: at, expiresAt: new Date(this.now() + 72 * 3600000).toISOString(), status: 'pending', attempts: 0,
          completedAt: undefined, nextAttemptAt: undefined, claim: undefined, httpStatus: undefined, response: undefined, reason: undefined, operationId: input.operationId });
      }
    });
    await this.apply(next, operation); return { deliveryId };
  }
}
