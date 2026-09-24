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
 * The samples are host-level totals: container/cgroup limits are NOT subtracted, and the card
 * says so.
 */
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
});
export type HostUsage = z.infer<typeof hostUsageSchema>;
