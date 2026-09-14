import { describe, expect, it } from 'vitest';
import {
  cronOf,
  nextOccurrence,
  normalizeSchedule,
  occurrencesBetween,
  parseCron,
  scheduleLabel,
  zonedParts,
  zonedWallTimeToUtc,
  type AutomationSchedule,
} from '@open-mercato/cezar-contract';

const WARSAW = 'Europe/Warsaw';
const NEW_YORK = 'America/New_York';
const at = (iso: string) => Date.parse(iso);
const wall = (ms: number, tz: string) => {
  const p = zonedParts(ms, tz)!;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} wd${p.weekday}`;
};

describe('scheduleLabel / cronOf / parseCron', () => {
  it.each<[AutomationSchedule, string, string]>([
    [{ type: 'daily', hour: 4, minute: 0 }, 'every day at 04:00', '0 4 * * *'],
    [{ type: 'weekdays', hour: 7, minute: 30 }, 'weekdays at 07:30', '30 7 * * 1-5'],
    [{ type: 'hours', every: 6 }, 'every 6 hours', '0 */6 * * *'],
    [{ type: 'hours', every: 1 }, 'every hour', '0 */1 * * *'],
    [{ type: 'weekly', day: 5, hour: 16, minute: 0 }, 'Fridays at 16:00', '0 16 * * 5'],
    [{ type: 'weekly', day: 7, hour: 2, minute: 0 }, 'Sundays at 02:00', '0 2 * * 0'],
    [{ type: 'daily' }, 'every day at 04:00', '0 4 * * *'],
  ])('%j → %s / %s', (schedule, label, cron) => {
    expect(scheduleLabel(schedule)).toBe(label);
    expect(cronOf(schedule)).toBe(cron);
    expect(parseCron(cron)).toEqual(normalizeSchedule(schedule).type === 'hours'
      ? { type: 'hours', every: normalizeSchedule(schedule).every }
      : normalizeSchedule(schedule).type === 'weekly'
        ? { type: 'weekly', hour: normalizeSchedule(schedule).hour, minute: normalizeSchedule(schedule).minute, day: normalizeSchedule(schedule).day }
        : { type: normalizeSchedule(schedule).type, hour: normalizeSchedule(schedule).hour, minute: normalizeSchedule(schedule).minute });
  });

  it('refuses every cron shape it cannot represent', () => {
    for (const bad of ['*/15 * * * *', '0 4 1 * *', '0 4 * 6 *', '0 4 * * 1,3', '0 4 * * 2-4', '0 */5 * * *', '60 4 * * *', '0 4 * *', 'nope']) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });
});

describe('occurrencesBetween', () => {
  it('lists a daily at the zone wall time, ascending, within [from, to)', () => {
    const from = at('2026-09-14T00:00:00Z'); // Mon 02:00 Warsaw (CEST, +2)
    const to = at('2026-09-17T00:00:00Z');
    const runs = occurrencesBetween({ type: 'daily', hour: 4, minute: 0 }, from, to, WARSAW);
    expect(runs.map((ms) => wall(ms, WARSAW))).toEqual([
      '2026-09-14 04:00 wd1', '2026-09-15 04:00 wd2', '2026-09-16 04:00 wd3',
    ]);
    expect(runs.map((ms) => new Date(ms).toISOString())).toEqual([
      '2026-09-14T02:00:00.000Z', '2026-09-15T02:00:00.000Z', '2026-09-16T02:00:00.000Z',
    ]);
  });

  it('skips the weekend for weekdays and picks one weekday for weekly', () => {
    const from = at('2026-09-14T00:00:00Z'); // Mon
    const to = at('2026-09-21T00:00:00Z');
    const weekdays = occurrencesBetween({ type: 'weekdays', hour: 7, minute: 30 }, from, to, WARSAW);
    expect(weekdays.map((ms) => zonedParts(ms, WARSAW)!.weekday)).toEqual([1, 2, 3, 4, 5]);
    const fridays = occurrencesBetween({ type: 'weekly', day: 5, hour: 16 }, from, to, WARSAW);
    expect(fridays.map((ms) => wall(ms, WARSAW))).toEqual(['2026-09-18 16:00 wd5']);
  });

  it('fires every N hours from midnight', () => {
    const from = at('2026-09-14T00:00:00Z');
    const to = at('2026-09-15T00:00:00Z');
    const runs = occurrencesBetween({ type: 'hours', every: 6 }, from, to, WARSAW);
    expect(runs.map((ms) => wall(ms, WARSAW).slice(11, 16))).toEqual(['06:00', '12:00', '18:00', '00:00']);
  });

  it('excludes the upper bound and honours the limit', () => {
    const from = at('2026-09-14T02:00:00Z'); // exactly the 04:00 Warsaw run
    const runs = occurrencesBetween({ type: 'daily', hour: 4 }, from, at('2026-09-15T02:00:00Z'), WARSAW);
    expect(runs).toEqual([from]);
    expect(occurrencesBetween({ type: 'hours', every: 1 }, from, from + 10 * 86_400_000, WARSAW, 5)).toHaveLength(5);
  });

  it('returns nothing for an unknown zone or an empty window', () => {
    expect(occurrencesBetween({ type: 'daily' }, 0, 86_400_000, 'Mars/Olympus')).toEqual([]);
    expect(occurrencesBetween({ type: 'daily' }, 10, 10, WARSAW)).toEqual([]);
  });

  // Europe/Warsaw springs forward 2026-03-29 02:00 → 03:00 and falls back 2026-10-25 03:00 → 02:00.
  it('fires once across the spring-forward gap and once across the fall-back hour', () => {
    const gap = occurrencesBetween({ type: 'daily', hour: 2, minute: 30 }, at('2026-03-28T12:00:00Z'), at('2026-03-30T12:00:00Z'), WARSAW);
    expect(gap).toHaveLength(2);
    // The 29th's 02:30 does not exist; the instant is near the gap and later than the 28th's run.
    expect(gap[1]! - gap[0]!).toBeGreaterThan(22 * 3_600_000);
    expect(gap[1]! - gap[0]!).toBeLessThan(25 * 3_600_000);

    const fold = occurrencesBetween({ type: 'daily', hour: 2, minute: 30 }, at('2026-10-24T12:00:00Z'), at('2026-10-26T12:00:00Z'), WARSAW);
    expect(fold).toHaveLength(2);
    expect(fold[1]! - fold[0]!).toBeGreaterThanOrEqual(24 * 3_600_000);
  });

  it('keeps the hourly shape anchored at midnight across a 25-hour day', () => {
    // America/New_York falls back 2026-11-01: the day has 25 hours, so `every 12` still gives 00:00 and 12:00.
    const runs = occurrencesBetween({ type: 'hours', every: 12 }, at('2026-11-01T04:00:00Z'), at('2026-11-02T06:00:00Z'), NEW_YORK);
    expect(runs.map((ms) => wall(ms, NEW_YORK))).toEqual(['2026-11-01 00:00 wd7', '2026-11-01 12:00 wd7', '2026-11-02 00:00 wd1']);
  });
});

describe('nextOccurrence', () => {
  it('is strictly after the given instant', () => {
    const run = at('2026-09-14T02:00:00Z');
    expect(nextOccurrence({ type: 'daily', hour: 4 }, run, WARSAW)).toBe(at('2026-09-15T02:00:00Z'));
    expect(nextOccurrence({ type: 'daily', hour: 4 }, run - 1, WARSAW)).toBe(run);
  });

  it('finds a weekly a week away and answers null for an unknown zone', () => {
    const friday = at('2026-09-18T14:00:00Z');
    expect(nextOccurrence({ type: 'weekly', day: 5, hour: 16 }, friday, WARSAW)).toBe(at('2026-09-25T14:00:00Z'));
    expect(nextOccurrence({ type: 'daily' }, friday, 'Mars/Olympus')).toBeNull();
  });
});

describe('zonedWallTimeToUtc', () => {
  it('round-trips a wall time in each zone', () => {
    const ms = zonedWallTimeToUtc(2026, 9, 14, 4, 0, WARSAW)!;
    expect(new Date(ms).toISOString()).toBe('2026-09-14T02:00:00.000Z');
    expect(wall(zonedWallTimeToUtc(2026, 1, 14, 4, 0, NEW_YORK)!, NEW_YORK)).toBe('2026-01-14 04:00 wd3');
  });
});
