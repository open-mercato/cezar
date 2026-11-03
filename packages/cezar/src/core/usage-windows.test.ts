import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { emitUsageWindows, normalizeClaudeTerminalUsageLimit, normalizeClaudeUsageWindows, normalizeCodexUsageWindows } from './usage-windows.ts';
import { usageWindowsObservationSchema } from '@open-mercato/cezar-contract';

// The parent owns the contract barrel export; keep this component independently testable.
vi.mock('@open-mercato/cezar-contract', async (original) => ({
  ...await original<object>(), ...await import(new URL('../../../contract/src/usage-windows.ts', import.meta.url).href),
}));

describe('usage metadata fixtures', () => {
  it('captures allowed Claude five-hour and weekly resets from the recorded stream', () => {
    const lines = readFileSync(new URL('./__fixtures__/claude/partial-messages.ndjson', import.meta.url), 'utf8').trim().split('\n');
    const observations = lines.map((line) => normalizeClaudeUsageWindows(JSON.parse(line), 1)).filter(Boolean);
    expect(observations).toHaveLength(1);
    const observation = usageWindowsObservationSchema.parse(observations[0]);
    expect(observation.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', status: 'allowed', usedPercent: 27, resetsAt: 1790734200000 }),
      expect.objectContaining({ id: 'seven_day', status: 'unknown', usedPercent: 57.99999999999999 }),
    ]);
  });
  it('does not broadcast rejected status or confuse overage with a main block', () => {
    const observation = normalizeClaudeUsageWindows({ type: 'rate_limit_event', rate_limit_info: {
      status: 'allowed', overageStatus: 'rejected', rateLimitType: 'five_hour', resetsAt: 100,
      unifiedWindows: { seven_day: { utilization: 1.2, resetsAt: 200 }, seven_day_sonnet: { resetsAt: 300 } },
    } })!;
    expect(observation.windows.find((w) => w.id === 'five_hour')?.status).toBe('allowed');
    expect(observation.windows.find((w) => w.id === 'seven_day')?.status).toBe('unknown');
    expect(observation.windows.find((w) => w.id === 'seven_day_sonnet')?.applicability).toBe('unknown');
  });
  it('normalizes a single weekly Codex primary without assuming five hours', () => {
    const observation = normalizeCodexUsageWindows({ rateLimits: {
      primary: { usedPercent: 123, resetsAt: 200, windowDurationMins: 10080 }, secondary: null,
    } }, 'codex-read', 10);
    expect(usageWindowsObservationSchema.parse(observation).windows).toEqual([
      expect.objectContaining({ kind: 'primary', durationMinutes: 10080, usedPercent: 123, status: 'blocked', resetsAt: 200000, applicability: 'all' }),
      expect.objectContaining({ kind: 'secondary', resetsAt: null, status: 'unknown' }),
    ]);
  });
  it('prefers keyed buckets and refuses unknown model applicability', () => {
    const observation = normalizeCodexUsageWindows({
      rateLimits: { primary: { resetsAt: 999 } },
      rateLimitsByLimitId: { codex: { primary: { resetsAt: 100 } }, 'gpt-special': { primary: { resetsAt: 200 } } },
    });
    expect(observation.windows.map((w) => [w.id, w.resetsAt, w.applicability])).toEqual([
      ['codex:primary', 100000, 'all'], ['gpt-special:primary', 200000, 'unknown'],
    ]);
  });
  it('clears explicit null buckets and refuses a mismatched bucket identifier', () => {
    expect(normalizeCodexUsageWindows({ rateLimits: null }).windows).toEqual([
      expect.objectContaining({ id: 'codex:primary', resetsAt: null }),
      expect.objectContaining({ id: 'codex:secondary', resetsAt: null }),
    ]);
    const conflicted = normalizeCodexUsageWindows({ rateLimitsByLimitId: { special: { limitId: 'codex', primary: { resetsAt: 100 } }, codex: { primary: { resetsAt: 200 } } } });
    expect(conflicted.windows.map((w) => [w.id, w.applicability])).toEqual([['special:primary', 'unknown'], ['codex:primary', 'all']]);
  });
  it('accepts null/malformed and partial payloads without inventing a reset', () => {
    expect(normalizeCodexUsageWindows(null).windows).toEqual([]);
    expect(normalizeCodexUsageWindows({ rateLimitsByLimitId: { special: {} } }).windows).toEqual([
      expect.objectContaining({ applicability: 'unknown', resetsAt: null }),
    ]);
    expect(normalizeCodexUsageWindows({ rateLimits: { secondary: { usedPercent: null, resetsAt: '123' } } }).windows)
      .toEqual([expect.objectContaining({ kind: 'secondary', resetsAt: null, usedPercent: null })]);
    expect(normalizeClaudeUsageWindows({ type: 'other' })).toBeNull();
    expect(() => emitUsageWindows(() => { throw new Error('store failed'); }, normalizeCodexUsageWindows(null))).not.toThrow();
  });
});


