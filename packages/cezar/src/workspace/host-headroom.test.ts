import { describe, expect, it } from 'vitest';
import type { HostUsage } from '@open-mercato/cezar-contract';
import {
  WorkspaceSemaphore,
  type SemaphoreParticipant,
  type WorkspaceResourceLimits,
  type WorkspaceSemaphoreOptions,
} from './semaphore.ts';
import { agentMemoryBlock, hostReserveBlock } from './host-headroom.ts';

const MB = 1024 * 1024;
const usage = (over: Partial<HostUsage> = {}): HostUsage => ({
  sampledAt: new Date(0).toISOString(),
  cpuCount: 8,
  memTotalBytes: 16 * 1024 * MB,
  memUsedBytes: 0,
  memAvailableBytes: 8 * 1024 * MB,
  ...over,
});

describe('hostReserveBlock', () => {
  it('admits when no guard is configured or telemetry is missing (fail open)', () => {
    expect(hostReserveBlock({ memoryMb: null, cpuPct: null }, usage({ memAvailableBytes: 1 }))).toBeNull();
    expect(hostReserveBlock({ memoryMb: 4096, cpuPct: 50 }, undefined)).toBeNull();
    // cpuPct is absent until a delta window exists: an unreadable figure never blocks
    expect(hostReserveBlock({ memoryMb: null, cpuPct: 50 }, usage())).toBeNull();
  });

  it('blocks below the memory floor and above the CPU ceiling', () => {
    expect(hostReserveBlock({ memoryMb: 4096, cpuPct: null }, usage({ memAvailableBytes: 1024 * MB }))).toMatch(
      /1024 MiB free/,
    );
    expect(hostReserveBlock({ memoryMb: null, cpuPct: 80 }, usage({ cpuPct: 95 }))).toMatch(/95%/);
    expect(hostReserveBlock({ memoryMb: 1024, cpuPct: 80 }, usage({ cpuPct: 40 }))).toBeNull();
  });

  it('measures memory against the container limit when one exists', () => {
    const inBox = usage({
      container: { source: 'cgroup-v2', memLimitBytes: 2048 * MB, memUsedBytes: 1800 * MB } as HostUsage['container'],
    });
    expect(hostReserveBlock({ memoryMb: 1024, cpuPct: null }, inBox)).toMatch(/248 MiB free/);
  });
});

describe('agentMemoryBlock', () => {
  it('sums every tree and blocks at the limit; empty input admits', () => {
    expect(agentMemoryBlock(null, { a: { rssBytes: 99 * 1024 * MB } })).toBeNull();
    expect(agentMemoryBlock(1000, {})).toBeNull();
    expect(agentMemoryBlock(1000, { a: { rssBytes: 600 * MB }, b: { rssBytes: 400 * MB } })).toMatch(/1000 MiB/);
    expect(agentMemoryBlock(1000, { a: { rssBytes: 600 * MB } })).toBeNull();
  });
});

describe('WorkspaceSemaphore host gate (spec 2026-10-21-host-resource-limits)', () => {
  function rig(initial: Partial<WorkspaceResourceLimits>) {
    let sample: HostUsage | undefined;
    let nowMs = 0;
    let agents: Record<string, { rssBytes: number }> = {};
    const hostListeners = new Set<() => void>();
    const agentListeners = new Set<() => void>();
    const host: NonNullable<WorkspaceSemaphoreOptions['host']> = {
      current: () => sample,
      subscribe: (l) => (hostListeners.add(l), () => hostListeners.delete(l)),
      agentUsage: () => agents,
      subscribeAgents: (l) => (agentListeners.add(l), () => agentListeners.delete(l)),
      now: () => nowMs,
    };
    const sem = new WorkspaceSemaphore({ initial, host });
    let busy = 0;
    let pumps = 0;
    const p: SemaphoreParticipant = {
      busySlots: () => busy,
      oldestQueuedAt: () => 1,
      pump: () => {
        pumps += 1;
      },
    };
    sem.register(p);
    const tick = () => [...hostListeners].forEach((l) => l());
    return {
      sem,
      host,
      hostListeners,
      agentListeners,
      tick,
      setBusy: (n: number) => (busy = n),
      setSample: (u: HostUsage | undefined) => (sample = u),
      setAgents: (a: typeof agents) => (agents = a),
      setNow: (n: number) => (nowMs = n),
      pumps: () => pumps,
    };
  }
  const reserve = { hostReserve: { memoryMb: 4096, cpuPct: null } };
  const low = usage({ memAvailableBytes: 512 * MB });

  it('is off and subscribes to nothing by default', () => {
    const r = rig({});
    expect(r.hostListeners.size).toBe(0);
    expect(r.sem.hostAdmits()).toBe(true);
  });

  it('refuses a start under pressure, but never when the workspace is idle (liveness)', () => {
    const r = rig(reserve);
    r.setSample(low);
    r.setBusy(1);
    expect(r.sem.hostAdmits()).toBe(false);
    r.setBusy(0);
    expect(r.sem.hostAdmits()).toBe(true);
  });

  it('fails open on a stale or missing sample', () => {
    const r = rig(reserve);
    r.setBusy(1);
    expect(r.sem.hostAdmits()).toBe(true); // no sample yet
    r.setSample(low);
    r.setNow(60_000); // sample is a minute old
    expect(r.sem.hostAdmits()).toBe(true);
  });

  it('re-pumps when the next tick arrives after a refusal', () => {
    const r = rig(reserve);
    r.setSample(low);
    r.setBusy(1);
    expect(r.sem.hostAdmits()).toBe(false);
    r.tick();
    expect(r.pumps()).toBe(1);
  });

  it('admits one gated start per telemetry tick', () => {
    const r = rig(reserve);
    r.setSample(usage({ memAvailableBytes: 9000 * MB }));
    r.setBusy(1);
    r.tick();
    expect(r.sem.hostAdmits()).toBe(true);
    r.sem.noteGatedStart();
    expect(r.sem.hostAdmits()).toBe(false);
    r.tick();
    expect(r.sem.hostAdmits()).toBe(true);
  });

  it('caps the summed agent RSS', () => {
    const r = rig({ totalAgentMemoryMb: 1000 });
    expect(r.agentListeners.size).toBe(1);
    r.setBusy(1);
    r.setAgents({ a: { rssBytes: 1200 * MB } });
    expect(r.sem.hostAdmits()).toBe(false);
    r.setAgents({});
    expect(r.sem.hostAdmits()).toBe(true);
  });

  it('refresh() starts and stops sampling with the config', async () => {
    let loaded: WorkspaceResourceLimits = { maxParallel: 2, memoryLimitMb: null, ...reserve };
    const r = rig({});
    const sem = new WorkspaceSemaphore({ load: async () => loaded, host: r.host });
    await sem.refresh();
    expect(r.hostListeners.size).toBe(1);
    loaded = { maxParallel: 2, memoryLimitMb: null };
    await sem.refresh();
    expect(r.hostListeners.size).toBe(0);
  });
});
