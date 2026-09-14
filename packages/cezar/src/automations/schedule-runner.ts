import { nextOccurrence, occurrencesBetween } from '@open-mercato/cezar-contract';
import type { AutomationStore } from './store.ts';
import type { AutomationLogRecord, AutomationReceipt, ScheduleAutomationDefinition } from './types.ts';

/**
 * The schedule kind's evaluator (spec 2026-09-14-automations-redesign § Lifecycle): what fires
 * when a scheduled automation's occurrence comes due, by the timer or by hand.
 *
 * The one rule that matters is the AGE rule in `fire`: how late the occurrence is decides what
 * happens — on time (within the grace window) it is `scheduled`; late but within a day, the
 * LATEST missed occurrence fires once as `catch-up`; older, nothing fires and the log says how
 * many were skipped. The same rule applies whether the timer fired on time, the laptop slept, or
 * cezar just booted, and `nextRunAt` always advances from `max(occurrence, now)` — which is what
 * makes a burst impossible: a daily that slept three days fires one catch-up, not three.
 *
 * Receipts are per occurrence (`schedule:<instant>`), so a second cockpit on the same project,
 * or a re-armed timer, meets the receipt and logs `duplicate` — never a second launch. A held
 * lease and a duplicate are not failures; they advance this process's own `nextRunAt` and do not
 * count towards the three-strike auto-pause.
 */

export const SCHEDULE_GRACE_MS = 10 * 60_000;
export const SCHEDULE_CATCH_UP_MS = 24 * 60 * 60_000;
export const SCHEDULE_AUTO_PAUSE_AFTER = 3;

export type ScheduleTrigger = 'schedule' | 'catch-up' | 'manual';

export interface ScheduleOccurrence {
  /** The scheduled wall-time instant (UTC ISO); for `manual`, the launch time. */
  at: string;
  trigger: ScheduleTrigger;
}

export type ScheduleLauncher = (
  definition: ScheduleAutomationDefinition,
  occurrence: ScheduleOccurrence,
  receiptId: string,
) => Promise<{ runId: string }>;

export interface ScheduleRunnerHandle {
  projectId: string;
  store: AutomationStore;
  /** The zone every schedule is evaluated in — the server's own. */
  timeZone: string;
  /** Absent = detection only (tests, or a cockpit that cannot launch): nothing is launched. */
  launch?: ScheduleLauncher;
  onChange?: (automationId: string, revision: number) => void;
  now?: () => number;
}

export type ScheduleFireOutcome =
  | { result: 'launched' | 'catch-up' | 'manual'; runId: string; occurrenceAt: string }
  | { result: 'skipped' | 'duplicate' | 'lease-held' | 'failed' | 'detection-only'; occurrenceAt?: string };

export class ScheduleRunner {
  constructor(private readonly handle: ScheduleRunnerHandle) {}

  private now(): number {
    return this.handle.now?.() ?? Date.now();
  }

  /**
   * When the timer should next fire this definition: the stored `nextRunAt`, or — for a
   * definition never armed, or whose schedule was edited (the PUT clears `nextRunAt`) — the next
   * occurrence after now, which is then persisted so every process agrees on it.
   */
  dueAt(definition: ScheduleAutomationDefinition): number | null {
    const state = this.handle.store.state(definition.id) ?? {};
    if (state.nextRunAt) return Date.parse(state.nextRunAt);
    const next = nextOccurrence(definition.schedule, this.now(), this.handle.timeZone);
    if (next === null) return null;
    this.handle.store.setState(definition.id, (current) => ({ ...current, revision: definition.revision, nextRunAt: new Date(next).toISOString() }));
    return next;
  }

