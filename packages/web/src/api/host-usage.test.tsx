import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostUsage } from '@open-mercato/cezar-api-client'
import {
  HOST_USAGE_WARMUP_MS,
  readWorkspaceHostUsage,
  useHostUsage,
  useHostUsageSubscription,
} from './host-usage'
import { createQueryClient } from './query-client'
import { workspaceQueryKeys } from './queries'

/**
 * The Machine card's transport rules (spec `.ai/specs/2026-09-20-host-resource-telemetry.md`):
 * a local cockpit reads pushed `host` frames and never fetches; a remote one reads the route and
 * follows an answer without `cpuPct` with EXACTLY ONE warm-up read — never an interval, and no
 * socket at all.
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
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

/** Counts the route reads the client actually issued. */
function routeCalls(): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes('/api/v1/workspace/host-usage')).length
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useHostUsage — remote transport', () => {
  it('reads the route once when the answer already carries cpuPct', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_REMOTE)
      return json(sample({ cpuPct: 38.4 }))
    })

    const { result } = renderHook(() => useHostUsage(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.cpuPct).toBe(38.4))
    expect(routeCalls()).toBe(1)
    expect(FakeSocket.instances).toHaveLength(0);
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

    const { result } = renderHook(() => useHostUsage(), { wrapper: wrapper() })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(routeCalls()).toBe(1)
    expect(result.current.data?.cpuPct).toBeUndefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_USAGE_WARMUP_MS + 50)
    })
    expect(routeCalls()).toBe(2)
    expect(result.current.data?.cpuPct).toBe(12.5)

    // Nothing schedules a third read: the warm-up is bounded, not an interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_USAGE_WARMUP_MS * 10)
    })
    expect(routeCalls()).toBe(2)
  })

  it('opens no socket and subscribes to nothing in remote mode', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_REMOTE)
      return json(sample({ cpuPct: 5 }))
    })

    renderHook(() => useHostUsageSubscription(), { wrapper: wrapper() })
    await act(async () => {
      await Promise.resolve()
    })
    expect(FakeSocket.instances).toHaveLength(0)
    expect(routeCalls()).toBe(0)
  })
})

describe('useHostUsage — local transport', () => {
  it('never fetches, subscribes in the caller’s view, and folds pushed frames into the cache', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/health')) return json(HEALTH_LOCAL)
      throw new Error(`unexpected fetch in local mode: ${url}`)
    })

    const { result, unmount } = renderHook(
      () => {
        useHostUsageSubscription()
        return useHostUsage()
      },
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0))
    act(() => {
      FakeSocket.instances[0]?.open()
    })
    await waitFor(() =>
      expect(FakeSocket.instances[0]?.frames().some((frame) => frame.topic === 'host')).toBe(true),
    )
    expect(routeCalls()).toBe(0)

    act(() => {
      FakeSocket.instances[0]?.deliver('host', sample({ cpuPct: 61.2, sampledAt: '2026-09-20T00:00:02.000Z' }))
    })
    await waitFor(() => expect(result.current.data?.cpuPct).toBe(61.2))

    // A frame the schema rejects never reaches the card as a half-filled sample.
    act(() => {
      FakeSocket.instances[0]?.deliver('host', { sampledAt: 'nope', cpuCount: 0 })
    })
    expect(result.current.data?.cpuPct).toBe(61.2)

    // Leaving the view is the 1→0: the unsubscribe goes out and no more frames are folded.
    unmount()
    await waitFor(() =>
      expect(
        FakeSocket.instances[0]?.frames().some((frame) => frame.type === 'unsubscribe' && frame.topic === 'host'),
      ).toBe(true),
    )
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
