import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider, useTheme } from './theme-provider'
import { THEME_STORAGE_KEY, type Theme } from '@/lib/theme'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

/** jsdom ships no `matchMedia`, so stub one in — and make it controllable, so a test can flip the
 *  OS preference the way a user switching their system appearance would. */
function mockMatchMedia(initiallyPrefersLight: boolean) {
  let prefersLight = initiallyPrefersLight
  const listeners = new Set<(event: MediaQueryListEvent) => void>()

  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        media: query,
        get matches() {
          return prefersLight
        },
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener)
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener)
        },
      }) as unknown as MediaQueryList
  )

  return {
    flipOsTo(next: boolean) {
      prefersLight = next
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
      })
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

let setTheme: (theme: Theme) => void
let seen: { theme: Theme; resolvedTheme: string }

function Probe() {
  const value = useTheme()
  setTheme = value.setTheme
  seen = { theme: value.theme, resolvedTheme: value.resolvedTheme }
  return (
    <span data-testid="probe">
      {value.theme}/{value.resolvedTheme}
    </span>
  )
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  )
}

const root = () => document.documentElement

beforeEach(() => {
  localStorage.clear()
  root().className = ''
  root().style.colorScheme = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ThemeProvider', () => {
  it('defaults to dark with nothing stored', () => {
    mockMatchMedia(false)
    renderProvider()

    expect(screen.getByTestId('probe').textContent).toBe('dark/dark')
    expect(root().classList.contains('light')).toBe(false)
    expect(root().style.colorScheme).toBe('dark')
  })

  it('seeds an explicit stored preference and stamps the root', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    mockMatchMedia(false)
    renderProvider()

    expect(seen).toEqual({ theme: 'light', resolvedTheme: 'light' })
    expect(root().classList.contains('light')).toBe(true)
    expect(root().style.colorScheme).toBe('light')
  })

  it.each([
    { osPrefersLight: true, resolved: 'light' },
    { osPrefersLight: false, resolved: 'dark' },
  ])('resolves system from matchMedia (light OS: $osPrefersLight)', ({ osPrefersLight, resolved }) => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system')
    mockMatchMedia(osPrefersLight)
    renderProvider()

    expect(seen.theme).toBe('system')
    expect(seen.resolvedTheme).toBe(resolved)
    expect(root().classList.contains('light')).toBe(osPrefersLight)
  })

  it('follows a live OS flip while system is selected', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system')
    const media = mockMatchMedia(false)
    renderProvider()
    expect(seen.resolvedTheme).toBe('dark')

    media.flipOsTo(true)

    expect(seen.resolvedTheme).toBe('light')
    expect(root().classList.contains('light')).toBe(true)
    expect(root().style.colorScheme).toBe('light')

    media.flipOsTo(false)

    expect(seen.resolvedTheme).toBe('dark')
    expect(root().classList.contains('light')).toBe(false)
  })

  it('ignores an OS flip while a theme is explicitly chosen', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const media = mockMatchMedia(false)
    renderProvider()

    media.flipOsTo(true)

    expect(seen.resolvedTheme).toBe('dark')
    expect(root().classList.contains('light')).toBe(false)
  })

  it('persists setTheme to the key the legacy cockpit shares', () => {
    mockMatchMedia(false)
    renderProvider()

    act(() => setTheme('light'))

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(seen).toEqual({ theme: 'light', resolvedTheme: 'light' })
    expect(root().classList.contains('light')).toBe(true)
  })

  it('removes the light class when setTheme goes back to dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    mockMatchMedia(false)
    renderProvider()
    expect(root().classList.contains('light')).toBe(true)

    act(() => setTheme('dark'))

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(root().classList.contains('light')).toBe(false)
    expect(root().style.colorScheme).toBe('dark')
  })

  it('stores system verbatim so the legacy page can degrade to its own dark default', () => {
    mockMatchMedia(true)
    renderProvider()

    act(() => setTheme('system'))

    // Not the resolved 'light' — that would destroy the choice on the next legacy visit.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  // A legacy value or plain garbage in the shared key must not crash the app.
  it.each(['neon', '', '{"theme":"dark"}'])('recovers from the stored value %o', (garbage) => {
    localStorage.setItem(THEME_STORAGE_KEY, garbage)
    mockMatchMedia(true)

    expect(() => renderProvider()).not.toThrow()
    expect(seen).toEqual({ theme: 'dark', resolvedTheme: 'dark' })
  })

  it('keeps working when storage is unreadable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    mockMatchMedia(false)
    renderProvider()

    act(() => setTheme('light'))

    expect(seen.resolvedTheme).toBe('light')
    expect(root().classList.contains('light')).toBe(true)
  })

  it('unsubscribes from the media query on unmount', () => {
    const media = mockMatchMedia(false)
    const { unmount } = renderProvider()
    expect(media.listenerCount).toBe(1)

    unmount()

    expect(media.listenerCount).toBe(0)
  })
})

describe('useTheme', () => {
  it('throws outside a provider rather than silently rendering the wrong palette', () => {
    // React logs the thrown render error; silence it so the run stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => render(<Probe />)).toThrow(/useTheme\(\) must be called inside <ThemeProvider>/)
  })
})
