import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunHistoryContext, RunHistoryPage } from '@open-mercato/cezar-api-client'
import { getRunHistory, getRunHistoryContext } from './client'
import { coveredLiveEventSeqs, mergeRunHistoryEvents, useRunHistory } from './run-history'

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
  it('appends a strictly newer live tail without re-sorting the retained page', () => {
    const base = [page(1).events[0]!, page(2).events[0]!]
    const live = [page(3).events[0]!, page(7).events[0]!]

    expect(mergeRunHistoryEvents(base, live).map(({ seq }) => seq)).toEqual([1, 2, 3, 7])
  })

  it('keeps reconnect overlap safe by falling back to ordered deduplication', () => {
    const base = [page(1).events[0]!, page(3).events[0]!]
    const replay = [page(2).events[0]!, page(3).events[0]!, page(4).events[0]!]

    expect(mergeRunHistoryEvents(base, replay).map(({ seq }) => seq)).toEqual([1, 2, 3, 4])
  })

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

  it('keeps late live frames in current state when context has a newer high-water mark', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    mockHistory.mockResolvedValue(page(100))
    mockContext.mockResolvedValue({ ...context(), asOfSeq: 300 })
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    FakeEventSource.instances[0]!.emit(
      'ui-event',
      JSON.stringify({ seq: 250, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: 'late-live' }),
    )
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(250))
    expect(result.current.currentEvents.map(({ seq }) => seq)).toEqual([90, 250])
    vi.unstubAllGlobals()
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

  it('keeps the optimized stream after an older-page failure so the retry remains available', async () => {
    mockHistory.mockImplementation(async (_id, cursor) => {
      if (cursor === 'older-100') throw new Error('older page unavailable')
      return page(100, { olderCursor: 'older-100', hasOlder: true })
    })
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(result.current.hasOlder).toBe(true))

    await act(async () => {
      await result.current.loadOlder().catch(() => undefined)
    })
    await waitFor(() => expect(result.current.isFetchingOlder).toBe(false))
    expect(result.current.fallback).toBe(false)
    expect(result.current.hasOlder).toBe(true)
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

  it('jumps to the latest tail without waiting for a hung older-page request', async () => {
    let resolveOlder!: (value: RunHistoryPage) => void
    const older = new Promise<RunHistoryPage>((resolve) => {
      resolveOlder = resolve
    })
    mockHistory.mockImplementation(async (_id, cursor) => {
      if (cursor === 'older-100') return older
      return page(100, { olderCursor: 'older-100', hasOlder: true })
    })
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(result.current.hasOlder).toBe(true))

    let loadingOlder!: Promise<void>
    act(() => {
      loadingOlder = result.current.loadOlder().catch(() => undefined)
    })
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))

    await act(async () => result.current.jumpToLatest())
    await waitFor(() => expect(result.current.retainedPages).toBe(1))
    expect(mockHistory).toHaveBeenCalledTimes(3)

    resolveOlder(page(1))
    await act(async () => loadingOlder)
    expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([100])
  })

  it('keeps the newest tail when maxPages evicts it during older-page browsing', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const olderPages: Record<string, RunHistoryPage> = {
      'older-1': page(90, { olderCursor: 'older-2', newerCursor: 'newer', hasOlder: true }),
      'older-2': page(80, { olderCursor: 'older-3', newerCursor: 'newer', hasOlder: true }),
      'older-3': page(70, { olderCursor: 'older-4', newerCursor: 'newer', hasOlder: true }),
      'older-4': page(60, { olderCursor: 'older-5', newerCursor: 'newer', hasOlder: true }),
      'older-5': page(50, { newerCursor: 'newer', hasOlder: false }),
    }
    mockHistory.mockImplementation(async (_id, cursor) =>
      cursor === undefined
        ? page(100, { olderCursor: 'older-1', hasOlder: true })
        : olderPages[cursor]!,
    )
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
    client.setQueryDefaults(['run-history'], { staleTime: Infinity })
    const first = renderHook(() => useRunHistory('run-1'), { wrapper })
    const { result } = first
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    for (let index = 1; index <= 5; index += 1) {
      await act(() => result.current.loadOlder())
      await waitFor(() => expect(result.current.retainedPages).toBe(Math.min(index + 1, 5)))
    }

    expect(result.current.retainedPages).toBe(5)
    expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([50, 60, 70, 80, 90, 100])
    expect(FakeEventSource.instances.at(-1)?.url).toBe('/api/v1/runs/run-1/events?cursor=live-100&afterSeq=100')

    first.unmount()
    renderHook(() => useRunHistory('run-1'), { wrapper })
    expect(FakeEventSource.instances.at(-1)?.url).toBe('/api/v1/runs/run-1/events?cursor=live-100&afterSeq=100')
  })

  it('does not let an older task request patch the current task cache', async () => {
    let resolveOlder!: (value: RunHistoryPage) => void
    const older = new Promise<RunHistoryPage>((resolve) => {
      resolveOlder = resolve
    })
    mockHistory.mockImplementation(async (id, cursor) => {
      if (id === 'run-a' && cursor === 'older-a') return older
      if (id === 'run-a') return page(100, { olderCursor: 'older-a', hasOlder: true })
      return page(200)
    })
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
    const { result, rerender } = renderHook(({ runId }: { runId: string }) => useRunHistory(runId), {
      initialProps: { runId: 'run-a' },
      wrapper,
    })
    await waitFor(() => expect(result.current.hasOlder).toBe(true))

    let loadingOlder!: Promise<void>
    act(() => {
      loadingOlder = result.current.loadOlder()
    })
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))
    rerender({ runId: 'run-b' })
    await waitFor(() => expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([200]))

    resolveOlder(page(1))
    await act(async () => loadingOlder)
    const runAEvents = client.getQueryData<{ pages: RunHistoryPage[] }>(['run-history', 'default', 'run-a'])?.pages
      .flatMap(({ events }) => events.map(({ seq }) => seq)) ?? []
    expect(runAEvents).toContain(100)
    expect(runAEvents).not.toContain(200)
    expect(client.getQueryData<{ pages: RunHistoryPage[] }>(['run-history', 'default', 'run-b'])?.pages
      .flatMap(({ events }) => events.map(({ seq }) => seq))).toEqual([200])
  })

  it('refreshes the tail while older-page loading is still pending', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    let resolveOlder!: (value: RunHistoryPage) => void
    const older = new Promise<RunHistoryPage>((resolve) => {
      resolveOlder = resolve
    })
    let resolveCompacted!: (value: RunHistoryPage) => void
    const compacted = new Promise<RunHistoryPage>((resolve) => {
      resolveCompacted = resolve
    })
    mockHistory.mockImplementation(async (_id, cursor) => {
      if (cursor === 'older-100') return older
      if (cursor === undefined && mockHistory.mock.calls.length > 1) return compacted
      return page(100, { olderCursor: 'older-100', hasOlder: true })
    })
    mockContext.mockResolvedValue(context())
    const { wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    let loadingOlder!: Promise<void>
    act(() => {
      loadingOlder = result.current.loadOlder()
    })
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2))

    act(() => {
      for (let seq = 101; seq <= 300; seq += 1) {
        FakeEventSource.instances[0]!.emit(
          'run-event',
          JSON.stringify({ seq, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: `event-${seq}` }),
        )
      }
    })
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(300))
    // Compaction is independent from the older-page queue, so a stuck pagination request cannot
    // hold the live tail hostage.
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(3))
    resolveCompacted(page(300))
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(300))

    resolveOlder(page(1))
    await act(async () => loadingOlder)
    expect(result.current.visibleEvents.map(({ seq }) => seq).at(0)).toBe(1)
    expect(result.current.visibleEvents.at(-1)?.seq).toBe(300)
    vi.unstubAllGlobals()
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
    let resolveCompacted!: (value: RunHistoryPage) => void
    const compacted = new Promise<RunHistoryPage>((resolve) => {
      resolveCompacted = resolve
    })
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockImplementationOnce(() => compacted)
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
    // This is live-only: it is emitted after the compaction snapshot request and is not in the
    // persisted page that will replace the old cursor.
    FakeEventSource.instances[0]!.emit(
      'ui-event',
      JSON.stringify({ seq: 301, ts: '2026-07-30T00:00:00.000Z', type: 'item.delta', itemId: 'm1', field: 'text', delta: 'live-only' }),
    )
    resolveCompacted(compactedTail)
    await waitFor(() => expect(result.current.retainedPages).toBe(1))
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(301))
    expect(result.current.visibleEvents.some(({ seq, type }) => seq === 301 && type === 'item.delta')).toBe(true)
    expect(result.current.retainedPages).toBe(1)
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('only covers live deltas that a durable item snapshot can reconstruct', () => {
    const delta = {
      seq: 101,
      ts: '2026-07-30T00:00:00.000Z',
      type: 'item.delta',
      stepId: 'step-1',
      itemId: 'message-1',
      field: 'text',
      delta: 'partial',
    }
    expect(coveredLiveEventSeqs([delta], [{
      seq: 103,
      ts: '2026-07-30T00:00:00.000Z',
      type: 'session.ended',
    }])).toEqual([])
    expect(coveredLiveEventSeqs([delta], [{
      seq: 102,
      ts: '2026-07-30T00:00:00.000Z',
      type: 'item.completed',
      stepId: 'step-1',
      item: { kind: 'message', id: 'message-1', role: 'assistant', text: 'complete' },
    }])).toEqual([101])
  })

  it('covers durable live lines that already paged out of the newest history page', () => {
    const oldLine = { seq: 101, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: 'old' }
    const liveOnlyUpdate = {
      seq: 102,
      ts: '2026-07-30T00:00:00.000Z',
      type: 'item.updated',
      stepId: 'step-1',
      item: { kind: 'message', id: 'message-1', role: 'assistant', text: 'partial' },
    }
    const completed = {
      seq: 103,
      ts: '2026-07-30T00:00:00.000Z',
      type: 'item.completed',
      stepId: 'step-1',
      item: { kind: 'message', id: 'message-1', role: 'assistant', text: 'complete' },
    }

    expect(coveredLiveEventSeqs([oldLine, liveOnlyUpdate], [completed], 103)).toEqual([101, 102])
  })

  it('keeps live events when the optimized history switches to fallback', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    let rejectContext!: (error: Error) => void
    const pendingContext = new Promise<RunHistoryContext>((_, reject) => {
      rejectContext = reject
    })
    mockHistory.mockResolvedValue(page(100, { olderCursor: 'older-0', hasOlder: true }))
    mockContext.mockImplementation(() => pendingContext)
    const { client, wrapper } = harness()
    const { result } = renderHook(() => useRunHistory('run-1'), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    FakeEventSource.instances[0]!.emit(
      'ui-event',
      JSON.stringify({ seq: 101, ts: '2026-07-30T00:00:00.000Z', type: 'item.delta', itemId: 'm1', field: 'text', delta: 'live-only' }),
    )
    await waitFor(() => expect(result.current.visibleEvents.at(-1)?.seq).toBe(101))

    rejectContext(new Error('context unavailable'))
    await waitFor(() => expect(result.current.fallback).toBe(true), { timeout: 3_000 })

    // The optimized stream is closed at handoff; its already-rendered tail is merged into the
    // single full-replay stream so a live-only frame emitted before the error cannot be lost.
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0]!.readyState).toBe(2)
    expect(FakeEventSource.instances[1]!.url).toBe('/api/v1/runs/run-1/events')
    FakeEventSource.instances[1]!.emit(
      'run-event',
      JSON.stringify({ seq: 50, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: 'full-replay' }),
    )
    await waitFor(() => expect(result.current.visibleEvents.map(({ seq }) => seq)).toEqual([50, 100, 101]))
    client.setQueryData(['run-history-context', 'default', 'run-1'], context())
    await waitFor(() => expect(result.current.fallback).toBe(true))
    vi.unstubAllGlobals()
  })

  it('compares compaction with the newest cursorless page, not an older page high-water mark', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    let resolveStale!: (value: RunHistoryPage) => void
    const stale = new Promise<RunHistoryPage>((resolve) => {
      resolveStale = resolve
    })
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockImplementationOnce(() => stale)
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
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

    client.setQueryData(['run-history', 'default', 'run-1'], {
      pages: [page(100, { newerCursor: 'newer', asOfSeq: 500 }), page(200)],
      pageParams: ['older', undefined],
    })
    resolveStale(page(250))
    await waitFor(() => expect(
      client.getQueryData<{ pages: RunHistoryPage[] }>(['run-history', 'default', 'run-1'])?.pages.at(-1)?.asOfSeq,
    ).toBe(250))
    expect(client.getQueryData<{ pages: RunHistoryPage[] }>(['run-history', 'default', 'run-1'])?.pages[0]?.asOfSeq).toBe(500)
    expect(result.current.visibleEvents.some(({ seq }) => seq === 250)).toBe(true)
    vi.unstubAllGlobals()
  })

  it('ignores a stale compaction response when newer history is already cached', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    let resolveStale!: (value: RunHistoryPage) => void
    const stale = new Promise<RunHistoryPage>((resolve) => {
      resolveStale = resolve
    })
    mockHistory
      .mockResolvedValueOnce(page(100))
      .mockImplementationOnce(() => stale)
    mockContext.mockResolvedValue(context())
    const { client, wrapper } = harness()
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

    client.setQueryData(['run-history', 'default', 'run-1'], {
      pages: [page(400)],
      pageParams: [undefined],
    })
    resolveStale(page(250))
    await waitFor(() => expect(result.current.retainedPages).toBe(1))
    expect(client.getQueryData<{ pages: RunHistoryPage[] }>(['run-history', 'default', 'run-1'])?.pages[0]?.asOfSeq).toBe(400)
    expect(result.current.visibleEvents.some(({ seq }) => seq === 250)).toBe(true)
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
    FakeEventSource.instances[0]!.emit(
      'run-event',
      JSON.stringify({ seq: 301, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: 'retry' }),
    )
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    FakeEventSource.instances[0]!.emit(
      'run-event',
      JSON.stringify({ seq: 302, ts: '2026-07-30T00:00:00.000Z', type: 'note', message: 'retry-after-backoff' }),
    )
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()

    process.off('unhandledRejection', unhandled)
    vi.unstubAllGlobals()
  })
})
