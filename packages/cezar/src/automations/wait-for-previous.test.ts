import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findActiveAutomationRun, type ActiveAutomationRun } from './active-run.ts';
import { ProjectTrackerAutomationScheduler } from './scheduler.ts';
import { ScheduleRunner } from './schedule-runner.ts';
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
  it('skips an overlapping occurrence without a receipt, advances, and launches the next one once settled', async () => {
    const { dir, store, definition, launch, runner, clock, settle } = scheduleSetup({ waitForPrevious: true });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    expect(await runner.fire(definition)).toMatchObject({ result: 'skipped', reason: expect.stringContaining('abcdef12') });
    expect(launch).not.toHaveBeenCalled();
    expect(store.receipts()).toHaveLength(0);
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + DAY).toISOString());
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'skipped', reason: expect.stringContaining('still running') });

    // A restart re-reads the advanced instant: the skipped occurrence never comes back as a burst.
    settle();
    clock.set(FIRST_RUN + DAY + 1_000);
    const restarted = new ScheduleRunner({ projectId: 'p', store: AutomationStore.open(dir, { now: () => new Date(clock.now()) }), timeZone: 'UTC', launch, now: clock.now, activeRun: async () => undefined });
    expect(await restarted.fire(definition)).toMatchObject({ result: 'launched', occurrenceAt: new Date(FIRST_RUN + DAY).toISOString() });
    expect(launch).toHaveBeenCalledTimes(1);
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

  it('leaves an unchecked automation launching every match', async () => {
    const { store, definition, launched, handle } = pollSetup({});
    await handle(store).check(definition);
    expect(launched).toEqual(['created:1', 'created:2']);
    expect(store.state(definition.id)?.checkpoint).toBe('after');
  });
});
