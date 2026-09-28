import { describe, expect, it } from 'vitest'

import type { HostUsage } from '@open-mercato/cezar-api-client'
import { effectiveHostView, formatCpuCores, formatMemPair } from './host-effective'

/**
 * The client half of the effective composition (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, §"One composition, no scope mixing").
 * Same matrix as the server's: one reader decides for both surfaces which number is effective, and
 * a limit whose value is missing renders `—` rather than borrowing the host figure.
 */

function sample(over: Partial<HostUsage> = {}): HostUsage {
  return {
    sampledAt: '2026-09-20T00:00:00.000Z',
    cpuPct: 31,
    cpuCount: 8,
    memTotalBytes: 32 * 1024 ** 3,
    memUsedBytes: 12 * 1024 ** 3,
    memAvailableBytes: 20 * 1024 ** 3,
    ...over,
  }
}

describe('effectiveHostView', () => {
  it('is the plain v1 host view without a container', () => {
    const view = effectiveHostView(sample())
    expect(view).toMatchObject({
      hasContainer: false,
      cpuLimited: false,
      cpuCores: 8,
      cpuPct: 31,
      cpuIsEffective: false,
      memTotalBytes: 32 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
      memIsEffective: false,
    })
  })

  it('takes the container CPU percentage, with effective cores as the denominator source', () => {
    const view = effectiveHostView(
      sample({ container: { source: 'cgroup-v2', cpuQuotaCores: 2, cpuPct: 50 }, hostCpuCount: 8 }),
    )
    expect(view).toMatchObject({
      hasContainer: true,
      cpuLimited: true,
      cpuLimitKind: 'quota',
      cpuCores: 2,
      cpuPct: 50,
      cpuIsEffective: true,
      // No memory limit: the host pair stays, and it is labelled host.
      memIsEffective: false,
      memTotalBytes: 32 * 1024 ** 3,
    })
  })

  it('bounds a quota wider than the host by the host core count', () => {
    const view = effectiveHostView(
      sample({ cpuCount: 8, container: { source: 'cgroup-v2', cpuQuotaCores: 100 }, hostCpuCount: 8 }),
    )
    expect(view.cpuCores).toBe(8)
  })

  it('labels a cpuset-only pin and keeps the host memory pair', () => {
    const view = effectiveHostView(
      sample({ cpuCount: 2, container: { source: 'cgroup-v2', cpuAffinityCores: 2, cpuPct: 100 }, hostCpuCount: 24 }),
    )
    expect(view).toMatchObject({
      cpuLimitKind: 'cpuset',
      cpuCores: 2,
      cpuPct: 100,
      memIsEffective: false,
    })
  })

  it('takes the container memory pair together when a memory limit exists', () => {
    const view = effectiveHostView(
      sample({
        container: {
          source: 'cgroup-v2',
          memLimitBytes: 2 * 1024 ** 3,
          memUsedBytes: 512 * 1024 ** 2,
        },
      }),
    )
    expect(view).toMatchObject({
      memLimited: true,
      memIsEffective: true,
      memTotalBytes: 2 * 1024 ** 3,
      memUsedBytes: 512 * 1024 ** 2,
      // No CPU limit: the CPU row stays the host's, and is not mislabelled effective.
      cpuLimited: false,
      cpuPct: 31,
      cpuIsEffective: false,
    })
  })

  it('renders nothing for a limit whose own value is missing', () => {
    const view = effectiveHostView(
      sample({
        cpuPct: 31,
        container: { source: 'cgroup-v2', cpuQuotaCores: 6, memLimitBytes: 8 * 1024 ** 3 },
      }),
    )
    expect(view.cpuLimited).toBe(true)
    expect(view.cpuPct).toBeUndefined()
    expect(view.memLimited).toBe(true)
    expect(view.memUsedBytes).toBeUndefined()
    expect(view.memTotalBytes).toBe(8 * 1024 ** 3)
  })
})

describe('the widget formatters', () => {
  it('writes cores the way the card does, keeping a fractional quota honest', () => {
    expect(formatCpuCores(4)).toBe('4 CPU')
    expect(formatCpuCores(24)).toBe('24 CPU')
    expect(formatCpuCores(0.5)).toBe('0.5 CPU')
    expect(formatCpuCores(1.25)).toBe('1.3 CPU')
  })

  it('writes the compact pair with one unit when both halves share it', () => {
    expect(formatMemPair(12 * 1024 ** 3, 32 * 1024 ** 3)).toBe('12.0/32.0 GB')
    // Mixed units: the unit is written twice rather than pretending 900 MB is `0.9` of the total.
    expect(formatMemPair(900 * 1024 ** 2, 1024 ** 3)).toBe('900 MB/1.0 GB')
    expect(formatMemPair(undefined, 2 * 1024 ** 3)).toBe('— / 2.0 GB')
  })
})
