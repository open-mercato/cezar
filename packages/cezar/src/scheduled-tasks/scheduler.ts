import { randomUUID } from 'node:crypto';
import type { ScheduledTaskCoordinator } from './coordinator.ts';
import type { ScheduledTaskStore } from './store.ts';
import type { ScheduledLaunchResult } from './task-template.ts';
import type { ScheduledTaskDefinition, ScheduledTaskTrigger } from './types.ts';

/** Node caps a single `setTimeout` delay at 2^31-1 ms (~24.8 days); a longer wait is armed in
 *  bounded segments and re-read at each wake. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

export type ScheduledLauncher = (
  definition: ScheduledTaskDefinition,
  occurrenceId: string,
  trigger: ScheduledTaskTrigger,
  scheduledFor: string,
) => Promise<ScheduledLaunchResult>;

export interface ProjectScheduledHandle {
  projectId: string;
  store: ScheduledTaskStore;
  launch?: ScheduledLauncher;
  onChange?: (scheduledTaskId: string, revision: number, occurrenceId?: string) => void;
}

/** The occurrence key for a scheduled fire — immutable per (definition, revision, instant). A
 *  revision bump (an edit) mints a new key, which is what makes an edited definition eligible
 *  again after a config error consumed the previous key. */
export function scheduledOccurrenceKey(definition: ScheduledTaskDefinition): string {
  return `${definition.id}:${definition.revision}:${definition.timing.at}`;
}

/**
 * Has this definition's current occurrence already been handled? Used both to decide the timer's
 * next due instant and to keep a fired-but-errored definition from being re-selected on every arm.
 */
export function occurrenceAlreadyHandled(store: ScheduledTaskStore, definition: ScheduledTaskDefinition): boolean {
  return store.latestOccurrencesByKey().has(scheduledOccurrenceKey(definition));
}

/** The absolute instant a definition should launch, or null when it is not a timer candidate. */
export function dueInstant(store: ScheduledTaskStore, definition: ScheduledTaskDefinition): number | null {
  if (!definition.enabled) return null;
  const status = store.state(definition.id)?.status;
  if (status === 'completed' || status === 'launching') return null;
  if (occurrenceAlreadyHandled(store, definition)) return null;
  const at = Date.parse(definition.timing.at);
  return Number.isNaN(at) ? null : at;
}