  /** The timer fired (or boot found a past-due occurrence): apply the age rule and launch. */
  async fire(definition: ScheduleAutomationDefinition): Promise<ScheduleFireOutcome> {
    const now = this.now();
    const due = this.dueAt(definition);
    if (due === null) return { result: 'skipped' };
    const age = now - due;
    if (age <= SCHEDULE_GRACE_MS) {
      return this.launch(definition, { at: new Date(due).toISOString(), trigger: 'schedule' }, now);
    }
    // Late. Every occurrence from the due one up to now was missed; the newest may catch up.
    const missed = occurrencesBetween(definition.schedule, due, now + 1, this.handle.timeZone);
    const latest = missed.at(-1) ?? due;
    const skippedCount = Math.max(0, missed.length - 1);
    if (now - latest <= SCHEDULE_CATCH_UP_MS) {
      if (skippedCount > 0) this.logSkipped(definition, skippedCount, latest);
      return this.launch(definition, { at: new Date(latest).toISOString(), trigger: 'catch-up' }, now);
    }
    this.logSkipped(definition, missed.length, null);
    this.advance(definition, now, now);
    return { result: 'skipped', occurrenceAt: new Date(latest).toISOString() };
  }

  /** `POST /automations/:id/run`: fire now, by hand, paused or not; `nextRunAt` is untouched. */
  async runNow(definition: ScheduleAutomationDefinition): Promise<ScheduleFireOutcome> {
    const now = this.now();
    return this.launch(definition, { at: new Date(now).toISOString(), trigger: 'manual' }, now, { advance: false });
  }

  /** Retry a `launch-error` receipt of this kind: the same receipt, fired again by hand. */
  async retry(definition: ScheduleAutomationDefinition, receipt: AutomationReceipt): Promise<ScheduleFireOutcome> {
    const now = this.now();
    const occurrence: ScheduleOccurrence = { at: receipt.occurrenceAt ?? new Date(now).toISOString(), trigger: 'manual' };
    const lease = this.handle.store.acquireLease();
    if (!lease) return { result: 'lease-held', occurrenceAt: occurrence.at };
    try {
      const reserved: AutomationReceipt = { ...receipt, status: 'reserved', error: undefined, updatedAt: new Date(now).toISOString() };
      this.handle.store.appendReceipt(reserved);
      return await this.launchReserved(definition, occurrence, reserved, now, { advance: false });
    } finally {
      lease.release();
    }
  }

