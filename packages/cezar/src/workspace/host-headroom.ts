import type { HostUsage } from '@open-mercato/cezar-contract';

/**
 * Pure admission checks for spec 2026-10-21-host-resource-limits. Each returns a human reason
 * when a NEW run must wait, or null to admit. Every unreadable input answers null (fail open):
 * telemetry that is missing must never wedge a queue.
 */

export interface HostReserve {
  memoryMb: number | null;
  cpuPct: number | null;
}

const MB = 1024 * 1024;

/** Memory still available to cezar: the container limit's headroom when one exists, never more
 *  than the host's own figure. */
export function availableMemoryBytes(usage: HostUsage): number | undefined {
  const container = usage.container;
  const inContainer =
    container?.memLimitBytes !== undefined && container.memUsedBytes !== undefined
      ? Math.max(0, container.memLimitBytes - container.memUsedBytes)
      : undefined;
  if (inContainer === undefined) return usage.memAvailableBytes;
  return Math.min(inContainer, usage.memAvailableBytes ?? Number.POSITIVE_INFINITY);
}

/** CPU busy percent in the scope that limits us: the cgroup's own when present. */
export function busyCpuPct(usage: HostUsage): number | undefined {
  return usage.container?.cpuPct ?? usage.cpuPct;
}

export function hostReserveBlock(reserve: HostReserve, usage: HostUsage | undefined): string | null {
  if (usage === undefined) return null;
  const { memoryMb, cpuPct } = reserve;
  if (memoryMb !== null && memoryMb > 0) {
    const available = availableMemoryBytes(usage);
    if (available !== undefined && available < memoryMb * MB) {
      return `host has ${Math.floor(available / MB)} MiB free, below the ${memoryMb} MiB reserve`;
    }
  }
  if (cpuPct !== null && cpuPct > 0) {
    const busy = busyCpuPct(usage);
    if (busy !== undefined && busy > cpuPct) return `host CPU is ${Math.round(busy)}%, above the ${cpuPct}% reserve`;
  }
  return null;
}

export function agentMemoryBlock(limitMb: number | null, usage: Record<string, { rssBytes: number }>): string | null {
  if (limitMb === null || limitMb <= 0) return null;
  let total = 0;
  for (const u of Object.values(usage)) total += u.rssBytes;
  return total >= limitMb * MB
    ? `agents hold ${Math.floor(total / MB)} MiB, at the ${limitMb} MiB total limit`
    : null;
}
