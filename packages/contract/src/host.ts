import { z } from 'zod';

/**
 * Live host resource telemetry — the Machine card in Settings → Resources (spec
 * `.ai/specs/2026-09-20-host-resource-telemetry.md`).
 *
 * One schema for both transports: the `host` WS topic's frames and the cached answer of
 * `GET /api/v1/workspace/host-usage` are the same shape, so the card cannot drift between local
 * and remote cockpits.
 *
 * Optional keys are optional ON THE WIRE, never zeroed stand-ins:
 * - `cpuPct` is absent until a CPU delta over a bounded window exists (never a fake 0 %).
 * - `swapTotalBytes`/`swapUsedBytes` are absent where the OS does not expose swap (macOS,
 *   Windows) and when the machine has no swap configured at all.
 * - `loadAvg` is absent on Windows, where `os.loadavg()` reports `[0, 0, 0]` — the card hides the
 *   row instead of printing a meaningless zero.
 *
 * The host fields stay host-level totals, and since the container-aware v2 (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`) a sandboxed process gets an additive
 * `container` object with its OWN cgroup's finite limits and usage, plus `hostCpuCount` for the
 * labelled host-context line. Both keys appear ONLY together and only when a real finite limit
 * exists - a usage-only cgroup (every plain host process) keeps the v1 payload byte-identical.
 * Nothing renders a limit without its value: a limit the probe could not read stays absent and the
 * card shows `—`, never the host figure in its place.
 *
 * The additive `admission` key reports the dispatch governor (spec
 * `.ai/specs/2026-09-20-adaptive-admission-governor.md`): it is present only while a
 * `dispatchMaxConcurrent` ceiling is configured, it reports the ceiling the dispatch gate enforces
 * right now (`effective`, the user's `configured` or lower), and a workspace without a ceiling sees
 * no new key at all.
 */
export const hostUsageContainerSchema = z.object({
  /** Which hierarchy the numbers came from; a systemd-limited host service is v2 too. */
  source: z.enum(['cgroup-v2', 'cgroup-v1']),
  /** Finite `cpu.max`/`cpu.cfs_quota_us` quota in cores; absent when unlimited or unreadable. */
  cpuQuotaCores: z.number().positive().optional(),
  /** Finite cpuset pin (`cpuset.cpus.effective`) below the host core count, in cores. */
  cpuAffinityCores: z.number().positive().optional(),
  /** Finite memory limit below the host total; a zero limit is not representable and is absent. */
  memLimitBytes: z.number().positive().optional(),
  /** Emitted only WITH `memLimitBytes`, and cache-excluded when `inactive_file` is readable. */
  memUsedBytes: z.number().nonnegative().optional(),
  /** Emitted only with a finite CPU limit; the delta is relative to the effective cores. */
  cpuPct: z.number().min(0).max(100).optional(),
});
export type HostUsageContainer = z.infer<typeof hostUsageContainerSchema>;

/**
 * The governor's readout, carried beside the host numbers: the sampler REPORTS what the shared
 * workspace semaphore owns and never decides anything itself, which is what keeps the display path
 * out of the admission decision.
 */
export const hostUsageAdmissionSchema = z.object({
  state: z.enum(['normal', 'elevated', 'critical']),
  /** The user's ceiling. Always present with `effective`: the whole object is omitted while no
   *  ceiling is configured, so a half-reported readout is not a state this wire shape has. */
  configured: z.number().int().positive(),
  /** What the admission gate was enforcing when this sample was taken (`configured` or lower).
   *  A cached route read can lag the live gate by up to the sampler's freshness window. */
  effective: z.number().int().positive(),
  /** ISO-8601 instant the current state began; absent while `normal`. */
  since: z.string().optional(),
});
export type HostUsageAdmission = z.infer<typeof hostUsageAdmissionSchema>;

export const hostUsageSchema = z.object({
  /** ISO-8601 instant this sample was read (server clock). */
  sampledAt: z.string(),
  /** Aggregate CPU utilization 0–100 across all cores; absent without a usable delta window. */
  cpuPct: z.number().min(0).max(100).optional(),
  /** Logical cores (`os.availableParallelism()`), always ≥ 1. */
  cpuCount: z.number().int().positive(),
  memTotalBytes: z.number().nonnegative(),
  memUsedBytes: z.number().nonnegative(),
  /** Headroom left for new work (libuv's `freemem`, i.e. `MemAvailable` on Linux). */
  memAvailableBytes: z.number().nonnegative(),
  swapTotalBytes: z.number().nonnegative().optional(),
  swapUsedBytes: z.number().nonnegative().optional(),
  loadAvg: z
    .object({ one: z.number(), five: z.number(), fifteen: z.number() })
    .optional(),
  /** The process's own cgroup, when a finite limit exists; absent on a plain host. */
  container: hostUsageContainerSchema.optional(),
  /** `os.cpus().length`, emitted only together with `container` and omitted when 0. */
  hostCpuCount: z.number().int().positive().optional(),
  /** The dispatch governor's snapshot; absent while no `dispatchMaxConcurrent` ceiling is set. */
  admission: hostUsageAdmissionSchema.optional(),
});
export type HostUsage = z.infer<typeof hostUsageSchema>;
