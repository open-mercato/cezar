import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostUsageSchema } from '@open-mercato/cezar-contract';
import {
  createHostSampler,
  HOST_SAMPLE_INTERVAL_MS,
  HOST_SAMPLE_STALE_MS,
  type HostCpuTimes,
} from './host-usage.ts';

/**
 * The contract half of the host-telemetry suite (spec
 * `.ai/specs/2026-09-20-host-resource-telemetry.md`): every optional field describes a fact the
 * OS may not expose, so "absent" has to survive both directions — parsing and serialization.
 * The sampler's own behavior is covered further down this file.
 */
describe('hostUsageSchema', () => {
  it('accepts a minimal sample with every optional key absent', () => {
    const minimal = {
      sampledAt: '2026-09-20T00:00:00.000Z',
      cpuCount: 8,
      memTotalBytes: 32 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
      memAvailableBytes: 20 * 1024 ** 3,
    };

    const parsed = hostUsageSchema.parse(minimal);
    expect(parsed).toEqual(minimal);
    // Both directions: nothing gained, nothing dropped — absent stays absent on the wire, so a
    // client can tell "the OS does not expose swap" from "swap is zero".
    expect(Object.keys(JSON.parse(JSON.stringify(parsed))).sort()).toEqual(Object.keys(minimal).sort());
  });

  it('accepts a full sample and round-trips every optional key', () => {
    const full = {
      sampledAt: '2026-09-20T00:00:02.000Z',
      cpuPct: 38.4,
      cpuCount: 4,
      memTotalBytes: 32 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
      memAvailableBytes: 20 * 1024 ** 3,
      swapTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 1024 ** 3,
      loadAvg: { one: 1.42, five: 0.98, fifteen: 0.76 },
    };

    const parsed = hostUsageSchema.parse(full);
    expect(parsed).toEqual(full);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(full);
  });

  it('rejects numbers the card could not render honestly', () => {
    const base = {
      sampledAt: '2026-09-20T00:00:00.000Z',
      cpuCount: 4,
      memTotalBytes: 1,
      memUsedBytes: 0,
      memAvailableBytes: 1,
    };

    expect(hostUsageSchema.safeParse({ ...base, cpuPct: 101 }).success).toBe(false);
    expect(hostUsageSchema.safeParse({ ...base, cpuPct: -0.5 }).success).toBe(false);
    expect(hostUsageSchema.safeParse({ ...base, cpuCount: 0 }).success).toBe(false);
    expect(hostUsageSchema.safeParse({ ...base, memUsedBytes: -1 }).success).toBe(false);
  });
});

/** A controllable CPU-times source: `advance` bumps idle+busy by the given core-milliseconds. */
function cpuTimesProbe(initial: HostCpuTimes = { idle: 0, total: 0 }) {
  let current = initial;
  return {
    source: () => current,
    advance: ({ idle = 0, busy = 0 }: { idle?: number; busy?: number }) => {
      current = { idle: current.idle + idle, total: current.total + idle + busy };
    },
    reset: (next: HostCpuTimes) => {
      current = next;
    },
  };
}

const SWAP_MEMINFO = ['MemTotal:       32768 kB', 'SwapTotal:       8192 kB', 'SwapFree:        1024 kB'].join('\n');

