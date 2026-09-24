import { afterEach, describe, expect, it } from 'vitest';
import { reviewGateEnabled } from './review-gate.ts';

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
