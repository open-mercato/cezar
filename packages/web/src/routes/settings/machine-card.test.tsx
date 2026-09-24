import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostUsageProvider } from '@/api/host-usage'
import { createQueryClient } from '@/api/query-client'
import type { HostUsage } from '@open-mercato/cezar-api-client'
import { MachineCard } from './machine-card'

/**
 * The Machine card (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, §UI/UX): what it
 * renders in each state, and the states that must never lie - before the first CPU delta
 * (`sampling…`, never a fake 0 %), on a host whose OS exposes no swap/load (rows hidden, never
 * zeroed), and under a cgroup limit (the effective number, or `—` when the limit's own value is
 * missing - never the host figure in its place).
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
    return (
      <QueryClientProvider client={client}>
        <HostUsageProvider>{children}</HostUsageProvider>
      </QueryClientProvider>
    )
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

const REMOTE_HEALTH = {
  ...HEALTH,
  capabilities: { ...HEALTH.capabilities, localHandoff: false },
}

/** jsdom has no `matchMedia`; the card's writers are gated on it, so each test picks a viewport. */
function stubViewport(desktop: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

/**
 * The cockpit's socket is `api/ws.ts`'s module-level singleton and outlives a test: a later
 * subscribe reuses the same instance while it is still open, and builds a new one once it closed.
 * `FakeSocket.instances` is therefore never reset; a test compares against the baseline it took
 * when it started, so "no socket" and "the socket I was already using" are both provable.
 */
let socketBaseline = 0
let frameBaselines = new Map<FakeSocket, number>()

function socketsCreatedThisTest(): FakeSocket[] {
  return FakeSocket.instances.slice(socketBaseline)
}

/** The frames a socket sent SINCE this test started; the shared one carries the previous test's. */
function newFrames(socket: FakeSocket): string[] {
  return socket.sent.slice(frameBaselines.get(socket) ?? 0)
}

/**
 * The socket that currently holds the `host` topic. The module reuses its singleton whenever it is
 * still open and builds a new one once it closed, so this opens whatever is still connecting and
 * then answers with the instance that actually sent this test's subscribe frame.
 */
async function subscribedSocket(): Promise<FakeSocket> {
  let found: FakeSocket | undefined
  await waitFor(() => {
    const pending = FakeSocket.instances.filter((socket) => socket.readyState === 0)
    if (pending.length > 0) act(() => pending.forEach((socket) => socket.open()))
    found = FakeSocket.instances
      .filter((socket) =>
        newFrames(socket).some((raw) => raw.includes('"subscribe"') && raw.includes('"host"')),
      )
      .pop()
    expect(found).toBeDefined()
  })
  return found as FakeSocket
}

beforeEach(() => {
  socketBaseline = FakeSocket.instances.length
  frameBaselines = new Map(FakeSocket.instances.map((socket) => [socket, socket.sent.length]))
  vi.stubGlobal('WebSocket', FakeSocket)
  stubViewport(true)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MachineCard — local cockpit, desktop', () => {
  it('shows sampling… before the first CPU delta, then the live card', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })

    const socket = await subscribedSocket()
    // The hub's first frame: memory and load exist, the CPU delta does not yet.
    act(() => {
      socket.deliver('host', sample({ loadAvg: undefined, swapTotalBytes: undefined }))
    })
    await waitFor(() => expect(screen.getByText('12.0 GB / 32.0 GB')).toBeTruthy())
    expect(screen.getByText('sampling…')).toBeTruthy()
    expect(document.querySelector('[data-slot="machine-card-cpu-sparkline"]')).toBeNull()
    // Windows-style host: no load row and no swap row, rather than zeros.
    expect(document.querySelector('[data-slot="machine-card-load"]')).toBeNull()
    expect(document.querySelector('[data-slot="machine-card-swap"]')).toBeNull()
    expect(screen.getByText('live')).toBeTruthy()
    expect(screen.getByText(/Host totals - no cgroup limit/)).toBeTruthy()

    act(() => {
      socket.deliver('host', sample({ cpuPct: 38.4, sampledAt: '2026-09-20T00:00:02.000Z' }))
    })
    await waitFor(() => expect(screen.getByText('38%')).toBeTruthy())
    act(() => {
      socket.deliver('host', sample({ cpuPct: 41.2, sampledAt: '2026-09-20T00:00:04.000Z' }))
    })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="machine-card-cpu-sparkline"]')).not.toBeNull(),
    )
    expect(screen.getByText('1.1 GB / 8.0 GB')).toBeTruthy()
    expect(screen.getByText(/1\.42 · 0\.98 · 0\.76/)).toBeTruthy()
    expect(screen.getByText('4 cores')).toBeTruthy()
  })

  it('renders the effective numbers under a cgroup limit, with the host totals as context', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })
    const socket = await subscribedSocket()

    act(() => {
      socket.deliver(
        'host',
        sample({
          cpuCount: 8,
          cpuPct: 31,
          container: {
            source: 'cgroup-v2',
            cpuQuotaCores: 2,
            memLimitBytes: 2 * 1024 ** 3,
            memUsedBytes: 1.5 * 1024 ** 3,
            cpuPct: 50,
          },
          hostCpuCount: 8,
        }),
      )
    })

    await waitFor(() => expect(screen.getByText('cgroup limits detected · cgroup-v2')).toBeTruthy())
    // `2 CPU · 50%` is the cgroup's own delta against effective cores, not the 31 % host figure.
    expect(screen.getByText('2 CPU · 50%')).toBeTruthy()
    expect(screen.getByText('1.5 GB / 2.0 GB')).toBeTruthy()
    expect(screen.getByText('host 8 CPU · 32.0 GB RAM')).toBeTruthy()
    // The load chip pairs with the HOST core count once a container exists, and says so: the row
    // above it is already the effective one.
    expect(screen.getByText('host 8 cores')).toBeTruthy()
    expect(screen.getByText(/Effective values come from this process/)).toBeTruthy()
  })

  it('labels a cpuset-only pin, where quota and memory read unlimited', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })
    const socket = await subscribedSocket()

    act(() => {
      socket.deliver(
        'host',
        sample({
          cpuCount: 2,
          container: { source: 'cgroup-v2', cpuAffinityCores: 2, cpuPct: 100 },
          hostCpuCount: 24,
        }),
      )
    })

    await waitFor(() => expect(screen.getByText('cpuset 2 CPU · 100%')).toBeTruthy())
    expect(screen.getByText('host 24 CPU · 32.0 GB RAM')).toBeTruthy()
    // The memory pair stays the host's: a cpuset pin says nothing about memory.
    expect(screen.getByText('12.0 GB / 32.0 GB')).toBeTruthy()
    expect(screen.getByText(/no cgroup limit|Effective values/)).toBeTruthy()
  })

  it('shows — for a limit whose own value is missing, never the host figure', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })
    const socket = await subscribedSocket()

    act(() => {
      socket.deliver(
        'host',
        sample({
          cpuCount: 8,
          cpuPct: 22,
          container: { source: 'cgroup-v2', cpuQuotaCores: 6, memLimitBytes: 8 * 1024 ** 3 },
          hostCpuCount: 8,
        }),
      )
    })

    await waitFor(() => expect(screen.getByText('6 CPU · —')).toBeTruthy())
    // The limit is known and the usage is not: `— / 8.0 GB`, not the host's 12 GB beside it.
    expect(screen.getByText('— / 8.0 GB')).toBeTruthy()
    expect(screen.queryByText(/22%/)).toBeNull()
  })

  it('prints the dispatch admission readout under the limits line, verbatim', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })
    const socket = await subscribedSocket()

    act(() => {
      socket.deliver(
        'host',
        sample({
          cpuPct: 18,
          container: {
            source: 'cgroup-v2',
            memLimitBytes: 2 * 1024 ** 3,
            memUsedBytes: 1024 ** 3,
          },
          hostCpuCount: 8,
          admission: {
            state: 'elevated',
            configured: 4,
            effective: 2,
            since: '2026-09-20T00:00:00.000Z',
          },
        }),
      )
    })

    await waitFor(() => expect(screen.getByText('cgroup limits detected · cgroup-v2')).toBeTruthy())
    const line = screen.getByText('Dispatch admission: elevated · 2 of 4')
    expect(line.getAttribute('data-slot')).toBe('machine-card-admission')
    // "Under the limits line" is the point: the ceiling's owner reads the two together.
    const limits = screen.getByText('cgroup limits detected · cgroup-v2')
    expect(
      (limits.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true)
  })

  it('carries no admission line when the sample has no ceiling', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })
    const socket = await subscribedSocket()

    act(() => {
      socket.deliver('host', sample({ cpuPct: 24, sampledAt: '2026-09-20T00:00:02.000Z' }))
    })
    await waitFor(() => expect(screen.getByText('24%')).toBeTruthy())
    expect(document.querySelector('[data-slot="machine-card-admission"]')).toBeNull()
    expect(screen.queryByText(/Dispatch admission/)).toBeNull()
  })

  it('drops a snapshot whose ceiling pair is incomplete instead of rendering half a line', async () => {
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })
    const socket = await subscribedSocket()

    // `configured` and `effective` ship together inside the `admission` object, or the key is
    // absent. A producer that sends half of the pair is rejected at the store boundary (the one
    // place untrusted frames enter), so the card keeps `sampling…` rather than printing
    // `Dispatch admission: normal ·  of `.
    act(() => {
      socket.deliver('host', {
        ...sample({ cpuPct: 27, sampledAt: '2026-09-20T00:00:02.000Z' }),
        admission: { state: 'normal' },
      })
    })
    await waitFor(() => expect(screen.getByText('sampling…')).toBeTruthy())
    expect(document.querySelector('[data-slot="machine-card-admission"]')).toBeNull()
  })
})

