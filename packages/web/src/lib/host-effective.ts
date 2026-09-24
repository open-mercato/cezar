import type { HostUsage } from '@open-mercato/cezar-api-client'

import { formatMem } from './tasks-table'

/**
 * The client half of the effective-capacity composition (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, §"One composition, no scope mixing").
 *
 * One reader for the card and the widget, so the two can never disagree about which number is the
 * effective one. The rules, all of them visible in the type below:
 *
 * - **No container** → every value is the v1 host figure, unchanged.
 * - **A CPU limit** (quota or cpuset) → the CPU percentage is the CONTAINER's own delta against
 *   effective cores, and a missing one renders `—`; the host percentage is never substituted.
 * - **A memory limit** → total and used come from the container together, cache-excluded; the
 *   host pair is never mixed in.
 * - A limit this payload does not carry a value for leaves the field `undefined` - `—`, never the
 *   host number in its place.
 */

export interface EffectiveHostView {
  /** True when this sample carries the additive `container` object. */
  hasContainer: boolean
  source?: 'cgroup-v2' | 'cgroup-v1'
  /** True when the sample carries a finite CPU limit (quota or cpuset pin). */
  cpuLimited: boolean
  /** Which kind of CPU limit is the binding one; `quota` wins when both exist. */
  cpuLimitKind?: 'quota' | 'cpuset'
  /** Effective cores (the `cpuPct` denominator), or the host core count without a CPU limit. */
  cpuCores: number
  /** Effective CPU percentage, when a CPU limit exists and the delta was measurable. */
  cpuPct?: number
  /** True when the CPU figure shown is the effective one rather than the host total. */
  cpuIsEffective: boolean
  /** True when the sample carries a finite memory limit. */
  memLimited: boolean
  memTotalBytes: number
  memUsedBytes?: number
  /** True when the memory pair shown is the effective one rather than the host total. */
  memIsEffective: boolean
  /** The host core count, for the labelled host-context line; absent without a container. */
  hostCpuCount?: number
}

export function effectiveHostView(sample: HostUsage): EffectiveHostView {
  const container = sample.container
  if (container === undefined) {
    return {
      hasContainer: false,
      cpuLimited: false,
      cpuCores: sample.cpuCount,
      ...(sample.cpuPct === undefined ? {} : { cpuPct: sample.cpuPct }),
      cpuIsEffective: false,
      memLimited: false,
      memTotalBytes: sample.memTotalBytes,
      ...(sample.memUsedBytes === undefined ? {} : { memUsedBytes: sample.memUsedBytes }),
      memIsEffective: false,
    }
  }

  const cpuLimited = container.cpuQuotaCores !== undefined || container.cpuAffinityCores !== undefined
  const cpuLimitKind =
    container.cpuQuotaCores !== undefined
      ? ('quota' as const)
      : container.cpuAffinityCores !== undefined
        ? ('cpuset' as const)
        : undefined
  // The host count bounds the effective cores even when the quota is wider than the machine, so a
  // saturated 8-core host under a 100-core quota reads 100 % rather than 8 %.
  const effectiveCores = cpuLimited
    ? Math.min(
        sample.cpuCount,
        sample.hostCpuCount ?? Number.POSITIVE_INFINITY,
        container.cpuQuotaCores ?? Number.POSITIVE_INFINITY,
        container.cpuAffinityCores ?? Number.POSITIVE_INFINITY,
      )
    : sample.cpuCount
  const memLimited = container.memLimitBytes !== undefined
  // A CPU limit without its own percentage renders `—`: the host percentage beside effective cores
  // is exactly the scope mix this design exists to avoid.
  const cpuPct = cpuLimited ? container.cpuPct : sample.cpuPct
  const memUsedBytes = memLimited ? container.memUsedBytes : sample.memUsedBytes

  return {
    hasContainer: true,
    source: container.source,
    cpuLimited,
    ...(cpuLimitKind === undefined ? {} : { cpuLimitKind }),
    cpuCores: effectiveCores,
    ...(cpuPct === undefined ? {} : { cpuPct }),
    cpuIsEffective: cpuLimited,
    memLimited,
    memTotalBytes: memLimited ? (container.memLimitBytes ?? sample.memTotalBytes) : sample.memTotalBytes,
    ...(memUsedBytes === undefined ? {} : { memUsedBytes }),
    memIsEffective: memLimited,
    ...(sample.hostCpuCount === undefined ? {} : { hostCpuCount: sample.hostCpuCount }),
  }
}

/**
 * `6 CPU` / `0.5 CPU` - the core count as the card and the widget write it. A fractional quota is
 * real (50000/100000 is half a core), so it is rounded to one decimal rather than to an integer
 * that would claim a whole core the process does not have.
 */
export function formatCpuCores(cores: number): string {
  const rounded = Math.round(cores * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} CPU`
}

/**
 * `14.2/16 GB` - the compact pair the 236 px widget has room for. The unit is written once when
 * both halves share it (the normal case), and twice when they do not (`900/1024 MB`).
 */
export function formatMemPair(usedBytes: number | undefined, totalBytes: number): string {
  const total = formatMem(totalBytes)
  if (usedBytes === undefined) return `— / ${total}`
  const used = formatMem(usedBytes)
  const unit = total.split(' ')[1]
  if (unit !== undefined && used.endsWith(` ${unit}`)) {
    return `${used.slice(0, -(unit.length + 1))}/${total}`
  }
  return `${used}/${total}`
}
