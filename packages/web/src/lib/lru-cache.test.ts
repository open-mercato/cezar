import { describe, expect, it } from 'vitest'

import { LruCache } from './lru-cache'

describe('LruCache', () => {
  it('evicts the least recently used entry past the entry cap', () => {
    const cache = new LruCache<string, number>(2, 100)
    cache.set('a', 1, 1)
    cache.set('b', 2, 1)
    expect(cache.get('a')).toBe(1) // a is now the most recent
    cache.set('c', 3, 1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
  })

  it('evicts by total size, and never stores a value larger than the cap', () => {
    const cache = new LruCache<string, string>(10, 10)
    cache.set('a', 'x', 6)
    cache.set('b', 'y', 6)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.totalSize).toBe(6)
    cache.set('huge', 'z', 11)
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('b')).toBe('y')
  })

  it('replacing or deleting a key keeps the size accounting exact', () => {
    const cache = new LruCache<string, string>(10, 10)
    cache.set('a', 'x', 4)
    cache.set('a', 'y', 3)
    expect(cache.totalSize).toBe(3)
    cache.delete('a')
    expect(cache.totalSize).toBe(0)
    expect(cache.size).toBe(0)
  })
})
