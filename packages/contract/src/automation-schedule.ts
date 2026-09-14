import { z } from 'zod';
import { isoWeekday, zonedParts, zonedWallTimeToUtc } from './zoned-time.ts';

/**
 * A scheduled automation's trigger (spec 2026-09-14-automations-redesign § Data Model) and the
 * pure occurrence math over it, shared by the server's schedule runner and the cockpit's
 * calendars, "next runs" rail and editor preview — one implementation, so what the editor
 * previews is what the timer fires.
 *
 * Four bounded shapes rather than cron: every day at HH:MM, weekdays at HH:MM, one weekday at
 * HH:MM, every N hours from midnight. A cron string is DERIVED for display and for the CLI
 * (`cronOf` / `parseCron`), never stored and never evaluated — the shapes are what the math runs.
 */

export const SCHEDULE_TYPES = ['daily', 'weekdays', 'weekly', 'hours'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

/** The `every` choices for the `hours` shape — the ones that divide a day evenly. */
export const SCHEDULE_HOURS_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const;
export type ScheduleEvery = (typeof SCHEDULE_HOURS_OPTIONS)[number];

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const automationScheduleSchema = z.object({
  type: z.enum(SCHEDULE_TYPES),
  /** 0–23; `daily`, `weekdays`, `weekly`. Default 4. */
  hour: z.number().int().min(0).max(23).optional(),
  /** 0–59; `daily`, `weekdays`, `weekly`. Default 0. */
  minute: z.number().int().min(0).max(59).optional(),
  /** ISO weekday, Monday = 1 … Sunday = 7; `weekly`. Default 1. */
  day: z.number().int().min(1).max(7).optional(),
  /** Hours between runs, from 00:00; `hours`. Default 6. */
  every: z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12),
  ]).optional(),
});
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

/** The same shape with every default filled — what the math and the labels read. */
export interface NormalizedSchedule {
  type: ScheduleType;
  hour: number;
  minute: number;
  day: number;
  every: ScheduleEvery;
}

export function normalizeSchedule(schedule: AutomationSchedule): NormalizedSchedule {
  return {
    type: schedule.type,
    hour: schedule.hour ?? 4,
    minute: schedule.minute ?? 0,
    day: schedule.day ?? 1,
    every: schedule.every ?? 6,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `HH:MM`. */
export function hm(hour: number, minute = 0): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** The trigger cell's text: `every day at 04:00`, `weekdays at 07:30`, `every 6 hours`, `Tuesdays at 02:00`. */
export function scheduleLabel(schedule: AutomationSchedule): string {
  const s = normalizeSchedule(schedule);
  switch (s.type) {
    case 'daily': return `every day at ${hm(s.hour, s.minute)}`;
    case 'weekdays': return `weekdays at ${hm(s.hour, s.minute)}`;
    case 'hours': return s.every === 1 ? 'every hour' : `every ${s.every} hours`;
    case 'weekly': return `${WEEKDAY_LONG[s.day - 1]}s at ${hm(s.hour, s.minute)}`;
  }
}

/** The derived five-field cron string (cron's Sunday is 0). */
export function cronOf(schedule: AutomationSchedule): string {
  const s = normalizeSchedule(schedule);
  switch (s.type) {
    case 'daily': return `${s.minute} ${s.hour} * * *`;
    case 'weekdays': return `${s.minute} ${s.hour} * * 1-5`;
    case 'hours': return `0 */${s.every} * * *`;
    case 'weekly': return `${s.minute} ${s.hour} * * ${s.day % 7}`;
  }
}

/**
 * The inverse of `cronOf` for the four shapes it emits — and ONLY those. Anything else (a
 * minute step, day-of-month, lists, ranges other than `1-5`) answers `null`; the caller names the
 * supported shapes.
 */
export function parseCron(expression: string): AutomationSchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== '*' || month !== '*') return null;
  const hoursEvery = /^\*\/(\d+)$/.exec(hourField);
  if (hoursEvery && minuteField === '0' && dow === '*') {
    const every = Number(hoursEvery[1]);
    return (SCHEDULE_HOURS_OPTIONS as readonly number[]).includes(every)
      ? { type: 'hours', every: every as ScheduleEvery }
      : null;
  }
  if (!/^\d{1,2}$/.test(minuteField) || !/^\d{1,2}$/.test(hourField)) return null;
  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (minute > 59 || hour > 23) return null;
  if (dow === '*') return { type: 'daily', hour, minute };
  if (dow === '1-5') return { type: 'weekdays', hour, minute };
  if (/^[0-7]$/.test(dow)) {
    const cronDay = Number(dow);
    // cron: 0 and 7 are both Sunday; ISO: Sunday is 7.
    const day = cronDay === 0 ? 7 : cronDay;
    return { type: 'weekly', hour, minute, day };
  }
  return null;
}

/** The wall times (hour, minute) a shape fires at on one calendar day, given that day's weekday. */
function wallTimesOn(s: NormalizedSchedule, weekday: number): Array<[number, number]> {
  switch (s.type) {
    case 'daily': return [[s.hour, s.minute]];
    case 'weekdays': return weekday <= 5 ? [[s.hour, s.minute]] : [];
    case 'weekly': return weekday === s.day ? [[s.hour, s.minute]] : [];
    case 'hours': {
      const out: Array<[number, number]> = [];
      for (let h = 0; h < 24; h += s.every) out.push([h, 0]);
      return out;
    }
  }
}

/**
 * Every instant the schedule fires in `[fromMs, toMs)`, ascending, in the zone. Bounded by
 * `limit` so a caller asking for a year of hourly runs gets the first `limit`, not a stall.
 * Each (day, wall time) yields exactly one instant, which is what makes a DST fall-back hour
 * fire once and a spring-forward gap fire once.
 */
export function occurrencesBetween(
  schedule: AutomationSchedule,
  fromMs: number,
  toMs: number,
  timeZone: string,
  limit = 1_000,
): number[] {
  const s = normalizeSchedule(schedule);
  const start = zonedParts(fromMs, timeZone);
  if (!start || toMs <= fromMs) return [];
  const out: number[] = [];
  // Walk calendar days in the zone, starting one day early so an offset change cannot hide the
  // first day's occurrence, and stopping one day past `toMs`.
  const dayCount = Math.ceil((toMs - fromMs) / 86_400_000) + 2;
  for (let d = -1; d <= dayCount; d += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + d));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    for (const [hour, minute] of wallTimesOn(s, isoWeekday(year, month, day))) {
      const at = zonedWallTimeToUtc(year, month, day, hour, minute, timeZone);
      if (at === null) return out;
      if (at >= fromMs && at < toMs) {
        out.push(at);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** The first instant strictly after `afterMs`, or `null` for an unknown zone. */
export function nextOccurrence(schedule: AutomationSchedule, afterMs: number, timeZone: string): number | null {
  // Every shape recurs within 7 days; 9 covers a weekly at the far end of a DST week.
  const [first] = occurrencesBetween(schedule, afterMs + 1, afterMs + 9 * 86_400_000, timeZone, 1);
  return first ?? null;
}
