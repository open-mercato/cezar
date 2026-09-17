import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from './store.ts';
import { SCHEDULE_AUTO_PAUSE_AFTER, ScheduleRunner } from './schedule-runner.ts';
import type { ScheduleAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const DAY = 86_400_000;
const HOUR = 3_600_000;
// A daily at 04:00 UTC. The clock starts on Monday 2026-09-14 at 03:59:30 UTC.
const T0 = Date.parse('2026-09-14T03:59:30Z');
const FIRST_RUN = Date.parse('2026-09-14T04:00:00Z');

async function setup(schedule: ScheduleAutomationDefinition['schedule'] = { type: 'daily', hour: 4, minute: 0 }) {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-schedule-runner-'));
  dirs.push(dir);
  let now = T0;
  const clock = { now: () => now, set: (ms: number) => { now = ms; } };
  const store = AutomationStore.open(dir, { now: () => new Date(now) });
  const definition = store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule, task: { prompt: 'Bump deps' } }, 'nightly') as ScheduleAutomationDefinition;
  const launch = vi.fn(async () => ({ runId: `run-${launch.mock.calls.length}` }));
  const changes: string[] = [];
  const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', launch, now: clock.now, onChange: (id) => changes.push(id) });
  return { dir, store, definition, launch, runner, clock, changes };
}