export class ProjectScheduledScheduler {
  constructor(
    private readonly handle: ProjectScheduledHandle,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** Fire the scheduled occurrence for one definition. Exactly-one-intent under the lease. */
  async fire(definition: ScheduledTaskDefinition): Promise<'launched' | 'config-error' | 'skipped'> {
    return this.launchOccurrence(definition, 'scheduled', scheduledOccurrenceKey(definition));
  }

  /** `Run now`: reserve a MANUAL occurrence, launch once, and complete the definition so the
   *  original time can never also launch. Returns the reserved occurrence id (and run id). */
  async runNow(definition: ScheduledTaskDefinition): Promise<{ occurrenceId: string; runId?: string }> {
    const { store } = this.handle;
    return store.runExclusiveAsync(async () => {
      const latest = store.get(definition.id);
      if (!latest) throw new Error('scheduled task not found');
      const key = `${latest.id}:${latest.revision}:manual:${randomUUID()}`;
      const occurrence = store.reserveOccurrence({
        scheduledTaskId: latest.id,
        revision: latest.revision,
        scheduledFor: latest.timing.at,
        trigger: 'manual',
        key,
      });
      if (!occurrence) throw new Error('could not reserve a manual occurrence');
      return this.completeReservation(latest, occurrence.occurrenceId, 'manual', latest.timing.at, {
        consumeDefinition: true,
      });
    });
  }

  private async launchOccurrence(
    definition: ScheduledTaskDefinition,
    trigger: ScheduledTaskTrigger,
    key: string,
  ): Promise<'launched' | 'config-error' | 'skipped'> {
    const { store } = this.handle;
    return store.runExclusiveAsync(async () => {
      const latest = store.get(definition.id);
      if (!latest || !latest.enabled) return 'skipped';
      if (trigger === 'scheduled' && occurrenceAlreadyHandled(store, latest)) return 'skipped';
      const occurrence = store.reserveOccurrence({
        scheduledTaskId: latest.id,
        revision: latest.revision,
        scheduledFor: latest.timing.at,
        trigger,
        key,
      });
      if (!occurrence) return 'skipped';
      const result = await this.completeReservation(latest, occurrence.occurrenceId, trigger, latest.timing.at, {
        consumeDefinition: false,
      });
      return result.runId ? 'launched' : 'config-error';
    });
  }

  /** Drive a reserved occurrence to a terminal state. Assumes the caller holds the lease. */
  private async completeReservation(
    definition: ScheduledTaskDefinition,
    occurrenceId: string,
    trigger: ScheduledTaskTrigger,
    scheduledFor: string,
    options: { consumeDefinition: boolean },
  ): Promise<{ occurrenceId: string; runId?: string }> {
    const { store, launch, onChange } = this.handle;
    const now = () => new Date().toISOString();
    const state = store.state(definition.id) ?? {};
    store.setState(definition.id, {
      ...state,
      revision: definition.revision,
      status: 'launching',
      lastOccurrenceId: occurrenceId,
      lastObservedAt: now(),
    });
    if (!launch) {
      // No launcher wired (a preview/discovery-only handle) — leave the reservation for the real
      // scheduler and report nothing launched.
      return { occurrenceId };
    }
    try {
      const launched = await launch(definition, occurrenceId, trigger, scheduledFor);
      store.appendOccurrence({
        ...findReserved(store, occurrenceId),
        status: 'launched',
        runId: launched.runId,
        groupId: launched.groupId,
        updatedAt: now(),
      });
      store.setState(definition.id, {
        ...(store.state(definition.id) ?? {}),
        revision: definition.revision,
        status: 'completed',
        lastOccurrenceId: occurrenceId,
        lastRunId: launched.runId,
        lastObservedAt: now(),
        consecutiveFailures: 0,
      });
      if (options.consumeDefinition) store.update(definition.id, definition.revision, consumableEdit(definition, false));
      onChange?.(definition.id, definition.revision, occurrenceId);
      return { occurrenceId, runId: launched.runId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      store.appendOccurrence({
        ...findReserved(store, occurrenceId),
        status: 'config-error',
        reason,
        updatedAt: now(),
      });
      store.setState(definition.id, {
        ...(store.state(definition.id) ?? {}),
        revision: definition.revision,
        status: 'error',
        lastOccurrenceId: occurrenceId,
        lastObservedAt: now(),
        consecutiveFailures: (state.consecutiveFailures ?? 0) + 1,
      });
      onChange?.(definition.id, definition.revision, occurrenceId);
      return { occurrenceId };
    }
  }
}

/** The latest stored fields for an occurrence id, so a finalize row carries its provenance. */
function findReserved(store: ScheduledTaskStore, occurrenceId: string) {
  const row = store.latestOccurrencesById().get(occurrenceId);
  if (!row) throw new Error(`occurrence ${occurrenceId} vanished before finalization`);
  const { seq, ...rest } = row;
  return rest;
}

/** The editable projection used to flip `enabled` while keeping every other field intact. */
function consumableEdit(definition: ScheduledTaskDefinition, enabled: boolean) {
  return {
    name: definition.name,
    description: definition.description,
    enabled,
    timing: definition.timing,
    task: definition.task,
  };
}

export interface WorkspaceScheduledSchedulerOptions {
  coordinator: ScheduledTaskCoordinator;
  handle: (projectId: string, store: ScheduledTaskStore) => ProjectScheduledHandle | undefined;
  now?: () => number;
  warn?: (message: string) => void;
}

/** One workspace timer, always armed for the earliest due instant across every project. */
export class WorkspaceScheduledScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private scheduleGeneration = 0;
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceScheduledSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.options.coordinator.refresh();
    if (this.stopped || generation !== this.scheduleGeneration) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.scheduleGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  hasTimer(): boolean {
    return this.timer !== undefined;
  }

  /** The earliest due instant across all projects, or null when nothing is pending. */
  nextDueAt(): number | null {
    let earliest: number | null = null;
    for (const { at } of this.collectDue()) {
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  private collectDue(): Array<{ at: number; definition: ScheduledTaskDefinition; handle: ProjectScheduledHandle }> {
    const due: Array<{ at: number; definition: ScheduledTaskDefinition; handle: ProjectScheduledHandle }> = [];
    for (const projectId of this.options.coordinator.enabledProjectIds()) {
      const store = this.options.coordinator.store(projectId);
      if (!store) continue;
      const handle = this.options.handle(projectId, store);
      if (!handle) continue;
      for (const definition of store.list()) {
        const at = dueInstant(store, definition);
        if (at !== null) due.push({ at, definition, handle });
      }
    }
    return due;
  }

  private schedule(): void {
    if (this.stopped) return;
    const due = this.collectDue();
    if (!due.length) return;
    due.sort((a, b) => a.at - b.at);
    const next = due[0]!;
    const now = this.now();
    const wait = next.at - now;
    // A wait past Node's timer horizon is armed in one bounded segment; the wake re-reads and
    // arms the next segment instead of treating the task as due.
    if (wait > MAX_TIMER_DELAY) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.reschedule();
      }, MAX_TIMER_DELAY);
      this.timer.unref?.();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.now() < next.at) {
        // Woke early (clock skew / horizon) — do not fire, just re-arm.
        void this.reschedule();
        return;
      }
      void new ProjectScheduledScheduler(next.handle, this.now)
        .fire(next.definition)
        .catch((error) => this.options.warn?.(error instanceof Error ? error.message : String(error)))
        .finally(() => this.schedule());
    }, Math.max(0, wait));
    this.timer.unref?.();
  }
}
