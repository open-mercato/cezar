import { describe, it, expect } from 'vitest';
import { chunkArray } from '@cezar/core';

describe('chunkArray', () => {
  it('splits array into chunks of given size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns single chunk when size >= array length', () => {
    expect(chunkArray([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it('returns empty array for empty input', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });

  it('handles chunk size of 1', () => {
    expect(chunkArray([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it('handles exact division', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('throws on non-positive size', () => {
    expect(() => chunkArray([1], 0)).toThrow('Chunk size must be positive');
    expect(() => chunkArray([1], -1)).toThrow('Chunk size must be positive');
  });

  it('works with generic types', () => {
    const result = chunkArray(['a', 'b', 'c'], 2);
    expect(result).toEqual([['a', 'b'], ['c']]);
  });
});
