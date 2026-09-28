import { describe, expect, it } from 'vitest';
import { hostUsageSchema } from '@open-mercato/cezar-contract';

import type { CgroupFacts } from './cgroup-probe.ts';
import {
  composeHostContainer,
  createHostSampler,
  HOST_SAMPLE_STALE_MS,
  type HostCpuTimes,
} from './host-usage.ts';

/**
 * The effective-capacity composition (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, §"One composition, no scope mixing").
 *
 * The matrix below is the spec's own list: quota-only, cpuset-only, memory-only, both, a quota
 * wider than the host, a limit without its value, and no limit at all. Two invariants run through
 * every case - a limit never borrows a host number, and `effectiveCores` is the denominator of
 * `container.cpuPct` so a saturated 8-core host under a 100-core quota reads 100 %.
 */

const HOST_MEMORY = 16 * 1024 ** 3;
const CPU_COUNT = 8;
const HOST_CORES = 8;

const facts = (overrides: Partial<CgroupFacts> = {}): CgroupFacts => ({
  source: 'cgroup-v2',
  ...overrides,
});

describe('composeHostContainer', () => {
  it('emits NOTHING for a usage-only cgroup: the host payload stays byte-identical to v1', () => {
    const composed = composeHostContainer({
      facts: facts({ memUsedBytes: 1024, cpuUsageUs: 2048 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      now: 1_000,
    });
    expect(composed).toEqual({});
  });

  it('composes a quota-only container and derives cpuPct from effective cores', () => {
    const composed = composeHostContainer({
      // One second of wall time with two cores' worth of CPU time booked: `2_000_000 - 1_000_000`
      // microseconds over 1 000 ms.
      facts: facts({ cpuQuotaCores: 2, cpuUsageUs: 2_000_000 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      previousUsage: { cpuUsageUs: 1_000_000, at: 1_000 },
      now: 2_000,
    });
    // One core busy out of a two-core quota = 50 %.
    expect(composed.container).toEqual({ source: 'cgroup-v2', cpuQuotaCores: 2, cpuPct: 50 });
    expect(composed.hostCpuCount).toBe(HOST_CORES);
  });

  it('composes a cpuset-only pin, the `--cpuset-cpus` case where quota and memory read max', () => {
    const composed = composeHostContainer({
      facts: facts({ cpusetCores: 4 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      previousUsage: { cpuUsageUs: 0, at: 1_000 },
      now: 2_000,
    });
    expect(composed.container).toEqual({ source: 'cgroup-v2', cpuAffinityCores: 4 });

    const busy = composeHostContainer({
      facts: facts({ cpusetCores: 2, cpuUsageUs: 6_000_000 }),
      cpuCount: 2,
      hostCpuCount: 24,
      memTotalBytes: HOST_MEMORY,
      previousUsage: { cpuUsageUs: 0, at: 1_000 },
      now: 2_000,
    });
    // A 2-core pin under a 24-core host, where the host itself reports 30-34 % overall: the
    // pinned cores are at 100 %, and that is what the card must read.
    expect(busy.container).toEqual({ source: 'cgroup-v2', cpuAffinityCores: 2, cpuPct: 100 });
    expect(busy.hostCpuCount).toBe(24);
  });

  it('treats a cpuset covering the whole host (or more) as no limit at all', () => {
    expect(
      composeHostContainer({
        facts: facts({ cpusetCores: HOST_CORES }),
        cpuCount: CPU_COUNT,
        hostCpuCount: HOST_CORES,
        memTotalBytes: HOST_MEMORY,
        now: 1_000,
      }),
    ).toEqual({});
  });

  it('composes a memory-only container with the cache-excluded used value paired to the limit', () => {
    const composed = composeHostContainer({
      facts: facts({ memLimitBytes: 2 * 1024 ** 3, memUsedBytes: 1024 ** 3 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      now: 1_000,
    });
    expect(composed.container).toEqual({
      source: 'cgroup-v2',
      memLimitBytes: 2 * 1024 ** 3,
      memUsedBytes: 1024 ** 3,
    });
    expect(composed.container?.cpuPct).toBeUndefined();
  });

  it('never emits an unpaired used value', () => {
    const composed = composeHostContainer({
      facts: facts({ memLimitBytes: 2 * 1024 ** 3 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      now: 1_000,
    });
    expect(composed.container).toEqual({ source: 'cgroup-v2', memLimitBytes: 2 * 1024 ** 3 });
    expect('memUsedBytes' in (composed.container ?? {})).toBe(false);
  });

  it('ignores a memory limit that is not below the host total', () => {
    expect(
      composeHostContainer({
        facts: facts({ memLimitBytes: HOST_MEMORY }),
        cpuCount: CPU_COUNT,
        hostCpuCount: HOST_CORES,
        memTotalBytes: HOST_MEMORY,
        now: 1_000,
      }),
    ).toEqual({});
    expect(
      composeHostContainer({
        facts: facts({ memLimitBytes: 64 * 1024 ** 3 }),
        cpuCount: CPU_COUNT,
        hostCpuCount: HOST_CORES,
        memTotalBytes: HOST_MEMORY,
        now: 1_000,
      }),
    ).toEqual({});
  });

  it('bounds a quota larger than the host: a saturated host reads 100 %, never 8 %', () => {
    const composed = composeHostContainer({
      facts: facts({ cpuQuotaCores: 100, cpuUsageUs: 8_000_000 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      previousUsage: { cpuUsageUs: 0, at: 1_000 },
      now: 2_000,
    });
    expect(composed.container).toEqual({ source: 'cgroup-v2', cpuQuotaCores: 100, cpuPct: 100 });
  });

  it('composes both limits at once, each in its own scope', () => {
    const composed = composeHostContainer({
      facts: facts({
        cpuQuotaCores: 6,
        cpusetCores: 4,
        memLimitBytes: 4 * 1024 ** 3,
        memUsedBytes: 1024 ** 3,
        cpuUsageUs: 2_000_000,
      }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      previousUsage: { cpuUsageUs: 0, at: 1_000 },
      now: 2_000,
    });
    expect(composed.container).toEqual({
      source: 'cgroup-v2',
      cpuQuotaCores: 6,
      cpuAffinityCores: 4,
      memLimitBytes: 4 * 1024 ** 3,
      memUsedBytes: 1024 ** 3,
      // Two cores busy of the tighter 4-core affinity = 50 %, not 33 % of the 6-core quota.
      cpuPct: 50,
    });
  });

  it('omits cpuPct whenever the delta cannot be trusted', () => {
    const base = {
      facts: facts({ cpuQuotaCores: 2, cpuUsageUs: 5_000_000 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: HOST_CORES,
      memTotalBytes: HOST_MEMORY,
      now: 2_000,
    };
    // First tick: no previous read at all.
    expect(composeHostContainer(base).container?.cpuPct).toBeUndefined();
    // Counter reset / unreadable stat: the delta is not a rate.
    expect(
      composeHostContainer({ ...base, previousUsage: { cpuUsageUs: 9_000_000, at: 1_000 } })
        .container?.cpuPct,
    ).toBeUndefined();
    // A gap longer than the sampler's own freshness bound is not a live window either.
    expect(
      composeHostContainer({
        ...base,
        previousUsage: { cpuUsageUs: 5_000_000, at: 2_000 - HOST_SAMPLE_STALE_MS - 1 },
      }).container?.cpuPct,
    ).toBeUndefined();
    // And with no readable usage counter there is nothing to derive a percentage from.
    expect(
      composeHostContainer({
        ...base,
        facts: facts({ cpuQuotaCores: 2 }),
        previousUsage: { cpuUsageUs: 0, at: 1_000 },
      }).container?.cpuPct,
    ).toBeUndefined();
  });

  it('omits hostCpuCount when the host reports no cores', () => {
    const composed = composeHostContainer({
      facts: facts({ cpuQuotaCores: 2 }),
      cpuCount: CPU_COUNT,
      hostCpuCount: 0,
      memTotalBytes: HOST_MEMORY,
      now: 1_000,
    });
    expect(composed.container).toEqual({ source: 'cgroup-v2', cpuQuotaCores: 2 });
    expect(composed.hostCpuCount).toBeUndefined();
  });
});

describe('the sampler with a cgroup probe', () => {
  const cpuTimes: HostCpuTimes = { idle: 1000, total: 2000 };

  it('emits the container object and the host core count together, schema-valid', () => {
    const sampler = createHostSampler({
      cpuTimes: () => cpuTimes,
      readMeminfo: () => undefined,
      cgroupProbe: () => facts({ cpuQuotaCores: 2, cpuUsageUs: 5_000_000 }),
      hostCoreCount: () => HOST_CORES,
      now: () => 1_000,
    });
    const sample = sampler.sampleHostUsage();
    expect(sample.container).toEqual({ source: 'cgroup-v2', cpuQuotaCores: 2 });
    expect(sample.hostCpuCount).toBe(HOST_CORES);
    expect(hostUsageSchema.safeParse(sample).success).toBe(true);
  });

  it('keeps the host-mode payload free of both keys, so v1 consumers see the same bytes', () => {
    const sampler = createHostSampler({
      cpuTimes: () => cpuTimes,
      readMeminfo: () => undefined,
      // `win32` keeps `loadAvg` out of the payload so this test asserts the KEY SET, not the
      // platform: the point is that the two cgroup keys are the only difference from v1.
      platform: 'win32',
      cgroupProbe: () => facts({ memUsedBytes: 4096, cpuUsageUs: 1 }),
      hostCoreCount: () => HOST_CORES,
      now: () => 1_000,
    });
    const sample = sampler.sampleHostUsage();
    expect('container' in sample).toBe(false);
    expect('hostCpuCount' in sample).toBe(false);
    expect(Object.keys(sample).sort()).toEqual(
      [
        'cpuCount',
        'memAvailableBytes',
        'memTotalBytes',
        'memUsedBytes',
        'sampledAt',
      ].sort(),
    );
  });

  it('turns a probe that answers nothing into no container and does not throw', () => {
    const sampler = createHostSampler({
      cpuTimes: () => cpuTimes,
      readMeminfo: () => undefined,
      cgroupProbe: () => undefined,
      now: () => 1_000,
    });
    const sample = sampler.sampleHostUsage();
    expect('container' in sample).toBe(false);
    // "Could not read" is NOT "read and found no limit" (spec review MAJOR): the payload says so,
    // so a consumer never derives a capacity ceiling from an absence it cannot interpret.
    expect(sample.cgroupProbe).toBe('unavailable');
    expect(hostUsageSchema.safeParse(sample).success).toBe(true);
  });

  it('distinguishes "unreadable" from "unconstrained" in the composition itself', () => {
    const base = { cpuCount: CPU_COUNT, hostCpuCount: HOST_CORES, memTotalBytes: HOST_MEMORY, now: 1_000 };
    // The probe could not read anything at all -> an explicit "unknown".
    expect(composeHostContainer({ ...base, facts: undefined })).toEqual({
      cgroupProbe: 'unavailable',
    });
    // The probe read fine and found no finite limit -> nothing at all, the byte-identical v1
    // payload every plain host has always shipped.
    expect(composeHostContainer({ ...base, facts: facts({ memUsedBytes: 1024 }) })).toEqual({});
  });
});
