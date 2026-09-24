/**
 * The cockpit's one WebSocket to `/api/v1/ws` — the subscription bus that replaced polling.
 * Design + the subscribe/unsubscribe discipline: spec
 * `.ai/specs/2026-07-23-websocket-subscriptions.md`.
 *
 * The server hub (src/server/ws.ts) does work per TOPIC only while someone holds it, so the
 * client's whole job is honest bookkeeping: `subscribeTopic(topic, listener)` ref-counts
 * listeners per topic, opens the socket lazily on the first subscription anywhere, sends one
 * `subscribe` frame per topic (not per listener), sends `unsubscribe` when a topic's last
 * listener leaves, and closes the socket once NO topic is held — so an idle cockpit costs the
 * server nothing, which is the point of moving off `refetchInterval` (#369).
 *
 * One socket per app, same argument as the SSE stream in global-events.tsx: the per-origin
 * connection budget is shared with every fetch, and duplicate sockets would carry duplicate
 * copies of the same frames.
 *
 * Wire protocol (both directions JSON, one frame per message):
 *   → {type: 'subscribe' | 'unsubscribe', topic}
 *   ← {type: 'event', topic, data}          — a payload for a held topic
 *   ← {type: 'error', topic?, error}        — ignored here beyond being non-events
 */

export type TopicListener = (data: unknown) => void

const WS_PATH = '/api/v1/ws'

/** Same reasoning (and value) as the SSE REOPEN_DELAY_MS: long enough not to hammer a server
 *  that is restarting, short enough that the chips are live again before the reader notices. */
const RECONNECT_DELAY_MS = 3_000

/** Grace before closing a socket that lost its last subscription. Not an optimization —
 *  StrictMode runs every effect's cleanup and re-run back to back, and a 0-delay close would
 *  tear down and rebuild the socket on every dev-mode remount and every route hop between two
 *  views that both hold a topic. */
const IDLE_CLOSE_DELAY_MS = 1_000

/** How long the socket may hear NOTHING — not even the server's heartbeat beat (ws.ts sends one
 *  every 30 s) — before we treat it as silently dead and reconnect. A browser only fires `close`
 *  when a FIN/RST actually arrives; a sleep or network partition delivers neither, so the socket
 *  would otherwise sit OPEN forever, hearing nothing, never reconnecting. Must exceed the
 *  server's beat by enough to ride out one dropped beat without a false positive — 70 s tolerates
 *  two missed 30 s beats. */
const HEARTBEAT_TIMEOUT_MS = 70_000

/** `WebSocket.CONNECTING`/`OPEN`, spelled as literals so nothing depends on the global's
 *  statics — the constructor is read off `globalThis` (tests stub it; jsdom has none). */
const CONNECTING = 0
const OPEN = 1

export interface TopicSocket {
  /** Deliver every `event` frame for `topic` to `listener`. Returns the unsubscribe. */
  subscribe(topic: string, listener: TopicListener): () => void
}

