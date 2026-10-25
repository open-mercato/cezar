import { SCHEDULE_GRACE_MS, SCHEDULE_CATCH_UP_MS } from './schedule-runner.ts';
import { DeferredPrelaunchError, DeferredBindingError } from './deferred-start.ts';
import { randomUUID } from 'node:crypto';
import type { ScheduleRunnerHandle, ScheduleFireOutcome } from './schedule-runner.ts';
import type { ScheduleAutomationDefinition } from './types.ts';

/** Composer starts share the existing project poll lease, receipts and scheduler. No new timer. */
export async function fireDeferred(handle: ScheduleRunnerHandle, requested: ScheduleAutomationDefinition, manual: boolean): Promise<ScheduleFireOutcome> {
  const store = handle.store;
  const lease = store.acquireLease();
  if (!lease) return { result: 'lease-held' };
  try {
    const fresh = store.get(requested.id);
    if (!fresh?.deferredStart || fresh.kind !== 'schedule' || !fresh.schedule || fresh.revision !== requested.revision) return { result: 'duplicate' };
    let definition = fresh as ScheduleAutomationDefinition;
    const saved = definition.deferredStart!;
    const now = handle.now?.() ?? Date.now();
    // A pending hold retains the explicit request across restart. A launch claim consumes
    // it below; an interrupted/failed launch must never inherit that permission.
    const heldRequest = definition.enabled && saved.status === 'pending'
      && saved.manualRequested === true && saved.holdUntil !== undefined;
    const explicitRetry = manual || heldRequest;
    manual ||= heldRequest;
    const occurrenceAt = saved.notBefore;
    const due = Math.max(Date.parse(occurrenceAt), saved.holdUntil ? Date.parse(saved.holdUntil) : 0);
    const occurrence = { at: occurrenceAt, trigger: manual ? 'manual' as const : now - Date.parse(occurrenceAt) > SCHEDULE_GRACE_MS ? 'catch-up' as const : 'schedule' as const };
    const set = (patch: Partial<typeof saved>, enabled = false) => {
      definition = store.update(definition.id, definition.revision, { ...definition, enabled, deferredStart: { ...definition.deferredStart!, ...patch } }) as ScheduleAutomationDefinition;
      handle.onChange?.(definition.id, definition.revision);
    };
    const receipt = [...store.latestReceipts().values()].find(r => r.automationId === definition.id && r.eventId === `deferred:${definition.id}`);
    // A process may have died after persisting runs but before the receipt/cleanup. Read fresh
    // durable evidence, including runs written by another cockpit, before deciding anything.
    let reuseIds: string[] | undefined;
    if (saved.runIds.length) {
      const found = await handle.deferredRunIds?.(definition.id, saved.runIds);
      if (!lease.isValid()) return { result: 'lease-held', occurrenceAt };
      if (found?.length === saved.runIds.length) {
        if (receipt) store.appendReceipt({ ...receipt, status: 'launched', runId: found[0]!, updatedAt: new Date(now).toISOString() });
        store.finishDeferred(definition.id, 'launched', found);
        handle.onChange?.(definition.id, definition.revision);
        return { result: 'launched', runId: found[0]!, occurrenceAt };
      }
      if (!explicitRetry || !found) {
        set({ status: 'failed', failureKind: 'ambiguous', error: `Launch outcome is uncertain: ${found?.length ?? 0} of ${saved.runIds.length} runs exist. Start the missing runs or dismiss this entry.` });
        return { result: 'failed', occurrenceAt };
      }
      // Explicit user action only: the launcher reuses the recorded ids, so existing runs are never repeated.
      reuseIds = saved.runIds;
    }
    if (!manual && (!definition.enabled || saved.status !== 'pending')) return { result: 'skipped', occurrenceAt };
    if (!manual && now < Date.parse(occurrenceAt)) return { result: 'skipped', occurrenceAt };
    if (!manual && now - due > SCHEDULE_CATCH_UP_MS) {
      set({ status: 'missed', error: 'The start was missed by more than 24 hours. Run now or choose another time.' });
      return { result: 'skipped', occurrenceAt };
    }
    try {
      if (!handle.validateDeferred || !handle.launch) throw new Error('This cockpit cannot verify and launch scheduled tasks.');
      await handle.validateDeferred(definition);
      if (!lease.isValid()) return { result: 'lease-held', occurrenceAt };
    } catch (error) {
      if (!lease.isValid()) return { result: 'lease-held', occurrenceAt };
      // Some recorded runs may exist, so the entry keeps its Start missing runs / Dismiss exits.
      set({ status: 'failed', failureKind: reuseIds ? 'ambiguous' : error instanceof DeferredBindingError ? 'binding-invalid' : 'transient', error: error instanceof Error ? error.message : String(error) });
      return { result: 'failed', occurrenceAt };
    }
    const hold = await handle.deferredHoldUntil?.(definition);
    if (!lease.isValid()) return { result: 'lease-held', occurrenceAt };
    if (hold && hold > now) {
      set({ status: 'pending', holdUntil: new Date(hold).toISOString(), manualRequested: manual,
        error: 'Waiting for a newer observed usage limit reset.' }, true);
      return { result: 'skipped', occurrenceAt };
    }
    const reserved = receipt ?? store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: `deferred:${definition.id}`, occurrenceAt });
    if (!reserved) return { result: 'duplicate', occurrenceAt };
    const runIds = reuseIds ?? Array.from({ length: definition.task.variants ?? 1 }, () => randomUUID());
    // Persist intent before handing control to the launcher. A crash in this gap is deliberately
    // ambiguous: it must never silently retry, spend tokens or report successful cancellation.
    set({ status: 'launching', manualRequested: false, failureKind: undefined, error: undefined, runIds }, true);
    let launched: { runId: string };
    try {
      launched = await handle.launch!(definition, occurrence, reserved.receiptId);
    } catch (error) {
      if (!lease.isValid()) return { result: 'lease-held', occurrenceAt };
      const message = error instanceof Error ? error.message : String(error);
      store.appendReceipt({ ...reserved, status: 'launch-error', error: message.slice(0, 2000), updatedAt: new Date(now).toISOString() });
      set({ status: 'failed', failureKind: !reuseIds && error instanceof DeferredBindingError ? 'binding-invalid' : !reuseIds && error instanceof DeferredPrelaunchError ? 'transient' : 'ambiguous', error: message, ...(error instanceof DeferredPrelaunchError && !reuseIds ? { runIds: [] } : {}) });
      return { result: 'failed', occurrenceAt };
    }
    const result = { result: occurrence.trigger === 'schedule' ? 'launched' as const : occurrence.trigger, runId: launched.runId, occurrenceAt };
    if (!lease.isValid()) return result;
    try {
      store.appendReceipt({ ...reserved, status: 'launched', runId: launched.runId, updatedAt: new Date(now).toISOString() });
      store.finishDeferred(definition.id, 'launched', runIds);
      handle.onChange?.(definition.id, definition.revision);
    } catch {
      // The runs exist; a contended cleanup is finished by the next tick's run-id reconciliation.
    }
    return result;
  } finally { lease.release(); }
}
