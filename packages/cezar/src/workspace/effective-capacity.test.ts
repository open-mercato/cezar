import { describe, expect, it } from 'vitest';
import type { HostUsage } from '@open-mercato/cezar-contract';
import {
  effectiveCapacity,
  effectiveCores,
  freeFromHost,
  headroomRuns,
  observedPerRun,
  stepScale,
  type CapacityInput,
} from './effective-capacity.ts';
import {
  WorkspaceSemaphore,
  type SemaphoreParticipant,
  type WorkspaceSemaphoreOptions,
} from './semaphore.ts';

const GiB = 1024 ** 3;
const host = (over: Partial<HostUsage> = {}): HostUsage => ({
  sampledAt: new Date(0).toISOString(),
  cpuCount: 8,
  cpuPct: 25,
  memTotalBytes: 32 * GiB,
  memUsedBytes: 16 * GiB,
  memAvailableBytes: 16 * GiB,
  ...over,
});
const base: CapacityInput = {
  configured: { main: 100, subagent: null, review: null },
  busy: { main: 0, subagent: 0, review: 0 },
};

describe('effectiveCapacity (spec 2026-10-21-work-limits)', () => {
  it('returns the configured limits when nothing is readable (fail open)', () => {
    expect(effectiveCapacity(base)).toEqual(base.configured);
  });

  it('is min(configured, busy + floor(min(free mem / mem per run, free cpu / cpu per run)))', () => {
    // 8 GiB free / 2 GiB = 4, 3 cores / 0.5 = 6 -> 4 more; 3 already busy -> 7
    const out = effectiveCapacity({
      ...base,
      busy: { main: 3, subagent: 0, review: 0 },
      freeMemBytes: 8 * GiB,
      freeCpuCores: 3,
      memPerRunBytes: 2 * GiB,
      cpuPerRunCores: 0.5,
    });
    expect(out.main).toBe(7);
  });

  it('never exceeds the configured limit and never drops below one', () => {
    expect(effectiveCapacity({ ...base, configured: { main: 4, subagent: null, review: null }, freeMemBytes: 999 * GiB }).main).toBe(4);
    expect(effectiveCapacity({ ...base, freeMemBytes: 0, freeCpuCores: 0 }).main).toBe(1);
  });

  it('scales a separate pool on its own busy count and leaves unset pools null', () => {
    const out = effectiveCapacity({
      configured: { main: 10, subagent: 50, review: null },
      busy: { main: 2, subagent: 20, review: 0 },
      freeMemBytes: 3 * GiB,
      memPerRunBytes: GiB,
      freeCpuCores: 100,
    });
    // room 3 goes to main first; the sub-agent pool keeps what it already runs
    expect(out).toEqual({ main: 5, subagent: 20, review: null });
  });

  it('allocates the headroom once: the sum of limits never exceeds busy + room (main, review, subagent order)', () => {
    const input: CapacityInput = {
      configured: { main: 10, subagent: 10, review: 10 },
      busy: { main: 1, subagent: 2, review: 0 },
      freeMemBytes: 8 * GiB,
      memPerRunBytes: GiB,
      freeCpuCores: 100,
    }; // room 8
    const out = effectiveCapacity(input);
    expect(out).toEqual({ main: 9, subagent: 2, review: 1 }); // main takes 8; the floor keeps review at 1
    const room = headroomRuns(input)!;
    const second = effectiveCapacity({ ...input, freeMemBytes: 14 * GiB }); // room 14: main 9 + review 5
    expect(second).toEqual({ main: 10, subagent: 2, review: 5 });
    expect(second.main + second.subagent! + second.review!).toBeLessThanOrEqual(3 + 14);
    expect(room).toBe(8);
  });

  it('falls back to 1 GiB and 0.5 core per run when none is observed', () => {
    expect(headroomRuns({ ...base, freeMemBytes: 4 * GiB })).toBe(4);
    expect(headroomRuns({ ...base, freeCpuCores: 2 })).toBe(4);
    expect(observedPerRun({})).toEqual({ memPerRunBytes: GiB, cpuPerRunCores: 0.5 });
  });

  it('averages observed trees; a zero CPU reading (Windows) falls back', () => {
    expect(observedPerRun({ a: { rssBytes: 2 * GiB, cpuPct: 0 }, b: { rssBytes: 4 * GiB, cpuPct: 0 } })).toEqual({
      memPerRunBytes: 3 * GiB,
      cpuPerRunCores: 0.5,
    });
    expect(observedPerRun({ a: { rssBytes: GiB, cpuPct: 50 }, b: { rssBytes: GiB, cpuPct: 150 } }).cpuPerRunCores).toBe(1);
  });
});

