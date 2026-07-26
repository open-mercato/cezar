import * as React from 'react'

/* Desktop-only preference: the drawer (<md) always renders the full sidebar, so nothing below
 * the breakpoint ever reads this. Presence-keyed ('1' or absent) rather than a JSON blob —
 * absent IS the default (expanded), so a cleared storage never deserializes into a surprise. */
const STORAGE_KEY = 'cezar:sidebar-collapsed'

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = React.useState(readStoredCollapsed)
  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        if (next) window.localStorage.setItem(STORAGE_KEY, '1')
        else window.localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* private mode: the toggle still works for the session, it just won't persist */
      }
      return next
    })
  }, [])
  return [collapsed, toggle]
}
