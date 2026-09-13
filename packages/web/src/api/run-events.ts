import { useEffect, useRef, useState } from 'react'

import { apiPath, getApiScope } from '@open-mercato/cezar-api-client'
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
 * Dedup is sequence-based, but the page's `asOfSeq` is not a received-event watermark: ephemeral
 * deltas consume sequence numbers that never reappear in a replay. A page refresh can therefore
 * move that file high-water mark past a live frame still waiting in this socket.
 */

/** Both wire names. Exported so tests and future consumers subscribe to exactly this set. */
export const RUN_EVENT_NAMES = ['run-event', 'ui-event'] as const

/**
 * EventSource delivers token/delta frames as separate tasks. Rendering once per frame makes a
 * transcript rebuild the whole visible thread at agent-event rate, so publish at most one batch
 * every 50 ms. This is below a normal typing frame while bounding React work during fast streams.
 */
export const RUN_EVENT_BATCH_MS = 50
const COMPACTION_RETRY_BASE_MS = 1_000
const COMPACTION_RETRY_MAX_MS = 60_000
const MAX_SEEN_SEQS = 10_000

function rememberSeq(seqs: Set<number>, seq: number): void {
  seqs.add(seq)
  if (seqs.size <= MAX_SEEN_SEQS) return
  const oldest = seqs.values().next().value
  if (typeof oldest === 'number') seqs.delete(oldest)
}

export type RunEventCompaction = readonly number[]

export function runItemKey(stepId: unknown, itemId: string): string {
  return typeof stepId === 'string' ? `${stepId}:${itemId}` : itemId
}

export function liveItemKey(event: RunEvent): string | undefined {
  const itemId = event.type === 'item.delta'
    ? event.itemId
    : typeof event.item === 'object' && event.item !== null && !Array.isArray(event.item)
      ? (event.item as { id?: unknown }).id
      : undefined
  return typeof itemId === 'string' && itemId !== ''
    ? runItemKey(event.stepId, itemId)
    : undefined
}

/** Keep optimized transcript state lossless without retaining one row per streamed chunk. */
function coalesceLiveDeltas(events: readonly RunEvent[]): RunEvent[] {
  const output: RunEvent[] = []
  const deltaIndexes = new Map<string, number>()
  for (const event of events) {
    const itemKey = liveItemKey(event)
    if (itemKey !== undefined && event.type !== 'item.delta') {
      for (const field of ['text', 'reasoning', 'output']) deltaIndexes.delete(`${itemKey}:${field}`)
    }
    if (
      event.type === 'item.delta' &&
      itemKey !== undefined &&
      (event.field === 'text' || event.field === 'reasoning' || event.field === 'output') &&
      typeof event.delta === 'string'
    ) {
      const key = `${itemKey}:${event.field}`
      const previousIndex = deltaIndexes.get(key)
      if (previousIndex !== undefined) {
        const previous = output[previousIndex]!
        // Keep the newest constituent seq. If a durable snapshot covers only the first chunk,
        // filtering by that old seq must not evict the merged event and lose the later text.
        const merged = {
          ...previous,
          seq: event.seq,
          ts: event.ts,
          delta: `${previous.delta as string}${event.delta}`,
        }
        if (previousIndex === output.length - 1) {
          output[previousIndex] = merged
        } else {
          output.splice(previousIndex, 1)
          for (const [trackedKey, index] of deltaIndexes) {
            if (index > previousIndex) deltaIndexes.set(trackedKey, index - 1)
          }
          deltaIndexes.set(key, output.length)
          output.push(merged)
        }
        continue
      }
      deltaIndexes.set(key, output.length)
    }
    output.push(event)
  }
  return output
}

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
 * Subscribe to one run's event stream and accumulate the ordered list. The optimized history
 * caller losslessly coalesces same-item delta chunks; the fallback keeps raw frames.
 *
 * The list resets when `runId` changes (a different run's events are not "earlier state" of
 * this one) and the socket closes on unmount — an EventSource left unclosed retries forever.
 * No reducer cache, no query-client involvement: unlike the global stream, this data belongs
 * to exactly the component that asked for it.
 */
