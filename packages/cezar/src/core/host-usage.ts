import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os';
import type { HostUsage, HostUsageContainer } from '@open-mercato/cezar-contract';

import { admissionStatusSnapshot } from './admission-status.ts';
import {
  createCgroupProbe,
  hostCoreCount,
  type CgroupFacts,
  type CgroupFileReader,
  type CgroupProbe,
} from './cgroup-probe.ts';

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
 * 3. **Effective capacity, one scope at a time** (spec
 *    `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`). Beside the host totals the sampler
 *    asks the cgroup probe for the PROCESS's own limits and emits an additive `container` object
 *    ONLY when a finite limit exists (CPU quota, cpuset pin, memory limit) - a usage-only cgroup
 *    keeps the v1 payload byte-identical, and `hostCpuCount` rides only with `container`. Nothing
 *    is mixed: `container.cpuPct` is the cgroup's own delta against effective cores, and a limit
 *    whose value is unreadable is omitted rather than replaced by the host figure.
 * 4. **The dispatch governor is REPORTED, never driven** (spec
 *    `.ai/specs/2026-09-20-adaptive-admission-governor.md`). The semaphore owns the governor and
 *    registers its snapshot in `admission-status.ts`; this sampler reads it once per sample and
 *    emits it as the additive `admission` key only while a `dispatchMaxConcurrent` ceiling is
 *    configured, so a workspace without one keeps the v1 payload byte-identical.
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
  /** Injectable for tests; defaults to reading `/proc/self/cgroup` and the cgroup files. */
  readCgroupFile?: CgroupFileReader;
  /** Injectable for tests; defaults to `createCgroupProbe({ readFile: readCgroupFile })`. */
  cgroupProbe?: CgroupProbe;
  /** Injectable for tests; defaults to `os.cpus().length`, the host core count. */
  hostCoreCount?: () => number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** The previous cgroup usage read, paired with its wall-clock instant for the delta. */
interface CgroupUsageSnapshot {
  cpuUsageUs: number;
  at: number;
}

/**
 * The one effective-capacity composition (spec §"One composition, no scope mixing"), in the one
 * place that has both scopes at hand. Returns `{}` - no `container`, no `hostCpuCount` - unless a
 * finite limit exists, which is what keeps the host-mode payload byte-identical to v1.
 *
 * Exported for its own matrix test: quota-only, cpuset-only, memory-only, both, a quota wider than
 * the host and a limit-without-value all have to behave, and none of them may borrow a host number.
 */
