import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTopicSocket } from './ws'

/**
 * The client's contract is bookkeeping, so the fake below records exactly what a server would
 * see: which sockets were opened, which frames each one sent, and when one was closed. Frame
 * delivery and lifecycle transitions are driven by hand (`open()`, `message()`, `drop()`).
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  url: string
  readyState = 0 // CONNECTING
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
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

  /** The client-initiated close. Browsers fire `close` asynchronously, but firing it inline is
   *  stricter — reentrancy in the close handler would surface here first. */
  close(): void {
    this.readyState = 3
    this.fire('close', {})
  }

  // ---- test controls ----
  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  message(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }

  /** A server-side drop (restart, network): same close event, not asked for. */
  drop(): void {
    this.readyState = 3
    this.fire('close', {})
  }

  frames(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw))
  }

  private fire(name: string, event: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
}

/** `instances[i]`, asserted — `noUncheckedIndexedAccess` would make every read conditional. */
const instance = (index: number): FakeWebSocket => {
  const ws = FakeWebSocket.instances[index]
  if (!ws) throw new Error(`no FakeWebSocket instance #${index}`)
  return ws
}

const URL = 'ws://cockpit.test/api/ws'
const IDLE_CLOSE_DELAY_MS = 1_000
const RECONNECT_DELAY_MS = 3_000
const HEARTBEAT_TIMEOUT_MS = 70_000

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createTopicSocket', () => {
  it('connects lazily on the first subscription and announces the topic on open', () => {
    const socket = createTopicSocket(URL)
    expect(FakeWebSocket.instances).toHaveLength(0)

    socket.subscribe('health', () => undefined)
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = instance(0)
    expect(ws.url).toBe(URL)
    expect(ws.sent).toHaveLength(0) // nothing before the handshake completes

    ws.open()
    expect(ws.frames()).toEqual([{ type: 'subscribe', topic: 'health' }])
  })

  it('ref-counts listeners: one subscribe frame per topic, events fan out to all of them', () => {
    const socket = createTopicSocket(URL)
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    socket.subscribe('health', (data) => seenA.push(data))
    const ws = instance(0)
    ws.open()
    socket.subscribe('health', (data) => seenB.push(data))

    expect(ws.frames()).toEqual([{ type: 'subscribe', topic: 'health' }]) // still exactly one

    ws.message({ type: 'event', topic: 'health', data: { version: '1' } })
    expect(seenA).toEqual([{ version: '1' }])
    expect(seenB).toEqual([{ version: '1' }])
  })

  it('routes events by topic and ignores frames that are not events', () => {
    const socket = createTopicSocket(URL)
    const seen: unknown[] = []
    socket.subscribe('health', (data) => seen.push(data))
    const ws = instance(0)
    ws.open()

    ws.message({ type: 'event', topic: 'other', data: 1 })
    ws.message({ type: 'error', topic: 'health', error: 'nope' })
    ws.message({ type: 'event', topic: 'health', data: 2 })
    expect(seen).toEqual([2])
  })

  it('unsubscribing the last listener sends the frame and closes after the grace window', () => {
    const socket = createTopicSocket(URL)
    const unsubscribe = socket.subscribe('health', () => undefined)
    const ws = instance(0)
    ws.open()

    unsubscribe()
    expect(ws.frames()).toEqual([
      { type: 'subscribe', topic: 'health' },
      { type: 'unsubscribe', topic: 'health' },
    ])
    expect(ws.readyState).toBe(1) // still open — the grace window absorbs remounts

    vi.advanceTimersByTime(IDLE_CLOSE_DELAY_MS)
    expect(ws.readyState).toBe(3)
    // Closed on purpose — no reconnect attempt later:
    vi.advanceTimersByTime(RECONNECT_DELAY_MS)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a second unsubscribe call is a no-op (React cleanup may run twice)', () => {
    const socket = createTopicSocket(URL)
    const unsubscribe = socket.subscribe('health', () => undefined)
    socket.subscribe('health', () => undefined)
    const ws = instance(0)
    ws.open()

    unsubscribe()
    unsubscribe()
    // One live listener remains, so no unsubscribe frame at all:
    expect(ws.frames()).toEqual([{ type: 'subscribe', topic: 'health' }])
  })

  it('resubscribing inside the grace window keeps the socket alive', () => {
    const socket = createTopicSocket(URL)
    const unsubscribe = socket.subscribe('health', () => undefined)
    const ws = instance(0)
    ws.open()

    unsubscribe()
    vi.advanceTimersByTime(IDLE_CLOSE_DELAY_MS / 2)
    socket.subscribe('health', () => undefined) // the StrictMode remount
    vi.advanceTimersByTime(IDLE_CLOSE_DELAY_MS)

    expect(ws.readyState).toBe(1)
    expect(FakeWebSocket.instances).toHaveLength(1) // same socket, no churn
    expect(ws.frames()).toEqual([
      { type: 'subscribe', topic: 'health' },
      { type: 'unsubscribe', topic: 'health' },
      { type: 'subscribe', topic: 'health' },
    ])
  })

  it('a dropped connection reconnects after the delay and resubscribes held topics', () => {
    const socket = createTopicSocket(URL)
    const seen: unknown[] = []
    socket.subscribe('health', (data) => seen.push(data))
    const first = instance(0)
    first.open()

    first.drop() // server restarted
    expect(FakeWebSocket.instances).toHaveLength(1) // not instantly — backoff first
    vi.advanceTimersByTime(RECONNECT_DELAY_MS)
    expect(FakeWebSocket.instances).toHaveLength(2)

    const second = instance(1)
    second.open()
    expect(second.frames()).toEqual([{ type: 'subscribe', topic: 'health' }])
    second.message({ type: 'event', topic: 'health', data: 'after-reconnect' })
    expect(seen).toEqual(['after-reconnect'])
  })

  it('a drop with nothing held does not reconnect', () => {
    const socket = createTopicSocket(URL)
    const unsubscribe = socket.subscribe('health', () => undefined)
    const ws = instance(0)
    ws.open()
    unsubscribe()
    ws.drop() // dies before the idle close fires

    vi.advanceTimersByTime(RECONNECT_DELAY_MS + IDLE_CLOSE_DELAY_MS)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a new subscription while the backoff is pending connects immediately', () => {
    const socket = createTopicSocket(URL)
    socket.subscribe('health', () => undefined)
    const first = instance(0)
    first.open()
    first.drop()

    socket.subscribe('todos', () => undefined) // user navigated — don't make them wait out backoff
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = instance(1)
    second.open()
    expect(second.frames()).toEqual([
      { type: 'subscribe', topic: 'health' },
      { type: 'subscribe', topic: 'todos' },
    ])
  })

  it('reconnects a silently dead socket — no close event, just gone quiet', () => {
    const socket = createTopicSocket(URL)
    socket.subscribe('health', () => undefined)
    const first = instance(0)
    first.open()

    // Nothing arrives — not even a heartbeat ping. The browser fires no `close` (no FIN), so
    // only the watchdog can notice. It closes the dead socket, and the normal backoff reconnects.
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS)
    expect(first.readyState).toBe(3) // watchdog force-closed it
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(RECONNECT_DELAY_MS)
    expect(FakeWebSocket.instances).toHaveLength(2)
    instance(1).open()
    expect(instance(1).frames()).toEqual([{ type: 'subscribe', topic: 'health' }])
  })

  it('a heartbeat ping keeps a quiet-but-healthy socket alive', () => {
    const socket = createTopicSocket(URL)
    socket.subscribe('health', () => undefined)
    const ws = instance(0)
    ws.open()

    // Just shy of the deadline, a heartbeat lands and resets the watchdog.
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 1_000)
    ws.message({ type: 'ping' })
    // Past the ORIGINAL deadline — but the ping reset it, so the socket is still up.
    vi.advanceTimersByTime(2_000)
    expect(ws.readyState).toBe(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('is a silent no-op where WebSocket does not exist (jsdom, prerender)', () => {
    vi.stubGlobal('WebSocket', undefined)
    const socket = createTopicSocket(URL)
    const unsubscribe = socket.subscribe('health', () => undefined)
    expect(FakeWebSocket.instances).toHaveLength(0)
    unsubscribe() // must not throw either
  })
})
