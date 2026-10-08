import * as React from 'react'

import { shortAge } from '@/lib/format'
import { useNow } from '@/lib/use-now'

const NowContext = React.createContext<number | null>(null)

/**
 * The clock for relative ages, published through context so the slow tick re-renders only the
 * age cells that read it — never the (memoized) rows around them. `now` pins it, for tests.
 */
export function LiveNowProvider({
  intervalMs,
  now,
  children,
}: {
  intervalMs: number
  now?: number
  children: React.ReactNode
}) {
  const live = useNow(intervalMs, now === undefined)
  return <NowContext.Provider value={now ?? live}>{children}</NowContext.Provider>
}

/** `shortAge` against the nearest `LiveNowProvider`'s clock (the wall clock without one). */
export function RelativeAge({ at }: { at: string }) {
  const now = React.useContext(NowContext) ?? Date.now()
  return <>{shortAge(at, now)}</>
}
