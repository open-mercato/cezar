import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { deriveAccountHolds } from './account-holds.ts';

const parked = (until: number) => ({
  id: 'r1', status: 'failed', runner: 'claude', steps: [], autoResumeAt: new Date(until).toISOString(), autoResumeReason: 'usage_limit',
}) as unknown as RunRecord;

/** A lifted deadline (spec 2026-08-03-auto-resume-after-usage-limit, 2026-11-23 addendum). */
describe('deriveAccountHolds — a lifted deadline', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const run = parked(now + 3_600_000);

  it('holds the account in flight until a resume sees its window open (#2525), not wide open', () => {
    for (const lift of ['login', 'released'] as const) {
      const holds = deriveAccountHolds([run], { now, lift: () => lift });
      expect(holds.deadline.size).toBe(0);
      expect([...holds.inFlight]).toEqual(['claude:default']);
    }
  });

  it('holds nothing in flight for a project nobody has loaded: no resume runs there to release it', () => {
    const holds = deriveAccountHolds([run], { now, lift: () => 'login', inFlight: false });
    expect([holds.deadline.size, holds.inFlight.size]).toEqual([0, 0]);
  });

  it('guard: an unlifted deadline is a deadline hold, and a passed one holds nothing', () => {
    expect([...deriveAccountHolds([run], { now }).deadline]).toEqual(['claude:default']);
    const passed = deriveAccountHolds([parked(now - 1)], { now, lift: () => 'login' });
    expect([passed.deadline.size, passed.inFlight.size]).toEqual([0, 0]);
  });
});