export interface RunEventStreamOptions {
  cursor?: string
  afterSeq?: number
  /** Request another compaction when the live snapshot exceeds this size; never truncates it. */
  compactWhenOver?: number
  /** Ask the history owner to fold the live prefix into a fresh persisted tail page. */
  compactAt?: number
  /** Return exactly the live sequence numbers now covered by durable history. */
  onCompact?: (events: readonly RunEvent[]) => RunEventCompaction | false | Promise<RunEventCompaction | false>
}

export function useRunEvents(runId: string | undefined, options: RunEventStreamOptions = {}): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const scope = getApiScope()
  const optionsRef = useRef(options)
  optionsRef.current = options
  const maxSeqRef = useRef(0)
  const pageHighWaterRef = useRef(0)
  const initialPageHighWaterRef = useRef(0)
  const allowLateFramesRef = useRef(false)
  const seenSeqsRef = useRef(new Set<number>())
  const compactCommittedRef = useRef<((events: readonly RunEvent[]) => void) | undefined>(undefined)

  useEffect(() => {
    const { afterSeq = 0 } = optionsRef.current
    // A runId change is the only time this hook changes owners. Cursor/compaction updates keep the
    // same socket and live buffer, so ephemeral frames cannot fall into a REST-to-SSE handoff gap.
    maxSeqRef.current = 0
    pageHighWaterRef.current = afterSeq
    initialPageHighWaterRef.current = afterSeq
    allowLateFramesRef.current = false
    seenSeqsRef.current.clear()
    setEvents([])
    if (!runId) return

    // Off `globalThis`, like global-events.tsx: jsdom has no EventSource, and the tests stub it.
    const Source = globalThis.EventSource
    if (typeof Source !== 'function') return

    let source: EventSource | null = null
    let streamToken = 0
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let compactionRequested = false
    let compactionFailures = 0
    let nextCompactionAt = 0
    let eventsSinceCompaction = 0
    let pending: RunEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined
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

    const markCompactionFailed = (): void => {
      compactionRequested = false
      compactionFailures = Math.min(compactionFailures + 1, 6)
      nextCompactionAt = Date.now() + Math.min(
        COMPACTION_RETRY_MAX_MS,
        COMPACTION_RETRY_BASE_MS * 2 ** (compactionFailures - 1),
      )
    }

    const requestCompaction = (snapshot: readonly RunEvent[]): void => {
      const options = optionsRef.current
      if (options.onCompact === undefined) return
      if (
        (options.compactAt === undefined || eventsSinceCompaction < options.compactAt)
        && (options.compactWhenOver === undefined || snapshot.length <= options.compactWhenOver)
      ) return
      if (Date.now() < nextCompactionAt) return
      compactionRequested = true
      const requestedAt = eventsSinceCompaction
      // Read the current callback: the history query can replace it while this request waits.
      void Promise.resolve()
        .then(() => {
          if (disposed) return undefined
          return optionsRef.current.onCompact?.(snapshot)
        })
        .then(
          (coveredSeqs) => {
            if (disposed) return
            // Empty coverage made no progress: keep the live buffer, but back off before asking
            // for the same snapshot on every 50 ms batch.
            if (!Array.isArray(coveredSeqs) || coveredSeqs.length === 0) {
              markCompactionFailed()
              return
            }
            compactionFailures = 0
            nextCompactionAt = 0
            eventsSinceCompaction = Math.max(0, eventsSinceCompaction - requestedAt)
            compactionRequested = false
            // The history owner knows which persisted snapshots cover live-only frames. A
            // numeric high-water mark is not enough: ephemeral deltas burn sequence numbers.
            const covered = new Set(coveredSeqs)
            if (covered.size === 0) return
            setEvents((current) => current.filter(({ seq }) => !covered.has(seq)))
          },
          () => {
            if (!disposed) markCompactionFailed()
          },
        )
    }

    const flush = (): void => {
      flushTimer = undefined
      if (pending.length === 0) return
      const batch = pending
      pending = []
      setEvents((current) => {
        const options = optionsRef.current
        return options.compactAt !== undefined || options.onCompact !== undefined
          ? coalesceLiveDeltas([...current, ...batch])
          : [...current, ...batch]
      })
    }

    const scheduleFlush = (): void => {
      if (flushTimer === undefined) flushTimer = setTimeout(flush, RUN_EVENT_BATCH_MS)
    }

    const closeSource = (): void => {
      streamToken += 1
      const current = source
      if (!current) return
      current.close()
      source = null
    }

    const onFrame = (event: Event, token: number) => {
      if (disposed || token !== streamToken) return
      // Any frame proves the socket is alive — bump the watchdog before the dedup drop, so a
      // replayed prefix (which is dropped below) still counts as liveness.
      lastFrameAt = Date.now()
      const parsed = parseRunEvent((event as MessageEvent<string>).data)
      if (!parsed || seenSeqsRef.current.has(parsed.seq)) return
      if (
        parsed.seq <= maxSeqRef.current
        && (!allowLateFramesRef.current || parsed.seq <= initialPageHighWaterRef.current)
      ) return
      rememberSeq(seenSeqsRef.current, parsed.seq)
      maxSeqRef.current = Math.max(maxSeqRef.current, parsed.seq)
      eventsSinceCompaction += 1
      pending.push(parsed)
      scheduleFlush()
    }

    // The keepalive carries no payload we accumulate — it exists only to prove the socket is
    // alive during quiet stretches (a run that is thinking emits nothing for seconds), so it
    // feeds the watchdog and nothing else.
    const onPing = (token: number): void => {
      if (disposed || token !== streamToken) return
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
      closeSource()
      const token = streamToken
      const { cursor, afterSeq = 0 } = optionsRef.current
      // A fresh socket resets the clock: replay is about to arrive, so it must not be judged
      // stale before its first frame lands.
      lastFrameAt = Date.now()
      pageHighWaterRef.current = Math.max(pageHighWaterRef.current, afterSeq)
      // Scoped per project like every client.ts path (spec 3.1) — unscoped this is the
      // byte-identical legacy URL. Read per (re)open, but the scope only changes with the
      // route, which unmounts this hook first.
      const params = new URLSearchParams()
      if (cursor !== undefined) params.set('cursor', cursor)
      if (cursor !== undefined || afterSeq > 0) {
        params.set('afterSeq', String(Math.max(pageHighWaterRef.current, maxSeqRef.current)))
      }
      const query = params.size > 0 ? `?${params.toString()}` : ''
      const current = new Source(apiPath(`/runs/${encodeURIComponent(runId)}/events${query}`), {
        withCredentials: true,
      })
      source = current
      const frameListener = (event: Event): void => onFrame(event, token)
      for (const name of RUN_EVENT_NAMES) {
        current.addEventListener(name, frameListener)
      }
      const pingListener = (): void => onPing(token)
      current.addEventListener('ping', pingListener)
      const errorListener = (): void => {
        if (disposed || token !== streamToken) return
        // Ordinary drops leave the socket CONNECTING and the browser retries on its own; CLOSED
        // means it gave up for good (what a restarting server produces), so nothing would reopen
        // it — the transcript would silently freeze while the header (global stream) keeps
        // updating, looking live over stale content. Reopen; `maxSeq` swallows the replay.
        if (current.readyState === CLOSED) reopenLater()
      }
      current.addEventListener('error', errorListener)
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
      closeSource()
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
    compactCommittedRef.current = requestCompaction
    open()

    return () => {
      disposed = true
      clearTimeout(reopenTimer)
      clearTimeout(flushTimer)
      flushTimer = undefined
      pending = []
      clearInterval(livenessTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      if (compactCommittedRef.current === requestCompaction) compactCommittedRef.current = undefined
      closeSource()
    }
  }, [runId, scope])

  useEffect(() => {
    if (events.length === 0) return
    compactCommittedRef.current?.(events)
  }, [events])

  // History compaction advances the persisted high-water mark without changing the run owner.
  // Keep the live buffer intact: persisted `asOfSeq` can move past ephemeral frames that are not
  // in the page, so trimming by sequence here would lose live-only transcript content.
  const afterSeq = options.afterSeq ?? 0
  useEffect(() => {
    if (!runId) return
    if (afterSeq > pageHighWaterRef.current) allowLateFramesRef.current = true
    pageHighWaterRef.current = Math.max(pageHighWaterRef.current, afterSeq)
  }, [afterSeq, runId])

  return events
}
