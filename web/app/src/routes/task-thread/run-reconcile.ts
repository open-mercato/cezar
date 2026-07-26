import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { queryKeys } from '@/api/queries'
import type { ApiRun, RunEvent } from '@/api/types'

/**
 * The thread's stale-record healer.
 *
 * The doctrine (task-thread.tsx) splits the page across two feeds: `useRun` (fetch, patched by
 * the workspace stream) is authoritative for the record, `useRunEvents` (per-run SSE) is the
 * transcript. The two can drift: the per-run socket has its own liveness watchdog (#424) and a
 * full replay on reconnect, so the transcript recovers from anything — but a record update lost
 * on the workspace stream (a half-open socket, a dropped frame across a server restart) is gone
 * until something refetches. The thread then renders an impossible mix: the transcript says
 * "goal achieved — session closed" / "run finished" while the record still says `running`, so
 * the Working… spinner keeps spinning and the composer stays in live-session mode — whose sends
 * then 409 against the closed session.
 *
 * The transcript itself carries the truth, so use it: when the latest session boundary in the
 * event list is a `session.ended` and the record still claims a live session, the record is
 * stale — refetch it (the reconcile-on-reconnect doctrine, applied to the one seam reconnect
 * cannot see). A grace period keeps the healthy path quiet: `session.ended` always lands
 * moments before the workspace stream's own record update, and that update cancels the timer.
 */

/** How long the workspace stream gets to deliver the record update on its own before the
 *  transcript's session end is treated as proof of a stale record. Long enough for the engine's
 *  settle write (diff stat, review gate) plus the stream hop; short enough that the reader sees
 *  the thread close instead of a spinner over a "run finished" line. */
export const STALE_RECORD_GRACE_MS = 2_000

/**
 * The seq of the transcript's last session end, when that end is the latest session boundary —
 * 0 when the stream says a session is (or may be) live. `session.ended` is the sink's one
 * guaranteed end-of-session line (ui-event-sink.ts persists it exactly once per session, on
 * every exit path); `session.started` or an agent `step-start` marks a session opening after it
 * (a Continue, a follow-up agent step), which makes an older end stale history, not news. Check
 * steps do not open agent sessions and therefore must not hide the preceding settle signal.
 */
export function settledSessionSeq(events: RunEvent[]): number {
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
  return lastEnd > lastStart ? lastEnd : 0
}

/** Reconcile the run record against the transcript (see module doc). Mounted by the thread
 *  route, next to the two feeds it reconciles. */
export function useRunRecordReconcile(run: ApiRun | undefined, events: RunEvent[]): void {
  const queryClient = useQueryClient()
  const settledSeq = useMemo(() => settledSessionSeq(events), [events])
  const runId = run?.id
  const status = run?.status

  useEffect(() => {
    if (settledSeq === 0 || runId === undefined) return
    // Only a record that claims a live session can be stale in the reported way. Every settled
    // status is what the transcript predicts, and `queued` has no session to have ended.
    if (status !== 'running' && status !== 'waiting') return
    const timer = setTimeout(() => {
      // The list gets the same refresh: the sidebar buckets ("Working") read from it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(runId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
    }, STALE_RECORD_GRACE_MS)
    // The healthy path's exit: the workspace stream patches the record, `status` flips to a
    // settled one, and this cleanup cancels the refetch before it fires.
    return () => clearTimeout(timer)
  }, [settledSeq, runId, status, queryClient])
}
