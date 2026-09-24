import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

/**
 * The process's own cgroup limits and usage (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, Phase 1).
 *
 * v1 telemetry (`host-usage.ts`) reads the MACHINE; in a sandboxed deployment the machine is not
 * what this process may use. This module answers the other half: which cgroup the PROCESS lives
 * in, the tightest finite limit on its ancestor chain, and its own usage.
 *
 * Four rules shape the whole module, and each one is a defect the v2 review found:
 *
 * 1. **The process's own cgroup, never the namespace root.** `/proc/self/cgroup` names the leaf;
 *    root `cpu.max`/`memory.max` read `max` on a real dev host while a systemd scope (or
 *    `--cgroupns=host`) carries the real limit.
 * 2. **Ancestors for LIMITS, the leaf for USAGE.** The walk takes the minimum finite limit; usage
 *    (`memory.current`, `cpu.stat`) comes from the leaf, because an ancestor's counters include
 *    every sibling and are not this process's usage.
 * 3. **Only a finite, positive limit is a limit.** v2 `max` is unlimited; v1 `cpu.cfs_quota_us`
 *    `-1`/`0` is unlimited; v1 `memory.limit_in_bytes` writes `-1` for unlimited and reads back a
 *    huge sentinel; a numeric `0` memory limit is a degenerate ZERO limit, not "unlimited", and
 *    being non-positive it is not representable in the positive schema, so it emits no limit at
 *    all. A cpuset list counts as a finite CPU limit only when its core count is below the host
 *    core count (`docker --cpuset-cpus` leaves `cpu.max=max`).
 * 4. **Never throws.** Non-Linux, a hardened container without `/proc`, an unreadable file - every
 *    one of them degrades to `undefined`, which the sampler renders as "no container object" and
 *    a byte-identical v1 payload.
 *
 * Cost: a handful of small reads per sample, and only while a sample is taken (the sampler is
 * demand-driven).
 */

/** Injectable file read: `/proc` is unreadable in plenty of hardened containers, and tests need
 *  to drive the whole parser without a container. */
export type CgroupFileReader = (path: string) => string | undefined;

export type CgroupSource = 'cgroup-v2' | 'cgroup-v1';

/**
 * Raw facts, not a verdict: the sampler decides which of them are limits (it knows the host's
 * core count and memory total, which the probe cannot).
 */
export interface CgroupFacts {
  source: CgroupSource;
  /** Tightest finite CPU quota on the ancestor chain, in cores (`quota / period`). */
  cpuQuotaCores?: number;
  /** The leaf's cpuset size in cores, when the controller exposes a non-empty list. */
  cpusetCores?: number;
  /** Tightest finite memory limit on the ancestor chain, in bytes. */
  memLimitBytes?: number;
  /** The leaf's memory usage with page cache excluded, when readable. */
  memUsedBytes?: number;
  /** The leaf's cumulative CPU usage, in MICROSECONDS (v1 `cpuacct.usage` is nanoseconds). */
  cpuUsageUs?: number;
}

export type CgroupProbe = () => CgroupFacts | undefined;

export interface CgroupProbeOptions {
  /** Defaults to a best-effort `readFileSync` returning `undefined` on any failure. */
  readFile?: CgroupFileReader;
  /** Defaults to `process.platform`; anything but Linux answers `undefined`. */
  platform?: NodeJS.Platform;
}

/** v1 reads back this "huge" value (or writes `-1`) for an unlimited memory cgroup. */
export const CGROUP_V1_MEMORY_UNLIMITED_SENTINEL = 0x7ffffffffffff000;

/** `/proc/self/cgroup` line for the unified hierarchy: `0::/user.slice/...`. */
export function parseUnifiedCgroupPath(cgroupFile: string): string | undefined {
  for (const line of cgroupFile.split('\n')) {
    const match = /^0::(.*)$/.exec(line.trim());
    if (match) return match[1] || '/';
  }
  return undefined;
}

/** Per-controller v1 lines: `<hierarchy>:<controllers>:<path>`, controllers comma-separated. */
export function parseLegacyCgroupPaths(
  cgroupFile: string,
): { controllers: string[]; path: string }[] {
  const rows: { controllers: string[]; path: string }[] = [];
  for (const line of cgroupFile.split('\n')) {
    const match = /^\d+:([^:]*):(.*)$/.exec(line.trim());
    if (!match) continue;
    const controllers = (match[1] ?? '').split(',').filter((name) => name.length > 0);
    rows.push({ controllers, path: match[2] || '/' });
  }
  return rows;
}

export interface MountInfoRow {
  mountPoint: string;
  fileSystem: string;
  /** The super-block options field, where v1 names its controllers (`rw,cpu,cpuacct`). */
  superOptions: string;
}

