import type { HostUsage } from '@open-mercato/cezar-contract';
import { availableMemoryBytes, busyCpuPct } from './host-headroom.ts';

/**
 * Pure maths for spec 2026-10-21-work-limits: which pool a run draws from, and how far the
 * configured pool limits may be scaled DOWN to what the machine can carry right now. Reduction
 * only, never below one, and every unknown input leaves the configured limit alone (fail open).
 */

export type PoolClass = 'main' | 'subagent' | 'review';
export interface ClassCounts {
  main: number;
  subagent: number;
  review: number;
}
/** A pool limit; `subagent`/`review` are null when that kind shares the main pool. */
export interface PoolLimits {
  main: number;
  subagent: number | null;
  review: number | null;
}

/** What one run costs when nothing has been observed yet. */
export const FALLBACK_MEM_PER_RUN_BYTES = 1024 * 1024 * 1024;
export const FALLBACK_CPU_PER_RUN_CORES = 0.5;
/** Floors that keep a near-idle observation from promising a hundred more runs. */
const MIN_MEM_PER_RUN_BYTES = 256 * 1024 * 1024;
const MIN_CPU_PER_RUN_CORES = 0.1;
/** A raise needs this many consecutive calm samples (~2 s each); a cut is immediate. */
export const SCALE_UP_CALM_SAMPLES = 3;

export interface CapacityInput {
  configured: PoolLimits;
  busy: ClassCounts;
  /** Memory / CPU cores still free for NEW agents; undefined = unreadable. */
  freeMemBytes?: number;
  freeCpuCores?: number;
  memPerRunBytes?: number;
  cpuPerRunCores?: number;
}

/** How many more runs the machine can take, or undefined when neither resource is readable. */
export function headroomRuns(input: CapacityInput): number | undefined {
  const mem = Math.max(MIN_MEM_PER_RUN_BYTES, input.memPerRunBytes ?? FALLBACK_MEM_PER_RUN_BYTES);
  const cpu = Math.max(MIN_CPU_PER_RUN_CORES, input.cpuPerRunCores ?? FALLBACK_CPU_PER_RUN_CORES);
  const byMem = input.freeMemBytes === undefined ? undefined : input.freeMemBytes / mem;
  const byCpu = input.freeCpuCores === undefined ? undefined : input.freeCpuCores / cpu;
  if (byMem === undefined && byCpu === undefined) return undefined;
  return Math.max(0, Math.floor(Math.min(byMem ?? Infinity, byCpu ?? Infinity)));
}

/**
 * The headroom is computed once and SHARED across pools in proportion to each pool's unused
 * configured capacity (configured - busy), so a roomy main pool cannot eat the room the dispatched
 * children need (live check: main-first starved both child pools at their floor of 1). Each pool's
 * limit = busy + its share, capped at configured; the integer remainder goes to main, then review,
 * then subagent. The sum of limits therefore never exceeds busy_total + room, except for the
 * floor of 1 per pool (a pool at zero is a dead end: parents park on children that can never start).
 */
export function effectiveCapacity(input: CapacityInput): PoolLimits {
  const room = headroomRuns(input);
  if (room === undefined) return input.configured;
  const pools = (['main', 'review', 'subagent'] as const).flatMap((k) => {
    const configured = input.configured[k];
    return configured === null ? [] : [{ k, configured, busy: input.busy[k], unused: Math.max(0, configured - input.busy[k]) }];
  });
  const totalUnused = pools.reduce((n, p) => n + p.unused, 0);
  const shares = new Map<string, number>();
  let given = 0;
  for (const p of pools) {
    const share = totalUnused === 0 ? 0 : Math.min(p.unused, Math.floor((room * p.unused) / totalUnused));
    shares.set(p.k, share);
    given += share;
  }
  for (const p of pools) {
    if (given >= room) break;
    const extra = Math.min(room - given, p.unused - (shares.get(p.k) ?? 0));
    shares.set(p.k, (shares.get(p.k) ?? 0) + extra);
    given += extra;
  }
  const limit = (k: 'main' | 'review' | 'subagent'): number | null => {
    const p = pools.find((x) => x.k === k);
    return p ? Math.max(1, Math.min(p.configured, p.busy + (shares.get(k) ?? 0))) : null;
  };
  return { main: limit('main') as number, subagent: limit('subagent'), review: limit('review') };
}

/** Lower at once; raise only after `needCalm` consecutive samples that want more. */
export function stepScale(
  prev: number,
  target: number,
  calm: number,
  needCalm = SCALE_UP_CALM_SAMPLES,
): { value: number; calm: number } {
  if (target <= prev) return { value: target, calm: 0 };
  return calm + 1 >= needCalm ? { value: target, calm: 0 } : { value: prev, calm: calm + 1 };
}

/** Mean cost of the agent trees running now; the fallback stands in when none is measurable
 *  (Windows reports 0 CPU, so its CPU term always falls back). */
export function observedPerRun(
  usage: Record<string, { rssBytes: number; cpuPct?: number }>,
): { memPerRunBytes: number; cpuPerRunCores: number } {
  const trees = Object.values(usage);
  const mem = trees.filter((t) => t.rssBytes > 0);
  const cpu = trees.filter((t) => (t.cpuPct ?? 0) > 0);
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    memPerRunBytes: mem.length ? mean(mem.map((t) => t.rssBytes)) : FALLBACK_MEM_PER_RUN_BYTES,
    cpuPerRunCores: cpu.length ? mean(cpu.map((t) => (t.cpuPct ?? 0) / 100)) : FALLBACK_CPU_PER_RUN_CORES,
  };
}

/** Cores cezar may use: the cgroup quota / cpuset when one exists, else the host's. */
export function effectiveCores(usage: HostUsage): number {
  const c = usage.container;
  return Math.min(usage.cpuCount, c?.cpuQuotaCores ?? Infinity, c?.cpuAffinityCores ?? Infinity);
}

/** Free memory (net of a configured reserve) and free cores from one host sample. */
export function freeFromHost(
  usage: HostUsage,
  reserveMemoryMb: number | null,
): { freeMemBytes?: number; freeCpuCores?: number } {
  const avail = availableMemoryBytes(usage);
  const busy = busyCpuPct(usage);
  return {
    ...(avail === undefined ? {} : { freeMemBytes: Math.max(0, avail - (reserveMemoryMb ?? 0) * 1024 * 1024) }),
    ...(busy === undefined ? {} : { freeCpuCores: Math.max(0, effectiveCores(usage) * (1 - busy / 100)) }),
  };
}
