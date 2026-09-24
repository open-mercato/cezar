import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os';
import type { HostUsage } from '@open-mercato/cezar-contract';

/**
 * Live host resource telemetry — the Machine card in Settings → Resources (spec
 * `.ai/specs/2026-09-20-host-resource-telemetry.md`).
 *
 * The sibling of `process-usage.ts`: that one aggregates ONE run's process tree; this one reads
 * the MACHINE — aggregate CPU, memory, swap and load — and is read by two cheap transports, the
 * `host` WS topic (local cockpits) and `GET /api/v1/workspace/host-usage` (remote snapshots).
 *
 * Two rules shape the whole module:
 *
 * 1. **`cpuPct` is a delta over a BOUNDED window.** It is only produced from a CPU-times capture
 *    no older than `HOST_SAMPLE_STALE_MS`; a read after a long idle gap re-arms the baseline and
 *    answers WITHOUT `cpuPct` (the card renders `sampling…`), because an hours-long "average" is
 *    not a live gauge and a fake 0 % would be worse. `os.cpus()` deltas are normalized 0–100.
 * 2. **Every read is best-effort.** Memory comes from `os`, swap from `/proc/meminfo` (the one
 *    value Node does not expose; Linux only), load from `os.loadavg()` (absent on Windows where
 *    it reports zeros). A missing fact is OMITTED, never zeroed, and nothing here throws.
 *
 * Cost: one `os.cpus()`-equivalent read per sample. Without a subscriber the timer never starts,
 * so an idle workspace pays nothing; the read-through path costs one read per route hit.
 */

export const HOST_SAMPLE_INTERVAL_MS = 2_000;
/**
 * A CPU reading is only trustworthy while its baseline is recent: the timer samples every 2 s, so
 * three intervals of silence means no live sampler owns the chain and the next read must re-arm.
 * Shared by the topic snapshot and the route — one bound, so the two transports cannot disagree.
 */
export const HOST_SAMPLE_STALE_MS = 3 * HOST_SAMPLE_INTERVAL_MS;

/** Raw CPU-time totals across all cores: `busy = total - idle`, so one delta needs two of these. */
export interface HostCpuTimes {
  idle: number;
  total: number;
}

export type HostCpuTimesSource = () => HostCpuTimes | undefined;

export interface HostSamplerOptions {
  /** Injectable for tests; defaults to summing `os.cpus()`. */
  cpuTimes?: HostCpuTimesSource;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to reading `/proc/meminfo` on Linux. */
  readMeminfo?: () => string | undefined;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface HostSampler {
  /** The last sample taken, whatever its age — a pure read, no side effects. */
  currentHostUsage(): HostUsage | undefined;
  /** Staleness-ruled read: the cached sample only while it carries `cpuPct` and is fresh. */
  sampleHostUsage(): HostUsage;
  /** 0→1 primes the baseline and starts the timer; the returned stop runs on 1→0. */
  onHostUsage(listener: (usage: HostUsage) => void): () => void;
  /** Stops everything and forgets the state — for tests and process teardown. */
  dispose(): void;
}

function defaultCpuTimes(): HostCpuTimes | undefined {
  const perCore = cpus();
  // `os.cpus()` is empty where `/proc` is unavailable. The count still comes from
  // `availableParallelism()`; the CPU percentage is simply omitted rather than faked.
  if (perCore.length === 0) return undefined;
  let idle = 0;
  let total = 0;
  for (const core of perCore) {
    const { user, nice, sys, idle: coreIdle, irq } = core.times;
    idle += coreIdle;
    total += user + nice + sys + coreIdle + irq;
  }
  return { idle, total };
}

function defaultReadMeminfo(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return undefined; // unreadable inside a hardened container is a normal outcome, not an error
  }
}

/**
 * The platform gate for the DEFAULT swap reader. `platform` is injectable, so the default has to
 * honour it too: a sampler told it runs on Windows must not answer with Linux's `/proc/meminfo`
 * swap while correctly omitting `loadAvg` — a sample that contradicts its own platform is worse
 * than a missing field.
 */
function readMeminfoFor(platform: NodeJS.Platform): () => string | undefined {
  return platform === 'linux' ? defaultReadMeminfo : () => undefined;
}

