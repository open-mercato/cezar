import * as React from 'react'

/**
 * Re-render on a slow tick so relative ages stay true between data updates.
 *
 * 30s is the callers' interval: finer than the coarsest unit an age can show ('1m'), and cheap
 * enough that a screen of rows costs nothing between SSE updates. `enabled` lets a caller that
 * pins the clock (a test) skip the timer entirely.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, enabled])
  return now
}
