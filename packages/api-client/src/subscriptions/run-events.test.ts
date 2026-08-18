import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCezarClient } from '../client.ts'
import { parseRunEvent } from './run-events.ts'

class FakeEventSource extends EventTarget {
  readyState = 0
  closed = false

  constructor(
    readonly url: string,
    init?: EventSourceInit,
  ) {
    super()
    this.withCredentials = init?.withCredentials === true
  }

  readonly withCredentials: boolean

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  emit(name: string, payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.dispatchEvent(new MessageEvent(name, { data }))
  }

  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  failPermanently(): void {
    this.readyState = 2
    this.dispatchEvent(new Event('error'))
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

let fakeDocument: FakeDocument
let fakeWindow: EventTarget

beforeEach(() => {
  fakeDocument = new FakeDocument()
  fakeWindow = new EventTarget()
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('window', fakeWindow)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(options: { baseUrl?: string } = {}) {
  const sources: FakeEventSource[] = []
  const client = createCezarClient({
    baseUrl: options.baseUrl,
    eventSource: (url, init) => {
      const source = new FakeEventSource(url, init)
      sources.push(source)
      return source
    },
  })
  return { client, sources }
}

describe('parseRunEvent', () => {
  it.each([
    'nope{',
    '[1,2]',
    'null',
    '{"type":"stdout"}',
    '{"seq":"7","type":"stdout"}',
    '{"seq":1}',
    '{"seq":1,"type":""}',
  ])('rejects an unorderable frame: %s', (data) => {
    expect(parseRunEvent(data)).toBeNull()
  })

  it('keeps the complete payload of an orderable frame', () => {
    expect(parseRunEvent('{"seq":3,"type":"item.delta","delta":"Hi"}')).toEqual({
      seq: 3,
      type: 'item.delta',
      delta: 'Hi',
    })
  })
})

describe('run event subscriptions', () => {
  it('opens a credentialed scoped stream, drops replayed seq values, and closes cleanly', () => {
    const { client, sources } = setup({ baseUrl: 'https://cezar.test/base' })
    const received: number[] = []
    const stop = client.forProject('p/a').events.subscribeRun(
      'r/a',
      { afterSeq: 4, cursor: 'next' },
      (event) => received.push(event.seq),
    )

    expect(sources[0]).toMatchObject({
      url: 'https://cezar.test/base/api/v1/p/p%2Fa/runs/r%2Fa/events?cursor=next&afterSeq=4',
      withCredentials: true,
    })
    sources[0]!.emit('run-event', { seq: 4, type: 'text' })
    sources[0]!.emit('ui-event', { seq: 5, type: 'item.completed' })
    expect(received).toEqual([5])

    stop()
    expect(sources[0]!.closed).toBe(true)
  })

  it('offers the same project event domain from the root client', () => {
    const { client, sources } = setup()
    const stop = client.events.forProject('p/a').subscribeRun('r/a', {}, () => {})

    expect(sources[0]!.url).toBe('/api/v1/p/p%2Fa/runs/r%2Fa/events')
    stop()
  })

  it('ignores malformed frames and accepts both event vocabularies', () => {
    const { client, sources } = setup()
    const received: Array<[number, string]> = []
    const stop = client.forProject(null).events.subscribeRun('run-1', {}, (event) => {
      received.push([event.seq, event.type])
    })

    sources[0]!.emit('run-event', 'not json{')
    sources[0]!.emit('ui-event', { type: 'item.started' })
    sources[0]!.emit('run-event', { seq: 1, type: 'stdout' })
    sources[0]!.emit('ui-event', { seq: 3, type: 'item.delta' })

    expect(received).toEqual([[1, 'stdout'], [3, 'item.delta']])
    stop()
  })

  it('resolves the browser EventSource only when subscribing and degrades when it is absent', () => {
    vi.stubGlobal('EventSource', undefined)
    const client = createCezarClient()
    const received: number[] = []

    expect(() => client.forProject(null).events.subscribeRun('run-1', {}, (event) => {
      received.push(event.seq)
    })).not.toThrow()

    const sources: FakeEventSource[] = []
    vi.stubGlobal('EventSource', class extends FakeEventSource {
      constructor(url: string, init?: EventSourceInit) {
        super(url, init)
        sources.push(this)
      }
    })
    const stop = client.forProject(null).events.subscribeRun('run-2', {}, (event) => {
      received.push(event.seq)
    })

    expect(sources).toHaveLength(1)
    sources[0]!.emit('run-event', { seq: 1, type: 'stdout' })
    expect(received).toEqual([1])
    stop()
  })

  it('does not install visible-tab recovery where no document or window exists', () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('window', undefined)
    const { client, sources } = setup()
    const stop = client.forProject(null).events.subscribeRun('run-1', {}, () => {})

    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(1)

    stop()
  })

  it('reports reconnect only after a replacement socket opens', () => {
    vi.useFakeTimers()
    const { client, sources } = setup()
    const onReconnect = vi.fn()
    const received: number[] = []
    const stop = client.forProject(null).events.subscribeRun('run-1', { onReconnect }, (event) => {
      received.push(event.seq)
    })

    sources[0]!.open()
    expect(onReconnect).not.toHaveBeenCalled()
    sources[0]!.emit('run-event', { seq: 2, type: 'stdout' })
    sources[0]!.failPermanently()
    vi.advanceTimersByTime(1_500)

    expect(sources).toHaveLength(2)
    expect(onReconnect).not.toHaveBeenCalled()
    sources[1]!.emit('run-event', { seq: 2, type: 'stdout' })
    sources[1]!.emit('run-event', { seq: 3, type: 'stdout' })
    sources[1]!.open()
    expect(received).toEqual([2, 3])
    expect(onReconnect).toHaveBeenCalledOnce()
    stop()
  })

  it('treats a native reconnect open as liveness before the next watchdog tick', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { client, sources } = setup()
    const onReconnect = vi.fn()
    const stop = client.forProject(null).events.subscribeRun('run-1', { onReconnect }, () => {})

    sources[0]!.open()
    fakeDocument.visibilityState = 'hidden'
    vi.advanceTimersByTime(60_000)

    fakeDocument.visibilityState = 'visible'
    sources[0]!.open()
    expect(onReconnect).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(10_000)

    expect(sources).toHaveLength(1)
    expect(onReconnect).toHaveBeenCalledOnce()
    stop()
  })

  it('watchdogs a visible silent socket, while pings and hidden tabs suppress reopen', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { client, sources } = setup()
    const stop = client.forProject(null).events.subscribeRun('run-1', {}, () => {})

    vi.advanceTimersByTime(30_000)
    sources[0]!.emit('ping', '')
    vi.advanceTimersByTime(30_000)
    expect(sources).toHaveLength(1)

    fakeDocument.visibilityState = 'hidden'
    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(1)

    fakeDocument.visibilityState = 'visible'
    vi.advanceTimersByTime(10_000)
    expect(sources).toHaveLength(2)
    expect(sources[0]!.closed).toBe(true)
    stop()
  })

  it('closes for pagehide, reopens a persisted pageshow, and disposes every recovery path', () => {
    vi.useFakeTimers()
    const { client, sources } = setup()
    const onReconnect = vi.fn()
    const received: number[] = []
    const stop = client.forProject(null).events.subscribeRun('run-1', { onReconnect }, (event) => {
      received.push(event.seq)
    })
    sources[0]!.emit('run-event', { seq: 1, type: 'stdout' })

    fakeWindow.dispatchEvent(new Event('pagehide'))
    expect(sources[0]!.closed).toBe(true)
    const pageshow = new Event('pageshow')
    Object.defineProperty(pageshow, 'persisted', { value: true })
    fakeWindow.dispatchEvent(pageshow)
    expect(sources).toHaveLength(2)
    sources[1]!.emit('run-event', { seq: 1, type: 'stdout' })
    sources[1]!.emit('run-event', { seq: 2, type: 'stdout' })
    sources[1]!.open()
    expect(received).toEqual([1, 2])
    expect(onReconnect).toHaveBeenCalledOnce()

    stop()
    sources[1]!.emit('run-event', { seq: 3, type: 'stdout' })
    sources[1]!.failPermanently()
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    fakeWindow.dispatchEvent(pageshow)
    vi.advanceTimersByTime(60_000)
    expect(received).toEqual([1, 2])
    expect(sources).toHaveLength(2)
  })

  it('requests compaction once at the accepted-event threshold and never after disposal', async () => {
    const { client, sources } = setup()
    const onCompact = vi.fn()
    const stop = client.forProject(null).events.subscribeRun('run-1', { compactAt: 2, onCompact }, () => {})

    sources[0]!.emit('run-event', { seq: 1, type: 'stdout' })
    sources[0]!.emit('run-event', { seq: 2, type: 'stdout' })
    sources[0]!.emit('run-event', { seq: 3, type: 'stdout' })
    await Promise.resolve()
    expect(onCompact).toHaveBeenCalledOnce()

    stop()
    sources[0]!.emit('run-event', { seq: 4, type: 'stdout' })
    await Promise.resolve()
    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('requests compaction from the pre-trim count when maxEvents is below compactAt', async () => {
    const { client, sources } = setup()
    const onCompact = vi.fn()
    const stop = client.forProject(null).events.subscribeRun(
      'run-1',
      { maxEvents: 2, compactAt: 3, onCompact },
      () => {},
    )

    sources[0]!.emit('run-event', { seq: 1, type: 'stdout' })
    sources[0]!.emit('run-event', { seq: 2, type: 'stdout' })
    sources[0]!.emit('run-event', { seq: 3, type: 'stdout' })
    await Promise.resolve()

    expect(onCompact).toHaveBeenCalledOnce()
    stop()
  })
})
