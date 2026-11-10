import { describe, expect, it } from 'vitest';
import { FILESYSTEM_LISTING_CONCURRENCY, mapWithConcurrency } from './concurrency.ts';

describe('mapWithConcurrency', () => {
  it('preserves order while overlapping work up to the limit', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value === 0 ? 20 : 1));
      active -= 1;
      return value * 2;
    });
    expect(result).toEqual([0, 2, 4, 6]);
    expect(peak).toBe(2);
  });

  it('returns immediately for empty input and rejects invalid limits', async () => {
    await expect(mapWithConcurrency([], 16, async (value: never) => value)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow('positive integer');
  });

  it('never exceeds the fixed listing budget of sixteen workers', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), FILESYSTEM_LISTING_CONCURRENCY, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      active -= 1;
      return value;
    });
    expect(result).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(peak).toBe(FILESYSTEM_LISTING_CONCURRENCY);
  });
});
