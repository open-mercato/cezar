/**
 * Provider usage-limit detection (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * A subscription that runs out of its window does not fail like an agent bug does: the work is
 * fine, the account is simply closed until a KNOWN instant. That instant is the whole feature —
 * without it there is nothing to schedule, so this module answers exactly one question about a
 * terminal error string: "is this a usage limit, and when does it lift?".
 *
 * The evidence differs per backend, so the shapes are recognized in order of how exact they are:
 *
 *  1. Claude Code's machine-readable envelope, `Claude AI usage limit reached|<epoch>` — the CLI
 *     puts it in an `is_error` result frame, which reaches cezar verbatim as the run's `error`.
 *     Exact, no locale, no parsing of prose. This is the one that matters in practice.
 *  2. An explicit reset instant in the prose (`try again at 2026-08-03T18:00:00Z`) — how Codex and
 *     OpenCode phrase the same thing when they carry a timestamp at all.
 *  3. A clock-only reset in prose (`resets 8:10pm (Europe/Warsaw)`) — how Claude Code phrases
 *     session windows in some interactive output.
 *  4. A relative delay (`try again in 42 minutes`, `retry-after: 3600`).
 *
 * Nothing else counts. A limit message with no recoverable reset instant returns `null` on
 * purpose: guessing a window would turn one interruption into a retry loop against a provider
 * that is still refusing, and "we don't know when" is an honest answer the caller can surface.
 */

export interface UsageLimitHit {
  /** When the provider says the limit lifts. Never in the past — a stale instant clamps to now. */
  resetAt: Date;
  /** Which shape carried it — the lifecycle note quotes this so the schedule is auditable. */
  evidence: 'claude-marker' | 'timestamp' | 'clock' | 'delay';
}

/**
 * The furthest ahead a reset may sit and still be believed. Claude's weekly window is the real
 * ceiling; anything beyond a week is a corrupt or unit-confused number, and parking a task on it
 * would be indistinguishable from losing the task.
 */
export const MAX_USAGE_LIMIT_WAIT_MS = 7 * 24 * 60 * 60_000;

/** Claude Code's own envelope. The suffix is Unix EPOCH SECONDS (ms tolerated — see below). */
const CLAUDE_MARKER_RE = /claude(?:\s+ai)?\s+usage\s+limit\s+reached\s*\|\s*(\d{9,16})/i;

/**
 * "This is a limit, not a crash." Deliberately narrow: it gates the two prose shapes below, and a
 * false positive there would schedule a resume on a timestamp that means something else entirely.
 */
const LIMIT_PHRASE_RE =
  /\b(?:usage|rate|session|weekly|hourly)[\s-]?limit\b|\brate[_-]?limit(?:_error|ed)?\b|\bquota\s+(?:exceeded|reached)\b|\bout\s+of\s+(?:credits|quota)\b/i;

/** `…try again at 2026-08-03T18:00:00Z`, `…resets at 2026-08-03 18:00`. */
const RESET_AT_RE =
  /(?:resets?|reset[s]?\s+at|try\s+again|retry|available\s+again|unlocks?)\b[^\n]{0,24}?\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/i;

/** `...resets 8:10pm (Europe/Warsaw)`, `...try again at 20:10`. */
const RESET_CLOCK_RE =
  /(?:resets?|reset[s]?\s+at|try\s+again|retry|available\s+again|unlocks?)\b[^\n]{0,24}?\b(?:at\s*)?(\d{1,2})(?:(?::(\d{2}))\s*([ap]\.?m\.?)?|\s*([ap]\.?m\.?))(?:\s*\(([^)]+)\))?/i;

/** `…try again in 42 minutes`, `…retry after 3600 seconds`, `retry-after: 3600`. */
const RESET_IN_RE =
  /(?:try\s+again|retry|resets?|available\s+again)\b[^\n]{0,16}?\b(?:in|after)\s+(\d{1,7})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const RETRY_AFTER_HEADER_RE = /\bretry[-_\s]?after\b\s*[:=]?\s*(\d{1,7})\b/i;

const UNIT_MS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

