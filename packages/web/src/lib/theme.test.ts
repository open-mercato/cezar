import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  applyThemeColorMeta,
  normalizeTheme,
  readStoredTheme,
  resolveTheme,
  systemPrefersLight,
  writeStoredTheme,
  type ResolvedTheme,
  type Theme,
} from './theme'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** jsdom ships no `matchMedia` at all, so stub rather than spy. */
function stubMatchMedia(matches: boolean) {
  const matchMedia = vi.fn((query: string) => ({ media: query, matches }) as MediaQueryList)
  vi.stubGlobal('matchMedia', matchMedia)
  return matchMedia
}

describe('resolveTheme', () => {
  it.each([
    { pref: 'light', systemPrefersLight: false, expected: 'light' },
    { pref: 'light', systemPrefersLight: true, expected: 'light' },
    { pref: 'dark', systemPrefersLight: false, expected: 'dark' },
    { pref: 'dark', systemPrefersLight: true, expected: 'dark' },
    { pref: 'system', systemPrefersLight: false, expected: 'dark' },
    { pref: 'system', systemPrefersLight: true, expected: 'light' },
  ] as const)(
    '$pref + systemPrefersLight=$systemPrefersLight → $expected',
    ({ pref, systemPrefersLight: light, expected }) => {
      expect(resolveTheme(pref, light)).toBe(expected)
    }
  )

  // The value comes from localStorage, where types don't reach — a stale/garbage preference must
  // land on the default palette rather than throw or produce an unstyled root.
  it.each([undefined, null, '', 'System', 'sepia', 42, {}])(
    'falls back to dark for the untyped value %o',
    (garbage) => {
      expect(resolveTheme(garbage as unknown as Theme, false)).toBe('dark')
      expect(resolveTheme(garbage as unknown as Theme, true)).toBe('dark')
    }
  )
})

describe('normalizeTheme', () => {
  it.each(['light', 'dark', 'system'] as const)('passes %s through', (theme) => {
    expect(normalizeTheme(theme)).toBe(theme)
  })

  it.each([undefined, null, '', 'DARK', 'auto', 7])('coerces %o to the default', (garbage) => {
    expect(normalizeTheme(garbage)).toBe(DEFAULT_THEME)
  })

  it('defaults to dark, matching the legacy page', () => {
    expect(DEFAULT_THEME).toBe('dark')
  })
})

describe('stored preference', () => {
  it('round-trips through the key the legacy cockpit shares', () => {
    writeStoredTheme('system')

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(readStoredTheme()).toBe('system')
  })

  // The legacy toggle only ever writes 'dark' | 'light'; both must survive a trip back here.
  it.each(['dark', 'light'] as const)('accepts the legacy value %s', (legacy) => {
    localStorage.setItem(THEME_STORAGE_KEY, legacy)

    expect(readStoredTheme()).toBe(legacy)
  })

  it('defaults when nothing is stored', () => {
    expect(readStoredTheme()).toBe('dark')
  })

  it('defaults when the stored value is garbage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, '{"theme":"neon"}')

    expect(readStoredTheme()).toBe('dark')
  })

  it('survives storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode')
    })

    expect(readStoredTheme()).toBe('dark')
    expect(() => writeStoredTheme('light')).not.toThrow()
  })
})

describe('systemPrefersLight', () => {
  it.each([true, false])('reports the light media query match (%s)', (matches) => {
    const matchMedia = stubMatchMedia(matches)

    expect(systemPrefersLight()).toBe(matches)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: light)')
  })

  it('assumes dark when matchMedia is missing', () => {
    // Nothing stubbed — jsdom's bare window has no matchMedia, exactly like an old environment.
    expect(systemPrefersLight()).toBe(false)
  })
})

describe('applyResolvedTheme', () => {
  it.each([
    { resolved: 'light', hasClass: true },
    { resolved: 'dark', hasClass: false },
  ] as const)('stamps $resolved on the root', ({ resolved, hasClass }) => {
    const root = document.createElement('html')

    applyResolvedTheme(root, resolved)

    expect(root.classList.contains('light')).toBe(hasClass)
    expect(root.style.colorScheme).toBe(resolved)
  })

  it('removes the light class when switching back to dark', () => {
    const root = document.createElement('html')

    applyResolvedTheme(root, 'light')
    applyResolvedTheme(root, 'dark')

    expect(root.classList.contains('light')).toBe(false)
    expect(root.style.colorScheme).toBe('dark')
  })

  it('leaves unrelated classes alone', () => {
    const root = document.createElement('html')
    root.className = 'js-enabled'

    applyResolvedTheme(root, 'light' as ResolvedTheme)

    expect(root.classList.contains('js-enabled')).toBe(true)
  })
})

describe('applyThemeColorMeta', () => {
  const head = () => {
    const el = document.createElement('head')
    el.innerHTML = '<meta name="theme-color" content="before">'
    return el
  }

  it('copies the root\'s --background into theme-color', () => {
    const root = document.createElement('html')
    root.style.setProperty('--background', 'rgb(1, 2, 3)')
    const target = head()

    applyThemeColorMeta(root, target)

    expect(target.querySelector('meta')?.getAttribute('content')).toBe('rgb(1, 2, 3)')
  })

  it('leaves the meta alone when the token is unreadable', () => {
    const target = head()

    applyThemeColorMeta(document.createElement('html'), target)

    expect(target.querySelector('meta')?.getAttribute('content')).toBe('before')
  })

  it('does nothing on a page without the meta', () => {
    expect(() => applyThemeColorMeta(document.createElement('html'), document.createElement('head'))).not.toThrow()
  })

  // The pre-paint script runs before any stylesheet, so it hard-codes both backgrounds.
  it('pre-paint colours match the --background tokens', () => {
    const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const css = readFileSync(resolve(web, 'src/styles/index.css'), 'utf8')
    const token = (selector: string) =>
      new RegExp(`\\n${selector.replace('.', '\\.')} \\{[^}]*?--background: (#[0-9a-f]+);`).exec(css)?.[1]
    const html = readFileSync(resolve(web, 'index.html'), 'utf8')
    expect(html).toContain(`light ? '${token('.light')}' : '${token(':root')}'`)
    expect(html).toContain(`<meta name="theme-color" content="${token(':root')}" />`)
  })
})
