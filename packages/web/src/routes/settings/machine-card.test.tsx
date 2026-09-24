import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HostUsage } from '@open-mercato/cezar-api-client'
import { MachineCard } from './machine-card'

/**
 * The Machine card (spec `.ai/specs/2026-09-20-host-resource-telemetry.md`, §UI/UX): what it
 * renders in each state, and the two states that must never lie — before the first CPU delta
 * (`sampling…`, never a fake 0 %) and on a host whose OS exposes no swap/load (rows hidden,
 * never a zeroed row).
 */

const HEALTH = {
  version: '0.1.3',
  repoRoot: '/srv/cezar',
  repo: { root: '/srv/cezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  capabilities: { localHandoff: true, followups: false, singleProject: false, automations: false },
}

function sample(over: Partial<HostUsage> = {}): HostUsage {
  return {
    sampledAt: '2026-09-20T00:00:00.000Z',
    cpuCount: 4,
    memTotalBytes: 32 * 1024 ** 3,
    memUsedBytes: 12 * 1024 ** 3,
    memAvailableBytes: 20 * 1024 ** 3,
    swapTotalBytes: 8 * 1024 ** 3,
    swapUsedBytes: 1.1 * 1024 ** 3,
    loadAvg: { one: 1.42, five: 0.98, fifteen: 0.76 },
    ...over,
  }
}

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(_url: string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    set.add(handler)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.fire('close', {})
  }

  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  deliver(topic: string, data: unknown): void {
    this.fire('message', { data: JSON.stringify({ type: 'event', topic, data }) })
  }

  private fire(name: string, event: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
}

function wrapper() {
  const client = createQueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

function serve(health: typeof HEALTH, hostSample?: HostUsage | (() => HostUsage)) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(health)
      if (url.includes('/api/v1/workspace/host-usage')) {
        if (hostSample === undefined) throw new Error('no host sample configured')
        return json(typeof hostSample === 'function' ? hostSample() : hostSample)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MachineCard — local cockpit', () => {
  it('shows sampling… before the first CPU delta, then the live card', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0))
    act(() => {
      FakeSocket.instances[0]?.open()
    })

    // The hub's first frame: memory and load exist, the CPU delta does not yet.
    act(() => {
      FakeSocket.instances[0]?.deliver('host', sample({ loadAvg: undefined, swapTotalBytes: undefined }))
    })
    await waitFor(() =>
      expect(screen.getByText('12.0 GB / 32.0 GB')).toBeTruthy(),
    )
    expect(screen.getByText('sampling…')).toBeTruthy()
    expect(document.querySelector('[data-slot="machine-card-cpu-sparkline"]')).toBeNull()
    // Windows-style host: no load row and no swap row, rather than zeros.
    expect(document.querySelector('[data-slot="machine-card-load"]')).toBeNull()
    expect(document.querySelector('[data-slot="machine-card-swap"]')).toBeNull()
    expect(screen.getByText('live')).toBeTruthy()
    expect(screen.getByText(/Host totals/)).toBeTruthy()

    // Two CPU samples make a line; the bar renders from the first one.
    act(() => {
      FakeSocket.instances[0]?.deliver('host', sample({ cpuPct: 38.4 }))
    })
    await waitFor(() => expect(screen.getByText('38%')).toBeTruthy())
    act(() => {
      FakeSocket.instances[0]?.deliver('host', sample({ cpuPct: 41.2 }))
    })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="machine-card-cpu-sparkline"]')).not.toBeNull(),
    )
    expect(screen.getByText('1.1 GB / 8.0 GB')).toBeTruthy()
    expect(screen.getByText(/1\.42 · 0\.98 · 0\.76/)).toBeTruthy()
    expect(screen.getByText('4 cores')).toBeTruthy()
  })
})

describe('MachineCard — remote cockpit', () => {
  it('reads the route, opens no socket, and labels the values last known', async () => {
    serve({ ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } }, sample({ cpuPct: 12 }))
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('12%')).toBeTruthy())
    expect(screen.getByText('last known')).toBeTruthy()
    expect(FakeSocket.instances).toHaveLength(0)
    expect(document.querySelector('[data-slot="machine-card-swap"]')).not.toBeNull()
  })

  it('follows a first answer without cpuPct with one warm-up read', async () => {
    let reads = 0
    serve(
      { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } },
      () => {
        reads += 1
        return reads === 1 ? sample() : sample({ cpuPct: 7.5 })
      },
    )
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('sampling…')).toBeTruthy())
    // The warm-up is a real 2.5 s wait; the test's real timers would be slow, so the assertion is
    // on the bounded behavior: the card does eventually show the CPU value…
    await waitFor(() => expect(screen.getByText('8%')).toBeTruthy(), { timeout: 5_000 })
    expect(reads).toBe(2)
    // A remote cockpit's updates are sparse, so it never draws the line scaled to the server's
    // 2 s cadence — the instantaneous bar only.
    expect(document.querySelector('[data-slot="machine-card-cpu-sparkline"]')).toBeNull()
  })

  it('admits failure instead of waiting forever when the route rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/v1/health')) {
          return json({ ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } })
        }
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('Host totals are unavailable right now.')).toBeTruthy())
    // The card still explains itself rather than going blank.
    expect(screen.getByText(/Host totals —/)).toBeTruthy()
  })
})

describe('MachineCard — review fixes (freshness basis, cache read, swap pair)', () => {
  it('ticks the age of the MEASUREMENT on a remote cockpit, not the age of the read', async () => {
    // The sample is already a few seconds old when the card receives it; receipt time would
    // stamp it `updated 0 s ago`, and a frozen clock would leave the line stuck forever.
    serve(
      { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } },
      sample({ cpuPct: 12, sampledAt: new Date(Date.now() - 3_500).toISOString() }),
    )
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText(/^updated [34] s ago$/)).toBeTruthy())
    // …and it keeps counting while the card is mounted (1 s interval), so a stalled remote read
    // cannot keep showing the same age as if it were live.
    await waitFor(() => expect(screen.getByText(/^updated [5-9] s ago$/)).toBeTruthy(), {
      timeout: 4_000,
    })
  })

  it('re-reads the route on a remount instead of presenting a cached sample as fresh', async () => {
    let reads = 0
    serve(
      { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } },
      () => {
        reads += 1
        return sample({ cpuPct: reads === 1 ? 12 : 80 })
      },
    )
    // One client across both mounts: the workspace default staleTime is five minutes, so without
    // the per-query override the second mount would render the first answer as `updated 0 s ago`.
    const client = createQueryClient()
    const wrapperWith = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const first = render(<MachineCard />, { wrapper: wrapperWith })
    await waitFor(() => expect(screen.getByText('12%')).toBeTruthy())
    first.unmount()

    render(<MachineCard />, { wrapper: wrapperWith })
    await waitFor(() => expect(screen.getByText('80%')).toBeTruthy())
    expect(reads).toBe(2)
  })

  it('hides the swap row when only one of the pair is on the wire', async () => {
    const { swapUsedBytes: _omitted, ...withoutUsed } = sample({ cpuPct: 12 })
    serve(
      { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } },
      withoutUsed,
    )
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('12%')).toBeTruthy())
    // The pair is both-or-neither by construction; a partial producer must not print `Swap  / 8 GB`.
    expect(document.querySelector('[data-slot="machine-card-swap"]')).toBeNull()
    expect(screen.queryByText(/8\.0 GB/)).toBeNull()
  })
})