describe('free resources from a host sample', () => {
  it('honours a container memory limit and CPU quota, net of the reserve', () => {
    const boxed = host({
      container: { source: 'cgroup-v2', memLimitBytes: 4 * GiB, memUsedBytes: 3 * GiB, cpuQuotaCores: 2, cpuPct: 50 } as HostUsage['container'],
    });
    expect(effectiveCores(boxed)).toBe(2);
    expect(freeFromHost(boxed, 512)).toEqual({ freeMemBytes: 0.5 * GiB, freeCpuCores: 1 });
  });

  it('omits what is unreadable', () => {
    const u = host();
    delete (u as { cpuPct?: number }).cpuPct;
    expect(freeFromHost(u, null)).toEqual({ freeMemBytes: 16 * GiB });
  });
});

describe('stepScale hysteresis', () => {
  it('lowers immediately and raises only after the calm samples', () => {
    expect(stepScale(8, 3, 2)).toEqual({ value: 3, calm: 0 });
    let s = { value: 3, calm: 0 };
    s = stepScale(s.value, 8, s.calm);
    s = stepScale(s.value, 8, s.calm);
    expect(s.value).toBe(3);
    s = stepScale(s.value, 8, s.calm);
    expect(s.value).toBe(8);
  });
});

describe('WorkspaceSemaphore pools and autoScale', () => {
  function rig(initial: NonNullable<WorkspaceSemaphoreOptions['initial']>) {
    let sample: HostUsage | undefined;
    let nowMs = 0;
    let stale = false;
    let agents: Record<string, { rssBytes: number; cpuPct?: number }> = {};
    const listeners = new Set<() => void>();
    const sem = new WorkspaceSemaphore({
      initial,
      host: {
        current: () => sample && { ...sample, sampledAt: new Date(stale ? 0 : nowMs).toISOString() },
        subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
        agentUsage: () => agents,
        subscribeAgents: () => () => undefined,
        now: () => nowMs,
      },
    });
    let busy = { main: 0, subagent: 0, review: 0 };
    let pumps = 0;
    const p: SemaphoreParticipant = {
      busySlots: () => busy.main + busy.subagent + busy.review,
      busyByClass: () => busy,
      oldestQueuedAt: () => null,
      pump: () => {
        pumps += 1;
      },
    };
    sem.register(p);
    return {
      sem,
      tick: () => {
        nowMs += 2_000;
        [...listeners].forEach((l) => l());
      },
      setNow: (n: number) => (nowMs = n),
      setStale: (v: boolean) => (stale = v),
      setSample: (u: HostUsage | undefined) => (sample = u),
      setAgents: (a: typeof agents) => (agents = a),
      setBusy: (b: Partial<typeof busy>) => (busy = { main: 0, subagent: 0, review: 0, ...b }),
      pumps: () => pumps,
    };
  }

  it('classifies a child into its own pool only when that pool is configured', () => {
    const shared = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    expect(shared.classify({ parentRunId: 'p', kind: 'review' })).toBe('main');
    const split = new WorkspaceSemaphore({ initial: { maxParallel: 2, maxSubagents: 8, maxReviewers: 3 } });
    expect(split.classify(undefined)).toBe('main');
    expect(split.classify({ parentRunId: 'p' })).toBe('subagent');
    expect(split.classify({ parentRunId: 'p', kind: 'implement' })).toBe('subagent');
    expect(split.classify({ parentRunId: 'p', kind: 'review' })).toBe('review');
    expect(split.classify({ kind: 'review' })).toBe('main'); // a root is never a child
  });

  it('reports free capacity per pool (limit - busy, never negative); an unset pool shows main', () => {
    const r = rig({ maxParallel: 4, maxReviewers: 2 });
    r.setBusy({ main: 5, review: 1 });
    expect(r.sem.freeCapacity()).toEqual({ main: 0, subagent: 0, review: 1 });
    expect(r.sem.poolHasRoom('review')).toBe(true);
    expect(r.sem.poolHasRoom('main')).toBe(false);
    r.setBusy({ main: 1 });
    expect(r.sem.freeCapacity()).toEqual({ main: 3, subagent: 3, review: 2 });
  });

  it('a stub participant without busyByClass counts as all main', () => {
    const sem = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    sem.register({ busySlots: () => 2, oldestQueuedAt: () => null, pump: () => undefined });
    expect(sem.busyBy()).toEqual({ main: 2, subagent: 0, review: 0 });
    expect(sem.freeCapacity().main).toBe(0);
  });

  it('autoScale off: effective equals configured and nothing is sampled', () => {
    const r = rig({ maxParallel: 10 });
    expect(r.sem.effectiveLimits()).toEqual({ main: 10, subagent: null, review: null });
  });

  it('autoScale lowers at once, raises only after calm samples, and re-pumps when it grows', () => {
    const r = rig({ maxParallel: 20, autoScale: true });
    r.setBusy({ main: 2 });
    // 3 GiB free / 1 GiB fallback = 3 more -> 5
    r.setSample(host({ memAvailableBytes: 3 * GiB }));
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(5);
    expect(r.sem.freeCapacity().main).toBe(3);
    // memory frees up: wants 10 more, but the raise waits for calm samples
    r.setSample(host({ memAvailableBytes: 8 * GiB }));
    r.tick();
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(5);
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(10);
    expect(r.pumps()).toBeGreaterThan(0); // a grown pool wakes the queue
    // pressure returns: immediate cut
    r.setSample(host({ memAvailableBytes: 0 }));
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(2);
  });

  it('autoScale never goes below one and never stops what is running', () => {
    const r = rig({ maxParallel: 20, autoScale: true });
    r.setBusy({ main: 6 });
    r.setSample(host({ memAvailableBytes: 0 }));
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(6); // busy + 0 headroom: running work keeps its slots
    r.setBusy({});
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(1);
  });

  it('autoScale alone brakes starts only when the computed room is nearly gone', () => {
    const roomy = rig({ maxParallel: 100, autoScale: true });
    roomy.setBusy({ main: 1 });
    roomy.setSample(host({ memAvailableBytes: 40 * GiB }));
    roomy.tick();
    for (let i = 0; i < 5; i++) {
      expect(roomy.sem.hostAdmits()).toBe(true);
      roomy.sem.noteGatedStart();
    }
    const tight = rig({ maxParallel: 100, autoScale: true });
    tight.setBusy({ main: 1 });
    tight.setSample(host({ memAvailableBytes: 1 * GiB })); // room 1
    tight.tick();
    expect(tight.sem.hostAdmits()).toBe(true);
    tight.sem.noteGatedStart();
    expect(tight.sem.hostAdmits()).toBe(false);
    tight.tick();
    expect(tight.sem.hostAdmits()).toBe(true);
  });

  it('a lowered limit does not stick when the sampler goes quiet', () => {
    const r = rig({ maxParallel: 20, autoScale: true });
    r.setSample(host({ memAvailableBytes: 0 }));
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(1);
    r.setNow(60_000); // no further ticks
    expect(r.sem.effectiveLimits().main).toBe(20);
  });

  it('a config change re-bases the limit on the current headroom instead of waiting for calm samples', async () => {
    let configured = 4;
    const r = rig({ maxParallel: 4, autoScale: true });
    r.setSample(host({ memAvailableBytes: 30 * GiB }));
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(4);
    const sem = new WorkspaceSemaphore({
      load: async () => ({ maxParallel: configured, memoryLimitMb: null, autoScale: true }),
      initial: { maxParallel: 4, autoScale: true },
      host: {
        current: () => host({ memAvailableBytes: 30 * GiB, sampledAt: new Date(0).toISOString() }),
        subscribe: () => () => undefined,
        agentUsage: () => ({}),
        subscribeAgents: () => () => undefined,
        now: () => 0,
      },
    });
    configured = 20;
    await sem.refresh();
    expect(sem.effectiveLimits().main).toBe(12); // headroom (6 free cores / 0.5), not 4 for three more samples
    sem.dispose();
  });

  it('autoScale fails open to the configured limits when telemetry is missing', () => {
    const r = rig({ maxParallel: 20, autoScale: true });
    r.setSample(host({ memAvailableBytes: 0 }));
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(1);
    r.setSample(undefined);
    r.tick();
    expect(r.sem.effectiveLimits().main).toBe(20);
  });
});