describe('host sampler', () => {
  let nowMs = 1_700_000_000_000;
  const now = (): number => nowMs;

  afterEach(() => {
    vi.useRealTimers();
    nowMs = 1_700_000_000_000;
  });

  it('primes the CPU baseline on the first read and reports no cpuPct until a second capture', () => {
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({ cpuTimes: probe.source, readMeminfo: () => undefined, now });

    const first = sampler.sampleHostUsage();
    expect(first.cpuPct).toBeUndefined();
    expect(first.memTotalBytes).toBeGreaterThan(0);
    expect(first.cpuCount).toBeGreaterThanOrEqual(1);
    expect(hostUsageSchema.safeParse(first).success).toBe(true);

    nowMs += 1_000;
    probe.advance({ idle: 700, busy: 300 });
    const second = sampler.sampleHostUsage();
    expect(second.cpuPct).toBe(30);
    sampler.dispose();
  });

  it('never fabricates a cpuPct from the hub\u2019s start-then-snapshot order (review BLOCKER)', () => {
    // The hub registers `start(onHostUsage)` and `snapshot(sampleHostUsage)` and calls them back to
    // back, so the 0\u21921 prime and the snapshot's own `os.cpus()` read are milliseconds apart. A
    // single CPU tick inside that window used to compute 50 % or 100 % - the red bar on a card that
    // is supposed to show `sampling\u2026`. A minimum window makes the order irrelevant.
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({ cpuTimes: probe.source, readMeminfo: () => undefined, now });

    const stop = sampler.onHostUsage(() => {});
    try {
      // One CPU tick lands inside the millisecond window - the worst case.
      probe.advance({ busy: 10 });
      expect(sampler.sampleHostUsage().cpuPct).toBeUndefined();
      // …and it stays absent on a second immediate read for the same reason.
      expect(sampler.sampleHostUsage().cpuPct).toBeUndefined();
      // A REAL interval later the delta is honest again.
      nowMs += HOST_SAMPLE_INTERVAL_MS;
      probe.advance({ busy: 1_000 });
      // A full interval, all of it busy in the synthetic counter: 1000 / 1000 = 100 %.
      expect(sampler.sampleHostUsage().cpuPct).toBe(100);
    } finally {
      stop();
    }
    sampler.dispose();
  });

  it('returns the cached sample while it is fresh and carries cpuPct', () => {
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({ cpuTimes: probe.source, readMeminfo: () => undefined, now });
    sampler.sampleHostUsage(); // prime
    nowMs += 1_000;
    probe.advance({ idle: 500, busy: 500 });
    const first = sampler.sampleHostUsage();
    expect(first.cpuPct).toBe(50);

    // A read inside the stale window is a pure read: same object, no new capture consumed.
    nowMs += 500;
    const cached = sampler.sampleHostUsage();
    expect(cached).toBe(first);
    expect(sampler.currentHostUsage()).toBe(first);
    sampler.dispose();
  });

  it('drops a stale baseline instead of averaging over the gap, then re-arms', () => {
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({ cpuTimes: probe.source, readMeminfo: () => undefined, now });
    sampler.sampleHostUsage();
    nowMs += 2_000;
    probe.advance({ idle: 1_000, busy: 1_000 });
    expect(sampler.sampleHostUsage().cpuPct).toBe(50);

    // An hour later the old numbers must not be presented as a live gauge.
    nowMs += 60 * 60 * 1_000;
    probe.advance({ idle: 3_600_000, busy: 3_600_000 });
    const afterGap = sampler.sampleHostUsage();
    expect(afterGap.cpuPct).toBeUndefined();
    expect(afterGap.sampledAt).toBe(new Date(nowMs).toISOString());

    // …and a warm-up read inside the window measures a real delta again.
    nowMs += 2_500;
    probe.advance({ idle: 2_500, busy: 2_500 });
    expect(sampler.sampleHostUsage().cpuPct).toBe(50);
    sampler.dispose();
  });

  it('omits cpuPct on a zero or reset delta and clamps impossible ratios', () => {
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({ cpuTimes: probe.source, readMeminfo: () => undefined, now });
    sampler.sampleHostUsage();

    nowMs += 2_000;
    expect(sampler.sampleHostUsage().cpuPct).toBeUndefined(); // counters did not move

    // Busy delta larger than the total delta (counter reset / clock weirdness) clamps to 100,
    // never above it; a shrinking total is treated as no measurement at all.
    nowMs += 2_000;
    probe.reset({ idle: 0, total: -500 });
    expect(sampler.sampleHostUsage().cpuPct).toBeUndefined();
    nowMs += 2_000;
    probe.advance({ idle: 0, busy: 4_000 });
    expect(sampler.sampleHostUsage().cpuPct).toBe(100);
    sampler.dispose();
  });

  it('reads swap from /proc/meminfo and omits it when there is none or it is unreadable', () => {
    const probe = cpuTimesProbe();
    const withSwap = createHostSampler({
      cpuTimes: probe.source,
      readMeminfo: () => SWAP_MEMINFO,
      now,
    }).sampleHostUsage();
    expect(withSwap.swapTotalBytes).toBe(8192 * 1024);
    expect(withSwap.swapUsedBytes).toBe((8192 - 1024) * 1024);

    const noSwap = createHostSampler({
      cpuTimes: probe.source,
      readMeminfo: () => 'MemTotal: 32768 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB',
      now,
    }).sampleHostUsage();
    expect(noSwap.swapTotalBytes).toBeUndefined();
    expect(noSwap.swapUsedBytes).toBeUndefined();

    const unreadable = createHostSampler({
      cpuTimes: probe.source,
      readMeminfo: () => undefined,
      now,
    }).sampleHostUsage();
    expect(unreadable.swapTotalBytes).toBeUndefined();
    expect(unreadable.swapUsedBytes).toBeUndefined();
  });

  it('omits loadAvg on Windows and carries it elsewhere', () => {
    const probe = cpuTimesProbe();
    const windows = createHostSampler({
      cpuTimes: probe.source,
      platform: 'win32',
      now,
    }).sampleHostUsage();
    expect(windows.loadAvg).toBeUndefined();

    const linux = createHostSampler({
      cpuTimes: probe.source,
      platform: 'linux',
      now,
    }).sampleHostUsage();
    expect(linux.loadAvg).toEqual({
      one: expect.any(Number),
      five: expect.any(Number),
      fifteen: expect.any(Number),
    });
    // The DEFAULT swap reader is platform-gated too. On a host with swap configured this is the
    // differential that proves it (Windows-label sample: no swap; Linux-label sample: swap); on a
    // swapless host — like a CI container — both are legitimately absent and only the invariant
    // below can be asserted.
    expect(windows.swapTotalBytes).toBeUndefined();
    if (linux.swapTotalBytes !== undefined) {
      expect(linux.swapTotalBytes).toBeGreaterThan(0);
    }
  });

  it('runs one timer for the first listener, publishes each tick, and stops on the last unsubscribe', () => {
    vi.useFakeTimers();
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({
      cpuTimes: probe.source,
      readMeminfo: () => undefined,
      now: () => Date.now(),
    });
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = sampler.onHostUsage(first);
    const stopSecond = sampler.onHostUsage(second);
    expect(sampler.currentHostUsage()).toBeUndefined(); // priming is not a sample

    probe.advance({ idle: 600, busy: 400 });
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0]).toMatchObject({ cpuPct: 40 });

    stopSecond();
    probe.advance({ idle: 600, busy: 400 });
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    probe.advance({ idle: 600, busy: 400 });
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS * 5);
    expect(first).toHaveBeenCalledTimes(2); // no timer after the last unsubscribe
    expect(vi.getTimerCount()).toBe(0);
    sampler.dispose();
  });

  it('keeps the stale bound at three sampling intervals', () => {
    expect(HOST_SAMPLE_STALE_MS).toBe(3 * HOST_SAMPLE_INTERVAL_MS);
  });
});
