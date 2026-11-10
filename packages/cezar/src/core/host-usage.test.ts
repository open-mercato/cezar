import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostUsageSchema } from '@open-mercato/cezar-contract';
import {
  createHostSampler,
  HOST_SAMPLE_INTERVAL_MS,
  HOST_SAMPLE_STALE_MS,
  parseDarwinSwap,
  parseVmStatAvailable,
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

/** `vm_stat` as macOS prints it, trimmed to the counts the parser reads plus two it must ignore. */
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                              128643.',
  'Pages inactive:                          947101.',
  'Pages wired down:                           200.',
  'Pages purgeable:                            100.',
  '"Translation faults":               68799011039.',
  'File-backed pages:                       738010.',
  'Anonymous pages:                           1000.',
  'Pages occupied by compressor:               300.',
].join('\n');
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
      platform: 'linux',
      readMeminfo: () => SWAP_MEMINFO,
      now,
    }).sampleHostUsage();
    expect(withSwap.swapTotalBytes).toBe(8192 * 1024);
    expect(withSwap.swapUsedBytes).toBe((8192 - 1024) * 1024);

    const noSwap = createHostSampler({
      cpuTimes: probe.source,
      platform: 'linux',
      readMeminfo: () => 'MemTotal: 32768 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB',
      now,
    }).sampleHostUsage();
    expect(noSwap.swapTotalBytes).toBeUndefined();
    expect(noSwap.swapUsedBytes).toBeUndefined();

    const unreadable = createHostSampler({
      cpuTimes: probe.source,
      platform: 'linux',
      readMeminfo: () => undefined,
      now,
    }).sampleHostUsage();
    expect(unreadable.swapTotalBytes).toBeUndefined();
    expect(unreadable.swapUsedBytes).toBeUndefined();
  });

  it('counts macOS memory the way Activity Monitor does, not as total minus the free list', () => {
    const probe = cpuTimesProbe();
    const darwin = createHostSampler({
      cpuTimes: probe.source,
      platform: 'darwin',
      readVmStat: () => VM_STAT,
      readSwapUsage: () => 'total = 6144.00M  used = 4449.25M  free = 1694.75M  (encrypted)',
      now,
    }).sampleHostUsage();
    // App (1000 − 100) + wired 200 + compressor 300 pages; free/inactive/file-backed are reclaimable.
    expect(darwin.memUsedBytes).toBe(1400 * 16384);
    expect(darwin.memAvailableBytes).toBe(darwin.memTotalBytes - 1400 * 16384);
    expect(darwin.swapTotalBytes).toBe(6144 * 1024 ** 2);
    expect(darwin.swapUsedBytes).toBe(Math.round(4449.25 * 1024 ** 2));
    expect(hostUsageSchema.safeParse(darwin).success).toBe(true);

    // A darwin sampler never reads /proc/meminfo, and a Linux one never runs vm_stat.
    const linux = createHostSampler({
      cpuTimes: probe.source,
      platform: 'linux',
      readVmStat: () => VM_STAT,
      readMeminfo: () => undefined,
      now,
    }).sampleHostUsage();
    expect(linux.memUsedBytes).not.toBe(1400 * 16384);
  });

  it('parses vm_stat defensively and falls back when a count is missing', () => {
    expect(parseVmStatAvailable(VM_STAT, 1400 * 16384 * 4)).toBe(1400 * 16384 * 3);
    // More used than total (a racing read) clamps at zero available, never negative.
    expect(parseVmStatAvailable(VM_STAT, 1000)).toBe(0);
    expect(parseVmStatAvailable(VM_STAT.replace(/^Anonymous pages:.*$/m, ''), 1e12)).toBeUndefined();
    expect(parseVmStatAvailable('garbage', 1e12)).toBeUndefined();
    expect(parseVmStatAvailable(undefined, 1e12)).toBeUndefined();

    expect(parseDarwinSwap('total = 0.00M  used = 0.00M  free = 0.00M')).toBeUndefined();
    expect(parseDarwinSwap('total = 2.00G  used = 512.00M  free = 1.50G')).toEqual({
      totalBytes: 2 * 1024 ** 3,
      usedBytes: 512 * 1024 ** 2,
    });
    expect(parseDarwinSwap(undefined)).toBeUndefined();

    // An unreadable vm_stat keeps the os reading rather than dropping the memory fields.
    const fallback = createHostSampler({
      cpuTimes: cpuTimesProbe().source,
      platform: 'darwin',
      readVmStat: () => undefined,
      readSwapUsage: () => undefined,
      now,
    }).sampleHostUsage();
    expect(fallback.memAvailableBytes).toBeGreaterThan(0);
    expect(fallback.memUsedBytes + fallback.memAvailableBytes).toBe(fallback.memTotalBytes);
    expect(fallback.swapTotalBytes).toBeUndefined();
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

  it('keeps sampling for one stale window after a route read, so a polling reader gets real deltas', () => {
    vi.useFakeTimers();
    const probe = cpuTimesProbe();
    const sampler = createHostSampler({
      cpuTimes: probe.source,
      readMeminfo: () => undefined,
      now: () => Date.now(),
    });

    expect(sampler.sampleHostUsage().cpuPct).toBeUndefined(); // the first read only primes
    sampler.keepWarm();
    for (let poll = 0; poll < 3; poll += 1) {
      probe.advance({ idle: 500, busy: 500 });
      vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
      const read = sampler.sampleHostUsage();
      sampler.keepWarm();
      expect(read.cpuPct).toBe(50);
      expect(read.sampledAt).toBe(new Date(Date.now()).toISOString()); // the tick's, not a replay
    }

    // A subscriber joining a warm timer must not start a second interval or re-prime it.
    const listener = vi.fn();
    const stop = sampler.onHostUsage(listener);
    expect(vi.getTimerCount()).toBe(2); // the interval + the warm lease
    probe.advance({ idle: 500, busy: 500 });
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ cpuPct: 50 });
    stop();

    // The lease outlives the subscriber; once it lapses unrenewed, the timer stops on its own.
    vi.advanceTimersByTime(HOST_SAMPLE_STALE_MS);
    expect(vi.getTimerCount()).toBe(0);
    sampler.dispose();
  });

  it('keeps the stale bound at three sampling intervals', () => {
    expect(HOST_SAMPLE_STALE_MS).toBe(3 * HOST_SAMPLE_INTERVAL_MS);
  });

  it('survives a throwing tick: the interval keeps going and the next read publishes', () => {
    vi.useFakeTimers();
    const probe = cpuTimesProbe();
    let calls = 0;
    const sampler = createHostSampler({
      cpuTimes: () => {
        calls += 1;
        // The prime (1) is fine; the first timer tick (2) throws - a /proc file that vanished
        // mid-read, a probe that hiccuped. Before the fix that exception escaped the timer
        // callback and took the whole cockpit down.
        if (calls === 2) throw new Error('boom');
        return probe.source();
      },
      readMeminfo: () => undefined,
      now: () => Date.now(),
    });
    const listener = vi.fn();
    const stop = sampler.onHostUsage(listener);

    probe.advance({ idle: 600, busy: 400 });
    expect(() => vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();

    // The next tick re-reads and publishes a real delta (two intervals of 40 % busy).
    probe.advance({ idle: 600, busy: 400 });
    vi.advanceTimersByTime(HOST_SAMPLE_INTERVAL_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ cpuPct: 40 });

    stop();
    sampler.dispose();
  });
});