export function composeHostContainer(input: {
  facts: CgroupFacts;
  cpuCount: number;
  hostCpuCount: number;
  memTotalBytes: number;
  previousUsage?: CgroupUsageSnapshot;
  now: number;
}): { container?: HostUsageContainer; hostCpuCount?: number } {
  const { facts, cpuCount, hostCpuCount, memTotalBytes, previousUsage, now } = input;

  const cpuQuotaCores =
    facts.cpuQuotaCores !== undefined && facts.cpuQuotaCores > 0 ? facts.cpuQuotaCores : undefined;
  // A cpuset is a limit only when it is SMALLER than the host: an effective list covering every
  // core is the unrestricted case, and a wider list must never inflate capacity.
  const cpuAffinityCores =
    facts.cpusetCores !== undefined && facts.cpusetCores > 0 && facts.cpusetCores < hostCpuCount
      ? facts.cpusetCores
      : undefined;
  const hasCpuLimit = cpuQuotaCores !== undefined || cpuAffinityCores !== undefined;
  const memLimitBytes =
    facts.memLimitBytes !== undefined &&
    facts.memLimitBytes > 0 &&
    facts.memLimitBytes < memTotalBytes
      ? facts.memLimitBytes
      : undefined;
  if (!hasCpuLimit && memLimitBytes === undefined) return {};

  // `os.availableParallelism()` already folds a `taskset` mask (and the cgroup quota on recent
  // libuv), so folding it into the min cannot overstate capacity - it can only lower it.
  const effectiveCores = hasCpuLimit
    ? Math.min(
        cpuCount,
        hostCpuCount > 0 ? hostCpuCount : Number.POSITIVE_INFINITY,
        cpuQuotaCores ?? Number.POSITIVE_INFINITY,
        cpuAffinityCores ?? Number.POSITIVE_INFINITY,
      )
    : undefined;

  let cpuPct: number | undefined;
  if (
    hasCpuLimit &&
    effectiveCores !== undefined &&
    effectiveCores > 0 &&
    facts.cpuUsageUs !== undefined &&
    previousUsage !== undefined
  ) {
    const usageDeltaUs = facts.cpuUsageUs - previousUsage.cpuUsageUs;
    const wallMs = now - previousUsage.at;
    // A counter reset (negative delta), a zero/negative wall, or a gap longer than the sampler's
    // own freshness bound all mean "no honest window": the field is omitted, never faked.
    if (usageDeltaUs >= 0 && wallMs > 0 && wallMs <= HOST_SAMPLE_STALE_MS) {
      const coresUsed = usageDeltaUs / 1000 / wallMs;
      cpuPct = Math.min(100, Math.max(0, Math.round((coresUsed / effectiveCores) * 1000) / 10));
    }
  }

  // `memUsedBytes` exists only inside a memory-limit container: nothing reads an unpaired value,
  // and pairing it with the host total is the scope mix this whole design avoids.
  const memUsedBytes =
    memLimitBytes !== undefined && facts.memUsedBytes !== undefined ? facts.memUsedBytes : undefined;

  return {
    container: {
      source: facts.source,
      ...(cpuQuotaCores === undefined ? {} : { cpuQuotaCores }),
      ...(cpuAffinityCores === undefined ? {} : { cpuAffinityCores }),
      ...(memLimitBytes === undefined ? {} : { memLimitBytes }),
      ...(memUsedBytes === undefined ? {} : { memUsedBytes }),
      ...(cpuPct === undefined ? {} : { cpuPct }),
    },
    ...(hostCpuCount > 0 ? { hostCpuCount } : {}),
  };
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
  const probe =
    options.cgroupProbe ??
    createCgroupProbe({
      ...(options.readCgroupFile === undefined ? {} : { readFile: options.readCgroupFile }),
      platform,
    });
  const hostCores = options.hostCoreCount ?? hostCoreCount;
  const now = options.now ?? Date.now;

  let lastSample: HostUsage | undefined;
  let lastSampleAt = 0;
  let previousCpu: HostCpuTimes | undefined;
  let previousCpuAt = 0;
  let previousCgroupUsage: CgroupUsageSnapshot | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(usage: HostUsage) => void>();

  const buildSample = (cpuPct: number | undefined): HostUsage => {
    const at = now();
    const memTotalBytes = totalmem();
    const memAvailableBytes = freemem();
    const swap = parseSwap(readMeminfo());
    // Windows reports `[0, 0, 0]` — absent on the wire, hidden by the card, never a fake row.
    const load = platform === 'win32' ? undefined : loadavg();
    const facts = probe();
    // One read of the semaphore's snapshot per sample: absent stays absent on the wire, so a
    // workspace without a dispatch ceiling emits no `admission` key at all.
    const admission = admissionStatusSnapshot();
    const effective = composeHostContainer({
      facts: facts ?? { source: 'cgroup-v2' },
      cpuCount: availableParallelism(),
      hostCpuCount: hostCores(),
      memTotalBytes,
      ...(previousCgroupUsage === undefined ? {} : { previousUsage: previousCgroupUsage }),
      now: at,
    });
    if (facts?.cpuUsageUs !== undefined) previousCgroupUsage = { cpuUsageUs: facts.cpuUsageUs, at };
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
      ...(effective.container === undefined ? {} : { container: effective.container }),
      ...(effective.hostCpuCount === undefined ? {} : { hostCpuCount: effective.hostCpuCount }),
      ...(admission === undefined ? {} : { admission }),
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
      previousCpu !== undefined && times !== undefined && at - previousCpuAt <= HOST_SAMPLE_STALE_MS
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
      previousCgroupUsage = undefined;
    },
  };
}

/** The process-wide sampler the route and the `host` topic share. */
export const hostUsageSampler = createHostSampler();

export const currentHostUsage = (): HostUsage | undefined => hostUsageSampler.currentHostUsage();
export const sampleHostUsage = (): HostUsage => hostUsageSampler.sampleHostUsage();
export const onHostUsage = (listener: (usage: HostUsage) => void): (() => void) =>
  hostUsageSampler.onHostUsage(listener);
