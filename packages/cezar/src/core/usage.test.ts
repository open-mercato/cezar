import { describe, expect, it } from 'vitest';

import { CACHE_CREATION_WEIGHT, CACHE_READ_WEIGHT, costWeightedTokens, type RawUsage } from './usage.ts';

describe('costWeightedTokens', () => {
  describe('absent or empty usage', () => {
    it.each([
      { name: 'undefined', usage: undefined },
      { name: 'null', usage: null },
      { name: 'empty record', usage: {} },
    ])('$name → 0', ({ usage }) => {
      expect(costWeightedTokens(usage)).toBe(0);
    });
  });

  describe('per-field weighting', () => {
    it.each<{ name: string; usage: RawUsage; expected: number }>([
      { name: 'input tokens count at face value', usage: { input_tokens: 1000 }, expected: 1000 },
      { name: 'output tokens count at face value', usage: { output_tokens: 250 }, expected: 250 },
      // Cache reads bill at ~10% of standard input, so 1000 read tokens cost as much as 100 input tokens.
      { name: 'cache reads are discounted', usage: { cache_read_input_tokens: 1000 }, expected: 100 },
      // Cache creation bills at ~125% — writing the cache costs more than a plain input token.
      { name: 'cache creation is surcharged', usage: { cache_creation_input_tokens: 1000 }, expected: 1250 },
    ])('$name', ({ usage, expected }) => {
      expect(costWeightedTokens(usage)).toBe(expected);
    });
  });

  it('sums every field into one weighted count', () => {
    const usage: RawUsage = {
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 8000,
    };

    // 500 input + 200 output + 400 * 1.25 cache creation + 8000 * 0.1 cache read
    expect(costWeightedTokens(usage)).toBe(500 + 200 + 500 + 800);
  });

  it('ignores fields the stream omits rather than treating them as NaN', () => {
    expect(costWeightedTokens({ input_tokens: 10, cache_read_input_tokens: 20 })).toBe(12);
  });

  describe('rounding — the result is always a whole token count', () => {
    it.each<{ name: string; usage: RawUsage; expected: number }>([
      { name: 'rounds a fractional cache read up', usage: { cache_read_input_tokens: 15 }, expected: 2 },
      { name: 'rounds a fractional cache read down', usage: { cache_read_input_tokens: 14 }, expected: 1 },
      { name: 'rounds a fractional cache creation', usage: { cache_creation_input_tokens: 3 }, expected: 4 },
      // Rounding happens once on the total, not per field: 0.1 + 0.25 = 0.35 → 0, not 0 + 0.
      { name: 'rounds the total, not each term', usage: { cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }, expected: 3 },
    ])('$name', ({ usage, expected }) => {
      expect(costWeightedTokens(usage)).toBe(expected);
    });
  });

  it('exposes the weights it applies', () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1);
    expect(CACHE_CREATION_WEIGHT).toBe(1.25);
    expect(costWeightedTokens({ cache_read_input_tokens: 100 })).toBe(Math.round(100 * CACHE_READ_WEIGHT));
    expect(costWeightedTokens({ cache_creation_input_tokens: 100 })).toBe(Math.round(100 * CACHE_CREATION_WEIGHT));
  });
});