/**
 * `/proc/self/mountinfo`, one mount per line: `id parent major:minor root mountPoint options
 * [optional...] - fstype source superOptions`. Everything after the `-` separator is the second
 * half of the record, which is where the file system type and the super options live.
 */
export function parseMountInfo(mountInfo: string): MountInfoRow[] {
  const rows: MountInfoRow[] = [];
  for (const line of mountInfo.split('\n')) {
    const fields = line.trim().split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4) continue;
    const mountPoint = fields[4];
    const fileSystem = fields[separator + 1];
    const superOptions = fields[separator + 3];
    if (mountPoint === undefined || fileSystem === undefined || superOptions === undefined) continue;
    rows.push({
      mountPoint,
      fileSystem,
      superOptions,
    });
  }
  return rows;
}

/**
 * A `cpu.max`/`cpu.cfs_quota_us`-style quota as cores. `max` (v2), `-1` and `0` (v1) all mean
 * unlimited and answer `undefined`, so a naive `quota / period` can never produce negative or
 * infinite cores.
 */
export function parseCpuQuotaCores(quotaText: string | undefined, periodUs: number | undefined): number | undefined {
  if (quotaText === undefined) return undefined;
  const quota = quotaText.trim().split(/\s+/)[0];
  if (quota === 'max') return undefined;
  const quotaUs = Number(quota);
  if (!Number.isFinite(quotaUs) || quotaUs <= 0) return undefined;
  const period = periodUs ?? Number(quotaText.trim().split(/\s+/)[1] ?? '100000');
  if (!Number.isFinite(period) || period <= 0) return undefined;
  return quotaUs / period;
}

/**
 * A `memory.max`/`memory.limit_in_bytes` value in bytes, or `undefined` when it names no usable
 * limit. Only the literal `max` (v2) and the v1 unlimited sentinels are "unlimited"; a numeric `0`
 * is a real zero limit, and since a non-positive limit is not representable in the positive schema
 * (and is degenerate for a running process) it answers `undefined` too - the same wire outcome as
 * unlimited, reached by a different route.
 */
export function parseMemoryLimitBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === '' || text === 'max') return undefined;
  const bytes = Number(text);
  if (!Number.isFinite(bytes)) return undefined;
  if (bytes <= 0 || bytes >= CGROUP_V1_MEMORY_UNLIMITED_SENTINEL) return undefined;
  return bytes;
}

/**
 * How many cores a cpuset CPU list covers: `0-2,4-6,8` is 7. Malformed tokens are ignored rather
 * than guessed at, and an empty list answers `undefined`: "no cpuset restriction" is not a count.
 */
export function countCpuList(cpuList: string | undefined): number | undefined {
  if (cpuList === undefined) return undefined;
  let total = 0;
  for (const token of cpuList.trim().split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token.trim());
    if (!range) continue;
    const first = Number(range[1]);
    const last = range[2] === undefined ? first : Number(range[2]);
    if (last < first) continue;
    total += last - first + 1;
  }
  return total > 0 ? total : undefined;
}

/** The `usage_usec` / `inactive_file` style keyed counters cgroup files are made of. */
export function parseKeyedCounter(text: string | undefined, key: string): number | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split('\n')) {
    const match = /^([a-z_]+)\s+(\S+)$/.exec(line.trim());
    if (!match || match[1] !== key) continue;
    const value = Number(match[2]);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/**
 * A file that holds a single bare number (`memory.current`, `memory.usage_in_bytes`,
 * `cpuacct.usage`). Not the keyed-counter parser above: those files have no key column, and
 * feeding them to it would answer `undefined` for every readable value.
 */
export function parseCgroupNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Leaf -> mount root, inclusive. The limit walk uses the whole list; the usage read uses only the
 * first entry. A path outside the mount (should not happen) degrades to itself rather than
 * guessing.
 */
export function ancestorChain(path: string, root: string): string[] {
  if (!path.startsWith(root)) return [path];
  const chain: string[] = [];
  let current = path;
  while (current.length > root.length && current !== root) {
    chain.push(current);
    const cut = current.lastIndexOf('/');
    current = cut <= 0 ? '/' : current.slice(0, cut);
  }
  chain.push(root);
  return chain;
}

function defaultReadCgroupFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // a hardened container without /proc is a normal outcome, not an error
  }
}

/** `path.join` would already normalize, but an empty leaf path must stay the mount root. */
function joinCgroupPath(mountPoint: string, cgroupPath: string): string {
  const root = mountPoint.replace(/\/+$/, '') || '/';
  if (cgroupPath === '/' || cgroupPath === '') return root;
  return join(root, cgroupPath);
}

