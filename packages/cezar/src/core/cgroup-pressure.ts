import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseCgroupNumber,
  parseKeyedCounter,
  parseLegacyCgroupPaths,
  parseMemoryLimitBytes,
  parseMountInfo,
  parseUnifiedCgroupPath,
  type CgroupFileReader,
} from './cgroup-probe.ts';

/**
 * Raw pressure signals from the process's own cgroup (spec
 * `.ai/specs/2026-09-20-adaptive-admission-governor.md`, implementation plan step 1).
 *
 * The display sampler answers "how much capacity do I have"; this answers "how close to the wall am
 * I". Both read the SAME cgroup, and the control path reads it directly rather than consulting the
 * rendered value: `memory.current` against `memory.max`, `memory.events` counters, and PSI. F12
 * pins that the display value is a rendering artifact, not a control signal. The one piece of
 * arithmetic the two share is page cache: the kernel charges it to the cgroup and reclaims
 * `inactive_file` instead of stalling, so the ratio subtracts it. A container that has simply read
 * a lot of files is not under pressure, and treating it as such would cut the ceiling for 10
 * minutes on a calm machine.
 *
 * Rules, all of which exist because a governor that fails closed is worse than none:
 *
 * 1. **Everything is optional.** A container without PSI contributes no PSI rows; a cgroup without a
 *    memory limit contributes no ratio. The governor treats a missing row as "no opinion", and a
 *    sample with no rows at all as "no pressure".
 * 2. **Deltas are this module's job.** `memory.events` counters are cumulative, so the consumer gets
 *    an increase since the previous read (and `undefined` on the first read - a governor must not
 *    mistake a machine that booted with `oom_kill: 3` for pressure happening now).
 * 3. **Never throws.** Unreadable files answer `undefined`, which the governor reads as "no
 *    pressure".
 * 4. **The leaf is resolved once.** Resolving it means reading and parsing `/proc/self/mountinfo`,
 *    and admission runs on the scheduler's hot path, so the answer is memoized per source. An
 *    unreadable `/proc` is deliberately NOT memoized: a hardened container that becomes readable
 *    later still starts seeing its cgroup.
 */

export interface PressureSample {
  /** `memory.current / memory.max`, only when the limit is finite and positive. */
  memoryUsedRatio?: number;
  /** Increase in `memory.events high` since the previous read; `undefined` on the first read. */
  highEventsDelta?: number;
  /** Increase in `memory.events oom_kill` since the previous read. */
  oomKillDelta?: number;
  /** PSI `memory.pressure` `some avg10` (percent of wall time stalled). */
  memoryPressureAvg10?: number;
  /** PSI `cpu.pressure` `some avg10`. */
  cpuPressureAvg10?: number;
}

export type PressureSource = () => PressureSample | undefined;

export interface PressureSourceOptions {
  readFile?: CgroupFileReader;
  platform?: NodeJS.Platform;
}

/** `some avg10=12.34 avg60=... avg300=... total=...` - the `some` line is the one that matters. */
export function parsePsiAvg10(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith('some')) continue;
    const match = /avg10=([0-9.]+)/.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // a hardened container without /proc is a normal outcome
  }
}

/** The leaf directory: v2 through `/proc/self/cgroup` + the cgroup2 mount, else the v1 memory one. */
function resolveLeafDirs(readFile: CgroupFileReader): { v2?: string; v1Memory?: string } {
  const cgroupFile = readFile('/proc/self/cgroup');
  const mountInfo = readFile('/proc/self/mountinfo');
  if (cgroupFile === undefined || mountInfo === undefined) return {};
  const mounts = parseMountInfo(mountInfo);

  const unified = mounts.find((mount) => mount.fileSystem === 'cgroup2');
  const unifiedPath = parseUnifiedCgroupPath(cgroupFile);
  if (unified && unifiedPath !== undefined) {
    const root = unified.mountPoint.replace(/\/+$/, '') || '/';
    return { v2: join(root, unifiedPath) };
  }

  const row = parseLegacyCgroupPaths(cgroupFile).find((entry) =>
    entry.controllers.includes('memory'),
  );
  const memoryMount = mounts.find((mount) =>
    mount.superOptions.split(',').includes('memory'),
  );
  if (!row || !memoryMount) return {};
  const root = memoryMount.mountPoint.replace(/\/+$/, '') || '/';
  return { v1Memory: join(root, row.path) };
}

