import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findActiveAutomationRun, wakeHeldOccurrence, type ActiveAutomationRun } from './active-run.ts';
import { ProjectTrackerAutomationScheduler } from './scheduler.ts';
import { PENDING_RECHECK_MS, ScheduleRunner } from './schedule-runner.ts';
import { AutomationStore } from './store.ts';
import { TrackerPoller } from './tracker-poller.ts';
import type { ScheduleAutomationDefinition, TrackerAutomationDefinition } from './types.ts';
import type { RunRecord } from '../runs/store.ts';

// #1801: `task.waitForPrevious`.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cezar-wait-previous-'));
  dirs.push(dir);
  return dir;
}

const run = (id: string, status: RunRecord['status'], provenance: Partial<RunRecord>): RunRecord => ({ id, status, ...provenance }) as RunRecord;

describe('findActiveAutomationRun', () => {
  it('finds a queued, running or waiting run of any provenance kind, live or persisted', () => {
    const store = {
      listRuns: () => [run('live', 'running', { automationTrigger: { automationId: 'nightly' } as RunRecord['automationTrigger'] })],
      listPersistedRuns: () => [run('other', 'waiting', { automationTracker: { automationId: 'jira' } as RunRecord['automationTracker'] })],
    };
    expect(findActiveAutomationRun(store, 'nightly')).toEqual({ id: 'live', status: 'running' });
    expect(findActiveAutomationRun(store, 'jira')).toEqual({ id: 'other', status: 'waiting' });
    expect(findActiveAutomationRun(store, 'unknown')).toBeUndefined();
  });

  it('counts review and terminal runs as finished, and a live record wins over its persisted copy', () => {
    const github = { automationId: 'gh' } as RunRecord['automation'];
    const store = {
      listRuns: () => [run('a', 'review', { automation: github }), run('b', 'done', { automation: github })],
      listPersistedRuns: () => [run('a', 'running', { automation: github }), run('c', 'cancelled', { automation: github })],
    };
    expect(findActiveAutomationRun(store, 'gh')).toBeUndefined();
  });

  it('still answers from live runs when runs.json is unreadable', () => {
    const store = {
      listRuns: () => [run('q', 'queued', { automation: { automationId: 'gh' } as RunRecord['automation'] })],
      listPersistedRuns: () => { throw new Error('unreadable'); },
    };
    expect(findActiveAutomationRun(store, 'gh')).toEqual({ id: 'q', status: 'queued' });
  });
});

const T0 = Date.parse('2026-09-14T03:59:30Z');
const FIRST_RUN = Date.parse('2026-09-14T04:00:00Z');
const DAY = 86_400_000;

function scheduleSetup(task: { waitForPrevious?: boolean }, schedule: ScheduleAutomationDefinition['schedule'] = { type: 'daily', hour: 4, minute: 0 }) {
  let now = T0;
  const clock = { now: () => now, set: (ms: number) => { now = ms; } };
  const dir = tempDir();
  const store = AutomationStore.open(dir, { now: () => new Date(now) });
  const definition = store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule, task: { prompt: 'Sweep', ...task } }, 'nightly') as ScheduleAutomationDefinition;
  const launch = vi.fn(async () => ({ runId: `run-${launch.mock.calls.length}` }));
  let active: ActiveAutomationRun | undefined = { id: 'abcdef12-previous', status: 'running' };
  const activeRun = vi.fn(async () => active);
  const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', launch, now: clock.now, activeRun });
  return { dir, store, definition, launch, activeRun, runner, clock, settle: () => { active = undefined; } };
}

