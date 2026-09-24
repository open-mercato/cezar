/* The desktop sidebar's width: the pure half. No React, no side effects beyond `localStorage`,
 * so the clamp and the storage contract are table-testable — the same shape `lib/theme.ts` uses
 * for the other browser-local preference the cockpit keeps.
 *
 * Why browser-local (#788): the right sidebar width is a property of the SCREEN you are sitting
 * at, not of the workspace. The same checkout opened on a 13" laptop and a 34" ultrawide wants
 * two different answers, and `~/.cezar/config.json` can only hold one. That also keeps this out
 * of a protected surface — nothing an older cezar has to be able to read.
 */

/** One key, one preference. Namespaced `cez-` like `cez-theme` and `cez-density`. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'cez-sidebar-width'

/**
 * The bounds, in CSS pixels.
 *
 * `MIN` is the shipped 264px column (spec `2026-07-14-cockpit-ui-redesign`, "App shell &
 * navigation") — the sidebar may grow but never shrink below the width the whole layout, the
 * mobile drawer and every screenshot were designed around. `MAX` keeps a widened sidebar from
 * eating the thread it exists to navigate; 420px is roughly the point where the main column on a
 * 13" laptop stops being comfortable.
 */
export const MIN_SIDEBAR_WIDTH = 264
export const MAX_SIDEBAR_WIDTH = 420
export const DEFAULT_SIDEBAR_WIDTH = MIN_SIDEBAR_WIDTH

/** How far one arrow key moves the handle. Big enough to get somewhere, small enough to aim. */
export const SIDEBAR_WIDTH_STEP = 16

/**
 * Anything → a width the layout can actually paint.
 *
 * Deliberately total: the input can be a drag delta, a hand-edited `localStorage` value, or a
 * `null` from an empty key, and none of those may produce a column that is 3px wide or `NaN`.
 * Non-finite input falls back to the default rather than to a bound, because "unparseable" is
 * not the same claim as "too small".
 */
export function clampSidebarWidth(raw: unknown): number {
  const width = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

/** The stored width, or the default when storage is empty, unreadable (private mode) or junk. */
export function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    // An absent key is the default, not a `Number(null) === 0` clamped up to the minimum. Same
    // answer today, but only by coincidence — say what is meant.
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH
    return clampSidebarWidth(raw)
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

/** Persist a width. Clamped on the way in as well as on the way out, so a bad value can never be
 *  written in the first place and an already-bad one can never be read back. */
export function writeStoredSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // Private mode / storage disabled — the width still applies for this page.
  }
}