/** `/proc/meminfo` expresses sizes in kB; swap used is `SwapTotal − SwapFree`. */
function parseSwap(meminfo: string | undefined): { totalBytes: number; usedBytes: number } | undefined {
  if (meminfo === undefined) return undefined;
  const readField = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(meminfo);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const totalBytes = readField('SwapTotal');
  const freeBytes = readField('SwapFree');
  if (totalBytes === undefined || freeBytes === undefined || totalBytes <= 0) return undefined;
  return { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

function computeCpuPct(previous: HostCpuTimes, next: HostCpuTimes): number | undefined {
  const totalDelta = next.total - previous.total;
  // A zero or negative delta means no measurable work happened between the captures (or the
  // counters were reset) — omit the field rather than publish a fabricated 0 %.
  if (totalDelta <= 0) return undefined;
  const busyDelta = totalDelta - (next.idle - previous.idle);
  const pct = Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
  return Math.round(pct * 10) / 10;
}

export function createHostSampler(options: HostSamplerOptions = {}): HostSampler {
  const cpuTimesSource = options.cpuTimes ?? defaultCpuTimes;
  const platform = options.platform ?? process.platform;
  const readMeminfo = options.readMeminfo ?? readMeminfoFor(platform);
  const now = options.now ?? Date.now;

  let lastSample: HostUsage | undefined;
  let lastSampleAt = 0;
  let previousCpu: HostCpuTimes | undefined;
  let previousCpuAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(usage: HostUsage) => void>();

  const buildSample = (cpuPct: number | undefined): HostUsage => {
    const at = now();
    const memTotalBytes = totalmem();
    const memAvailableBytes = freemem();
    const swap = parseSwap(readMeminfo());
    // Windows reports `[0, 0, 0]` — absent on the wire, hidden by the card, never a fake row.
    const load = platform === 'win32' ? undefined : loadavg();
    return {
      sampledAt: new Date(at).toISOString(),
      ...(cpuPct === undefined ? {} : { cpuPct }),
      cpuCount: availableParallelism(),
      memTotalBytes,
      memUsedBytes: Math.max(0, memTotalBytes - memAvailableBytes),
      memAvailableBytes,
      ...(swap === undefined
        ? {}
        : { swapTotalBytes: swap.totalBytes, swapUsedBytes: swap.usedBytes }),
      ...(load === undefined
        ? {}
        : { loadAvg: { one: load[0] ?? 0, five: load[1] ?? 0, fifteen: load[2] ?? 0 } }),
    };
  };

  /** The one read path: capture CPU times, derive a delta only from a bounded window. */
  const takeSample = (force: boolean): HostUsage => {
    const at = now();
    const cached = lastSample;
    if (
      !force &&
      cached !== undefined &&
      cached.cpuPct !== undefined &&
      at - lastSampleAt < HOST_SAMPLE_STALE_MS
    ) {
      return cached;
    }
    const times = cpuTimesSource();
    const cpuPct =
      previousCpu !== undefined &&
      times !== undefined &&
      // A MINIMUM window as well as a maximum (review BLOCKER): the hub calls `start()` and then
      // `snapshot()` back to back, and two `os.cpus()` reads are milliseconds apart - a single CPU
      // tick inside that window computes to 50 % or 100 %, which is how the first frame of a fresh
      // subscription painted a red 100 % bar that every surface promises cannot happen. A delta is
      // only a RATE when its window is at least half a sampling interval; below that the field is
      // omitted and the card shows `sampling…`.
      at - previousCpuAt >= HOST_SAMPLE_INTERVAL_MS / 2 &&
      at - previousCpuAt <= HOST_SAMPLE_STALE_MS
        ? computeCpuPct(previousCpu, times)
        : undefined;
    if (times !== undefined) {
      previousCpu = times;
      previousCpuAt = at;
    }
    const sample = buildSample(cpuPct);
    lastSample = sample;
    lastSampleAt = at;
    return sample;
  };

  return {
    currentHostUsage: () => lastSample,
    sampleHostUsage: () => takeSample(false),
    onHostUsage(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // Prime the baseline on 0→1 so the first tick two seconds later is a real delta; the
        // snapshot the hub takes right after `start()` therefore answers without `cpuPct`.
        const times = cpuTimesSource();
        if (times !== undefined) {
          previousCpu = times;
          previousCpuAt = now();
        }
        timer = setInterval(() => {
          const sample = takeSample(true);
          for (const current of [...listeners]) current(sample);
        }, HOST_SAMPLE_INTERVAL_MS);
        timer.unref?.();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    dispose() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      listeners.clear();
      lastSample = undefined;
      lastSampleAt = 0;
      previousCpu = undefined;
      previousCpuAt = 0;
    },
  };
}

/** The process-wide sampler the route and the `host` topic share. */
export const hostUsageSampler = createHostSampler();

export const currentHostUsage = (): HostUsage | undefined => hostUsageSampler.currentHostUsage();
export const sampleHostUsage = (): HostUsage => hostUsageSampler.sampleHostUsage();
export const onHostUsage = (listener: (usage: HostUsage) => void): (() => void) =>
  hostUsageSampler.onHostUsage(listener);
