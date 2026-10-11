import { describe, expect, it } from 'vitest';
import { createHostProbeCache } from './host-probe-cache.ts';

function harness(ttlMs = 1_000, maxStaleMs = Number.POSITIVE_INFINITY) {
  let clock = 0;
  let calls = 0;
  const pending: ((value: number) => void)[] = [];
  const cache = createHostProbeCache(
    () => {
      calls++;
      return new Promise<number>((resolve) => pending.push(resolve));
    },
    ttlMs,
    { now: () => clock, maxStaleMs },
  );
  return {
    cache,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
    resolveNext: async (value: number) => {
      pending.shift()?.(value);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('createHostProbeCache', () => {
  it('a cold read waits, concurrent cold reads share one compute', async () => {
    const h = harness();
    const a = h.cache.get();
    const b = h.cache.get();
    expect(h.calls()).toBe(1);
    await h.resolveNext(1);
    expect(await a).toBe(1);
    expect(await b).toBe(1);
  });

  it('inside the TTL a read answers from cache with no compute', async () => {
    const h = harness();
    const first = h.cache.get();
    await h.resolveNext(1);
    await first;
    h.advance(999);
    expect(await h.cache.get()).toBe(1);
    expect(h.calls()).toBe(1);
  });

  it('past the TTL a read answers stale and revalidates behind it, once', async () => {
    const h = harness();
    const first = h.cache.get();
    await h.resolveNext(1);
    await first;
    h.advance(1_000);
    expect(await h.cache.get()).toBe(1);
    expect(await h.cache.get()).toBe(1);
    expect(h.calls()).toBe(2);
    await h.resolveNext(2);
    expect(await h.cache.get()).toBe(2);
  });

  it('seed adopts a running compute instead of starting another', async () => {
    const h = harness();
    let resolveSeed: (v: number) => void = () => {};
    h.cache.seed(new Promise<number>((resolve) => (resolveSeed = resolve)));
    const read = h.cache.get();
    resolveSeed(7);
    expect(await read).toBe(7);
    expect(h.calls()).toBe(0);
  });

  it('invalidate makes the next read wait for a fresh compute and drops a late older answer', async () => {
    const h = harness();
    const first = h.cache.get();
    h.cache.invalidate();
    const second = h.cache.get();
    expect(h.calls()).toBe(2);
    await h.resolveNext(1);
    await first;
    await h.resolveNext(2);
    expect(await second).toBe(2);
    expect(await h.cache.get()).toBe(2);
  });

  it('a failed compute is not cached', async () => {
    let calls = 0;
    const cache = createHostProbeCache(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 5;
    }, 1_000, { maxStaleMs: Number.POSITIVE_INFINITY });
    await expect(cache.get()).rejects.toThrow('boom');
    expect(await cache.get()).toBe(5);
  });

  it('past the ceiling a read waits for the recompute instead of answering stale', async () => {
    const h = harness(1_000, 5_000);
    const first = h.cache.get();
    await h.resolveNext(1);
    await first;
    h.advance(5_000);
    const read = h.cache.get();
    // Not resolved from cache: it is waiting on the fresh compute.
    expect(h.calls()).toBe(2);
    await h.resolveNext(2);
    expect(await read).toBe(2);
  });

  it('between the TTL and the ceiling a read still answers stale and revalidates behind it', async () => {
    const h = harness(1_000, 5_000);
    const first = h.cache.get();
    await h.resolveNext(1);
    await first;
    h.advance(1_000);
    expect(await h.cache.get()).toBe(1);
    expect(h.calls()).toBe(2);
  });

  it('a failed revalidation keeps the last value and defers the next attempt by a full TTL', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createHostProbeCache(
      async () => {
        calls++;
        if (calls >= 2) throw new Error('boom');
        return 1;
      },
      1_000,
      { now: () => clock, maxStaleMs: Number.POSITIVE_INFINITY },
    );
    expect(await cache.get()).toBe(1);
    clock += 1_000;
    expect(await cache.get()).toBe(1); // stale served, revalidation fails behind
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the rejection settle
    clock += 999;
    expect(await cache.get()).toBe(1);
    expect(calls).toBe(2);
  });
});
