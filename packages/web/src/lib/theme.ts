/* Theme preference: the pure half. No React, no side effects beyond the two DOM helpers at the
 * bottom, so the resolution rules can be table-tested and the pre-paint script in
 * `packages/web/index.html` can mirror them in five lines of vanilla JS.
 *
 * IMPORTANT: `packages/web/index.html`'s inline script duplicates `resolveTheme` + `applyResolvedTheme`
 * on purpose — it has to run before the bundle exists. Change one, change the other.
 */

/** Shared with the legacy cockpit (`web/app.js`), which reads/writes the same key. */
export const THEME_STORAGE_KEY = 'cez-theme'

/** The media query `system` follows. Light is the query (not dark) because dark is our default. */
export const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** Dark, matching the legacy page's `localStorage.getItem('cez-theme') || 'dark'`. */
export const DEFAULT_THEME: Theme = 'dark'

/** Coerce anything (missing key, a future value, garbage) into a Theme. */
export function normalizeTheme(raw: unknown): Theme {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_THEME
}

/** Which palette actually paints. Deliberately defensive about `pref` — it can come from
 *  localStorage, where the type system doesn't reach. */
export function resolveTheme(pref: Theme, systemPrefersLight: boolean): ResolvedTheme {
  if (pref === 'light') return 'light'
  if (pref === 'system') return systemPrefersLight ? 'light' : 'dark'
  return 'dark'
}

/** The stored preference, or the default when storage is empty/unreadable (private mode). */
export function readStoredTheme(): Theme {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME
  }
}

/* We store `'system'` in the key the legacy page shared (it only understood
 * `'dark' | 'light'`; retired in R7, but the key and value set stay so existing
 * browsers keep their choice). Storing a resolved `'dark'`/`'light'` instead
 * would silently destroy the user's `system` preference. */
export function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Private mode / storage disabled — the theme still applies for this page.
  }
}

/** Does the OS ask for light right now? False wherever `matchMedia` is missing (old jsdom, SSR). */
export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(LIGHT_MEDIA_QUERY).matches
    : false
}

/** Stamp the root element. `.light` flips the token sheet; `color-scheme` makes native scrollbars,
 *  form controls and the canvas match before/independently of our stylesheet. */
export function applyResolvedTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle('light', resolved === 'light')
  root.style.colorScheme = resolved
}