describe('ScheduleRunner', () => {
  it('computes and persists the next occurrence on first sight', async () => {
    const { store, definition, runner } = await setup();
    expect(runner.dueAt(definition)).toBe(FIRST_RUN);
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN).toISOString());
    // A second call reads the persisted instant rather than recomputing.
    expect(runner.dueAt(definition)).toBe(FIRST_RUN);
  });

  it('fires on time: receipt, launch, log, next occurrence advanced', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 2_000);
    const outcome = await runner.fire(definition);
    expect(outcome).toMatchObject({ result: 'launched', runId: 'run-1', occurrenceAt: new Date(FIRST_RUN).toISOString() });
    expect(launch).toHaveBeenCalledWith(definition, { at: new Date(FIRST_RUN).toISOString(), trigger: 'schedule' }, expect.any(String));
    expect(store.latestReceipts().get(`nightly:schedule:${new Date(FIRST_RUN).toISOString()}`)).toMatchObject({ status: 'launched', runId: 'run-1', occurrenceAt: new Date(FIRST_RUN).toISOString() });
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'launched', runId: 'run-1', reason: expect.stringContaining('Scheduled run at') });
    expect(store.state('nightly')).toMatchObject({
      nextRunAt: new Date(FIRST_RUN + DAY).toISOString(),
      lastRunAt: new Date(FIRST_RUN).toISOString(),
      consecutiveFailures: 0,
    });
  });

  it('catches up ONE missed occurrence after a gap and never bursts — daily', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    // Asleep for three days: the due instant is FIRST_RUN, now is 3 days + 1 h later.
    clock.set(FIRST_RUN + 3 * DAY + HOUR);
    const outcome = await runner.fire(definition);
    expect(outcome).toMatchObject({ result: 'catch-up', runId: 'run-1', occurrenceAt: new Date(FIRST_RUN + 3 * DAY).toISOString() });
    expect(launch).toHaveBeenCalledTimes(1);
    const logs = store.logs({ automationId: 'nightly' });
    expect(logs.map((row) => row.result)).toEqual(['catch-up', 'skipped']);
    expect(logs[1]?.reason).toContain('Missed 3 older occurrence');
    // Advanced from NOW, not from the missed occurrence — the timer will not re-fire at once.
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + 4 * DAY).toISOString());
    // And firing again right away is a no-op wait, not a launch.
    expect(runner.dueAt(definition)).toBeGreaterThan(clock.now());
  });

  it('catches up ONE missed occurrence after a gap and never bursts — hourly', async () => {
    const { store, definition, runner, launch, clock } = await setup({ type: 'hours', every: 1 });
    const due = runner.dueAt(definition)!;
    clock.set(due + 3 * DAY + 30 * 60_000);
    await runner.fire(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.logs({ automationId: 'nightly' }).map((row) => row.result)).toEqual(['catch-up', 'skipped']);
    expect(Date.parse(store.state('nightly')!.nextRunAt!)).toBeGreaterThan(clock.now());
  });

  it('skips an occurrence older than a day and launches nothing', async () => {
    // Only a weekly can be more than a day late without a newer occurrence to catch up: every
    // other shape recurs within 24 h, so its latest miss is always young enough.
    const { store, definition, runner, launch, clock } = await setup({ type: 'weekly', day: 1, hour: 4, minute: 0 });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 3 * DAY);
    const outcome = await runner.fire(definition);
    expect(outcome.result).toBe('skipped');
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'skipped', reason: expect.stringContaining('Missed 1 occurrence ') });
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + 7 * DAY).toISOString());
  });

  it('meets an existing receipt with duplicate, advances, and counts no failure', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    store.reserveReceipt({ automationId: 'nightly', revision: 1, eventId: `schedule:${new Date(FIRST_RUN).toISOString()}` });
    const outcome = await runner.fire(definition);
    expect(outcome.result).toBe('duplicate');
    expect(launch).not.toHaveBeenCalled();
    expect(store.state('nightly')).toMatchObject({ nextRunAt: new Date(FIRST_RUN + DAY).toISOString() });
    expect(store.state('nightly')?.consecutiveFailures).toBeUndefined();
  });

  it('yields to a held lease without a failure or a log row', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    const lease = store.acquireLease()!;
    try {
      const outcome = await runner.fire(definition);
      expect(outcome.result).toBe('lease-held');
      expect(launch).not.toHaveBeenCalled();
      expect(store.logs({ automationId: 'nightly' })).toEqual([]);
      expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + DAY).toISOString());
    } finally {
      lease.release();
    }
  });

  it('records a failed launch, advances, and auto-pauses after three in a row', async () => {
    const { store, definition, runner, launch, clock, changes } = await setup();
    launch.mockRejectedValue(new Error('unknown workflow: nope'));
    let current = definition;
    for (let attempt = 1; attempt <= SCHEDULE_AUTO_PAUSE_AFTER; attempt += 1) {
      const due = runner.dueAt(current)!;
      clock.set(due + 1_000);
      const outcome = await runner.fire(current);
      expect(outcome.result).toBe('failed');
      current = store.get('nightly') as ScheduleAutomationDefinition;
    }
    expect(store.get('nightly')?.enabled).toBe(false);
    const logs = store.logs({ automationId: 'nightly' });
    expect(logs[0]).toMatchObject({ result: 'failed', reason: expect.stringContaining('Paused after 3 consecutive launch failures') });
    expect(logs.filter((row) => row.reason === 'unknown workflow: nope')).toHaveLength(3);
    expect(store.latestReceipts().size).toBe(3);
    expect([...store.latestReceipts().values()].every((receipt) => receipt.status === 'launch-error')).toBe(true);
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });

  it('runs now by hand while paused, without touching the timer', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    const paused = store.update('nightly', 1, { name: 'Nightly', enabled: false, kind: 'schedule', schedule: definition.schedule, task: definition.task }) as ScheduleAutomationDefinition;
    runner.dueAt(paused);
    const before = store.state('nightly')?.nextRunAt;
    clock.set(T0 + 5 * 60_000);
    const outcome = await runner.runNow(paused);
    expect(outcome).toMatchObject({ result: 'manual', runId: 'run-1' });
    expect(launch).toHaveBeenCalledWith(paused, { at: new Date(clock.now()).toISOString(), trigger: 'manual' }, expect.any(String));
    expect(store.logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'manual', runId: 'run-1', reason: expect.stringContaining('Started by hand') });
    expect(store.state('nightly')?.nextRunAt).toBe(before);
    expect(store.get('nightly')?.enabled).toBe(false);
  });

  it('retries a launch-error receipt under the same receipt id', async () => {
    const { store, definition, runner, launch, clock } = await setup();
    launch.mockRejectedValueOnce(new Error('boom'));
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    await runner.fire(definition);
    const failed = [...store.latestReceipts().values()][0]!;
    expect(failed.status).toBe('launch-error');
    const outcome = await runner.retry(definition, failed);
    expect(outcome).toMatchObject({ result: 'manual', runId: 'run-2' });
    const retried = store.latestReceipts().get(failed.receiptKey)!;
    expect(retried).toMatchObject({ receiptId: failed.receiptId, status: 'launched', runId: 'run-2' });
    expect(launch).toHaveBeenLastCalledWith(definition, { at: failed.occurrenceAt, trigger: 'manual' }, failed.receiptId);
  });

  it('reports detection-only when the cockpit cannot launch', async () => {
    const { store, definition, clock } = await setup();
    const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', now: clock.now });
    runner.dueAt(definition);
    clock.set(FIRST_RUN + 1_000);
    expect((await runner.fire(definition)).result).toBe('detection-only');
    expect(store.state('nightly')?.nextRunAt).toBe(new Date(FIRST_RUN + DAY).toISOString());
  });
});
