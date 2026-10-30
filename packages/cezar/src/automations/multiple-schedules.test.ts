import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationSchedulesSchema, nextScheduleOccurrence, scheduleOccurrencesBetween } from '@open-mercato/cezar-contract';
import { automationDefinitionSchema, type ScheduleAutomationDefinition } from './types.ts';
import { AutomationStore } from './store.ts';
import { ScheduleRunner } from './schedule-runner.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const first = { type: 'weekdays' as const, hour: 9, minute: 0 };
const second = { type: 'weekly' as const, day: 5, hour: 16, minute: 0 };
const input = { name: 'Shared task', kind: 'schedule' as const, enabled: true, schedules: [first, second], task: { prompt: 'Check the repo' } };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez1818-')); dirs.push(dir);
  let now = Date.parse('2026-10-30T08:00:00Z');
  const store = AutomationStore.open(dir, { now: () => new Date(now) });
  const definition = store.create(input, 'shared') as ScheduleAutomationDefinition;
  const launch = vi.fn(async () => ({ runId: 'r1' }));
  const runner = new ScheduleRunner({ projectId: 'p', store, timeZone: 'UTC', now: () => now, launch });
  return { dir, store, definition, launch, runner, setNow: (at: string) => { now = Date.parse(at); }, now: () => now };
}

