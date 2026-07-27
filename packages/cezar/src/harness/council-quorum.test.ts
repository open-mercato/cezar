import { describe, expect, it } from 'vitest';
import { councilQuorum, isRetryableReviewerFailure, pool, type CouncilOutcome } from './council-quorum.js';

/**
 * Resilience rules for a council round (2026-07-25).
 *
 * The live failure these encode: a run spent 5.3M tokens and $12, two reviewers
 * completed and wrote their findings to disk, the third (a free-tier model)
 * burned its 60-minute budget twice without ever producing a result — and the
 * whole run was thrown away as "a partial council is no council".
 *
 * A council still needs independent voices to mean anything, so the answer is
 * not "accept anything". It is a quorum: enough completed reviewers, from
 * enough independent families, to still be a council — and a loud, recorded
 * degradation when one drops out.
 */

const done = (label: string, family: string): CouncilOutcome => ({ label, family, status: 'completed' });
const failed = (label: string, family: string, reason = 'timed out'): CouncilOutcome => ({
  label,
  family,
  status: 'failed',
  reason,
});

describe('councilQuorum', () => {
  it('refuses a partial council by default because every selected reviewer is required', () => {
    const q = councilQuorum([
      done('claude/opus', 'claude'),
      done('codex/gpt-5.6-sol', 'codex'),
      failed('opencode/mimo-v2.5-free', 'opencode'),
    ]);

    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toMatch(/required reviewers/i);
    expect(q.reason).toContain('opencode/mimo-v2.5-free');
  });

  it('allows a degraded council only under an explicit quorum policy', () => {
    const q = councilQuorum(
      [
        done('claude/opus', 'claude'),
        done('codex/gpt-5.6-sol', 'codex'),
        failed('opencode/mimo-v2.5-free', 'opencode'),
      ],
      { mode: 'quorum' },
    );

    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.degraded).toBe(true);
  });

  it('is not degraded when everyone completed', () => {
    const q = councilQuorum([done('claude/opus', 'claude'), done('codex/x', 'codex')]);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.degraded).toBe(false);
    expect(q.failed).toEqual([]);
  });

  it('refuses when only one reviewer survives — one voice is not a council', () => {
    const q = councilQuorum(
      [done('claude/opus', 'claude'), failed('codex/x', 'codex')],
      { mode: 'quorum' },
    );
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toMatch(/1 of 2 reviewers/);
    expect(q.reason).toContain('codex/x');
    expect(q.reason).toContain('timed out');
  });

  it('refuses when the survivors collapse to a single family — independence is the point', () => {
    // Two completed, but both anthropic: no cross-family check happened.
    const q = councilQuorum(
      [
        done('claude/opus', 'claude'),
        done('claude/sonnet', 'claude'),
        failed('codex/x', 'codex'),
      ],
      { mode: 'quorum' },
    );
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toMatch(/independent famil/i);
  });

  it('names every failure and its reason, so the operator can act', () => {
    const q = councilQuorum(
      [
        done('claude/opus', 'claude'),
        failed('codex/x', 'codex', 'exited 1'),
        failed('opencode/mimo', 'opencode', 'timed out after 60m'),
      ],
      { mode: 'quorum' },
    );
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toContain('exited 1');
    expect(q.reason).toContain('timed out after 60m');
  });

  it('treats an empty round as no council rather than a silent pass', () => {
    const q = councilQuorum([]);
    expect(q.ok).toBe(false);
  });
});

describe('isRetryableReviewerFailure', () => {
  it('does not retry a timeout — the budget is already spent', () => {
    // Observed live: two consecutive 60-minute timeouts on the same reviewer,
    // costing two hours to learn the same thing twice.
    expect(isRetryableReviewerFailure('opencode timed out after 60m and was killed')).toBe(false);
    expect(isRetryableReviewerFailure('POST /session/x/message timed out after 3600000ms')).toBe(false);
  });

  it('retries a failure that plausibly differs on a second attempt', () => {
    expect(isRetryableReviewerFailure('claude CLI exited with code 143')).toBe(true);
    expect(isRetryableReviewerFailure('wrote no valid result file')).toBe(true);
    expect(isRetryableReviewerFailure('ECONNRESET')).toBe(true);
  });
});

describe('pool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await pool([30, 5, 20, 1], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 5, 20, 1]);
  });

  it('actually runs concurrently — this is the whole point', async () => {
    let inFlight = 0;
    let peak = 0;
    await pool(Array.from({ length: 6 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await pool(Array.from({ length: 10 }, (_, i) => i), 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBe(2);
  });

  it('handles an empty list and a limit above the item count', async () => {
    expect(await pool([], 5, async () => 1)).toEqual([]);
    expect(await pool([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });
});
