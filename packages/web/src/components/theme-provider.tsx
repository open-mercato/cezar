import * as React from 'react'

import {
  LIGHT_MEDIA_QUERY,
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  systemPrefersLight,
  writeStoredTheme,
  type ResolvedTheme,
  type Theme,
} from '@/lib/theme'

type ThemeContextValue = {
  /** What the user chose: `light`, `dark`, or `system`. */
  theme: Theme
  /** What is actually painting — `system` collapsed against the OS preference. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

/** Owns the theme preference: seeds from `localStorage` (the same value the pre-paint script in
 *  index.html already stamped, so mounting never repaints), tracks the OS preference live, and
 *  keeps the root element in sync. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(readStoredTheme)
  const [prefersLight, setPrefersLight] = React.useState<boolean>(systemPrefersLight)

  React.useEffect(() => {
    const query = window.matchMedia?.(LIGHT_MEDIA_QUERY)
    if (!query) return
    // Re-read on subscribe: the OS can flip between the initial render and this effect.
    setPrefersLight(query.matches)
    const onChange = (event: MediaQueryListEvent) => setPrefersLight(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const resolvedTheme = resolveTheme(theme, prefersLight)

  // Layout effect, not effect: the class must land before the browser paints the mounted tree.
  React.useLayoutEffect(() => {
    applyResolvedTheme(document.documentElement, resolvedTheme)
  }, [resolvedTheme])

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next)
    writeStoredTheme(next)
  }, [])

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext)
  if (!context) throw new Error('cezar: useTheme() must be called inside <ThemeProvider>')
  return context
}
