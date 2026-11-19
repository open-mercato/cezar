import { useEffect, useRef, useState } from 'react'

import type { ManagerActionStatus } from '@open-mercato/cezar-api-client'

/** How long a card decided on the Approvals or Questions page stays after it finished. */
export const LINGER_MS = 30_000
/** The fade at the end of the linger; reduced motion skips it. */
export const FADE_MS = 300

export function isFinished(status: ManagerActionStatus): boolean {
  return status !== 'pending' && status !== 'running'
}

export const lingerFading = (finishedAt: number | undefined, now: number) => finishedAt !== undefined && finishedAt + LINGER_MS - FADE_MS <= now

/**
 * The clock lingering rows read: it ticks at each row's fade and end, and calls `prune` when a
 * row's linger ended. A clock behind a just-finished row only keeps that row longer, never shorter.
 */
export function useLingerClock(rows: ReadonlyArray<{ finishedAt?: number }>, prune: (now: number) => void): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const at = Date.now()
    const due = rows
      .flatMap((row) => (row.finishedAt === undefined ? [] : [row.finishedAt + LINGER_MS - FADE_MS, row.finishedAt + LINGER_MS]))
      .filter((when) => when > at)
    // Every boundary armed at once: the end must not wait for the fade's re-render to schedule it.
    const timers = [...new Set(due)].map((when) => setTimeout(() => {
      const tick = Date.now()
      setNow(tick)
      prune(tick)
    }, when - at))
    return () => timers.forEach(clearTimeout)
  }, [rows, prune])
  return now
}

/**
 * Keeps the order items first appeared in for this mount; new ones follow. A decision bumps its
 * manager's last activity, and re-sorting then moved the decided card out from under the reader.
 */
export function useStableOrder<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = useRef<readonly string[]>([])
  const rank = new Map(seen.current.map((id, index) => [id, index]))
  const known = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const ordered = [...known, ...items.filter((item) => !rank.has(item.id))]
  // An id briefly missing from a list keeps its slot for when it comes back.
  seen.current = [...ordered.map((item) => item.id), ...seen.current.filter((id) => !items.some((item) => item.id === id))]
  return ordered
}