describe('#1818 multiple schedule union', () => {
  it('mirrors the first schedule and keeps the list across reopen', () => {
    const { dir, definition } = setup();
    expect(definition.schedule).toEqual(first);
    expect(AutomationStore.open(dir).get('shared')?.schedules).toEqual([first, second]);
  });

  it('bounds lists and refuses mixed once, missing dates and conflicting mirrors', () => {
    expect(automationSchedulesSchema.safeParse([]).success).toBe(false);
    expect(automationSchedulesSchema.safeParse(Array(17).fill(first)).success).toBe(false);
    expect(automationSchedulesSchema.safeParse([first, { type: 'once', date: '2026-12-01' }]).success).toBe(false);
    expect(automationSchedulesSchema.safeParse([{ type: 'once' }]).success).toBe(false);
    const { definition } = setup();
    expect(automationDefinitionSchema.safeParse({ ...definition, schedule: second }).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ ...definition, kind: 'github', events: ['issue.opened'] }).success).toBe(false);
  });

  it('reads legacy stored records without manufacturing a list', () => {
    const { dir, definition } = setup();
    const { schedules: _, ...legacy } = definition;
    writeFileSync(join(dir, 'automations.json'), JSON.stringify({ version: 1, automations: [legacy] }));
    const loaded = AutomationStore.open(dir).get('shared');
    expect(loaded?.schedule).toEqual(first);
    expect(loaded?.schedules).toBeUndefined();
  });

  it('recomputes on secondary edits/removals, and a legacy write replaces the list', () => {
    const { store, definition, runner } = setup();
    runner.dueAt(definition);
    const changed = store.update('shared', 1, { ...input, schedules: [first, { ...second, hour: 8, minute: 30 }] }) as ScheduleAutomationDefinition;
    expect(store.state('shared')?.nextRunAt).toBeUndefined();
    expect(runner.dueAt(changed)).toBe(Date.parse('2026-10-30T08:30:00Z'));
    const single = store.update('shared', 2, { ...input, schedules: [first] });
    expect(store.state('shared')?.nextRunAt).toBeUndefined();
    const { schedules: _, ...legacy } = single;
    const replaced = store.update('shared', 3, { ...legacy, schedule: second });
    expect(replaced.schedules).toBeUndefined();
    expect(replaced.schedule).toEqual(second);
  });

  it('merges upcoming distinct instants before applying the cap', () => {
    const from = Date.parse('2026-10-30T00:00:00Z');
    expect(scheduleOccurrencesBetween(input, from, from + 7 * 86_400_000, 'UTC', 3).map(at => new Date(at).toISOString())).toEqual([
      '2026-10-30T09:00:00.000Z', '2026-10-30T16:00:00.000Z', '2026-11-02T09:00:00.000Z',
    ]);
    expect(nextScheduleOccurrence({ schedules: [second, first] }, from, 'UTC')).toBe(from + 9 * 3_600_000);
  });

  it('does not resurrect an old union from another cockpit timer after an edit', async () => {
    const { store, definition, runner, launch } = setup();
    runner.dueAt(definition);
    const changed = store.update('shared', 1, { ...input, schedules: [{ type: 'daily', hour: 17 }] }) as ScheduleAutomationDefinition;
    expect(runner.dueAt(definition)).toBeNull();
    expect((await runner.fire(definition)).result).toBe('skipped');
    expect(store.state('shared')?.nextRunAt).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    expect(runner.dueAt(changed)).toBe(Date.parse('2026-10-30T17:00:00Z'));
  });

  it.each(['2026-03-29', '2026-10-25'])('deduplicates coincident triggers through DST on %s', date => {
    const from = Date.parse(`${date}T00:00:00Z`);
    const schedules = [{ type: 'daily' as const, hour: 2, minute: 30 }, { type: 'weekly' as const, day: 7, hour: 2, minute: 30 }];
    const times = scheduleOccurrencesBetween({ schedules }, from, from + 24 * 3_600_000, 'Europe/Warsaw');
    expect(times).toHaveLength(1);
    // Preserve the existing single-shape wall-time resolution: near the gap, later fold.
    expect(new Date(times[0]!).toISOString()).toBe(date === '2026-03-29' ? '2026-03-29T00:30:00.000Z' : '2026-10-25T01:30:00.000Z');
  });

  it('uses one receipt for a coincident instant across restart and a competing cockpit', async () => {
    const { dir, store, runner, setNow, launch } = setup();
    const definition = store.update('shared', 1, { ...input, schedules: [first, { ...second, hour: 9 }] }) as ScheduleAutomationDefinition;
    runner.dueAt(definition);
    setNow('2026-10-30T09:00:01Z');
    const otherStore = AutomationStore.open(dir);
    const otherLaunch = vi.fn(async () => ({ runId: 'r2' }));
    const other = new ScheduleRunner({ projectId: 'p', store: otherStore, timeZone: 'UTC', now: () => Date.parse('2026-10-30T09:00:01Z'), launch: otherLaunch });
    const lease = store.acquireLease()!;
    expect((await other.fire(definition)).result).toBe('lease-held');
    expect(otherStore.state('shared')?.nextRunAt).toBe('2026-10-30T09:00:00.000Z');
    lease.release();
    expect((await runner.fire(definition)).result).toBe('launched');
    // Recreate stale due state, as a contender that observed the original instant would do.
    otherStore.setState('shared', state => ({ ...state, nextRunAt: '2026-10-30T09:00:00.000Z' }));
    expect((await other.fire(definition)).result).toBe('duplicate');
    expect(launch).toHaveBeenCalledTimes(1); expect(otherLaunch).not.toHaveBeenCalled();
    expect(otherStore.receipts().filter(row => row.status === 'launched')).toHaveLength(1);
  });

  it('catches only the newest union miss after years asleep, not the first 1000 occurrences', async () => {
    const { store, runner, dir, launch, setNow, now } = setup();
    const definition = store.update('shared', 1, { ...input, schedules: [{ type: 'hours', every: 1 }, second] }) as ScheduleAutomationDefinition;
    runner.dueAt(definition);
    setNow('2030-11-01T16:31:00Z');
    const reopened = AutomationStore.open(dir);
    const restarted = new ScheduleRunner({ projectId: 'p', store: reopened, timeZone: 'UTC', now, launch });
    expect(await restarted.fire(definition)).toMatchObject({ result: 'catch-up', occurrenceAt: '2030-11-01T16:00:00.000Z' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(reopened.state('shared')?.nextRunAt).toBe('2030-11-01T17:00:00.000Z');
    expect(reopened.logs().some(row => row.reason?.includes('latest nine days'))).toBe(true);
  });
});