  private async launch(
    definition: ScheduleAutomationDefinition,
    occurrence: ScheduleOccurrence,
    now: number,
    options: { advance: boolean } = { advance: true },
  ): Promise<ScheduleFireOutcome> {
    const { store } = this.handle;
    const lease = store.acquireLease();
    if (!lease) {
      // Another cockpit holds the project; it will fire this occurrence. Move our own timer on
      // without counting a failure.
      if (options.advance) this.advance(definition, Date.parse(occurrence.at), now);
      return { result: 'lease-held', occurrenceAt: occurrence.at };
    }
    try {
      const eventId = occurrence.trigger === 'manual' ? `manual:${occurrence.at}` : `schedule:${occurrence.at}`;
      const receipt = store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId, occurrenceAt: occurrence.at });
      if (!receipt) {
        store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'duplicate', reason: `A durable receipt already exists for the ${occurrence.at} occurrence.` });
        if (options.advance) this.advance(definition, Date.parse(occurrence.at), now);
        return { result: 'duplicate', occurrenceAt: occurrence.at };
      }
      return await this.launchReserved(definition, occurrence, receipt, now, options);
    } finally {
      lease.release();
      try { store.maybeCompact(); } catch { /* append-only state remains readable; next fire retries */ }
    }
  }

  private async launchReserved(
    definition: ScheduleAutomationDefinition,
    occurrence: ScheduleOccurrence,
    receipt: AutomationReceipt,
    now: number,
    options: { advance: boolean },
  ): Promise<ScheduleFireOutcome> {
    const { store } = this.handle;
    if (!this.handle.launch) {
      store.appendReceipt({ ...receipt, status: 'launch-error', error: 'This cockpit cannot launch tasks.', updatedAt: new Date(now).toISOString() });
      if (options.advance) this.advance(definition, Date.parse(occurrence.at), now);
      return { result: 'detection-only', occurrenceAt: occurrence.at };
    }
    const started = Date.now();
    const result: AutomationLogRecord['result'] = occurrence.trigger === 'schedule' ? 'launched' : occurrence.trigger;
    try {
      const launched = await this.handle.launch(definition, occurrence, receipt.receiptId);
      store.appendReceipt({ ...receipt, status: 'launched', runId: launched.runId, updatedAt: new Date(this.now()).toISOString() });
      store.appendLog({
        automationId: definition.id, revision: definition.revision, result,
        reason: reasonFor(occurrence, this.handle.timeZone),
        receiptId: receipt.receiptId, runId: launched.runId, durationMs: Date.now() - started,
      });
      store.setState(definition.id, (current) => ({
        ...current,
        revision: definition.revision,
        ...(options.advance ? { nextRunAt: nextIso(definition, Math.max(Date.parse(occurrence.at), now), this.handle.timeZone), lastRunAt: occurrence.at } : {}),
        lastSuccessAt: new Date(this.now()).toISOString(),
        consecutiveFailures: 0,
      }));
      this.handle.onChange?.(definition.id, definition.revision);
      return { result, runId: launched.runId, occurrenceAt: occurrence.at };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendReceipt({ ...receipt, status: 'launch-error', error: message, updatedAt: new Date(this.now()).toISOString() });
      store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'failed', reason: message, receiptId: receipt.receiptId, durationMs: Date.now() - started });
      this.recordFailure(definition, occurrence, now, options.advance);
      return { result: 'failed', occurrenceAt: occurrence.at };
    }
  }

  private recordFailure(definition: ScheduleAutomationDefinition, occurrence: ScheduleOccurrence, now: number, advance: boolean): void {
    const { store } = this.handle;
    let failures = 0;
    store.setState(definition.id, (current) => {
      failures = (current.consecutiveFailures ?? 0) + 1;
      return {
        ...current,
        revision: definition.revision,
        consecutiveFailures: failures,
        ...(advance ? { nextRunAt: nextIso(definition, Math.max(Date.parse(occurrence.at), now), this.handle.timeZone) } : {}),
      };
    });
    if (failures >= SCHEDULE_AUTO_PAUSE_AFTER && definition.enabled) {
      const { id, revision, createdAt: _c, updatedAt: _u, ...editable } = definition;
      const paused = store.update(id, revision, { ...editable, enabled: false });
      store.appendLog({ automationId: id, revision: paused.revision, result: 'failed', reason: `Paused after ${SCHEDULE_AUTO_PAUSE_AFTER} consecutive launch failures; fix the task and enable it again.` });
      this.handle.onChange?.(id, paused.revision);
      return;
    }
    this.handle.onChange?.(definition.id, definition.revision);
  }

  private advance(definition: ScheduleAutomationDefinition, fromMs: number, now: number): void {
    this.handle.store.setState(definition.id, (current) => ({
      ...current,
      revision: definition.revision,
      nextRunAt: nextIso(definition, Math.max(fromMs, now), this.handle.timeZone),
    }));
    this.handle.onChange?.(definition.id, definition.revision);
  }

  private logSkipped(definition: ScheduleAutomationDefinition, count: number, firedInstead: number | null): void {
    this.handle.store.appendLog({
      automationId: definition.id,
      revision: definition.revision,
      result: 'skipped',
      reason: firedInstead === null
        ? `Missed ${count} occurrence${count === 1 ? '' : 's'} while cezar was not running; nothing was launched for them.`
        : `Missed ${count} older occurrence${count === 1 ? '' : 's'} while cezar was not running; only the latest one caught up.`,
    });
  }
}

function nextIso(definition: ScheduleAutomationDefinition, afterMs: number, timeZone: string): string | undefined {
  const next = nextOccurrence(definition.schedule, afterMs, timeZone);
  return next === null ? undefined : new Date(next).toISOString();
}

function reasonFor(occurrence: ScheduleOccurrence, timeZone: string): string {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(occurrence.at));
  switch (occurrence.trigger) {
    case 'schedule': return `Scheduled run at ${when}.`;
    case 'catch-up': return `Caught up the ${when} occurrence missed while cezar was not running.`;
    case 'manual': return `Started by hand at ${when}.`;
  }
}
