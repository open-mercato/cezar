import { useEffect, useLayoutEffect, useState } from 'react'

export type CezarTheme = 'light' | 'dark' | 'system'
export type CezarResolvedTheme = 'light' | 'dark'
export type CezarAccent = 'lime' | 'violet'
export type CezarDensity = 'comfortable' | 'compact' | 'ultra'
export type CezarWidth = 'narrow' | 'wide'

export const CEZAR_SYSTEM_THEME_QUERY = '(prefers-color-scheme: light)'

export interface CezarAppearance {
  theme: CezarTheme
  accent: CezarAccent
  density: CezarDensity
  width: CezarWidth
}

export function resolveCezarTheme(
  theme: CezarTheme,
  systemPrefersLight = false,
): CezarResolvedTheme {
  if (theme === 'system') return systemPrefersLight ? 'light' : 'dark'
  return theme
}

export function useResolvedCezarTheme(theme: CezarTheme): CezarResolvedTheme {
  const [resolved, setResolved] = useState<CezarResolvedTheme>(() => resolveCezarTheme(theme))

  useEffect(() => {
    if (theme !== 'system') {
      setResolved(theme)
      return
    }

    const media = globalThis.matchMedia?.(CEZAR_SYSTEM_THEME_QUERY)
    if (!media) {
      setResolved('dark')
      return
    }
    const update = (matches: boolean) => setResolved(matches ? 'light' : 'dark')
    update(media.matches)
    const onChange = (event: MediaQueryListEvent) => update(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  return resolved
}

const APPEARANCE_ATTRIBUTES = [
  'data-cezar-theme',
  'data-cezar-accent',
  'data-cezar-density',
  'data-cezar-width',
] as const

function classTokens(className: string | undefined): string[] {
  return ['cezar-root', ...(className?.split(/\s+/).filter(Boolean) ?? [])]
}

/** Apply appearance to an adopted host node and restore the exact host-owned baseline. */
export function useAdoptedCezarAppearance(
  rootElement: HTMLElement | null | undefined,
  resolvedTheme: CezarResolvedTheme,
  accent: CezarAccent,
  density: CezarDensity,
  width: CezarWidth,
  className?: string,
): void {
  useLayoutEffect(() => {
    if (!rootElement) return

    const hadClassAttribute = rootElement.hasAttribute('class')
    const hadStyleAttribute = rootElement.hasAttribute('style')
    const addedClasses = classTokens(className).filter((token) => !rootElement.classList.contains(token))
    rootElement.classList.add(...addedClasses)
    const previousAttributes = new Map(
      APPEARANCE_ATTRIBUTES.map((attribute) => [attribute, rootElement.getAttribute(attribute)]),
    )
    const previousColorScheme = rootElement.style.getPropertyValue('color-scheme')
    const previousColorSchemePriority = rootElement.style.getPropertyPriority('color-scheme')

    rootElement.setAttribute('data-cezar-theme', resolvedTheme)
    rootElement.setAttribute('data-cezar-accent', accent)
    rootElement.setAttribute('data-cezar-density', density)
    rootElement.setAttribute('data-cezar-width', width)
    rootElement.style.setProperty('color-scheme', resolvedTheme)

    return () => {
      for (const token of addedClasses) rootElement.classList.remove(token)
      if (!hadClassAttribute && rootElement.className === '') rootElement.removeAttribute('class')
      for (const attribute of APPEARANCE_ATTRIBUTES) {
        const previous = previousAttributes.get(attribute)
        if (previous === null || previous === undefined) rootElement.removeAttribute(attribute)
        else rootElement.setAttribute(attribute, previous)
      }
      if (previousColorScheme === '') rootElement.style.removeProperty('color-scheme')
      else {
        rootElement.style.setProperty(
          'color-scheme',
          previousColorScheme,
          previousColorSchemePriority,
        )
      }
      if (!hadStyleAttribute && rootElement.getAttribute('style') === '') {
        rootElement.removeAttribute('style')
      }
    }
  }, [rootElement, resolvedTheme, accent, density, width, className])
}

export function cezarRootClassName(className?: string): string {
  return classTokens(className).join(' ')
}
