import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { parseRunEvent, RUN_EVENT_BATCH_MS, useRunEvents } from './run-events'

/**
 * Same doctrine as the global-stream suite: jsdom ships no EventSource, so the stub IS the test
 * double — it implements only what the hook touches and adds the one lever the hook cannot,
 * emitting a named frame.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1)
    if (!instance) throw new Error('no EventSource was constructed')
    return instance
  }

  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(fn)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, fn: (event: Event) => void): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.readyState = 2
    this.closeCount += 1
  }

  /** One `event:`/`data:` frame. */
  emit(name: string, data: string): void {
    act(() => {
      for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data }))
    })
  }
}

/** A wire line as the server stamps it: seq + ts + type + payload. */
const line = (seq: number, type: string, rest: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, ts: '2026-07-14T12:00:00.000Z', type, ...rest })

beforeEach(() => {
  FakeEventSource.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function flushEvents(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_EVENT_BATCH_MS)
  })
}

describe('parseRunEvent', () => {
  it.each([
    { label: 'not JSON', data: 'nope{' },
    { label: 'an array', data: '[1,2]' },
    { label: 'null', data: 'null' },
    { label: 'no seq', data: '{"type":"stdout"}' },
    { label: 'seq not a number', data: '{"seq":"7","type":"stdout"}' },
    { label: 'no type', data: '{"seq":1}' },
    { label: 'empty type', data: '{"seq":1,"type":""}' },
  ])('rejects $label', ({ data }) => {
    expect(parseRunEvent(data)).toBeNull()
  })

  it('keeps the whole payload of a valid line', () => {
    expect(parseRunEvent(line(3, 'item.delta', { itemId: 'i1', field: 'text', delta: 'Hi' }))).toEqual({
      seq: 3,
      ts: '2026-07-14T12:00:00.000Z',
      type: 'item.delta',
      itemId: 'i1',
      field: 'text',
      delta: 'Hi',
    })
  })
})

describe('useRunEvents — subscription', () => {
  it('opens one stream at the run endpoint, and none without a run id', () => {
    renderHook(() => useRunEvents('run-1'))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.last.url).toBe('/api/v1/runs/run-1/events')
    expect(FakeEventSource.last.init).toEqual({ withCredentials: true })

    cleanup()
    renderHook(() => useRunEvents(undefined))
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('opens the scoped endpoint when a project scope is active (multi-project, step 3.1)', () => {
    setApiScope('proj-a')
    try {
      renderHook(() => useRunEvents('run-1'))
      expect(FakeEventSource.last.url).toBe('/api/v1/p/proj-a/runs/run-1/events')
    } finally {
      setApiScope(null)
    }
  })

  it('collects BOTH wire vocabularies into one ordered list — v1 `run-event` and v2 `ui-event`', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last

    source.emit('run-event', line(1, 'stdout', { text: 'building…' }))
    source.emit('ui-event', line(2, 'item.started', { item: { kind: 'message', id: 'm1', role: 'assistant', text: '' } }))
    source.emit('ui-event', line(3, 'item.delta', { itemId: 'm1', field: 'text', delta: 'Hello' }))
    source.emit('run-event', line(4, 'token-usage', { tokensUsed: 42 }))
    await flushEvents()

    expect(result.current.map((event) => [event.seq, event.type])).toEqual([
      [1, 'stdout'],
      [2, 'item.started'],
      [3, 'item.delta'],
      [4, 'token-usage'],
    ])
  })

  it('survives a malformed frame — one bad line costs one line', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last

    source.emit('ui-event', 'not json{')
    source.emit('ui-event', '{"type":"item.started"}') // no seq — unorderable
    source.emit('ui-event', line(1, 'plan.updated', { entries: [] }))
    await flushEvents()

    expect(result.current.map((event) => event.type)).toEqual(['plan.updated'])
  })

  it('reopens a CLOSED stream on return-to-visible; the replay dedups (#minor-run-sse-recovery)', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const first = FakeEventSource.last
    first.emit('run-event', line(1, 'stdout', { text: 'a' }))
    await flushEvents()

    // A frozen tab (or a server restart) left the socket dead with no error handler firing.
    first.close() // readyState → CLOSED
    act(() => document.dispatchEvent(new Event('visibilitychange'))) // jsdom is 'visible' by default

    expect(FakeEventSource.instances).toHaveLength(2)
    const second = FakeEventSource.last
    // The server replays the whole file on reconnect: seq 1 (already seen) is swallowed, seq 2 lands.
    second.emit('run-event', line(1, 'stdout', { text: 'a' }))
    second.emit('run-event', line(2, 'stdout', { text: 'b' }))
    await flushEvents()
    expect(result.current.map((event) => event.seq)).toEqual([1, 2])
  })
})

