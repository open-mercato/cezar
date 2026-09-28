import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostUsage } from '@open-mercato/cezar-api-client'
import {
  createHostUsageStore,
  HostUsageProvider,
  HOST_HISTORY_GAP_MS,
  HOST_USAGE_WARMUP_MS,
  readWorkspaceHostUsage,
  useHostHistory,
  useHostLastFrameAt,
  useHostSubscription,
  useHostUsage,
  useHostUsageRoute,
  useHostUsageSubscription,
} from './host-usage'
import { createQueryClient } from './query-client'

/**
 * The Machine card's and the widget's data layer (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`): a local cockpit reads pushed `host`
 * frames into the per-app store and never fetches; a remote one reads the route and follows an
 * answer without `cpuPct` with EXACTLY ONE warm-up read — never an interval, and no socket at all.
 * Exactly one writer is live per viewport, and the store dedupes, gaps and resets honestly.
 */

const fetchMock = vi.fn<typeof fetch>()

const HEALTH_REMOTE = {
  version: '0.1.3',
  repoRoot: '/srv/cezar',
  repo: { root: '/srv/cezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  capabilities: { localHandoff: false, followups: false, singleProject: false, automations: false },
}

const HEALTH_LOCAL = {
  ...HEALTH_REMOTE,
  capabilities: { ...HEALTH_REMOTE.capabilities, localHandoff: true },
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Minimal socket stand-in (api/ws.ts reads the constructor off `globalThis`). */
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

  frames(): Array<{ type: string; topic: string }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; topic: string })
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

/** The same provider, mounted the way the app mounts it: inside `StrictMode` (main.tsx). */
function strictWrapper() {
  const Inner = wrapper()
  return function StrictWrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <Inner>{children}</Inner>
      </StrictMode>
    )
  }
}

/** Counts the route reads the client actually issued. */
function routeCalls(): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes('/api/v1/workspace/host-usage')).length
}

/**
 * The cockpit's socket is `api/ws.ts`'s module-level singleton, so it OUTLIVES a test: the next
 * subscribe reuses the same instance when it is still open and builds a new one when it closed.
 * These helpers make assertions honest either way - `FakeSocket.instances` is never reset, and a
 * test looks at the delta it created plus the frames the live socket sent from its own baseline.
 */
let socketBaseline = 0

function socketsCreatedThisTest(): FakeSocket[] {
  return FakeSocket.instances.slice(socketBaseline)
}

function liveSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
  if (!socket) throw new Error('no socket has been opened yet')
  return socket
}

/** Flush whatever the shared socket still owes: opening it is what releases queued frames. */
async function subscribedTo(topic: string, from: number): Promise<void> {
  const socket = liveSocket()
  if (socket.readyState === 0) act(() => socket.open())
  await waitFor(() =>
    expect(
      socket.frames().slice(from).some((frame) => frame.type === 'subscribe' && frame.topic === topic),
    ).toBe(true),
  )
}

/** Desktop (`md` and up) is the default here; the phone cases stub this to `false`. */
function stubViewport(desktop: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

beforeEach(() => {
  socketBaseline = FakeSocket.instances.length
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeSocket)
  stubViewport(true)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useHostUsageRoute — remote transport', () => {
  it('reads the route once when the answer already carries cpuPct, and folds it into the store', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_REMOTE)
      return json(sample({ cpuPct: 38.4 }))
    })

    const { result } = renderHook(() => ({ route: useHostUsageRoute(), store: useHostUsage() }), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.route.data?.cpuPct).toBe(38.4))
    await waitFor(() => expect(result.current.store?.cpuPct).toBe(38.4))
    expect(routeCalls()).toBe(1)
    expect(socketsCreatedThisTest()).toHaveLength(0)
  })

  it('follows an answer without cpuPct with exactly one warm-up read, then stops', async () => {
    vi.useFakeTimers()
    let reads = 0
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_REMOTE)
      reads += 1
      return json(reads === 1 ? sample() : sample({ cpuPct: 12.5 }))
    })

    const { result } = renderHook(() => ({ route: useHostUsageRoute(), store: useHostUsage() }), {
      wrapper: wrapper(),
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(routeCalls()).toBe(1)
    expect(result.current.route.data?.cpuPct).toBeUndefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_USAGE_WARMUP_MS + 50)
    })
    expect(routeCalls()).toBe(2)
    expect(result.current.route.data?.cpuPct).toBe(12.5)
    expect(result.current.store?.cpuPct).toBe(12.5)

    // Nothing schedules a third read: the warm-up is bounded, not an interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_USAGE_WARMUP_MS * 10)
    })
    expect(routeCalls()).toBe(2)
  })

  it('opens no socket and reads nothing in remote mode', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_REMOTE)
      return json(sample({ cpuPct: 5 }))
    })

    renderHook(() => useHostUsageSubscription(), { wrapper: wrapper() })
    await act(async () => {
      await Promise.resolve()
    })
    expect(socketsCreatedThisTest()).toHaveLength(0)
    expect(routeCalls()).toBe(0)
  })
})

