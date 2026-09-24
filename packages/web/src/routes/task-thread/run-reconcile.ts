import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { queryKeys } from '@/api/queries'
import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

/**
 * The thread's stale-record healer, in BOTH directions.
 *
 * The doctrine (task-thread.tsx) splits the page across two feeds: `useRun` (fetch, patched by
 * the workspace stream) is authoritative for the record, `useRunEvents` (per-run SSE) is the
 * transcript. The two can drift: the per-run socket has its own liveness watchdog (#424) and a
 * full replay on reconnect, so the transcript recovers from anything — but a record update lost
 * on the workspace stream (a half-open socket, a dropped frame across a server restart) is gone
 * until something refetches. Nothing else refetches it: the cockpit does not poll, `staleTime`
 * is five minutes and window focus is deliberately not a refetch trigger (query-client.ts), so
 * navigating away and back lands on the same cached lie — only a page reload clears it.
 *
 * The thread then renders an impossible mix, and it has two shapes:
 *
 *  - the record says `running` over a settled transcript: the Working… spinner keeps spinning
 *    under "run finished", and the composer stays in live-session mode — whose sends then 409
 *    against the closed session;
 *  - the record says `done`/`review`/`failed` over a transcript whose session is OPEN again (a
 *    Continue, an auto-resume after a usage limit, a restart recovery): the thread reads as
 *    closed while the task is running, and the composer is aimed at `POST /continue`, which
 *    answers "run is still active" — the reply bounces back into the draft with a toast, and
 *    typing again changes nothing because nothing here refetches the record.
 *
 * The transcript carries the truth in both, so use it: compare the LATEST session boundary in
 * the event list against what the record claims, and refetch when they disagree (the
 * reconcile-on-reconnect doctrine, applied to the one seam reconnect cannot see). A grace period
 * keeps the healthy path quiet: a boundary always lands moments before the workspace stream's
 * own record update, and that update cancels the timer.
 */

/** How long the workspace stream gets to deliver the record update on its own before the
 *  transcript's session end is treated as proof of a stale record. Long enough for the engine's
 *  settle write (diff stat, review gate) plus the stream hop; short enough that the reader sees
 *  the thread close instead of a spinner over a "run finished" line. */
export const STALE_RECORD_GRACE_MS = 2_000

/**
 * The transcript's last session boundary of each kind.
 *
 * `session.ended` is the sink's one guaranteed end-of-session line (ui-event-sink.ts persists it
 * exactly once per session, on every exit path). An opening is `session.started` — every mapper
 * emits it from the backend's init frame — or an agent `step-start`, which the store writes the
 * moment a Continue adds its step and therefore arrives seconds earlier. Check steps do not open
 * agent sessions and so are not openings here.
 */
function sessionBoundaries(events: RunEvent[]): { lastEnd: number; lastStart: number } {
  let lastEnd = 0
  let lastStart = 0
  for (const event of events) {
    if (typeof event.seq !== 'number') continue
    if (event.type === 'session.ended' && event.seq > lastEnd) lastEnd = event.seq
    if (
      (event.type === 'session.started' ||
        (event.type === 'step-start' && event.kind === 'agent')) &&
      event.seq > lastStart
    )
      lastStart = event.seq
  }
  return { lastEnd, lastStart }
}

/**
 * The seq of the transcript's last session end, when that end is the latest session boundary —
 * 0 when the stream says a session is (or may be) live. An opening after it (a Continue, a
 * follow-up agent step) makes that end stale history, not news.
 */
export function settledSessionSeq(events: RunEvent[]): number {
  const { lastEnd, lastStart } = sessionBoundaries(events)
  return lastEnd > lastStart ? lastEnd : 0
}

/**
 * The mirror: the seq of the transcript's last session OPENING, when that opening is the latest
 * boundary — 0 when the newest boundary is an end (or there is no boundary at all). A session
 * that opened and has not ended is the transcript saying the run is live, whatever the record
 * claims.
 */
export function liveSessionSeq(events: RunEvent[]): number {
  const { lastEnd, lastStart } = sessionBoundaries(events)
  return lastStart > lastEnd ? lastStart : 0
}

/** Reconcile the run record against the transcript (see module doc). Mounted by the thread
 *  route, next to the two feeds it reconciles. */
export function useRunRecordReconcile(run: ApiRun | undefined, events: RunEvent[]): void {
  const queryClient = useQueryClient()
  const settledSeq = useMemo(() => settledSessionSeq(events), [events])
  const liveSeq = useMemo(() => liveSessionSeq(events), [events])
  const runId = run?.id
  const status = run?.status

  useEffect(() => {
    if (runId === undefined || status === undefined) return
    // `queued` is neither claim: the run has no session yet, and a continuation deferred for
    // capacity (workflows/run.ts) parks at `queued` with its Continue step — an opening — already
    // in the transcript. Reading that as drift would refetch a record that is telling the truth.
    if (status === 'queued') return
    const claimsLiveSession = status === 'running' || status === 'waiting'
    // Derived rather than enumerated, like `runIsTerminal` in the thread: anything that is not
    // live and not queued is a settled record, so a status added later cannot slip past this.
    const drifted = claimsLiveSession ? settledSeq > 0 : liveSeq > 0
    if (!drifted) return
    const timer = setTimeout(() => {
      // The list gets the same refresh: the sidebar buckets ("Working") read from it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(runId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
    }, STALE_RECORD_GRACE_MS)
    // The healthy path's exit: the workspace stream patches the record, `status` flips to the
    // one the transcript predicted, and this cleanup cancels the refetch before it fires.
    return () => clearTimeout(timer)
  }, [settledSeq, liveSeq, runId, status, queryClient])
}
