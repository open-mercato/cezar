/* The terminal drawer's own browser-local state: whether it is open, and how tall (spec
 * `.ai/specs/2026-10-07-task-workspace.md` §6). Separate from `layout-state.ts` on purpose —
 * the drawer belongs to the TASK, not to a saved layout, and is shared by all of them.
 *
 * The pure half, like `lib/sidebar-width.ts`: no React, no side effects beyond `localStorage`,
 * so the clamp and the two restore rules below are table-testable.
 */

/** One key per task, namespaced `cez-` like every other browser-local preference here. */
export function drawerStorageKey(taskId: string): string {
  return `cez-task-terminal:${taskId}`
}

/** Pixel bounds for the drawer. `MIN` still shows a tab strip and a few lines — below that it is
 *  a sliver pretending to be a terminal. `MAX` keeps the views it slides over usable. */
export const MIN_DRAWER_HEIGHT = 120
export const MAX_DRAWER_HEIGHT = 640
export const DEFAULT_DRAWER_HEIGHT = 256

/** How far one arrow key moves the drawer's top edge, and how far Shift+Arrow does. */
export const DRAWER_HEIGHT_STEP = 16
export const DRAWER_HEIGHT_STEP_LARGE = 64

export interface DrawerState {
  open: boolean
  height: number
}

export function defaultDrawerState(): DrawerState {
  return { open: false, height: DEFAULT_DRAWER_HEIGHT }
}

/** Anything → a height the drawer can actually paint. Total, for the same reason
 *  `clampSidebarWidth` is: the input can be a drag delta or a hand-edited storage value. */
export function clampDrawerHeight(raw: unknown): number {
  // `null` and `undefined` are "no value", not a number: `Number(null)` is 0, which would clamp
  // a missing height up to the MINIMUM and silently give a returning user the shortest possible
  // drawer instead of the default one.
  if (raw === null || raw === undefined) return DEFAULT_DRAWER_HEIGHT
  const height = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(height)) return DEFAULT_DRAWER_HEIGHT
  return Math.min(MAX_DRAWER_HEIGHT, Math.max(MIN_DRAWER_HEIGHT, Math.round(height)))
}

/**
 * Has this page load opened a task yet?
 *
 * The spec draws a line two restores could otherwise blur. A page REFRESH restores whether the
 * drawer was open ("Refreshing or reconnecting the browser … restores the drawer's previous
 * open/closed state"), but NAVIGATING to another task and back does not ("Switching to another
 * task hides this task's terminal … Returning to the task keeps it hidden with the same
 * sessions"). Both read the same stored flag, so something has to tell them apart, and the only
 * honest difference is that a refresh is a new page load.
 *
 * Module-level because that is exactly the scope of the question. Reset by the reload itself.
 */
let pageLoadConsumed = false

/** Test seam: pretend this is a fresh page load. */
export function resetPageLoadForTest(): void {
  pageLoadConsumed = false
}

/**
 * The drawer state a task should open with.
 *
 * The height always comes back. Whether the drawer is OPEN comes back only for the first task of
 * a page load — that is the refresh. Every later task in the same page load starts hidden, which
 * is both the spec's rule and the safer default: arriving at a task should never drop you into a
 * shell you did not ask for on this visit.
 */
export function readDrawerState(taskId: string): DrawerState {
  const firstOfPageLoad = !pageLoadConsumed
  pageLoadConsumed = true

  let raw: string | null = null
  try {
    raw = localStorage.getItem(drawerStorageKey(taskId))
  } catch {
    return defaultDrawerState()
  }
  if (raw === null) return defaultDrawerState()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultDrawerState()
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultDrawerState()
  const source = parsed as { open?: unknown; height?: unknown }
  return {
    open: firstOfPageLoad && source.open === true,
    height: clampDrawerHeight(source.height),
  }
}

/** Persist the drawer's state. Clamped on the way in as well as out, so a bad height can never
 *  be written in the first place. */
export function writeDrawerState(taskId: string, state: DrawerState): void {
  try {
    localStorage.setItem(
      drawerStorageKey(taskId),
      JSON.stringify({ open: state.open === true, height: clampDrawerHeight(state.height) }),
    )
  } catch {
    // Private mode or a full quota: the drawer still works for this visit.
  }
}