describe('useRunEvents — liveness watchdog (#424)', () => {
  it('reopens a silently-dead socket that never reached CLOSED, then dedups the replay', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const first = FakeEventSource.last
    first.emit('run-event', line(1, 'stdout', { text: 'a' }))
    // The socket is half-open: the browser still reports it OPEN, no `error` ever fires, and no
    // frame (not even a ping) arrives. None of the CLOSED-gated reopen paths can catch this.
    expect(first.readyState).toBe(0)

    act(() => {
      vi.advanceTimersByTime(55_000) // past the ~40 s stale threshold with total silence
    })

    // The watchdog rebuilt the socket; the server replays the file and live events resume.
    expect(FakeEventSource.instances).toHaveLength(2)
    const second = FakeEventSource.last
    second.emit('run-event', line(1, 'stdout', { text: 'a' }))
    second.emit('run-event', line(2, 'stdout', { text: 'b' }))
    await flushEvents()
    expect(result.current.map((event) => event.seq)).toEqual([1, 2])
  })

  it('keeps a quiet-but-alive socket open — a ping resets the staleness clock', () => {
    renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last

    // A run that is thinking emits no data for a while, but the 15 s server keepalive keeps
    // arriving — that alone must prove liveness and prevent a needless reopen.
    act(() => vi.advanceTimersByTime(30_000))
    source.emit('ping', '')
    act(() => vi.advanceTimersByTime(30_000))
    source.emit('ping', '')
    act(() => vi.advanceTimersByTime(30_000))

    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('does not reopen while the tab is hidden — a throttled tab is expected to be quiet', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      renderHook(() => useRunEvents('run-1'))
      expect(FakeEventSource.instances).toHaveLength(1)

      act(() => vi.advanceTimersByTime(60_000))

      // Hidden and silent is normal; the visibilitychange path reopens on return instead.
      expect(FakeEventSource.instances).toHaveLength(1)
    } finally {
      visibility.mockRestore()
    }
  })

  it('stops the watchdog on unmount — no reopen after the effect is torn down', () => {
    const { unmount } = renderHook(() => useRunEvents('run-1'))
    expect(FakeEventSource.instances).toHaveLength(1)

    unmount()
    act(() => vi.advanceTimersByTime(60_000))

    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('useRunEvents — seq dedup uses `>`', () => {
  it('drops the replayed prefix after a reconnect instead of duplicating it', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last

    source.emit('run-event', line(1, 'stdout', { text: 'a' }))
    source.emit('ui-event', line(2, 'turn.started', { turnId: 't1' }))

    // EventSource reconnected on its own; the server replays the file from the top and then
    // carries on with what happened while we were away.
    source.emit('run-event', line(1, 'stdout', { text: 'a' }))
    source.emit('ui-event', line(2, 'turn.started', { turnId: 't1' }))
    source.emit('ui-event', line(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn' }))
    await flushEvents()

    expect(result.current.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it('accepts seq gaps — ephemeral deltas burn numbers that never replay', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last

    source.emit('ui-event', line(2, 'item.started', { item: { kind: 'reasoning', id: 'r1', text: '' } }))
    // seq 3–6 were coalesced deltas this client never saw; the next persisted line jumps.
    source.emit('ui-event', line(7, 'item.completed', { item: { kind: 'reasoning', id: 'r1', text: 'done' } }))
    await flushEvents()

    expect(result.current.map((event) => event.seq)).toEqual([2, 7])
  })

  it('drops a stale line at the high-water mark, not merely duplicates', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last

    source.emit('ui-event', line(5, 'turn.started', { turnId: 't1' }))
    source.emit('ui-event', line(5, 'turn.started', { turnId: 't1' })) // equal — not `>`
    source.emit('ui-event', line(4, 'stdout', { text: 'late' })) // below — replayed history
    await flushEvents()

    expect(result.current).toHaveLength(1)
  })

  it('accepts an unseen late frame after history advances its file high-water mark', async () => {
    const { result, rerender } = renderHook(
      ({ afterSeq }: { afterSeq: number }) => useRunEvents('run-1', { afterSeq }),
      { initialProps: { afterSeq: 100 } },
    )
    const source = FakeEventSource.last

    source.emit('run-event', line(101, 'stdout', { text: 'first' }))
    source.emit('run-event', line(200, 'stdout', { text: 'second' }))
    await flushEvents()

    // A compaction page may now say 300 even though an ephemeral frame from the old socket is
    // still in flight. It is newer than the original page and must not be dropped as replay.
    rerender({ afterSeq: 300 })
    source.emit('ui-event', line(150, 'item.delta', {
      itemId: 'm1', field: 'text', delta: 'late-live',
    }))
    await flushEvents()

    expect(result.current.map(({ seq }) => seq)).toEqual([101, 200, 150])
  })
})

describe('useRunEvents — compaction handoff', () => {
  it('labels a coalesced delta with its newest sequence', async () => {
    const { result } = renderHook(() => useRunEvents('run-1', {
      compactWhenOver: 10,
      compactAt: 100,
    }))
    const source = FakeEventSource.last

    source.emit('ui-event', line(1, 'item.delta', {
      itemId: 'm1', field: 'text', delta: 'a',
    }))
    source.emit('ui-event', line(3, 'item.delta', {
      itemId: 'm1', field: 'text', delta: 'b',
    }))
    await flushEvents()

    expect(result.current).toHaveLength(1)
    expect(result.current[0]).toMatchObject({ seq: 3, delta: 'ab' })
  })

  it('keeps coalesced deltas ordered around unrelated events', async () => {
    const { result } = renderHook(() => useRunEvents('run-1', { compactAt: 100 }))
    const source = FakeEventSource.last

    source.emit('ui-event', line(1, 'item.delta', {
      itemId: 'm1', field: 'text', delta: 'a',
    }))
    source.emit('run-event', line(2, 'stdout', { text: 'tool output' }))
    source.emit('ui-event', line(3, 'item.delta', {
      itemId: 'm1', field: 'text', delta: 'b',
    }))
    await flushEvents()

    expect(result.current.map(({ seq }) => seq)).toEqual([2, 3])
    expect(result.current[1]).toMatchObject({ type: 'item.delta', delta: 'ab' })
  })

  it('does not evict live events while compaction is still pending', async () => {
    let resolveCompaction!: (coveredSeqs: readonly number[] | false) => void
    const compaction = new Promise<readonly number[] | false>((resolve) => {
      resolveCompaction = resolve
    })
    const { result } = renderHook(() => useRunEvents('run-1', {
      compactWhenOver: 2,
      compactAt: 1,
      onCompact: () => compaction,
    }))
    const source = FakeEventSource.last

    source.emit('run-event', line(1, 'stdout', { text: 'a' }))
    source.emit('run-event', line(2, 'stdout', { text: 'b' }))
    source.emit('run-event', line(3, 'stdout', { text: 'c' }))
    await flushEvents()

    // A snapshot that has not answered cannot repair any ephemeral prefix it would evict.
    expect(result.current.map(({ seq }) => seq)).toEqual([1, 2, 3])
    resolveCompaction([1])
    await vi.waitFor(() => expect(result.current.map(({ seq }) => seq)).toEqual([2, 3]))
  })

  it('does not truncate live events when compaction has no durable coverage', async () => {
    const onCompact = vi.fn(async () => [])
    const { result } = renderHook(() => useRunEvents('run-1', {
      compactWhenOver: 2,
      compactAt: 1,
      onCompact,
    }))
    const source = FakeEventSource.last

    act(() => {
      for (let seq = 1; seq <= 5_001; seq += 1) {
        source.emit('ui-event', line(seq, 'item.delta', {
          itemId: 'message-1',
          field: 'text',
          delta: 'x',
        }))
      }
    })
    await flushEvents()
    await vi.waitFor(() => expect(onCompact).toHaveBeenCalled())

    // A numeric high-water cap would silently delete live-only deltas. Empty coverage keeps the
    // chunks lossless and backs off instead of retrying on every 50 ms batch.
    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.delta).toHaveLength(5_001)
    source.emit('ui-event', line(5_002, 'item.delta', {
      itemId: 'message-1',
      field: 'text',
      delta: 'y',
    }))
    await flushEvents()
    expect(onCompact).toHaveBeenCalledTimes(1)
  })
})

describe('useRunEvents — lifecycle', () => {
  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useRunEvents('run-1'))
    const source = FakeEventSource.last
    expect(source.closeCount).toBe(0)

    unmount()
    expect(source.closeCount).toBe(1)
    expect(source.readyState).toBe(2)
  })

  it('resets the list and resubscribes when the run id changes', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useRunEvents(id), {
      initialProps: { id: 'run-1' },
    })
    const first = FakeEventSource.last
    first.emit('ui-event', line(9, 'session.ended', { reason: 'end_turn' }))
    await flushEvents()
    expect(result.current).toHaveLength(1)

    rerender({ id: 'run-2' })

    // Old socket closed, new one at the new endpoint, and run-1's events are gone.
    expect(first.closeCount).toBe(1)
    expect(FakeEventSource.last.url).toBe('/api/v1/runs/run-2/events')
    expect(result.current).toEqual([])

    // The high-water mark reset with the list: run-2's own seq 1 must not be "stale".
    FakeEventSource.last.emit('run-event', line(1, 'stdout', { text: 'fresh' }))
    await flushEvents()
    expect(result.current.map((event) => event.seq)).toEqual([1])
  })

  it('renders empty where there is no EventSource at all (prerender, bare jsdom)', () => {
    vi.stubGlobal('EventSource', undefined)
    const { result } = renderHook(() => useRunEvents('run-1'))
    expect(result.current).toEqual([])
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('closes on pagehide and reopens on a bfcache restore, deduping the replay', async () => {
    const { result } = renderHook(() => useRunEvents('run-1'))
    const first = FakeEventSource.last
    first.emit('run-event', line(1, 'stdout', { text: 'before' }))
    await flushEvents()

    // Navigate away: the parked document must not hold a per-origin socket.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(first.closeCount).toBe(1)

    // Restored from bfcache: a fresh socket to the same run, and the server's replay of what
    // we already rendered stays swallowed by the high-water mark.
    const pageshow = new Event('pageshow')
    Object.defineProperty(pageshow, 'persisted', { value: true })
    act(() => {
      window.dispatchEvent(pageshow)
    })

    const second = FakeEventSource.last
    expect(second).not.toBe(first)
    expect(second.url).toBe('/api/v1/runs/run-1/events')
    second.emit('run-event', line(1, 'stdout', { text: 'before' })) // replayed prefix
    second.emit('run-event', line(2, 'stdout', { text: 'after' }))
    await flushEvents()
    expect(result.current.map((event) => event.seq)).toEqual([1, 2])
  })
})