describe('schedule with waitForPrevious', () => {
  it('holds an overlapping occurrence instead of skipping it, and launches nothing while the run is active', async () => {
    const { store, definition, launch, runner, clock } = scheduleSetup({ waitForPrevious: true });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'skipped', reason: expect.stringContaining('abcdef12') });
    expect(store.receipts()).toHaveLength(0);
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + DAY).toISOString());
    expect(store.state('nightly')?.pendingOccurrence?.at).toBe(new Date(FIRST_RUN).toISOString());
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'skipped', reason: expect.stringContaining('is held and launches once it settles') });
    // The held occurrence re-arms the timer on its own, and every recheck while active launches nothing.
    expect(runner.dueAt(definition)).toBe(FIRST_RUN + 1_000 + PENDING_RECHECK_MS);
    for (let i = 1; i <= 3; i++) {
      clock.set(FIRST_RUN + 1_000 + i * PENDING_RECHECK_MS);
      expect(await runner.fire(definition)).toMatchObject({ result: 'skipped' });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches exactly one catch-up once the previous run settles', async () => {
    const { store, definition, launch, runner, clock, settle } = scheduleSetup({ waitForPrevious: true });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    await runner.fire(definition);
    settle();
    clock.set(runner.dueAt(definition)!);
    expect(await runner.fire(definition)).toMatchObject({ result: 'catch-up', occurrenceAt: new Date(FIRST_RUN).toISOString() });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'catch-up', held: true }), expect.any(String));
    expect(store.state('nightly')?.pendingOccurrence).toBeUndefined();
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + DAY).toISOString());
    // Nothing is left to launch until the next real occurrence.
    expect(runner.dueAt(definition)).toBe(FIRST_RUN + DAY);
    expect(await runner.fire(definition)).toMatchObject({ result: 'skipped' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('collapses three missed occurrences into one launch', async () => {
    const { store, definition, launch, runner, clock, settle } = scheduleSetup({ waitForPrevious: true }, { type: 'hours', every: 1 });
    runner.dueAt(definition);
    for (let hour = 0; hour < 3; hour++) {
      clock.set(FIRST_RUN + hour * 3_600_000 + 1_000);
      expect(await runner.fire(definition)).toMatchObject({ result: 'skipped' });
    }
    const lastHeld = new Date(FIRST_RUN + 2 * 3_600_000).toISOString();
    expect(store.state('nightly')?.pendingOccurrence?.at).toBe(lastHeld);
    expect(store.logs({ automationId: 'nightly' })[0]?.reason).toContain('replaces the held');
    settle();
    clock.set(FIRST_RUN + 2 * 3_600_000 + 1_000 + PENDING_RECHECK_MS);
    expect(await runner.fire(definition)).toMatchObject({ result: 'catch-up', occurrenceAt: lastHeld });
    clock.set(FIRST_RUN + 2 * 3_600_000 + 1_000 + 5 * PENDING_RECHECK_MS);
    expect(await runner.fire(definition)).toMatchObject({ result: 'skipped' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('a settling run pulls the held check forward', async () => {
    const { store, definition, runner, clock } = scheduleSetup({ waitForPrevious: true });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    await runner.fire(definition);
    const settled = { status: 'review', automationTrigger: { automationId: 'nightly' } } as RunRecord;
    expect(wakeHeldOccurrence(store, { ...settled, status: 'running' }, clock.now())).toBe(false);
    expect(wakeHeldOccurrence(store, settled, clock.now())).toBe(true);
    expect(runner.dueAt(definition)).toBe(clock.now());
  });

  it('pausing, unticking waitForPrevious or deleting drops the held occurrence', async () => {
    for (const change of ['pause', 'untick', 'delete'] as const) {
      const { store, definition, launch, runner, clock, settle } = scheduleSetup({ waitForPrevious: true });
      runner.dueAt(definition);
      clock.set(FIRST_RUN + 1_000);
      await runner.fire(definition);
      expect(store.state('nightly')?.pendingOccurrence).toBeDefined();
      const { id, revision, createdAt: _c, updatedAt: _u, ...editable } = definition;
      if (change === 'delete') store.delete(id);
      else store.update(id, revision, change === 'pause' ? { ...editable, enabled: false } : { ...editable, task: { ...editable.task, waitForPrevious: false } });
      expect(store.state('nightly')?.pendingOccurrence, change).toBeUndefined();
      settle();
      if (change === 'untick') {
        const edited = store.get(id) as ScheduleAutomationDefinition;
        clock.set(FIRST_RUN + 1_000 + PENDING_RECHECK_MS);
        // The timer is armed for the next real occurrence only.
        expect(runner.dueAt(edited)).toBe(FIRST_RUN + DAY);
      }
      expect(launch).not.toHaveBeenCalled();
    }
  });

  it('keeps the held occurrence across a restart and launches it once', async () => {
    const { dir, definition, launch, runner, clock } = scheduleSetup({ waitForPrevious: true });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    await runner.fire(definition);
    clock.set(FIRST_RUN + 10 * 60_000);
    const reopened = AutomationStore.open(dir, { now: () => new Date(clock.now()) });
    expect(reopened.state('nightly')?.pendingOccurrence?.at).toBe(new Date(FIRST_RUN).toISOString());
    const restarted = new ScheduleRunner({ projectId: 'p', store: reopened, timeZone: 'UTC', launch, now: clock.now, activeRun: async () => undefined });
    expect(restarted.dueAt(definition)).toBe(FIRST_RUN + 1_000 + PENDING_RECHECK_MS);
    expect(await restarted.fire(definition)).toMatchObject({ result: 'catch-up', occurrenceAt: new Date(FIRST_RUN).toISOString() });
    expect(await restarted.fire(definition)).toMatchObject({ result: 'skipped' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('drops a held occurrence the age rule finds too old after a long downtime', async () => {
    const { dir, definition, launch, runner, clock } = scheduleSetup({ waitForPrevious: true }, { type: 'weekly', day: 1, hour: 4, minute: 0 });
    const first = runner.dueAt(definition)!;
    clock.set(first + 1_000);
    await runner.fire(definition);
    clock.set(first + 7 * DAY + 2 * DAY);
    const reopened = AutomationStore.open(dir, { now: () => new Date(clock.now()) });
    const restarted = new ScheduleRunner({ projectId: 'p', store: reopened, timeZone: 'UTC', launch, now: clock.now, activeRun: async () => undefined });
    expect(await restarted.fire(definition)).toMatchObject({ result: 'skipped' });
    expect(reopened.state('nightly')?.pendingOccurrence).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it('leaves an unchecked automation exactly as before', async () => {
    const { definition, launch, activeRun, runner, clock } = scheduleSetup({});
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'launched' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(activeRun).not.toHaveBeenCalled();
  });

  it('lets Run now and a one-time schedule through', async () => {
    const manual = scheduleSetup({ waitForPrevious: true });
    expect(await manual.runner.runNow(manual.definition)).toMatchObject({ result: 'manual' });
    const once = scheduleSetup({ waitForPrevious: true }, { type: 'once', date: '2026-09-14', hour: 4, minute: 0 });
    once.runner.dueAt(once.definition);
    once.clock.set(FIRST_RUN + 1_000);
    expect(await once.runner.fire(once.definition)).toMatchObject({ result: 'launched' });
  });
});

describe('poll with waitForPrevious', () => {
  const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: 'P', externalName: 'Project' };
  const base = { event: 'issue.opened' as const, tieBreaker: '1', association, provider: 'jira' as const, issueId: '1', title: 'test', url: 'https://example.atlassian.net/browse/P-1', labels: [], status: 'todo', change: {} };
  const candidates = [
    { ...base, eventId: 'created:1', key: 'P-1', timestamp: '2026-09-19T01:00:00.000Z' },
    { ...base, eventId: 'created:2', key: 'P-2', timestamp: '2026-09-19T01:05:00.000Z' },
  ];

  function pollSetup(task: { waitForPrevious?: boolean }) {
    const dir = tempDir();
    const store = AutomationStore.open(dir);
    const definition = store.create({ kind: 'tracker', enabled: true, name: 'jira', intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, trackerTrigger: { access: { version: 1, writes: [] }, association, events: ['issue.opened'] }, task: { prompt: 'test', ...task } }) as TrackerAutomationDefinition;
    store.setState(definition.id, () => ({ baselineAt: '2026-09-19T00:00:00.000Z', checkpoint: 'before' }));
    const pollEvents = vi.fn(async () => ({ candidates, checkpoint: 'after', complete: true }));
    const launched: string[] = [];
    let active: ActiveAutomationRun | undefined;
    const launchTracker = vi.fn(async (_definition: unknown, candidate: { eventId: string }) => {
      launched.push(candidate.eventId);
      active = { id: `run-${candidate.eventId}`, status: 'queued' };
      return { runId: `run-${candidate.eventId}` };
    });
    const handle = (currentStore: AutomationStore) => new ProjectTrackerAutomationScheduler({
      projectId: 'p', timeZone: 'UTC', store: currentStore, launchTracker, activeRun: async () => active,
      tracker: { poller: new TrackerPoller(), getDriver: async () => ({ association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents }) },
    });
    return { dir, store, definition, launched, handle, settle: () => { active = undefined; } };
  }

  it('launches one match, holds the rest without a receipt or a cursor move, and drains them across a restart', async () => {
    const { dir, store, definition, launched, handle, settle } = pollSetup({ waitForPrevious: true });
    await handle(store).check(definition);
    expect(launched).toEqual(['created:1']);
    expect(store.latestReceipts().size).toBe(1);
    expect(store.state(definition.id)?.checkpoint).toBe('before');
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped', reason: expect.stringMatching(/run-created:1.*1 match is held/) });

    // Still active: the next poll holds again and launches nothing.
    await handle(store).check(definition);
    expect(launched).toEqual(['created:1']);

    settle();
    const restarted = AutomationStore.open(dir);
    await handle(restarted).check(definition);
    expect(launched).toEqual(['created:1', 'created:2']);
    expect(restarted.latestReceipts().size).toBe(2);
    // Nothing is left behind created:2, so the checkpoint finally moves.
    expect(restarted.state(definition.id)?.checkpoint).toBe('after');
  });

  it('re-reads the active run only after a real launch, not once per candidate', async () => {
    const store = AutomationStore.open(tempDir());
    const definition = store.create({ kind: 'github', enabled: true, name: 'gh', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'test', waitForPrevious: true } });
    const activeRun = vi.fn(async () => undefined);
    // Two duplicates, then a real launch, then one more candidate.
    const launch = vi.fn(async () => launch.mock.calls.length >= 3);
    const { runEventPollCycle } = await import('./event-poll-cycle.ts');
    await runEventPollCycle({ store, definition, mode: 'execute', activeRun, launch,
      poll: async () => ({ candidates: [1, 2, 3, 4].map(n => ({ timestamp: `2026-09-19T0${n}:00:00.000Z` })) }),
      persist: (_result, state) => state,
    });
    expect(launch).toHaveBeenCalledTimes(4);
    expect(activeRun).toHaveBeenCalledTimes(2);
    activeRun.mockClear();
    await runEventPollCycle({ store, definition, mode: 'execute', activeRun, launch: undefined,
      poll: async () => ({ candidates: [{ timestamp: '2026-09-19T04:00:00.000Z' }] }), persist: (_result, state) => state,
    });
    expect(activeRun).not.toHaveBeenCalled();
  });

  it('leaves an unchecked automation launching every match', async () => {
    const { store, definition, launched, handle } = pollSetup({});
    await handle(store).check(definition);
    expect(launched).toEqual(['created:1', 'created:2']);
    expect(store.state(definition.id)?.checkpoint).toBe('after');
  });
});
