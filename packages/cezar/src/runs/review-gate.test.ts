import { afterEach, describe, expect, it } from 'vitest';
import { assessedWithoutChanges, diffHasChanges, reviewGateEnabled } from './review-gate.ts';

describe('reviewGateEnabled', () => {
  const saved = process.env.CEZ_REVIEW_GATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_REVIEW_GATE;
    else process.env.CEZ_REVIEW_GATE = saved;
  });

  it('defaults OFF (the deliberate inverse of liveTitleUpdates, #489)', () => {
    delete process.env.CEZ_REVIEW_GATE;
    expect(reviewGateEnabled({})).toBe(false);
  });

  it('the env default turns it on with exactly "1"', () => {
    expect(reviewGateEnabled({}, { CEZ_REVIEW_GATE: '1' })).toBe(true);
    expect(reviewGateEnabled({}, { CEZ_REVIEW_GATE: '0' })).toBe(false);
    // Malformed truthy strings are OFF — only '1' enables.
    expect(reviewGateEnabled({}, { CEZ_REVIEW_GATE: 'true' })).toBe(false);
    expect(reviewGateEnabled({}, { CEZ_REVIEW_GATE: 'yes' })).toBe(false);
    expect(reviewGateEnabled({}, {})).toBe(false);
  });

  it('the Settings toggle (config) wins over the env in both directions', () => {
    expect(reviewGateEnabled({ reviewGate: true }, {})).toBe(true);
    expect(reviewGateEnabled({ reviewGate: false }, { CEZ_REVIEW_GATE: '1' })).toBe(false);
    expect(reviewGateEnabled({ reviewGate: true }, { CEZ_REVIEW_GATE: '0' })).toBe(true);
  });
});

describe('assessedWithoutChanges (spec 2026-10-22 Q11)', () => {
  it('is true only for a run with a subject and no changes', () => {
    const subject = { kind: 'spec', path: '.ai/specs/x.md', blobSha: 'b' };
    expect(assessedWithoutChanges({ subject }, '')).toBe(true);
    expect(assessedWithoutChanges({ subject }, '  \n')).toBe(true);
    expect(assessedWithoutChanges({ subject }, '(diff failed: no base)')).toBe(true);
    expect(assessedWithoutChanges({ subject }, 'diff --git a/x b/x\n')).toBe(false);
    expect(assessedWithoutChanges({}, '')).toBe(false);
  });

  it('diffHasChanges ignores an empty or failed diff', () => {
    expect(diffHasChanges('')).toBe(false);
    expect(diffHasChanges('(diff failed: x)')).toBe(false);
    expect(diffHasChanges('diff --git a/x b/x')).toBe(true);
  });
});
