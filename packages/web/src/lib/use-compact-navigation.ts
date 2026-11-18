import { useLayoutEffect, useState, type RefObject } from 'react'

// Sidebar plus main-view room (spec 2026-10-31-managers, Phones); embedded shells use their own width.
export const DESKTOP_NAV_MIN_WIDTH = 1024

export function useCompactNavigation(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(() => window.innerWidth < DESKTOP_NAV_MIN_WIDTH)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      setCompact((width > 0 ? width : window.innerWidth) < DESKTOP_NAV_MIN_WIDTH)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref])
  return compact
}
