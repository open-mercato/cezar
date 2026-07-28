/* Appearance preferences (accent + density): the pure half, mirroring `lib/theme.ts`.
 *
 * The authoritative store is the server's `ui-state.json` (`GET/PUT /api/ui-state`, additive
 * `appearance` key) so the choice follows the repo, not the browser. localStorage keeps a
 * per-browser MIRROR of the last-applied values purely so the pre-paint script in
 * `packages/web/index.html` can stamp `data-accent`/`data-density` before first paint — the same
 * no-flash trick the theme uses. When the server answers, its value wins and the mirror is
 * rewritten.
 *
 * IMPORTANT: `packages/web/index.html`'s inline script duplicates `applyAppearance`'s stamping in
 * vanilla JS on purpose — it must run before the bundle exists. Change one, change the other.
 */

export const ACCENT_STORAGE_KEY = 'cez-accent'
export const DENSITY_STORAGE_KEY = 'cez-density'
export const WIDTH_STORAGE_KEY = 'cez-width'

/** The two accents the token sheet can express today: `lime` is `--primary` as shipped;
 *  `violet` swaps the `--primary` family onto the existing `--violet` tokens (index.css
 *  `:root[data-accent="violet"]`). More accents = more token families there, nothing here. */
export type Accent = 'lime' | 'violet'

/** Density shrinks Tailwind v4's one spacing token (`--spacing`, default 4px/unit) so every
 *  padding/gap/control height tightens while type stays full-size: `compact` → 3.5px (~12%),
 *  `ultra` ("Compact for real") → 3px (~25%). See the `:root[data-density]` blocks in index.css. */
export type Density = 'comfortable' | 'compact' | 'ultra'

/** Reading width flips the one `--measure` token that caps the task-view column (index.css
 *  `:root[data-width="wide"]`): `narrow` is the shipped 820px reading column; `wide` opens it
 *  to 1180px so long transcripts use more of the screen. Type size and spacing stay untouched. */
export type Width = 'narrow' | 'wide'

export const DEFAULT_ACCENT: Accent = 'lime'
export const DEFAULT_DENSITY: Density = 'comfortable'
export const DEFAULT_WIDTH: Width = 'narrow'

export interface Appearance {
  accent: Accent
  density: Density
  width: Width
}

/** Coerce anything (missing key, a future value, garbage) into an Accent. */
export function normalizeAccent(raw: unknown): Accent {
  return raw === 'lime' || raw === 'violet' ? raw : DEFAULT_ACCENT
}

export function normalizeDensity(raw: unknown): Density {
  return raw === 'comfortable' || raw === 'compact' || raw === 'ultra' ? raw : DEFAULT_DENSITY
}

export function normalizeWidth(raw: unknown): Width {
  return raw === 'narrow' || raw === 'wide' ? raw : DEFAULT_WIDTH
}

/** The `appearance` key of a ui-state payload, defaults filled in. Defensive about shape —
 *  the server passes unknown keys through, so this can meet anything. */
export function normalizeAppearance(raw: unknown): Appearance {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    accent: normalizeAccent(obj.accent),
    density: normalizeDensity(obj.density),
    width: normalizeWidth(obj.width),
  }
}

/** The mirrored preference, or the default when storage is empty/unreadable (private mode). */
export function readStoredAppearance(): Appearance {
  try {
    return {
      accent: normalizeAccent(localStorage.getItem(ACCENT_STORAGE_KEY)),
      density: normalizeDensity(localStorage.getItem(DENSITY_STORAGE_KEY)),
      width: normalizeWidth(localStorage.getItem(WIDTH_STORAGE_KEY)),
    }
  } catch {
    return { accent: DEFAULT_ACCENT, density: DEFAULT_DENSITY, width: DEFAULT_WIDTH }
  }
}

export function writeStoredAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, appearance.accent)
    localStorage.setItem(DENSITY_STORAGE_KEY, appearance.density)
    localStorage.setItem(WIDTH_STORAGE_KEY, appearance.width)
  } catch {
    // Private mode / storage disabled — the appearance still applies for this page.
  }
}

/** Stamp the root element. Defaults REMOVE the attribute rather than writing `data-accent="lime"`,
 *  so the stock token sheet applies untouched and the CSS only ever names the non-default cases. */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  if (appearance.accent === DEFAULT_ACCENT) delete root.dataset.accent
  else root.dataset.accent = appearance.accent
  if (appearance.density === DEFAULT_DENSITY) delete root.dataset.density
  else root.dataset.density = appearance.density
  if (appearance.width === DEFAULT_WIDTH) delete root.dataset.width
  else root.dataset.width = appearance.width
}
