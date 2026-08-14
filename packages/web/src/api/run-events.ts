import { useEffect, useState } from 'react'

import { apiPath } from '@open-mercato/cezar-api-client'
import type { RunEvent } from '@open-mercato/cezar-api-client'

/**
 * The per-run event stream (`GET /api/runs/:id/events`), as a raw ordered list — R2 Step 2.4's
 * proof that the protocol-v2 pipe works end to end. Deliberately NO rendering and NO
 * interpretation: R3's thread view is the consumer that turns these into items; this hook only
 * owns the subscription mechanics that every consumer would otherwise get wrong the same way.
 *
 * The endpoint speaks TWO SSE event names on one socket (src/server/server.ts):
 *  - `run-event` — the v1 lines, what the legacy transcript renders;
 *  - `ui-event`  — protocol v2 (dotted types): persisted snapshots AND the ephemeral coalesced
 *    `item.delta` flushes, which never hit the NDJSON file.
 * Both land in the one list, in arrival (= `seq`) order, because v2 is *additive*: a consumer
 * migrating one panel at a time needs both vocabularies over one clock.
 *
 * Dedup MUST be `seq > maxSeq`, never equality or gap detection: the server replays the whole
 * NDJSON file on every (re)connect — dropping everything at or below the high-water mark is
 * what makes an EventSource auto-reconnect invisible — and ephemeral deltas consume seq numbers
 * that never reappear in a replay, so gaps are normal, not loss.
 */

/** Both wire names. Exported so tests and future consumers subscribe to exactly this set. */
export const RUN_EVENT_NAMES = ['run-event', 'ui-event'] as const

/**
 * Parse one SSE frame into a `RunEvent`, or null for anything malformed. Null rather than a
 * throw, as everywhere on the stream boundary: one bad frame costs one frame, not the socket.
 * `seq` must be a number — it is the dedup axis, and a line without one cannot be ordered.
 */
export function parseRunEvent(data: string): RunEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const { seq, type } = payload as { seq?: unknown; type?: unknown }
  if (typeof seq !== 'number' || typeof type !== 'string' || type === '') return null
  return payload as RunEvent
}

/**
 * Subscribe to one run's event stream and accumulate the raw ordered list.
 *
 * The list resets when `runId` changes (a different run's events are not "earlier state" of
 * this one) and the socket closes on unmount — an EventSource left unclosed retries forever.
 * No reducer cache, no query-client involvement: unlike the global stream, this data belongs
 * to exactly the component that asked for it.
 */
export interface RunEventStreamOptions {
  cursor?: string
  afterSeq?: number
  /** Optimized history keeps a bounded live tail; full-replay fallback leaves this absent. */
  maxEvents?: number
  /** Ask the history owner to fold the live prefix into a fresh persisted tail page. */
  compactAt?: number
  onCompact?: () => void
}

