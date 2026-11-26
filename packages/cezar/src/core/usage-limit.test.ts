import { describe, expect, it } from 'vitest';
import { classifyAgentFailure } from './agent-failure-class.ts';
import { isResetlessLimitMessage } from './agent-errors.ts';
import { isUsageExhaustion, isUsageLimitMessage, MAX_USAGE_LIMIT_WAIT_MS, parseUsageLimit } from './usage-limit.ts';

/** A fixed clock — every expectation below is relative to it. */
const NOW = Date.parse('2026-08-03T12:00:00.000Z');

describe('parseUsageLimit', () => {
  it('reads Claude Code\'s own envelope, in epoch seconds', () => {
    const resetAt = Date.parse('2026-08-03T17:00:00.000Z');
    const hit = parseUsageLimit(
      `continue failed: Claude AI usage limit reached|${resetAt / 1_000}`,
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T17:00:00.000Z');
    expect(hit?.evidence).toBe('claude-marker');
  });

  it('accepts the same marker in milliseconds rather than parking it ~50,000 years out', () => {
    const hit = parseUsageLimit(`Claude AI usage limit reached|${NOW + 3_600_000}`, NOW);
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T13:00:00.000Z');
  });

  it('reads an explicit reset instant out of prose', () => {
    const hit = parseUsageLimit(
      "You've hit your usage limit. Try again at 2026-08-03T15:30:00Z.",
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T15:30:00.000Z');
    expect(hit?.evidence).toBe('timestamp');
  });

  it('reads a date-only reset as local midnight, the way the zoneless prose forms are read', () => {
    // The ECMAScript date-ONLY form is defined as UTC, so a bare `YYYY-MM-DD` reaching
    // `Date.parse` unchanged would land up to a day away from the day the provider named. The
    // zoneless prose forms are deliberately read on the host's clock — the provider is talking
    // to the person at this machine — and a bare date has to answer the same way.
    // Two days out, so the expectation is unambiguous (and un-clamped) in every host timezone.
    const hit = parseUsageLimit('Usage limit reached. Try again at 2026-08-05.', NOW);
    const midnight = new Date(2026, 7, 5, 0, 0, 0, 0);
    expect(hit?.resetAt.getTime()).toBe(midnight.getTime());
    expect(hit?.evidence).toBe('timestamp');
  });

  it('reads Claude Code session-limit prose with a clock and IANA timezone', () => {
    const hit = parseUsageLimit(
      "You've hit your session limit · resets 8:10pm (Europe/Warsaw)",
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T18:11:00.000Z');
    expect(hit?.evidence).toBe('clock');
  });

  it('uses tomorrow when a clock-only reset already passed today in its named timezone', () => {
    const lateWarsawNight = Date.parse('2026-08-03T21:30:00.000Z');
    const hit = parseUsageLimit(
      "You've hit your session limit · resets 8:10pm (Europe/Warsaw)",
      lateWarsawNight,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-04T18:11:00.000Z');
  });

  it.each([0, 30, 38, 59])('buffers a clock-only reset before day rollover at second %s', (second) => {
    const now = new Date(2026, 9, 16, 14, 39, second).getTime();
    const hit = parseUsageLimit("You've hit your usage limit. Try again at 2:39 PM.", now);
    expect(hit?.resetAt.getTime()).toBe(new Date(2026, 9, 16, 14, 40).getTime());
    expect(hit?.evidence).toBe('clock');
  });

  it('keeps the buffered minute boundary on today', () => {
    const now = new Date(2026, 9, 16, 14, 40).getTime();
    expect(parseUsageLimit('Usage limit reached. Try again at 14:39.', now)?.resetAt.getTime()).toBe(now);
  });

  it('buffers a zoned clock before choosing tomorrow', () => {
    const now = Date.parse('2026-10-16T14:39:38Z');
    const hit = parseUsageLimit('Usage limit reached. Try again at 2:39 PM (UTC).', now);
    expect(hit?.resetAt.toISOString()).toBe('2026-10-16T14:40:00.000Z');
  });

  it('buffers the final minute across midnight', () => {
    const now = Date.parse('2026-10-16T23:59:38Z');
    const hit = parseUsageLimit('Usage limit reached. Try again at 23:59 (UTC).', now);
    expect(hit?.resetAt.toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });

  it('buffers real elapsed time across a named-zone DST jump', () => {
    const now = Date.parse('2026-03-29T00:59:38Z');
    const hit = parseUsageLimit('Usage limit reached. Resets 1:59am (Europe/Warsaw).', now);
    expect(hit?.resetAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('keeps an exact reset second from Claude and timestamp prose', () => {
    const now = Date.parse('2026-10-16T14:39:38Z');
    const resetAt = Date.parse('2026-10-16T14:39:52Z');
    for (const message of [
      `Claude AI usage limit reached|${resetAt / 1000}`,
      'Usage limit reached. Try again at 2026-10-16T14:39:52Z.',
    ]) expect(parseUsageLimit(message, now)?.resetAt.getTime()).toBe(resetAt);
  });

  it('resumes now, not a day later, when a minute-truncated clock reset just passed (telemetry 4bf9686a)', () => {
    const justAfter = Date.parse('2026-08-03T18:10:40.000Z');
    const zoned = parseUsageLimit("You've hit your session limit · resets 8:10pm (Europe/Warsaw)", justAfter);
    expect(zoned?.resetAt.getTime()).toBe(justAfter + 20_000);
    const local = new Date(2026, 7, 3, 2, 10, 40).getTime();
    expect(parseUsageLimit("You've hit your session limit · resets 2:10am", local)?.resetAt.getTime()).toBe(local + 20_000);
  });

  it('reads the session-limit prose with a UTC zone (telemetry 987e8238)', () => {
    const hit = parseUsageLimit("You've hit your session limit · resets 3:10pm (UTC)", NOW);
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T15:11:00.000Z');
  });

  it('honors the day a weekly reset names instead of resuming at the next matching clock', () => {
    const hit = parseUsageLimit("You've hit your weekly limit · resets Aug 6, 9am (Europe/Warsaw)", NOW);
    expect(hit?.resetAt.toISOString()).toBe('2026-08-06T07:01:00.000Z');
    expect(hit?.evidence).toBe('clock');
    expect(parseUsageLimit('Weekly limit reached ∙ resets Aug 4 at 10:30am (UTC)', NOW)?.resetAt.toISOString())
      .toBe('2026-08-04T10:31:00.000Z');
  });

  it('rolls a weekly reset named in January over the year end', () => {
    const lateDecember = Date.parse('2026-12-30T12:00:00.000Z');
    expect(parseUsageLimit('weekly limit · resets Jan 2, 9am (UTC)', lateDecember)?.resetAt.toISOString())
      .toBe('2027-01-02T09:01:00.000Z');
  });

  it('refuses a named day the calendar does not have rather than guessing a clock', () => {
    expect(parseUsageLimit('weekly limit · resets Feb 31, 9am (UTC)', NOW)).toBeNull();
  });

  it('reads a relative delay, and a bare retry-after', () => {
    expect(parseUsageLimit('rate limit exceeded — try again in 42 minutes', NOW)?.resetAt.toISOString())
      .toBe('2026-08-03T12:42:00.000Z');
    expect(parseUsageLimit('429 rate_limit_error; retry-after: 3600', NOW)?.resetAt.toISOString())
      .toBe('2026-08-03T13:00:00.000Z');
    expect(parseUsageLimit('usage limit reached, retry after 90 s', NOW)?.evidence).toBe('delay');
  });

  it('clamps an already-elapsed reset to now — the limit has lifted, resume as soon as allowed', () => {
    const hit = parseUsageLimit(`Claude AI usage limit reached|${(NOW - 60_000) / 1_000}`, NOW);
    expect(hit?.resetAt.getTime()).toBe(NOW);
  });

  it('refuses a reset further out than a week — a corrupt number must not swallow the task', () => {
    const beyond = (NOW + MAX_USAGE_LIMIT_WAIT_MS + 60_000) / 1_000;
    expect(parseUsageLimit(`Claude AI usage limit reached|${beyond}`, NOW)).toBeNull();
  });

  it('is null for anything that is not a usage limit', () => {
    expect(parseUsageLimit(undefined, NOW)).toBeNull();
    expect(parseUsageLimit('claude CLI exited with code 1 — ENOENT', NOW)).toBeNull();
    expect(parseUsageLimit('Failed to authenticate. API Error: 401', NOW)).toBeNull();
    // A timestamp with no limit phrase around it must never schedule a resume.
    expect(parseUsageLimit('build failed at 2026-08-03T15:30:00Z', NOW)).toBeNull();
  });

  it('is null for a limit with no recoverable instant — guessing would be a retry loop', () => {
    expect(parseUsageLimit('You have hit your usage limit. Upgrade to continue.', NOW)).toBeNull();
    expect(parseUsageLimit("You've hit your 5-hour limit · resets 3:10pm (UTC)", NOW)?.evidence).toBe('clock');
    expect(parseUsageLimit('429 {"type":"rate_limit_error"}', NOW)).toBeNull();
  });
});

describe('isUsageExhaustion — credits ran out (0fa28a3b)', () => {
  it('counts the message as exhaustion, but not an RPM throttle', () => {
    expect(isUsageExhaustion('API Error: Usage credits ran out before the response was finished.')).toBe(true);
    expect(isUsageExhaustion('Model user RPM limit exceeded for glm/glm-5 maximum 3 requests per minute per account')).toBe(false);
  });
});

describe("Claude's out-of-usage-credits window (manager backup did not take over)", () => {
  const message = "You're out of usage credits · resets Dec 1 at 1am (Europe/Warsaw)";
  it('is usage exhaustion with its reset as the hold, not billing', () => {
    expect(isUsageExhaustion(message)).toBe(true);
    expect(isUsageLimitMessage(message)).toBe(true);
    // Dec 1, 01:00 in Warsaw (UTC+1), plus the minute the prose truncates.
    expect(parseUsageLimit(message, Date.parse('2026-11-26T09:11:00Z'))).toEqual({
      resetAt: new Date('2026-12-01T00:01:00.000Z'),
      evidence: 'clock',
    });
  });

  it('keeps a monthly reset that is weeks away, but not a weekly one', () => {
    const early = Date.parse('2026-11-05T09:00:00Z');
    expect(parseUsageLimit(message, early)?.resetAt.toISOString()).toBe('2026-12-01T00:01:00.000Z');
    expect(parseUsageLimit("You've hit your weekly limit · resets Dec 1 at 1am (Europe/Warsaw)", early)).toBeNull();
    // A month and more out is still a corrupt or stale date.
    expect(parseUsageLimit(message, Date.parse('2026-10-20T09:00:00Z'))).toBeNull();
  });

  it('gives an ISO reset in the credits wording the same monthly cap', () => {
    const early = Date.parse('2026-11-05T09:00:00Z');
    expect(parseUsageLimit("You're out of usage credits, try again at 2026-12-01T00:00:00Z", early)?.resetAt.toISOString())
      .toBe('2026-12-01T00:00:00.000Z');
    expect(parseUsageLimit('Usage limit reached, try again at 2026-12-01T00:00:00Z', early)).toBeNull();
    // The relative shapes too: 20 days in hours.
    expect(parseUsageLimit("You're out of usage credits, try again in 480 hours", early)?.evidence).toBe('delay');
    expect(parseUsageLimit('Usage limit reached, try again in 480 hours', early)).toBeNull();
  });

  it('keeps a weekly reset at the edge of the window — padding is not counted against the cap', () => {
    // Exactly seven days out; the minute of padding lands just past the cap.
    const now = Date.parse('2026-11-24T09:00:00Z');
    expect(parseUsageLimit('weekly limit · resets Dec 1, 9am (UTC)', now)?.resetAt.toISOString())
      .toBe('2026-12-01T09:01:00.000Z');
    expect(parseUsageLimit('weekly limit · resets Dec 1, 9:01am (UTC)', now)).toBeNull();
  });

  it('without a reset it is still a usage limit with nothing to schedule, never billing', () => {
    const bare = "You're out of usage credits";
    expect(isUsageLimitMessage(bare)).toBe(true);
    expect(isUsageExhaustion(bare)).toBe(true);
    expect(parseUsageLimit(bare, Date.parse('2026-11-26T09:11:00Z'))).toBeNull();
    expect(classifyAgentFailure(bare)).toBe('usage_limit');
    expect(isResetlessLimitMessage("You're out of usage credits. Add credits to continue.")).toBe(true);
  });

  it('reads "out of usage quota" the same way', () => {
    const quota = 'You are out of usage quota · resets Dec 1 at 1am (Europe/Warsaw)';
    expect(isUsageLimitMessage(quota)).toBe(true);
    expect(isUsageExhaustion(quota)).toBe(true);
    expect(classifyAgentFailure(quota)).toBe('usage_limit');
    expect(parseUsageLimit(quota, Date.parse('2026-11-26T09:11:00Z'))?.resetAt.toISOString()).toBe('2026-12-01T00:01:00.000Z');
  });
});
