import { useEffect, useState } from 'react'

/** The shared default: md-and-up, the "phones force unified+wrap" rule's own threshold. */
const DESKTOP_MIN_WIDTH = 768

/**
 * md-and-up, live: the "phones force unified+wrap" rule (spec §"Session git view — Changes &
 * Files tabs (#390)") must follow a rotation/resize, not the first render. jsdom (no
 * matchMedia) counts as desktop, same convention as plan-dock.ts.
 *
 * Shared by the task Changes tab and the repo view (R5 1.7) — one seam, one rule.
 *
 * `minWidth` overrides the threshold for a caller whose question is not that rule's question.
 * The task workspace is the one such caller: it asks whether there is room for SEVERAL COLUMNS
 * SIDE BY SIDE, which needs more width than deciding whether a diff should wrap, and its spec
 * names "mobile/tablet" for one-column-at-a-time. The mechanism stays here so there is still one
 * implementation of the live media query rather than a second hand-rolled listener.
 */
export function useIsDesktop(minWidth: number = DESKTOP_MIN_WIDTH): boolean {
  const query = `(min-width: ${minWidth}px)`
  const [desktop, setDesktop] = useState(
    () => typeof window.matchMedia !== 'function' || window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    // Re-synced on a changed threshold, not only on a media change: the first state was computed
    // against whatever `query` was at mount.
    setDesktop(media.matches)
    const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return desktop
}