/**
 * The effective file wins only when it actually carries a list: an EMPTY `cpuset.cpus.effective`
 * is the unreadable case, not "no cores", so it falls through to `cpuset.cpus` as the spec says.
 */
function readCpusetList(effective: string | undefined, fallback: string | undefined): string | undefined {
  return effective !== undefined && effective.trim() !== '' ? effective : fallback;
}

/** The tightest finite value wins; `undefined` entries (unlimited, unreadable) never win. */
function minFinite(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return Math.min(current, next);
}

/**
 * The v2 walk: parse the leaf path out of `/proc/self/cgroup`, find the cgroup2 mount, read the
 * ancestor chain's limit files and the leaf's own counters.
 */
function probeV2(
  readFile: CgroupFileReader,
  cgroupFile: string,
  mountPoint: string,
): CgroupFacts | undefined {
  const leafPath = parseUnifiedCgroupPath(cgroupFile);
  if (leafPath === undefined) return undefined;
  const leafDir = joinCgroupPath(mountPoint, leafPath);
  const chain = ancestorChain(leafDir, mountPoint.replace(/\/+$/, '') || '/');

  let cpuQuotaCores: number | undefined;
  let memLimitBytes: number | undefined;
  for (const dir of chain) {
    const quotaText = readFile(`${dir}/cpu.max`);
    cpuQuotaCores = minFinite(cpuQuotaCores, parseCpuQuotaCores(quotaText, undefined));
    memLimitBytes = minFinite(memLimitBytes, parseMemoryLimitBytes(readFile(`${dir}/memory.max`)));
  }

  const cpuUsageUs = parseKeyedCounter(readFile(`${leafDir}/cpu.stat`), 'usage_usec');
  const memCurrent = parseCgroupNumber(readFile(`${leafDir}/memory.current`));
  const inactiveFile = parseKeyedCounter(readFile(`${leafDir}/memory.stat`), 'inactive_file');
  const memUsedBytes =
    memCurrent === undefined ? undefined : Math.max(0, memCurrent - (inactiveFile ?? 0));
  const cpusetCores = countCpuList(
    readCpusetList(
      readFile(`${leafDir}/cpuset.cpus.effective`),
      readFile(`${leafDir}/cpuset.cpus`),
    ),
  );

  return {
    source: 'cgroup-v2',
    ...(cpuQuotaCores === undefined ? {} : { cpuQuotaCores }),
    ...(cpusetCores === undefined ? {} : { cpusetCores }),
    ...(memLimitBytes === undefined ? {} : { memLimitBytes }),
    ...(memUsedBytes === undefined ? {} : { memUsedBytes }),
    ...(cpuUsageUs === undefined ? {} : { cpuUsageUs }),
  };
}

/**
 * The v1 fallback: one mount per controller group, resolved from the mount table rather than
 * assumed, because `cpu,cpuacct` share one mount on most hosts and are separate on others.
 */
