import { useEffect, useRef, useState } from 'react'

/**
 * Publish a fast-changing value at most once per window — leading edge immediately, then the
 * latest value at the end of each window while the changes keep coming.
 *
 * WHY: a live run's SSE stream flushes coalesced deltas every ~40 ms (the server's own
 * `DELTA_FLUSH_MS`), and every frame that reaches React re-folds the transcript and re-renders
 * the task thread. That render costs far more than 40 ms on a phone, so the main thread never
 * gets a quiet moment and touch scrolling stutters. Coalescing once more here turns ~25
 * renders/s into ~8 — still well past the rate at which streaming text reads as live.
 *
 * The leading edge is what keeps that honest: after a quiet stretch — a tool starting, the
 * user's own message landing, a session ending — the very next change publishes with no delay.
 * Only a genuine burst is throttled.
 *
 * Both edges publish DURING RENDER (React's documented adjusting-state-while-rendering pattern)
 * rather than from an effect: an effect would commit the stale value first and re-render the
 * whole subtree to correct it, which is exactly the work this hook exists to avoid.
 *
 * `resetKey` publishes immediately when it changes: the window belongs to a stream of updates
 * about one subject, and switching subjects (another run) must never show the previous one's
 * value for even a frame.
 *
 * `value` must keep its identity between actual changes (state or a memo, not a fresh array
 * built inline every render) — this compares by reference, as a coalescer of a stream must.
 */
export function useThrottledValue<T>(value: T, windowMs: number, resetKey?: unknown): T {
  const [published, setPublished] = useState<{ key: unknown; value: T }>({ key: resetKey, value })
  // Read at FLUSH time, never captured: a timer scheduled before the latest change must publish
  // what is current when it fires, labelled with the subject that is current when it fires.
  const latest = useRef(value)
  latest.current = value
  const latestKey = useRef(resetKey)
  latestKey.current = resetKey
  const publishedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hasCommittedPublication = useRef(false)

  const stale = !Object.is(published.value, value)
  if (published.key !== resetKey) setPublished({ key: resetKey, value })
  else if (stale && timer.current === undefined && Date.now() - publishedAt.current >= windowMs) {
    setPublished({ key: resetKey, value })
  }

  // State adjustment is the only render-phase write. Timer cancellation and clock mutation wait
  // for a committed publication, so a discarded concurrent/StrictMode render changes no external
  // scheduling state.
  useEffect(() => {
    if (!hasCommittedPublication.current) {
      hasCommittedPublication.current = true
      return
    }
    clearTimeout(timer.current)
    timer.current = undefined
    publishedAt.current = Date.now()
  }, [published])

  // The trailing edge: whatever the window swallowed lands as one update when it closes.
  useEffect(() => {
    if (Object.is(published.value, value) || timer.current !== undefined) return
    const wait = Math.max(0, publishedAt.current + windowMs - Date.now())
    timer.current = setTimeout(() => {
      timer.current = undefined
      publishedAt.current = Date.now()
      setPublished({ key: latestKey.current, value: latest.current })
    }, wait)
  }, [published, value, windowMs])

  useEffect(() => () => clearTimeout(timer.current), [])

  return published.value
}
