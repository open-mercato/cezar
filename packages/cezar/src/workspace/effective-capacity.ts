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
 * The headroom is computed once and ALLOCATED across pools, in this order: main (the intake and
 * root work everything else hangs off), then review (finishing a pipeline frees it), then
 * subagent. Each pool's effective limit = busy + its share of the room, capped at its configured
 * limit, so the sum of limits never exceeds busy_total + room. The one exception is the floor of
 * 1 per pool (a pool at zero is a dead end: parents park on children that can never start).
 */
export function effectiveCapacity(input: CapacityInput): PoolLimits {
  const room = headroomRuns(input);
  if (room === undefined) return input.configured;
  let left = room;
  const scale = (configured: number | null, busy: number): number | null => {
    if (configured === null) return null;
    const share = Math.min(left, Math.max(0, configured - busy));
    left -= share;
    return Math.max(1, Math.min(configured, busy + share));
  };
  const main = scale(input.configured.main, input.busy.main) as number;
  const review = scale(input.configured.review, input.busy.review);
  const subagent = scale(input.configured.subagent, input.busy.subagent);
  return { main, subagent, review };
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