export function createTopicSocket(url?: string): TopicSocket {
  const listeners = new Map<string, Set<TopicListener>>()
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined

  // Restart the liveness deadline. Called on open and on every inbound frame (the server's
  // heartbeat beat counts, so a healthy-but-quiet socket keeps resetting it); if it ever fires,
  // nothing has arrived in HEARTBEAT_TIMEOUT_MS, so the socket is silently dead — close it and
  // let the `close` handler run the normal reconnect path.
  const petWatchdog = (): void => {
    clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined
      socket?.close() // 'close' → reconnect (with backoff) while anything is still held
    }, HEARTBEAT_TIMEOUT_MS)
  }

  // Derived per connect, not at module load: `location` is what carries the cockpit's actual
  // origin (dev proxy port included), and a hosted cockpit behind TLS must speak wss.
  const socketUrl = (): string =>
    url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}`

  const send = (frame: { type: 'subscribe' | 'unsubscribe'; topic: string }): void => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(frame))
  }

  const connect = (): void => {
    const Ctor = globalThis.WebSocket
    if (typeof Ctor !== 'function') return // jsdom / prerender — subscriptions stay silent
    if (socket && (socket.readyState === CONNECTING || socket.readyState === OPEN)) return

    const ws = new Ctor(socketUrl())
    socket = ws

    // Every handler checks `ws === socket`: a superseded socket (closed during reconnect,
    // replaced by a newer connect) must not mutate state that now belongs to its successor.
    ws.addEventListener('open', () => {
      if (ws !== socket) return
      petWatchdog() // arm liveness detection the moment the socket is usable
      // (Re)announce everything held — on a reconnect the server-side subscription state died
      // with the old socket, and each subscribe answers with a fresh snapshot, so listeners
      // catch up on whatever changed while we were away without any extra reconcile step.
      for (const topic of listeners.keys()) send({ type: 'subscribe', topic })
    })

    ws.addEventListener('message', (event) => {
      if (ws !== socket) return
      petWatchdog() // ANY inbound frame — event, error, or heartbeat ping — proves the socket lives
      let frame: unknown
      try {
        frame = JSON.parse((event as MessageEvent<string>).data)
      } catch {
        return
      }
      if (typeof frame !== 'object' || frame === null) return
      const { type, topic, data } = frame as { type?: unknown; topic?: unknown; data?: unknown }
      if (type !== 'event' || typeof topic !== 'string') return
      const held = listeners.get(topic)
      if (!held) return // an unsubscribe raced an in-flight event — drop it
      for (const listener of [...held]) listener(data)
    })

    ws.addEventListener('close', () => {
      if (ws !== socket) return
      socket = null
      clearTimeout(watchdogTimer) // no live socket to watch; a fresh one re-arms on open
      watchdogTimer = undefined
      // Reconnect only while something is held; the idle path already closed on purpose.
      if (listeners.size > 0 && reconnectTimer === undefined) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          if (listeners.size > 0) connect()
        }, RECONNECT_DELAY_MS)
      }
    })

    // 'error' is always followed by 'close' — the listener exists only so the browser
    // doesn't log an unhandled event.
    ws.addEventListener('error', () => undefined)
  }

  return {
    subscribe(topic, listener) {
      let held = listeners.get(topic)
      if (!held) {
        held = new Set()
        listeners.set(topic, held)
      }
      const firstForTopic = held.size === 0
      held.add(listener)

      // Any live subscription cancels a pending idle close — the socket is wanted again.
      clearTimeout(idleTimer)
      idleTimer = undefined

      if (!socket) {
        // A pending reconnect backoff shouldn't delay a fresh subscription.
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        connect()
      } else if (firstForTopic) {
        send({ type: 'subscribe', topic }) // no-op while CONNECTING; 'open' announces instead
      }

      let active = true
      return () => {
        // Idempotent: React cleanup contracts allow double calls, and a second call must not
        // decrement someone else's refcount.
        if (!active) return
        active = false
        held.delete(listener)
        if (held.size > 0) return
        listeners.delete(topic)
        send({ type: 'unsubscribe', topic })
        if (listeners.size === 0 && idleTimer === undefined) {
          idleTimer = setTimeout(() => {
            idleTimer = undefined
            if (listeners.size > 0) return // resubscribed during the grace window
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
            // Clear the watchdog here, not via the close handler: nulling `socket` first makes
            // the eventual (async, in a real browser) close event fail its `ws === socket` guard.
            clearTimeout(watchdogTimer)
            watchdogTimer = undefined
            socket?.close()
            socket = null
          }, IDLE_CLOSE_DELAY_MS)
        }
      }
    },
  }
}

/** The app-wide socket every hook shares. Lazy so importing this module (tests, storybooks)
 *  never opens a connection — the first real `subscribeTopic` does. */
let shared: TopicSocket | null = null

export function subscribeTopic(topic: string, listener: TopicListener): () => void {
  shared ??= createTopicSocket()
  return shared.subscribe(topic, listener)
}
