/**
 * A small LRU bounded by entry count AND a caller-defined total size, so one huge value
 * cannot pin memory and many small ones cannot either. A value larger than `maxSize` is
 * never stored. Insertion order of a `Map` is the recency order.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>()
  private total = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxSize: number,
  ) {}

  get size(): number {
    return this.map.size
  }

  get totalSize(): number {
    return this.total
  }

  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: K, value: V, size: number): void {
    this.delete(key)
    if (size > this.maxSize) return
    this.map.set(key, { value, size })
    this.total += size
    for (const [oldest, entry] of this.map) {
      if (this.map.size <= this.maxEntries && this.total <= this.maxSize) break
      this.map.delete(oldest)
      this.total -= entry.size
    }
  }

  delete(key: K): void {
    const hit = this.map.get(key)
    if (!hit) return
    this.map.delete(key)
    this.total -= hit.size
  }

  clear(): void {
    this.map.clear()
    this.total = 0
  }
}
