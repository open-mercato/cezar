/**
 * Timezone math for one-time scheduled tasks (spec 2026-08-01-postponed-tasks).
 *
 * The composer submits a naive local wall-clock (`YYYY-MM-DDTHH:mm[:ss]`) plus an IANA zone; the
 * server owns the conversion to an absolute UTC instant so a definition's stored `at` is always
 * authoritative and never depends on the browser's own clock or zone. Uses only `Intl` — no
 * dependency, and the same data every Node ships with.
 */

const LOCAL_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's UTC offset (ms, east positive) at a given absolute instant. */
function zoneOffsetMs(timezone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/**
 * The absolute instant at which the wall-clock `localAt` occurs in `timezone`, or `null` when the
 * local string is malformed. Refines once so a DST transition resolves to the correct offset.
 */
export function zonedTimeToUtc(localAt: string, timezone: string): Date | null {
  const match = LOCAL_AT_RE.exec(localAt.trim());
  if (!match || !isValidTimezone(timezone)) return null;
  const [, y, mo, d, h, mi, s] = match;
  const wallAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
  );
  if (Number.isNaN(wallAsUtc)) return null;
  const offset = zoneOffsetMs(timezone, new Date(wallAsUtc));
  let instant = wallAsUtc - offset;
  const refined = zoneOffsetMs(timezone, new Date(instant));
  if (refined !== offset) instant = wallAsUtc - refined;
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Format the instant as the wall-clock it lands on in `timezone`, e.g. `Tue, 5 Aug 2026, 09:30`. */
export function formatLocalLabel(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/** Format the instant in UTC, e.g. `13:30 UTC`. */
export function formatUtcLabel(instant: Date): string {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return `${hhmm} UTC`;
}
