/* The file-tree column's width (Changes and Files views): the pure half (the same shape as `lib/sidebar-width.ts`).
 *
 * Browser-local for the reason the sidebar width is: it belongs to the screen, not the workspace.
 * Unlike the sidebar there is no single default number — untouched, the column keeps its
 * responsive CSS widths — so "no preference" is `null`, never a stored default.
 */

export const TREE_PANE_WIDTH_STORAGE_KEY = 'cez-tree-pane-width'

/** Narrow enough to give the diff most of a laptop screen, wide enough for a deep path. */
export const MIN_TREE_PANE_WIDTH = 160
export const MAX_TREE_PANE_WIDTH = 720

/** How far one arrow key moves the handle — the sidebar's step. */
export const TREE_PANE_WIDTH_STEP = 16

/** The share of the Changes body the tree may take, so a wide tree never squeezes the diff out. */
export const MAX_TREE_PANE_SHARE = 0.6

/** Anything → a paintable width, or `null` (no preference) for input that is not a number. */
export function clampTreePaneWidth(raw: unknown, available = Number.POSITIVE_INFINITY): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const width = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(width)) return null
  const max = Math.max(MIN_TREE_PANE_WIDTH, Math.min(MAX_TREE_PANE_WIDTH, available * MAX_TREE_PANE_SHARE))
  return Math.min(max, Math.max(MIN_TREE_PANE_WIDTH, Math.round(width)))
}

/** The stored width, or `null` when storage is empty, unreadable (private mode) or junk. */
export function readStoredTreePaneWidth(): number | null {
  try {
    return clampTreePaneWidth(localStorage.getItem(TREE_PANE_WIDTH_STORAGE_KEY))
  } catch {
    return null
  }
}

/** Persist a width, or forget it (`null`: back to the responsive defaults). */
export function writeStoredTreePaneWidth(width: number | null): void {
  try {
    const clamped = clampTreePaneWidth(width)
    if (clamped === null) localStorage.removeItem(TREE_PANE_WIDTH_STORAGE_KEY)
    else localStorage.setItem(TREE_PANE_WIDTH_STORAGE_KEY, String(clamped))
  } catch {
    // Private mode / storage disabled — the width still applies for this page.
  }
}
