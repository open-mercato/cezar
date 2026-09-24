import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostUsageProvider, useHostUsageStore } from '@/api/host-usage'
import { createQueryClient } from '@/api/query-client'
import type { HostUsage } from '@open-mercato/cezar-api-client'
import { HostUsageWidget, HOST_WIDGET_STALE_MS } from './host-usage-widget'

/**
 * The sidebar glance (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, §UI/UX): the
 * three states that must be honest (`sampling…` before a first CPU point, `stale` after the
 * re-armed timeout, `—` for a limit whose value is missing), and the two gates that must UNMOUNT it
 * rather than hide it (below `md`, and remote).
 */

const HEALTH_LOCAL = {
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
    cpuCount: 8,
    memTotalBytes: 32 * 1024 ** 3,
    memUsedBytes: 12 * 1024 ** 3,
    memAvailableBytes: 20 * 1024 ** 3,
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
    const set = this.handlers.get(name) ?? new Set()
    set.add(handler)
    this.handlers.set(name, set)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  private fire(name: string, event: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
}

/** Pushes one sample into the store the way a writer would, so the widget renders real data. */
let pushFrame: ((value: HostUsage) => void) | undefined

function Seed({ samples }: { samples: HostUsage[] }) {
  const store = useHostUsageStore()
  // Exposed so a test can deliver a LATER frame to the same store (the stale → live re-arm).
  pushFrame = (value) => store?.push(value, Date.now(), 'root')
  for (const [index, value] of samples.entries()) {
    store?.push(value, Date.now() + index, 'root')
  }
  return null
}

function wrapper(samples: HostUsage[] = []) {
  const client = createQueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <HostUsageProvider>
          <MemoryRouter>
            <Seed samples={samples} />
            {children}
          </MemoryRouter>
        </HostUsageProvider>
      </QueryClientProvider>
    )
  }
}

function stubViewport(desktop: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

function serve(health = HEALTH_LOCAL): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(health)
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  stubViewport(true)
  serve()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('HostUsageWidget', () => {
  it('shows the effective CPU, its sparkline and compact RAM, linked to Resources', async () => {
    render(<HostUsageWidget />, {
      wrapper: wrapper([
        sample({ cpuPct: 38.4, sampledAt: '2026-09-20T00:00:00.000Z' }),
        sample({ cpuPct: 41.2, sampledAt: '2026-09-20T00:00:02.000Z' }),
      ]),
    })

    await waitFor(() => expect(screen.getByText('41%')).toBeTruthy())
    expect(screen.getByText('12.0/32.0 GB')).toBeTruthy()
    expect(document.querySelector('[data-slot="host-usage-widget-sparkline"]')).not.toBeNull()
    const row = document.querySelector('[data-slot="host-usage-widget"]')
    expect(row?.closest('a')?.getAttribute('href')).toBe('/settings/resources')
  })

  it('reads `sampling…` before the first CPU point', async () => {
    render(<HostUsageWidget />, { wrapper: wrapper([sample()]) })
    await waitFor(() => expect(screen.getByText('sampling…')).toBeTruthy())
    expect(document.querySelector('[data-slot="host-usage-widget-sparkline"]')).toBeNull()
  })

  it('shows effective cores and — for a cgroup limit with no CPU value', async () => {
    render(<HostUsageWidget />, {
      wrapper: wrapper([
        sample({
          cpuCount: 8,
          cpuPct: 31,
          container: { source: 'cgroup-v2', cpuQuotaCores: 6, memLimitBytes: 8 * 1024 ** 3 },
          hostCpuCount: 8,
        }),
      ]),
    })

    // The container's percentage is missing, so `—` - never the host's 31 % beside effective cores.
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
    expect(screen.getByText('6 CPU')).toBeTruthy()
    expect(screen.getByText('— / 8.0 GB')).toBeTruthy()
    expect(screen.queryByText('31%')).toBeNull()
  })

  it('flips to `stale` after the re-armed timeout, and back on the next frame', async () => {
    vi.useFakeTimers()
    render(<HostUsageWidget />, {
      wrapper: wrapper([sample({ cpuPct: 12, sampledAt: '2026-09-20T00:00:00.000Z' })]),
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('12%')).toBeTruthy()

    // Five ticks of silence (the spec's >15 s check, clocked from the client receipt stamp).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_WIDGET_STALE_MS + 5_000)
    })
    expect(screen.getByText('stale')).toBeTruthy()

    // …and back: a new frame re-arms the timeout rather than leaving the row stale forever.
    act(() => {
      pushFrame?.(sample({ cpuPct: 33, sampledAt: '2026-09-20T00:00:10.000Z' }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('33%')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('is unmounted below md, where the sidebar column is not even in flow', async () => {
    stubViewport(false)
    render(<HostUsageWidget />, { wrapper: wrapper([sample({ cpuPct: 12 })]) })
    await waitFor(() => expect(document.querySelector('[data-slot="host-usage-widget"]')).toBeNull())
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('is unmounted in remote, where the card owns the route read', async () => {
    serve({
      ...HEALTH_LOCAL,
      capabilities: { ...HEALTH_LOCAL.capabilities, localHandoff: false },
    })
    render(<HostUsageWidget />, { wrapper: wrapper([sample({ cpuPct: 12 })]) })
    await waitFor(() => expect(document.querySelector('[data-slot="host-usage-widget"]')).toBeNull())
    expect(FakeSocket.instances).toHaveLength(0)
  })
})
