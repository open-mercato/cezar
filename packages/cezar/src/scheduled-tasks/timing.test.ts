import { describe, expect, it } from 'vitest';
import { formatUtcLabel, isValidTimezone, zonedTimeToUtc } from './timing.ts';

describe('scheduled-task timing', () => {
  it('validates IANA timezones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('converts a wall-clock time in a zone to the correct UTC instant (EDT, -4)', () => {
    // 5 Aug 2026 is during daylight saving in New York (UTC-4).
    const at = zonedTimeToUtc('2026-08-05T09:30', 'America/New_York');
    expect(at?.toISOString()).toBe('2026-08-05T13:30:00.000Z');
  });

  it('converts a wall-clock time in a zone during standard time (EST, -5)', () => {
    const at = zonedTimeToUtc('2026-01-05T09:30', 'America/New_York');
    expect(at?.toISOString()).toBe('2026-01-05T14:30:00.000Z');
  });

  it('treats a UTC wall-clock as itself', () => {
    expect(zonedTimeToUtc('2026-08-05T09:30', 'UTC')?.toISOString()).toBe('2026-08-05T09:30:00.000Z');
  });

  it('rejects a malformed local string or invalid zone', () => {
    expect(zonedTimeToUtc('not-a-date', 'UTC')).toBeNull();
    expect(zonedTimeToUtc('2026-08-05T09:30', 'Not/AZone')).toBeNull();
  });

  it('formats a UTC label', () => {
    expect(formatUtcLabel(new Date('2026-08-05T13:30:00.000Z'))).toBe('13:30 UTC');
  });
});