describe('MachineCard — local cockpit, below md', () => {
  it('is itself the writer: the phone layout subscribes through the card', async () => {
    stubViewport(false)
    serve(HEALTH)
    render(<MachineCard />, { wrapper: wrapper() })

    const socket = await subscribedSocket()
    act(() => {
      socket.deliver('host', sample({ cpuPct: 9, sampledAt: '2026-09-20T00:00:02.000Z' }))
    })
    await waitFor(() => expect(screen.getByText('9%')).toBeTruthy())
  })
})

describe('MachineCard — remote cockpit', () => {
  it('reads the route, opens no socket, and labels the values last known', async () => {
    serve(REMOTE_HEALTH, sample({ cpuPct: 12 }))
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('12%')).toBeTruthy())
    expect(screen.getByText('last known')).toBeTruthy()
    expect(socketsCreatedThisTest()).toHaveLength(0)
    expect(document.querySelector('[data-slot="machine-card-swap"]')).not.toBeNull()
  })

  it('follows a first answer without cpuPct with one warm-up read', async () => {
    let reads = 0
    serve(REMOTE_HEALTH, () => {
      reads += 1
      return reads === 1 ? sample() : sample({ cpuPct: 7.5 })
    })
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('sampling…')).toBeTruthy())
    // The warm-up is a real 2.5 s wait; the assertion is on the bounded behavior.
    await waitFor(() => expect(screen.getByText('8%')).toBeTruthy(), { timeout: 5_000 })
    expect(reads).toBe(2)
  })

  it('admits failure instead of waiting forever when the route rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/v1/health')) return json(REMOTE_HEALTH)
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    render(<MachineCard />, { wrapper: wrapper() })

    await waitFor(() => expect(screen.getByText('Host totals are unavailable right now.')).toBeTruthy())
    // The card still explains itself rather than going blank.
    expect(screen.getByText(/Host totals - no cgroup limit|Effective values/)).toBeTruthy()
  })
})
