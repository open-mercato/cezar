/* Appearance preferences (density + reading width): the pure half, mirroring `lib/theme.ts`.
 *
 * The authoritative store is the server's `ui-state.json` (`GET/PUT /api/ui-state`, additive
 * `appearance` key) so the choice follows the repo, not the browser. localStorage keeps a
 * per-browser MIRROR of the last-applied values purely so the pre-paint script in
 * `packages/web/index.html` can stamp `data-density`/`data-width` before first paint — the same
 * no-flash trick the theme uses. When the server answers, its value wins and the mirror is
 * rewritten.
 *
 * The accent picker was retired with "Violet only" (redesign 2026-11): a stored `accent` key is
 * tolerated and ignored, never a parse failure — ui-state.json outlives this code's vocabulary.
 *
 * IMPORTANT: `packages/web/index.html`'s inline script duplicates `applyAppearance`'s stamping in
 * vanilla JS on purpose — it must run before the bundle exists. Change one, change the other.
 */

export const DENSITY_STORAGE_KEY = 'cez-density'
export const WIDTH_STORAGE_KEY = 'cez-width'

/** Density shrinks Tailwind v4's one spacing token (`--spacing`, default 4px/unit) so every
 *  padding/gap/control height tightens while type stays full-size: `compact` → 3.5px (~12%),
 *  `ultra` ("Compact for real") → 3px (~25%). See the `:root[data-density]` blocks in index.css. */
export type Density = 'comfortable' | 'compact' | 'ultra'

/** Reading width flips the shared `--measure` token (index.css `:root[data-width="narrow"]`):
 *  `wide` is the legacy spelling for the zero-config full-width mode; `narrow` restores the old
 *  820px reading column. Used by task and skill detail views; type size and spacing stay untouched. */
export type Width = 'narrow' | 'wide'

export const DEFAULT_DENSITY: Density = 'comfortable'
export const DEFAULT_WIDTH: Width = 'wide'

export interface Appearance {
  density: Density
  width: Width
}

export function normalizeDensity(raw: unknown): Density {
  return raw === 'comfortable' || raw === 'compact' || raw === 'ultra' ? raw : DEFAULT_DENSITY
}

export function normalizeWidth(raw: unknown): Width {
  return raw === 'narrow' || raw === 'wide' ? raw : DEFAULT_WIDTH
}

/** The `appearance` key of a ui-state payload, defaults filled in. Defensive about shape —
 *  the server passes unknown keys through, so this can meet anything (a retired `accent`
 *  included). */
export function normalizeAppearance(raw: unknown): Appearance {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    density: normalizeDensity(obj.density),
    width: normalizeWidth(obj.width),
  }
}

/** The mirrored preference, or the default when storage is empty/unreadable (private mode). */
export function readStoredAppearance(): Appearance {
  try {
    return {
      density: normalizeDensity(localStorage.getItem(DENSITY_STORAGE_KEY)),
      width: normalizeWidth(localStorage.getItem(WIDTH_STORAGE_KEY)),
    }
  } catch {
    return { density: DEFAULT_DENSITY, width: DEFAULT_WIDTH }
  }
}

export function writeStoredAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, appearance.density)
    localStorage.setItem(WIDTH_STORAGE_KEY, appearance.width)
  } catch {
    // Private mode / storage disabled — the appearance still applies for this page.
  }
}

/** Stamp the root element. Defaults REMOVE the attribute rather than writing `data-width="wide"`,
 *  so the stock token sheet applies untouched and the CSS only ever names the non-default cases.
 *  A `data-accent` left by a pre-"Violet only" shell is cleared the same way. */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  delete root.dataset.accent
  if (appearance.density === DEFAULT_DENSITY) delete root.dataset.density
  else root.dataset.density = appearance.density
  if (appearance.width === DEFAULT_WIDTH) delete root.dataset.width
  else root.dataset.width = appearance.width
}
