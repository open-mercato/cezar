import { useCallback, useSyncExternalStore } from 'react'

/** Does the viewport match `query` right now — live, so a rotated phone re-renders. Without
 *  `matchMedia` (jsdom) the answer is false. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
      if (!list) return () => {}
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  )
}

/** Below Tailwind's `md` — the header's and the strip's phone breakpoint. */
export const PHONE_QUERY = '(max-width: 767px)'