describe('useHostUsageSubscription — local transport', () => {
  it('never fetches, subscribes in the caller’s view, and folds pushed frames into the store', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_LOCAL)
      throw new Error(`unexpected fetch in local mode: ${url}`)
    })

    const { result, unmount } = renderHook(
      () => {
        // The card's own view effect IS the writer below `md`: it calls this hook with
        // `enabled: !useIsDesktop()`, which is what a phone layout mounts.
        useHostUsageSubscription({ enabled: true })
        return {
          sample: useHostUsage(),
          history: useHostHistory(),
          lastFrameAt: useHostLastFrameAt(),
        }
      },
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0))
    const socket = liveSocket()
    const frameBaseline = socket.frames().length
    await subscribedTo('host', frameBaseline)
    expect(routeCalls()).toBe(0)

    act(() => {
      socket.deliver(
        'host',
        sample({ cpuPct: 61.2, sampledAt: '2026-09-20T00:00:02.000Z' }),
      )
    })
    await waitFor(() => expect(result.current.sample?.cpuPct).toBe(61.2))
    // The receipt stamp and the ring are the widget's clock and the card's sparkline.
    expect(result.current.lastFrameAt).toEqual(expect.any(Number))
    expect(result.current.history).toHaveLength(1)

    // A frame the schema rejects never reaches the card as a half-filled sample.
    act(() => {
      socket.deliver('host', { sampledAt: 'nope', cpuCount: 0 })
    })
    expect(result.current.sample?.cpuPct).toBe(61.2)

    unmount()
    await waitFor(() =>
      expect(
        socket
          .frames()
          .slice(frameBaseline)
          .some((frame) => frame.type === 'unsubscribe' && frame.topic === 'host'),
      ).toBe(true),
    )
  })
})

describe('useHostSubscription — the root writer', () => {
  const localOnly = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('/api/v1/health')) return json(HEALTH_LOCAL)
    throw new Error(`unexpected fetch in local mode: ${url}`)
  }

  it('stays off below md, where the card is the only demand', async () => {
    fetchMock.mockImplementation(localOnly)
    stubViewport(false)

    renderHook(() => useHostSubscription(), { wrapper: wrapper() })
    await act(async () => {
      await Promise.resolve()
    })
    expect(socketsCreatedThisTest()).toHaveLength(0)
  })

  it('subscribes once on desktop and releases the topic on unmount, under StrictMode', async () => {
    fetchMock.mockImplementation(localOnly)

    const { result, unmount } = renderHook(
      () => {
        useHostSubscription()
        return { sample: useHostUsage(), history: useHostHistory() }
      },
      { wrapper: strictWrapper() },
    )
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0))
    const socket = liveSocket()
    const frameBaseline = socket.frames().length
    // ONE subscribe frame for ONE root writer: the bus ref-counts topics, so a second writer in
    // the same viewport would show up here as a second frame.
    await subscribedTo('host', frameBaseline)
    expect(
      socket
        .frames()
        .slice(frameBaseline)
        .filter((frame) => frame.type === 'subscribe' && frame.topic === 'host'),
    ).toHaveLength(1)

    // StrictMode's mount → unmount → mount must still fold ONE frame once: two folds would show
    // up as a doubled ring.
    act(() => {
      socket.deliver('host', sample({ cpuPct: 44, sampledAt: '2026-09-20T00:00:08.000Z' }))
    })
    await waitFor(() => expect(result.current.sample?.cpuPct).toBe(44))
    expect(result.current.history).toHaveLength(1)

    unmount()
    await waitFor(() =>
      expect(
        socket
          .frames()
          .slice(frameBaseline)
          .some((frame) => frame.type === 'unsubscribe' && frame.topic === 'host'),
      ).toBe(true),
    )
  })
})