/**
 * Read a usage limit out of a terminal error message, or `null` when it is not one (or carries no
 * usable reset instant). `now` is injected so callers and tests share one clock.
 *
 * Never throws: this runs on the failure path of every run, where a second failure helps nobody.
 */
export function parseUsageLimit(message: string | undefined, now = Date.now()): UsageLimitHit | null {
  if (!message) return null;
  const marker = CLAUDE_MARKER_RE.exec(message);
  if (marker) {
    const raw = Number(marker[1]);
    // Epoch seconds is the documented unit; a value large enough to only make sense as
    // milliseconds is accepted rather than parked ~50,000 years out.
    const epochMs = raw >= 1e12 ? raw : raw * 1_000;
    return settle(epochMs, now, 'claude-marker');
  }
  if (!LIMIT_PHRASE_RE.test(message)) return null;

  const at = RESET_AT_RE.exec(message);
  if (at) {
    // A bare date, or `YYYY-MM-DD HH:MM` without a zone, is read in the host's local time — the
    // provider is talking to the person at this machine, and `Date.parse` would otherwise read the
    // space-separated form as UTC on some runtimes and local on others. A date with no time at all
    // needs the midnight spelled out for the same reason: the ECMAScript date-ONLY form is defined
    // as UTC, so `2026-08-03` alone would land up to a day away from the day the provider named.
    const stamp = at[1]!.includes('T') ? at[1]! : at[1]!.replace(' ', 'T');
    const parsed = Date.parse(stamp.includes('T') ? stamp : `${stamp}T00:00`);
    if (Number.isFinite(parsed)) return settle(parsed, now, 'timestamp');
  }

  const clock = RESET_CLOCK_RE.exec(message);
  if (clock) {
    const parsed = parseClockReset(clock, now);
    if (parsed !== null) return settle(parsed, now, 'clock');
  }

  const relative = RESET_IN_RE.exec(message);
  if (relative) {
    const unit = UNIT_MS[relative[2]!.toLowerCase()];
    if (unit !== undefined) return settle(now + Number(relative[1]) * unit, now, 'delay');
  }
  const header = RETRY_AFTER_HEADER_RE.exec(message);
  if (header) return settle(now + Number(header[1]) * 1_000, now, 'delay');

  return null;
}

function parseClockReset(match: RegExpExecArray, now: number): number | null {
  const hourRaw = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = (match[3] ?? match[4])?.toLowerCase().replaceAll('.', '');
  if (!Number.isInteger(hourRaw) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  let hour = hourRaw;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
    else return null;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  const timeZone = validTimeZone(match[5]?.trim());
  if (timeZone) return nextClockInTimeZone(hour, minute, timeZone, now);
  return nextLocalClock(hour, minute, now);
}

function nextLocalClock(hour: number, minute: number, now: number): number {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < now) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

function nextClockInTimeZone(hour: number, minute: number, timeZone: string, now: number): number | null {
  const today = zonedParts(now, timeZone);
  if (!today) return null;
  let candidate = zonedWallTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate === null) return null;
  if (candidate < now) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    candidate = zonedWallTimeToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

function validTimeZone(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return null;
  }
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = wallAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const offset = timeZoneOffsetMs(timeZone, candidate);
    if (offset === null) return null;
    const next = wallAsUtc - offset;
    if (Math.abs(next - candidate) < 1_000) return next;
    candidate = next;
  }
  return candidate;
}

function timeZoneOffsetMs(timeZone: string, utcMs: number): number | null {
  const parts = zonedParts(utcMs, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

function zonedParts(
  utcMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcMs));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: value('year'),
      month: value('month'),
      day: value('day'),
      hour: value('hour'),
      minute: value('minute'),
      second: value('second'),
    };
  } catch {
    return null;
  }
}

/** Bound a candidate instant: past → now (the limit already lifted), absurd → not believed. */
function settle(epochMs: number, now: number, evidence: UsageLimitHit['evidence']): UsageLimitHit | null {
  if (!Number.isFinite(epochMs)) return null;
  if (epochMs - now > MAX_USAGE_LIMIT_WAIT_MS) return null;
  return { resetAt: new Date(Math.max(epochMs, now)), evidence };
}