describe('Claude terminal usage limits', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const resetAt = now + 3_600_000;
  const frame = (result: unknown, is_error = true) => ({ type: 'result', is_error, result });
  it.each([resetAt / 1000, resetAt])('retains the canonical reset %s without guessing a window duration', epoch => {
    const observation = normalizeClaudeTerminalUsageLimit(frame(`Claude AI usage limit reached|${epoch}`), now);
    expect(observation).toEqual({ provider: 'claude', source: 'claude-stream', observedAt: now, windows: [{
      id: 'terminal-limit', kind: 'other', applicability: 'all', models: [], resetsAt: resetAt,
      durationMinutes: null, usedPercent: 100, status: 'blocked', observedAt: now,
    }] });
    expect(usageWindowsObservationSchema.parse(observation)).toEqual(observation);
  });
  it('reads canonical markers from terminal errors arrays and emits only the latest block', () => {
    const observation = normalizeClaudeTerminalUsageLimit({ type: 'result', is_error: true,
      result: `Claude AI usage limit reached|${resetAt / 1000}`,
      errors: [null, 123, 'ordinary failure', `Claude AI usage limit reached|${(resetAt + 60_000) / 1000}`],
    }, now);
    expect(observation?.windows).toHaveLength(1);
    expect(observation?.windows[0]?.resetsAt).toBe(resetAt + 60_000);
    expect(normalizeClaudeTerminalUsageLimit({ type: 'result', is_error: true,
      errors: [`Claude AI usage limit reached|${resetAt / 1000}`] }, now)?.windows[0]?.resetsAt).toBe(resetAt);
  });
  it.each([
    { type: 'result', is_error: false, errors: [`Claude AI usage limit reached|${resetAt / 1000}`] },
    { type: 'assistant', is_error: true, errors: [`Claude AI usage limit reached|${resetAt / 1000}`] },
    { type: 'result', is_error: true, errors: ['Rate limit reached; retry after 3600 seconds'] },
    { type: 'result', is_error: true, errors: [{ message: `Claude AI usage limit reached|${resetAt / 1000}` }] },
    { type: 'result', is_error: true, errors: [`Claude AI usage limit reached|${now / 1000}`] },
  ])('does not broaden trust for errors arrays: %j', message => {
    expect(normalizeClaudeTerminalUsageLimit(message, now)).toBeNull();
  });
  it.each([
    null, [], {}, { type: 'assistant', is_error: true, result: `Claude AI usage limit reached|${resetAt / 1000}` },
    frame(`Claude AI usage limit reached|${resetAt / 1000}`, false), frame(123),
    frame('Unrelated failure'), frame('Claude AI usage limit reached'),
    frame(`Claude AI usage limit reached|${(now + 8 * 86_400_000) / 1000}`),
    frame(`Claude AI usage limit reached|${now / 1000}`),
    frame(`Claude AI usage limit reached|${(now - 1000) / 1000}`),
    frame('Rate limit reached; retry after 3600 seconds'),
  ])('rejects untrusted, nonterminal, expired or unbounded evidence: %j', message => {
    expect(normalizeClaudeTerminalUsageLimit(message, now)).toBeNull();
  });
  it('uses the same reset and grace deadline as the unchanged auto-resume parser', async () => {
    const { parseUsageLimit } = await import('./usage-limit.ts');
    const { AUTO_RESUME_GRACE_MS } = await import('../workflows/run.ts');
    const text = `Claude AI usage limit reached|${resetAt / 1000}`;
    const autoResumeAt = parseUsageLimit(text, now)!.resetAt.getTime() + AUTO_RESUME_GRACE_MS;
    expect(normalizeClaudeTerminalUsageLimit(frame(text), now)!.windows[0]!.resetsAt! + AUTO_RESUME_GRACE_MS).toBe(autoResumeAt);
    expect(autoResumeAt).toBe(resetAt + 30_000);
  });
});