describe('createHostUsageStore', () => {
  const point = (sampledAt: string): HostUsage => sample({ sampledAt, cpuPct: 10 })

  it('keeps identity stable for a replayed sample and never doubles a point', () => {
    const store = createHostUsageStore()
    const first = point('2026-09-20T00:00:00.000Z')
    store.push(first, 1_000, 'root')
    const after = store.get()
    store.push(first, 1_000, 'root')
    expect(store.get()).toBe(after)
    // A later receipt of the SAME server sample refreshes the clock without a second point.
    store.push(first, 2_000, 'root')
    expect(store.get().history).toHaveLength(1)
    expect(store.get().lastFrameAt).toBe(2_000)
  })

  it('clears the ring on a writer change and on a gap', () => {
    const store = createHostUsageStore()
    store.push(point('2026-09-20T00:00:00.000Z'), 1_000, 'card')
    store.push(point('2026-09-20T00:00:02.000Z'), 3_000, 'card')
    expect(store.get().history).toHaveLength(2)

    // The card unmounts and the root takes over: the line restarts rather than bridging writers.
    store.push(point('2026-09-20T00:00:04.000Z'), 5_000, 'root')
    expect(store.get().history).toHaveLength(1)

    // A reconnection that skipped more than four frames is not a line either.
    const next = new Date(
      Date.parse('2026-09-20T00:00:04.000Z') + HOST_HISTORY_GAP_MS + 2_000,
    ).toISOString()
    store.push(point(next), 9_000, 'root')
    expect(store.get().history).toHaveLength(1)
  })

  it('clears the ring even when the new writer replays the sample the old one delivered', () => {
    const store = createHostUsageStore()
    const cardsSample = sample({ sampledAt: '2026-09-20T00:00:00.000Z', cpuPct: 10 })
    store.push(cardsSample, 1_000, 'card')
    store.push(sample({ sampledAt: '2026-09-20T00:00:02.000Z', cpuPct: 20 }), 3_000, 'card')
    expect(store.get().history).toHaveLength(2)

    // A rotation across `md`: the root writer's first frame is the topic snapshot, which repeats
    // the last sampledAt. The line belongs to the new writer, so it restarts - with that one
    // point, not with a duplicate of the old writer's two.
    store.push(cardsSample, 4_000, 'root')
    expect(store.get().history.map((entry) => entry.cpuPct)).toEqual([10])
  })

  it('drops CPU-less samples from the ring and forgets everything on reset', () => {
    const store = createHostUsageStore()
    store.push(sample({ sampledAt: '2026-09-20T00:00:00.000Z' }), 1_000, 'root')
    expect(store.get().latest).toBeDefined()
    expect(store.get().history).toHaveLength(0)
    store.reset()
    expect(store.get().latest).toBeUndefined()
    expect(store.get().lastFrameAt).toBeUndefined()
  })

  it('never builds the sparkline ring from remote route answers', () => {
    const store = createHostUsageStore()
    // The route writer answers on mount and on a reconnect/visibility reconcile - sparse and
    // irregular. A line scaled to the server's 2 s cadence would state a rate nobody measured, so
    // remote keeps the instantaneous bar and no chart; the latest sample and the receipt clock
    // (which the widget's `stale` state reads) still arrive.
    store.push(point('2026-09-20T00:00:00.000Z'), 1_000, 'route')
    store.push(point('2026-09-20T00:00:02.500Z'), 3_500, 'route')
    expect(store.get().latest).toBeDefined()
    expect(store.get().lastFrameAt).toBe(3_500)
    expect(store.get().history).toHaveLength(0)
  })

  it('records a refused topic until a fresh mount, and a late frame never clears it', () => {
    const store = createHostUsageStore()
    expect(store.get().topicUnavailable).toBeUndefined()
    store.markTopicUnavailable()
    expect(store.get().topicUnavailable).toBe(true)
    // A route-fallback sample arriving afterwards is a different fact about the same origin: the
    // refusal stands until the store is recreated (a fresh mount re-subscribes).
    store.push(point('2026-09-20T00:00:00.000Z'), 1_000, 'route')
    expect(store.get().topicUnavailable).toBe(true)
    store.reset()
    expect(store.get().topicUnavailable).toBeUndefined()
  })

  it('rings the EFFECTIVE percentage, so the line under a number is the same quantity', () => {
    const store = createHostUsageStore()
    // A sandboxed sample: 31 % host-wide, 50 % of the two effective cores.
    store.push(
      sample({
        cpuPct: 31,
        sampledAt: '2026-09-20T00:00:00.000Z',
        container: { source: 'cgroup-v2', cpuQuotaCores: 2, cpuPct: 50 },
        hostCpuCount: 8,
      }),
      1_000,
      'root',
    )
    expect(store.get().history.map((entry) => entry.cpuPct)).toEqual([50])

    // A CPU limit whose own percentage is unreadable contributes no point at all: the surface
    // renders `—`, and a line of host utilization would be the scope mix this rule exists to stop.
    store.push(
      sample({
        cpuPct: 31,
        sampledAt: '2026-09-20T00:00:02.000Z',
        container: { source: 'cgroup-v2', cpuQuotaCores: 2 },
        hostCpuCount: 8,
      }),
      3_000,
      'root',
    )
    expect(store.get().history.map((entry) => entry.cpuPct)).toEqual([50])
  })
})

describe('readWorkspaceHostUsage', () => {
  it('aborts the pending warm-up when the caller aborts, without a second read', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_REMOTE)
      controller.abort()
      return json(sample())
    })

    await expect(readWorkspaceHostUsage(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(routeCalls()).toBe(1)
  })
})