export function useRunEvents(runId: string | undefined, options: RunEventStreamOptions = {}): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const { cursor, afterSeq = 0, maxEvents, compactAt, onCompact } = options

  useEffect(() => {
    // The reset also covers the runId-changed case: whatever accumulated belongs to the old id.
    setEvents([])
    if (!runId) return

    // Off `globalThis`, like global-events.tsx: jsdom has no EventSource, and the tests stub it.
    const Source = globalThis.EventSource
    if (typeof Source !== 'function') return

    // The high-water mark lives with the socket's effect, not in state: a reconnect replay
    // arrives between renders, and dedup must not race React's batching.
    let maxSeq = afterSeq
    let source: EventSource | null = null
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let compactionRequested = false
    const CLOSED = 2 // EventSource.CLOSED, spelled literally like global-events.tsx
    const REOPEN_DELAY_MS = 1_500

    // Liveness watchdog (#424): a backgrounded tab or the app's iframe can leave the socket
    // half-open — TCP dead, but `readyState` stuck at OPEN/CONNECTING so no `error` ever fires and
    // none of the reopen paths below match. The transcript then freezes until a full reload, with
    // "no further SSE updates coming through" (exactly the reported symptom). The server pings every
    // 15 s (server.ts); we treat a long silence across BOTH data and pings as a dead socket and
    // force a reopen. `maxSeq` swallows the replay, same as every other reconnect here.
    const STALE_MS = 40_000 // ~2.5× the 15 s server ping — one dropped ping must not trip it
    const LIVENESS_CHECK_MS = 10_000
    let lastFrameAt = Date.now()
    let livenessTimer: ReturnType<typeof setInterval> | undefined

    const onFrame = (event: Event) => {
      // Any frame proves the socket is alive — bump the watchdog before the dedup drop, so a
      // replayed prefix (which is dropped below) still counts as liveness.
      lastFrameAt = Date.now()
      const parsed = parseRunEvent((event as MessageEvent<string>).data)
      if (!parsed || !(parsed.seq > maxSeq)) return
      maxSeq = parsed.seq
      setEvents((current) => {
        const next = [...current, parsed]
        if (
          !compactionRequested &&
          compactAt !== undefined &&
          next.length >= compactAt
        ) {
          compactionRequested = true
          queueMicrotask(() => {
            if (!disposed) onCompact?.()
          })
        }
        return maxEvents === undefined || next.length <= maxEvents ? next : next.slice(-maxEvents)
      })
    }

    // The keepalive carries no payload we accumulate — it exists only to prove the socket is
    // alive during quiet stretches (a run that is thinking emits nothing for seconds), so it
    // feeds the watchdog and nothing else.
    const onPing = (): void => {
      lastFrameAt = Date.now()
    }

    const reopenLater = (): void => {
      if (disposed || reopenTimer !== undefined) return
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined
        if (!disposed) open()
      }, REOPEN_DELAY_MS)
    }

    const open = (): void => {
      source?.close()
      // A fresh socket resets the clock: replay is about to arrive, so it must not be judged
      // stale before its first frame lands.
      lastFrameAt = Date.now()
      // Scoped per project like every client.ts path (spec 3.1) — unscoped this is the
      // byte-identical legacy URL. Read per (re)open, but the scope only changes with the
      // route, which unmounts this hook first.
      const params = new URLSearchParams()
      if (cursor !== undefined) params.set('cursor', cursor)
      if (cursor !== undefined || afterSeq > 0) params.set('afterSeq', String(maxSeq))
      const query = params.size > 0 ? `?${params.toString()}` : ''
      source = new Source(apiPath(`/runs/${encodeURIComponent(runId)}/events${query}`), {
        withCredentials: true,
      })
      for (const name of RUN_EVENT_NAMES) source.addEventListener(name, onFrame)
      source.addEventListener('ping', onPing)
      source.addEventListener('error', () => {
        // Ordinary drops leave the socket CONNECTING and the browser retries on its own; CLOSED
        // means it gave up for good (what a restarting server produces), so nothing would reopen
        // it — the transcript would silently freeze while the header (global stream) keeps
        // updating, looking live over stale content. Reopen; `maxSeq` swallows the replay.
        if (source?.readyState === CLOSED) reopenLater()
      })
    }

    // The phone-in-a-pocket case: a frozen background tab can leave the stream dead for an hour
    // with no error handler ever firing. On return, reopen if it's closed — whatever is on screen
    // is about to be trusted (the thread is the app's primary view, same threat model as the
    // global stream). #minor-run-sse-recovery.
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      if (!source || source.readyState === CLOSED) {
        clearTimeout(reopenTimer)
        reopenTimer = undefined
        open()
      }
    }

    // Same bfcache discipline as the global stream: a full navigation parks this document with
    // its socket open and starves the per-origin pool. Close on pagehide; a bfcache restore
    // reopens, and `maxSeq` swallows the replayed prefix.
    const onPageHide = (): void => {
      clearTimeout(reopenTimer)
      reopenTimer = undefined
      source?.close()
    }
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) open()
    }

    // The watchdog only acts while the tab is visible: a hidden tab legitimately receives
    // nothing (the browser throttles it), and `onVisibilityChange` already reopens a CLOSED
    // socket on return. This catches the case that one cannot — a socket still reported OPEN
    // that has silently stopped delivering.
    livenessTimer = setInterval(() => {
      if (disposed || document.visibilityState !== 'visible') return
      if (Date.now() - lastFrameAt <= STALE_MS) return
      clearTimeout(reopenTimer)
      reopenTimer = undefined
      open()
    }, LIVENESS_CHECK_MS)

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    open()

    return () => {
      disposed = true
      clearTimeout(reopenTimer)
      clearInterval(livenessTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      source?.close()
    }
  }, [runId, cursor, afterSeq, maxEvents, compactAt, onCompact])

  return events
}