/**
 * One readable sample per call, with `memory.events` deltas computed against the previous call.
 * `undefined` means "nothing readable" - the governor's fail-open case.
 */
export function createCgroupPressureSource(options: PressureSourceOptions = {}): PressureSource {
  const readFile = options.readFile ?? defaultReadFile;
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return () => undefined;

  let previous: { high?: number; oomKill?: number } | undefined;
  let resolved: { v2?: string; v1Memory?: string } | undefined;

  return () => {
    try {
      const dirs = resolved ?? resolveLeafDirs(readFile);
      if (resolved === undefined && (dirs.v2 !== undefined || dirs.v1Memory !== undefined)) {
        resolved = dirs;
      }
      const sample: PressureSample = {};
      let sawAnything = false;

      if (dirs.v2 !== undefined) {
        const current = parseCgroupNumber(readFile(`${dirs.v2}/memory.current`));
        const limit = parseMemoryLimitBytes(readFile(`${dirs.v2}/memory.max`));
        if (current !== undefined && limit !== undefined && limit > 0) {
          // Reclaimable page cache only - `active_file` is not free, and a missing `memory.stat`
          // falls back to the raw usage rather than to no row at all.
          const inactiveFile = parseKeyedCounter(
            readFile(`${dirs.v2}/memory.stat`),
            'inactive_file',
          );
          sample.memoryUsedRatio = Math.max(0, current - (inactiveFile ?? 0)) / limit;
          sawAnything = true;
        }
        const events = readFile(`${dirs.v2}/memory.events`);
        if (events !== undefined) {
          const high = parseKeyedCounter(events, 'high');
          const oomKill = parseKeyedCounter(events, 'oom_kill');
          if (high !== undefined || oomKill !== undefined) {
            if (previous !== undefined) {
              if (high !== undefined && previous.high !== undefined && high >= previous.high) {
                sample.highEventsDelta = high - previous.high;
              }
              if (oomKill !== undefined && previous.oomKill !== undefined && oomKill >= previous.oomKill) {
                sample.oomKillDelta = oomKill - previous.oomKill;
              }
            }
            previous = { ...(high === undefined ? {} : { high }), ...(oomKill === undefined ? {} : { oomKill }) };
            sawAnything = true;
          }
        }
        const memoryPsi = parsePsiAvg10(readFile(`${dirs.v2}/memory.pressure`));
        if (memoryPsi !== undefined) {
          sample.memoryPressureAvg10 = memoryPsi;
          sawAnything = true;
        }
        const cpuPsi = parsePsiAvg10(readFile(`${dirs.v2}/cpu.pressure`));
        if (cpuPsi !== undefined) {
          sample.cpuPressureAvg10 = cpuPsi;
          sawAnything = true;
        }
      } else if (dirs.v1Memory !== undefined) {
        const usage = parseCgroupNumber(readFile(`${dirs.v1Memory}/memory.usage_in_bytes`));
        const limit = parseMemoryLimitBytes(readFile(`${dirs.v1Memory}/memory.limit_in_bytes`));
        if (usage !== undefined && limit !== undefined && limit > 0) {
          const inactiveFile = parseKeyedCounter(
            readFile(`${dirs.v1Memory}/memory.stat`),
            'total_inactive_file',
          );
          sample.memoryUsedRatio = Math.max(0, usage - (inactiveFile ?? 0)) / limit;
          sawAnything = true;
        }
      }

      return sawAnything ? sample : undefined;
    } catch {
      return undefined; // a pressure read must never take the admission path down with it
    }
  };
}
