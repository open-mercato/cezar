import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunHistoryContext, RunHistoryPage } from '@open-mercato/cezar-api-client'
import { getRunHistory, getRunHistoryContext } from './client'
import { useRunHistory } from './run-history'

vi.mock('./client', () => ({
  getRunHistory: vi.fn(),
  getRunHistoryContext: vi.fn(),
}))

const mockHistory = vi.mocked(getRunHistory)
const mockContext = vi.mocked(getRunHistoryContext)

class FakeEventSource {
  static instances: FakeEventSource[] = []
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readyState = 0

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  close(): void {
    this.readyState = 2
  }

  emit(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }))
  }
}

const page = (
  seq: number,
  extras: Partial<RunHistoryPage> = {},
): RunHistoryPage => ({
  events: [{ seq, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: `event-${seq}` }],
  itemCount: 1,
  liveCursor: `live-${seq}`,
  asOfSeq: seq,
  hasOlder: false,
  ...extras,
})

const context = (seq = 90): RunHistoryContext => ({
  contextEvents: [{
    seq,
    ts: '2026-07-30T00:00:00.000Z',
    type: 'plan.updated',
    entries: [{ content: 'current plan', status: 'in_progress' }],
  }],
  asOfSeq: 100,
})

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom deliberately has no native EventSource; the stream hook degrades to no live frames.
  Reflect.deleteProperty(globalThis, 'EventSource')
})

describe('useRunHistory', () => {
  it('hydrates the visible tail and current context independently, then prepends one older page', async () => {
    mockHistory.mockImplementation(async (_id, cursor) =>
      cursor === 'older-100'
        ? page(1)
        : page(100, { olderCursor: 'older-100', hasOlder: true }),
    )
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })

    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([100])
    expect(result.current.currentEvents.map(({ seq }) => seq)).toEqual([90])
    expect(result.current.hasOlder).toBe(true)

    await act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([1, 100]))
    expect(mockHistory).toHaveBeenLastCalledWith('run-1', 'older-100', expect.any(Object))
    expect(result.current.retainedPages).toBe(2)
  })

  it('falls back to the protected full replay when either optimized request cannot load', async () => {
    mockHistory.mockRejectedValue(new Error('old server'))
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })

    await waitFor(() => expect(result.current.fallback).toBe(true), { timeout: 3_000 })
    expect(result.current.isPending).toBe(false)
    expect(result.current.hasOlder).toBe(false)
  })

  it('jump-to-latest clears retained older pages and refetches the cursorless tail', async () => {
    mockHistory.mockImplementation(async (_id, cursor) =>
      cursor === 'older-100'
        ? page(1)
        : page(100, { olderCursor: 'older-100', hasOlder: true }),
    )
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.retainedPages).toBe(2))

    await act(() => result.current.jumpToLatest())
    await waitFor(() => expect(result.current.retainedPages).toBe(1))
    expect(mockHistory).toHaveBeenLastCalledWith('run-1', undefined, expect.any(Object))
  })

  it('compacts a long live prefix into a fresh persisted tail page', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const compactedTail: RunHistoryPage = {
      ...page(300),
      events: Array.from({ length: 100 }, (_, index) => ({
        seq: 201 + index,
        ts: '2026-07-30T00:00:00.000Z',
        type: 'note',
        message: `event-${201 + index}`,
      })),
      itemCount: 100,
    }
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockResolvedValue(compactedTail)
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    act(() => {
      for (let seq = 101; seq <= 300; seq += 1) {
        FakeEventSource.instances[0]!.emit(
          'run-event',
          JSON.stringify({
            seq,
            ts: '2026-07-30T00:00:00.000Z',
            type: 'note',
            message: `event-${seq}`,
          }),
        )
      }
    })

    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(300))
    expect(result.current.visibleEvents).toHaveLength(100)
    expect(result.current.visibleEvents[0]?.seq).toBe(201)
    expect(result.current.retainedPages).toBe(1)
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2)
    vi.unstubAllGlobals()
  })

  /**
   * The compaction call is fire-and-forget, so it has no query to carry a rejection (#827).
   * Since the client now REJECTS a malformed history page instead of casting it, this path can
   * be reached by a bad body as well as by a transport error — and must stay a silent no-op
   * rather than an unhandled rejection that fails the surrounding render.
   */
  it('survives a failed compaction: the live transcript stands and the guard reopens', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockRejectedValue(new Error('the cezar server answered /runs/run-1/history with an unexpected body'))
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    act(() => {
      for (let seq = 101; seq <= 300; seq += 1) {
        FakeEventSource.instances[0]!.emit(
          'run-event',
          JSON.stringify({ seq, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: `event-${seq}` }),
        )
      }
    })

    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))
    // Nothing was compacted, so the events the SSE already delivered are still what renders.
    expect(result.current.visibleEvents.at(-1)?.seq).toBe(300)
    // A failed compaction is not a load failure: the transcript must NOT drop to full replay.
    expect(result.current.fallback).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()

    process.off('unhandledRejection', unhandled)
    vi.unstubAllGlobals()
  })
})