function probeV1(
  readFile: CgroupFileReader,
  cgroupFile: string,
  mounts: MountInfoRow[],
): CgroupFacts | undefined {
  const rows = parseLegacyCgroupPaths(cgroupFile);
  const controllerMount = (controller: string): { mountPoint: string; path: string } | undefined => {
    const row = rows.find((candidate) => candidate.controllers.includes(controller));
    if (!row) return undefined;
    const mount = mounts.find((candidate) =>
      candidate.superOptions.split(',').includes(controller),
    );
    if (!mount) return undefined;
    return { mountPoint: mount.mountPoint.replace(/\/+$/, '') || '/', path: row.path };
  };

  const cpu = controllerMount('cpu');
  const memory = controllerMount('memory');
  const cpuset = controllerMount('cpuset');
  // `cpuacct` alone is still worth a probe: a quota with no percentage is worse than a percentage
  // without a quota, but neither is worth discarding the other fact over.
  const cpuacct = controllerMount('cpuacct');
  if (!cpu && !memory && !cpuset && !cpuacct) return undefined;

  let cpuQuotaCores: number | undefined;
  let memLimitBytes: number | undefined;
  if (cpu) {
    for (const dir of ancestorChain(joinCgroupPath(cpu.mountPoint, cpu.path), cpu.mountPoint)) {
      const periodUs = Number(readFile(`${dir}/cpu.cfs_period_us`)?.trim() ?? '');
      const quotaText = readFile(`${dir}/cpu.cfs_quota_us`);
      cpuQuotaCores = minFinite(
        cpuQuotaCores,
        parseCpuQuotaCores(quotaText, Number.isFinite(periodUs) ? periodUs : undefined),
      );
    }
  }
  if (memory) {
    for (const dir of ancestorChain(joinCgroupPath(memory.mountPoint, memory.path), memory.mountPoint)) {
      memLimitBytes = minFinite(
        memLimitBytes,
        parseMemoryLimitBytes(readFile(`${dir}/memory.limit_in_bytes`)),
      );
    }
  }

  let cpuUsageUs: number | undefined;
  let memUsedBytes: number | undefined;
  let cpusetCores: number | undefined;
  // Usage lives where `cpuacct` lives - the same `cpu,cpuacct` mount on most hosts, a mount of its
  // own on some, so read it from its own resolution rather than from the cpu controller's.
  const usageMount = cpuacct ?? cpu;
  if (usageMount) {
    const leafDir = joinCgroupPath(usageMount.mountPoint, usageMount.path);
    // `cpuacct.usage` is NANOSECONDS while the v2 `cpu.stat` counter is microseconds: a literal
    // read would be 1000x too large and clamp every v1 container to 100 %.
    const cpuacctNs = parseCgroupNumber(readFile(`${leafDir}/cpuacct.usage`));
    cpuUsageUs = cpuacctNs === undefined ? undefined : cpuacctNs / 1000;
  }
  if (memory) {
    const leafDir = joinCgroupPath(memory.mountPoint, memory.path);
    const usage = parseCgroupNumber(readFile(`${leafDir}/memory.usage_in_bytes`));
    const inactive = parseKeyedCounter(readFile(`${leafDir}/memory.stat`), 'total_inactive_file');
    memUsedBytes = usage === undefined ? undefined : Math.max(0, usage - (inactive ?? 0));
  }
  if (cpuset) {
    const leafDir = joinCgroupPath(cpuset.mountPoint, cpuset.path);
    cpusetCores = countCpuList(
      readCpusetList(
        readFile(`${leafDir}/cpuset.effective_cpus`),
        readFile(`${leafDir}/cpuset.cpus`),
      ),
    );
  }

  return {
    source: 'cgroup-v1',
    ...(cpuQuotaCores === undefined ? {} : { cpuQuotaCores }),
    ...(cpusetCores === undefined ? {} : { cpusetCores }),
    ...(memLimitBytes === undefined ? {} : { memLimitBytes }),
    ...(memUsedBytes === undefined ? {} : { memUsedBytes }),
    ...(cpuUsageUs === undefined ? {} : { cpuUsageUs }),
  };
}

/**
 * Whether these facts carry a limit a caller can act on. `cpusetCores` is deliberately NOT one:
 * the sampler treats a cpuset as a limit only when it is below the host's core count, and a v2
 * cpuset equal to every core must not stop the walk from finding a real quota on the v1 side.
 */
function hasAuthoritativeLimit(facts: CgroupFacts | undefined): facts is CgroupFacts {
  return (
    facts !== undefined && (facts.cpuQuotaCores !== undefined || facts.memLimitBytes !== undefined)
  );
}

/**
 * Resolve the process's cgroup and read its limits and usage. v2 first (the unified hierarchy is
 * what every current distribution ships), v1 as the fallback; on non-Linux, or with nothing
 * readable, `undefined` - which is the sampler's "emit no `container`" signal.
 */
export function createCgroupProbe(options: CgroupProbeOptions = {}): CgroupProbe {
  const readFile = options.readFile ?? defaultReadCgroupFile;
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return () => undefined;

  return () => {
    const cgroupFile = readFile('/proc/self/cgroup');
    const mountInfo = readFile('/proc/self/mountinfo');
    if (cgroupFile === undefined || mountInfo === undefined) return undefined;

    const mounts = parseMountInfo(mountInfo);
    const unified = mounts.find((mount) => mount.fileSystem === 'cgroup2');
    try {
      const unifiedFacts = unified
        ? probeV2(readFile, cgroupFile, unified.mountPoint.replace(/\/+$/, '') || '/')
        : undefined;
      if (hasAuthoritativeLimit(unifiedFacts)) return unifiedFacts;
      // A hybrid host can mount cgroup2 while the controllers still live on v1 (or a container
      // can expose an empty unified mount). Answering with v2's usage-only facts there would make
      // the card claim "no cgroup limit detected" about a process that HAS one, so the v1 side
      // gets its say whenever v2 carries no quota and no memory limit.
      const legacyFacts = mounts.some((mount) => mount.fileSystem === 'cgroup')
        ? probeV1(readFile, cgroupFile, mounts)
        : undefined;
      if (hasAuthoritativeLimit(legacyFacts)) return legacyFacts;
      return unifiedFacts ?? legacyFacts;
    } catch {
      // A probe that throws is worse than a probe that answers nothing: the whole sampler tick
      // (host CPU, memory, load) would be lost with it.
      return undefined;
    }
  };
}

/** The host core count the cpuset comparison and the context line use (`os.cpus().length`). */
export function hostCoreCount(): number {
  return cpus().length;
}
