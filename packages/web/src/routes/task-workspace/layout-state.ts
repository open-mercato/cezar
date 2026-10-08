/* The task workspace's saved layouts: the pure half (spec `.ai/specs/2026-10-07-task-workspace.md`
 * §5.2 "Layout model", §5.3 "Persistence and URLs"). No React and no I/O at all — every
 * transition (add, close, rename, resize, reorder) is a plain function of the previous state, so
 * the whole model is table-testable.
 *
 * WHERE IT IS STORED is not this module's business and deliberately not its decision: §5.3 says
 * layouts live "on the Cezar host that owns the task", and `use-workspace-layouts.ts` does that
 * over `GET/PUT /api/v1/runs/:id/layouts`. What stays here is the repair path — `reviveState`
 * takes whatever the host sends, including something a later cezar wrote, and returns a workspace
 * this build can paint.
 */

import { drawerStorageKey } from './drawer-state'

/** The surfaces a column can show. `terminal` is deliberately absent — it is the bottom drawer,
 *  not a column — and an unavailable view must never be representable in saved state (spec §5.1,
 *  no placeholder that implies it works). */
export type ViewId = 'session' | 'changes' | 'commits' | 'files' | 'browser'

export const VIEW_IDS: readonly ViewId[] = ['session', 'changes', 'commits', 'files', 'browser']

/** The Polish labels the spec names: `Czat`, `Zmiany`, `Commity`, `Pliki`. These are what the
 *  layout cards and column headers read, and what an automatic layout name is derived from. */
const VIEW_LABELS: Record<ViewId, string> = {
  session: 'Czat',
  changes: 'Zmiany',
  commits: 'Commity',
  files: 'Pliki',
  browser: 'Przeglądarka',
}

export function viewLabel(view: ViewId): string {
  return VIEW_LABELS[view]
}

export function isViewId(raw: unknown): raw is ViewId {
  return typeof raw === 'string' && (VIEW_IDS as readonly string[]).includes(raw)
}

/**
 * A Browser column's own tabs (spec §7: "Each Browser column has its own saved browser tabs").
 *
 * Only SUCCESSFULLY loaded addresses are stored, which is the spec's rule and the reason this
 * holds plain strings rather than tab objects: a tab whose last attempt failed comes back blank,
 * so there is nothing about the failure worth persisting. An empty string IS a blank tab.
 */
export interface BrowserState {
  tabs: string[]
  /** Index into `tabs`. Clamped on read, so a stored value can never point past the end. */
  active: number
}

/** One column: which view it shows, how wide it is, and — for a Browser — its own tabs. */
export interface WorkspaceColumn {
  view: ViewId
  /** Percent of the row. The columns of a layout always sum to 100. */
  width: number
  /** Present only on a Browser column. Carried in the column rather than beside it so a column
   *  and its tabs cannot drift apart when columns are reordered or closed. */
  browser?: BrowserState
}

/** A Browser column with nothing loaded: one blank tab, which is what `+` and a fresh column
 *  both produce. */
export function emptyBrowserState(): BrowserState {
  return { tabs: [''], active: 0 }
}

/** Anything → a Browser state the view can paint. Total, like every other reviver here: the
 *  input can be a hand-edited storage value. */
export function reviveBrowserState(raw: unknown): BrowserState {
  if (typeof raw !== 'object' || raw === null) return emptyBrowserState()
  const source = raw as { tabs?: unknown; active?: unknown }
  if (!Array.isArray(source.tabs)) return emptyBrowserState()
  const tabs = source.tabs.filter((tab): tab is string => typeof tab === 'string').slice(0, MAX_BROWSER_TABS)
  if (tabs.length === 0) return emptyBrowserState()
  const active = typeof source.active === 'number' && Number.isFinite(source.active)
    ? Math.min(tabs.length - 1, Math.max(0, Math.trunc(source.active)))
    : 0
  return { tabs, active }
}

/** A bound on tabs per Browser column — enough for any real comparison, few enough that a
 *  hand-edited file cannot make the strip unusable. */
export const MAX_BROWSER_TABS = 12

export interface WorkspaceLayout {
  /** Unique within the task, and the card's label. Renameable (spec §5.2). */
  name: string
  columns: WorkspaceColumn[]
}

export interface WorkspaceState {
  layouts: WorkspaceLayout[]
  /** The active card's name. Always the name of a layout present in `layouts`. */
  active: string
}

/** A layout holds one to three side-by-side columns — no rows, no nesting (spec §5.2). */
export const MAX_COLUMNS = 3

/** The narrowest a column may be dragged, in percent. Three columns at the floor still leave a
 *  readable remainder for the one being widened, and nothing can be dragged to a sliver. */
export const MIN_COLUMN_WIDTH = 12

/** How far one arrow key moves a divider, and how far Shift+Arrow does (spec §5.2 — "Arrow keys
 *  adjust a focused divider in small steps; Shift+Arrow uses a larger step"). Percent, like the
 *  widths themselves, so a step means the same thing at every viewport. */
export const RESIZE_STEP = 2
export const RESIZE_STEP_LARGE = 10

/** The name a fresh task's first card carries (spec §5.2 — "A new task starts with one active
 *  card named `Czat`"). */
export const DEFAULT_LAYOUT_NAME = VIEW_LABELS.session

/** The state a task with nothing saved opens with: one full-width Conversation column. Also the
 *  recovery target for state that is missing, malformed, or names views this build does not have
 *  (spec §5.3 — "recover to the one-column Conversation default without an error"). A factory
 *  rather than a shared constant so no caller can mutate the default for everyone else. */
export function defaultState(): WorkspaceState {
  return { layouts: [{ name: DEFAULT_LAYOUT_NAME, columns: [{ view: 'session', width: 100 }] }], active: DEFAULT_LAYOUT_NAME }
}

/**
 * Anything → widths the row can actually paint: clamped to the floor, and normalized so they sum
 * to exactly 100.
 *
 * Deliberately total. The input can be a drag result, a hand-edited `localStorage` value, or a
 * set of `NaN`s, and none of those may produce a row that overflows or collapses. A set that
 * cannot be rescued (every entry non-finite, or a sum of zero) falls back to equal widths, because
 * "unparseable" is not a claim about proportions.
 */
export function normalizeWidths(raw: readonly number[]): number[] {
  const count = raw.length
  if (count === 0) return []
  const floor = Math.min(MIN_COLUMN_WIDTH, 100 / count)
  const clamped = raw.map((value) => {
    const width = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(width) && width > 0 ? Math.max(floor, width) : floor
  })
  const total = clamped.reduce((sum, width) => sum + width, 0)
  if (!Number.isFinite(total) || total <= 0) return equalWidths(count)
  // Scale to 100, then give the rounding remainder to the last column so the row always sums
  // exactly — a 1/3 split that stored 33.33 three times would leave a 0.01 seam otherwise.
  const scaled = clamped.map((width) => round2((width / total) * 100))
  const drift = round2(100 - scaled.reduce((sum, width) => sum + width, 0))
  const last = scaled.length - 1
  scaled[last] = round2((scaled[last] ?? 0) + drift)
  return scaled
}

function equalWidths(count: number): number[] {
  if (count === 0) return []
  const each = round2(100 / count)
  const widths = Array.from({ length: count }, () => each)
  // The remainder goes to the last column so the row sums to exactly 100.
  widths[count - 1] = round2(100 - each * (count - 1))
  return widths
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Re-split a layout's columns evenly. Adding, removing and reordering all land here (spec §5.2 —
 *  "Adding or removing a column divides the available width equally… Reordering equalizes all
 *  column widths"), which is also the confirmed answer to what a close does to the survivors. */
function withEqualWidths(columns: readonly WorkspaceColumn[]): WorkspaceColumn[] {
  const widths = equalWidths(columns.length)
  return columns.map((column, index) => ({ ...column, width: widths[index] ?? 0 }))
}

/* ── Reading and writing ─────────────────────────────────────────────────────────────────────── */

/**
 * Repair whatever the host sent into a state the workspace can paint.
 *
 * Salvages per entry rather than per file, the same stance the workspace registry takes: one
 * unparseable layout never costs the user the rest of them (spec §5.3 — "recover to the
 * one-column Conversation default without an error").
 */
export function reviveState(parsed: unknown): WorkspaceState {
  if (typeof parsed !== 'object' || parsed === null) return defaultState()
  const source = parsed as { layouts?: unknown; active?: unknown }
  if (!Array.isArray(source.layouts)) return defaultState()

  const layouts: WorkspaceLayout[] = []
  for (const entry of source.layouts) {
    const layout = reviveLayout(entry, layouts)
    if (layout) layouts.push(layout)
  }
  // Every layout was junk, or the file held an empty list: that is not a workspace the user chose
  // to empty, it is a workspace we cannot read. Recover to the default.
  if (layouts.length === 0) return defaultState()

  const active =
    typeof source.active === 'string' && layouts.some((layout) => layout.name === source.active)
      ? source.active
      : preferredActive(layouts)
  return { layouts, active }
}

function reviveLayout(entry: unknown, taken: readonly WorkspaceLayout[]): WorkspaceLayout | null {
  if (typeof entry !== 'object' || entry === null) return null
  const source = entry as { name?: unknown; columns?: unknown }
  if (typeof source.name !== 'string' || source.name.trim() === '') return null
  if (!Array.isArray(source.columns)) return null

  // Drop columns naming a view this build does not have — a layout saved by a later cezar must
  // still open here, minus that column, rather than failing the whole file.
  const views: ViewId[] = []
  const widths: number[] = []
  const browsers: Array<BrowserState | undefined> = []
  for (const column of source.columns.slice(0, MAX_COLUMNS)) {
    if (typeof column !== 'object' || column === null) continue
    const candidate = column as { view?: unknown; width?: unknown; browser?: unknown }
    if (!isViewId(candidate.view)) continue
    views.push(candidate.view)
    widths.push(typeof candidate.width === 'number' ? candidate.width : Number.NaN)
    browsers.push(candidate.view === 'browser' ? reviveBrowserState(candidate.browser) : undefined)
  }
  // An EMPTY layout survives; a layout EMPTIED BY RECOVERY does not.
  //
  // Spec §10 — "A saved layout may intentionally have no columns" — so a card the user emptied
  // must round-trip. But a card that arrived with columns and lost every one of them to an
  // unknown view is malformed state, and §5.3 says malformed state recovers rather than being
  // presented as the user's own. The two cases are only distinguishable here, before the
  // surviving views are counted against what was actually saved.
  if (source.columns.length > 0 && views.length === 0) return null

  const name = uniqueName(source.name.trim(), taken)
  const normalized = normalizeWidths(widths)
  return {
    name,
    columns: views.map((view, index) => ({
      view,
      width: normalized[index] ?? 0,
      ...(browsers[index] ? { browser: browsers[index] } : {}),
    })),
  }
}

/**
 * What this BROWSER remembers about a task, now that the layouts themselves do not live here.
 *
 * The layouts are the owning cezar's (spec §5.3) and go with the run-delete route. What is left
 * in the browser is the drawer's own open/height preference, which is per screen rather than per
 * task-on-a-host — and a task id is never reused, so leaving it behind would be a leak nothing
 * ever cleans up.
 *
 * Called when a task is permanently DELETED, never when it is archived (§5.3 keeps layouts for
 * the unarchive, and §6 keeps the Browser tabs inside them).
 */
export function forgetTask(taskId: string): void {
  try {
    // The key comes from the module that owns it; spelling it again here is how the two drift.
    localStorage.removeItem(drawerStorageKey(taskId))
  } catch {
    // Storage disabled — there was nothing stored to forget either.
  }
}

/* ── Transitions ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Which card a returning visit opens when the stored selection is unreadable: the one named `Czat` when
 * it is still there, otherwise the first. Deliberately not "the last active" — reopening a task
 * should land somewhere predictable, and `Czat` is where the task's own conversation lives.
 */
export function preferredActive(layouts: readonly WorkspaceLayout[]): string {
  const conversation = layouts.find((layout) => layout.name === DEFAULT_LAYOUT_NAME)
  return (conversation ?? layouts[0])?.name ?? DEFAULT_LAYOUT_NAME
}

/** `name`, or `name 2` / `name 3` … when it is already taken (spec §5.2 — "If the entered name
 *  already exists, append the next available number"). */
export function uniqueName(name: string, layouts: readonly WorkspaceLayout[], ignore?: string): string {
  const isTaken = (candidate: string) =>
    layouts.some((layout) => layout.name === candidate && layout.name !== ignore)
  if (!isTaken(name)) return name
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${name} ${suffix}`
    if (!isTaken(candidate)) return candidate
  }
  return `${name} ${layouts.length + 1}`
}

export function findLayout(state: WorkspaceState, name = state.active): WorkspaceLayout | undefined {
  return state.layouts.find((layout) => layout.name === name)
}

export function activeLayout(state: WorkspaceState): WorkspaceLayout | undefined {
  return findLayout(state, state.active)
}

/** Replace one layout, by name, leaving the rest and the active card alone. The single write path
 *  every column transition below goes through. */
function replaceLayout(state: WorkspaceState, name: string, next: WorkspaceLayout): WorkspaceState {
  return {
    ...state,
    layouts: state.layouts.map((layout) => (layout.name === name ? next : layout)),
    active: state.active === name ? next.name : state.active,
  }
}

/**
 * The next automatic card name (spec §5.2: "gives it an automatic editable name (for example,
 * `Układ 2`)", and §5.3 for a deep link: "Give it the next automatic unique layout name").
 *
 * Counting from the number of cards means the second card of a fresh task is `Układ 2`, which is
 * the spec's own example; `uniqueName` then settles any collision with a card the user renamed.
 */
export function nextAutomaticName(layouts: readonly WorkspaceLayout[]): string {
  return uniqueName(`Układ ${layouts.length + 1}`, layouts)
}

/** A new card with one full-width column, automatically named and activated (spec §5.2). */
export function addLayout(state: WorkspaceState, view: ViewId): WorkspaceState {
  const name = nextAutomaticName(state.layouts)
  return {
    layouts: [...state.layouts, { name, columns: [{ ...newColumn(view), width: 100 }] }],
    active: name,
  }
}

/**
 * Close a card, immediately and permanently — no confirmation, no undo (spec §5.2).
 *
 * Closing the ACTIVE card selects the one to its right, or the previous one when there is none,
 * which is the tab grammar every editor uses. Closing the last card leaves no layouts at all:
 * that empty workspace is the user's own state and stays empty for this visit, and the next
 * `readState` for the task hands back a fresh `Czat` because an empty saved list is unreadable
 * (see `reviveState`). Those two rules are the confirmed decision, and they only agree because
 * the emptiness is never persisted as a legitimate shape.
 */
export function closeLayout(state: WorkspaceState, name: string): WorkspaceState {
  const index = state.layouts.findIndex((layout) => layout.name === name)
  if (index === -1) return state
  const layouts = state.layouts.filter((layout) => layout.name !== name)
  if (layouts.length === 0) return { layouts: [], active: '' }
  const neighbour = layouts[Math.min(index, layouts.length - 1)]!
  return { layouts, active: state.active === name ? neighbour.name : state.active }
}

export function selectLayout(state: WorkspaceState, name: string): WorkspaceState {
  if (!state.layouts.some((layout) => layout.name === name)) return state
  return { ...state, active: name }
}

/** Rename a card, keeping names unique within the task. An empty or whitespace-only name is the
 *  user abandoning the edit, not a request for a nameless card: the old name stands. */
export function renameLayout(state: WorkspaceState, name: string, requested: string): WorkspaceState {
  const layout = findLayout(state, name)
  if (!layout) return state
  const trimmed = requested.trim()
  if (trimmed === '' || trimmed === name) return state
  return replaceLayout(state, name, { ...layout, name: uniqueName(trimmed, state.layouts, name) })
}

/** Add a column at the right, equalizing widths. A no-op at `MAX_COLUMNS` — the control that
 *  reaches this is disabled there too, and a silent cap is better than a thrown away click. */
export function addColumn(state: WorkspaceState, name: string, view: ViewId): WorkspaceState {
  const layout = findLayout(state, name)
  if (!layout || layout.columns.length >= MAX_COLUMNS) return state
  return replaceLayout(state, name, {
    ...layout,
    columns: withEqualWidths([...layout.columns, newColumn(view)]),
  })
}

/** A fresh column. A Browser starts with one blank tab, which is what §7 asks a new one to be. */
function newColumn(view: ViewId): WorkspaceColumn {
  return view === 'browser'
    ? { view, width: 0, browser: emptyBrowserState() }
    : { view, width: 0 }
}

/**
 * Replace a Browser column's tabs.
 *
 * Its own transition rather than a general column patch, because this is the one piece of column
 * state the VIEW owns and writes back: everything else about a column is decided by the strip
 * around it.
 */
export function setColumnBrowser(
  state: WorkspaceState,
  name: string,
  index: number,
  browser: BrowserState,
): WorkspaceState {
  const layout = findLayout(state, name)
  const column = layout?.columns[index]
  if (!layout || !column || column.view !== 'browser') return state
  return replaceLayout(state, name, {
    ...layout,
    columns: layout.columns.map((entry, position) =>
      position === index ? { ...entry, browser } : entry,
    ),
  })
}

/**
 * Close a column and divide its width equally among the survivors (spec §5.2). Closing the LAST
 * one empties the card rather than closing it — see the note in the body. Returns a whole state
 * rather than a layout because the caller only ever holds the state.
 */
export function closeColumn(state: WorkspaceState, name: string, index: number): WorkspaceState {
  const layout = findLayout(state, name)
  if (!layout || index < 0 || index >= layout.columns.length) return state
  const columns = layout.columns.filter((_, position) => position !== index)
  // Closing the LAST column empties the layout, it does not close it: spec §5.2 — "Closing the
  // last column leaves the layout card in place with an empty area and the `+` control to add
  // another view" — and §10, "A saved layout may intentionally have no columns". Closing the
  // CARD is a separate, explicit act (its X, or its context menu).
  return replaceLayout(state, name, { ...layout, columns: withEqualWidths(columns) })
}

/** Point a column at another view, keeping its width. The caller owns the unsaved-work warning
 *  (spec §5.2) — this is the commit, not the question. */
export function setColumnView(
  state: WorkspaceState,
  name: string,
  index: number,
  view: ViewId,
): WorkspaceState {
  const layout = findLayout(state, name)
  if (!layout || index < 0 || index >= layout.columns.length) return state
  if (layout.columns[index]?.view === view) return state
  return replaceLayout(state, name, {
    ...layout,
    columns: layout.columns.map((column, position) =>
      // Re-pointing a column REPLACES it, tabs and all: the Browser state belonged to the view
      // that is going away, and keeping it would resurrect those tabs if the user came back.
      position === index ? { ...newColumn(view), width: column.width } : column,
    ),
  })
}

/**
 * Drag (or arrow-key) the divider to the RIGHT of column `index` by `delta` percent.
 *
 * The pair on either side trade width and nothing else moves (spec §5.2 — "Dragging a divider
 * changes the widths on both sides"), so a three-column row keeps its far column exactly where
 * the user put it. The move is clamped by BOTH floors, which is what makes a drag past the end
 * stop dead rather than pushing the neighbour out of the row.
 */
export function resizeColumns(
  state: WorkspaceState,
  name: string,
  index: number,
  delta: number,
): WorkspaceState {
  const layout = findLayout(state, name)
  if (!layout) return state
  if (index < 0 || index + 1 >= layout.columns.length) return state
  if (!Number.isFinite(delta) || delta === 0) return state

  const left = layout.columns[index]
  const right = layout.columns[index + 1]
  if (!left || !right) return state
  const pair = left.width + right.width
  const floor = Math.min(MIN_COLUMN_WIDTH, pair / 2)
  const nextLeft = round2(Math.min(pair - floor, Math.max(floor, left.width + delta)))
  if (nextLeft === left.width) return state

  return replaceLayout(state, name, {
    ...layout,
    columns: layout.columns.map((column, position) =>
      position === index
        ? { ...column, width: nextLeft }
        : position === index + 1
          ? { ...column, width: round2(pair - nextLeft) }
          : column,
    ),
  })
}

/** Move a column to another position, equalizing every width (spec §5.2 — "Reordering equalizes
 *  all column widths"). */
export function moveColumn(
  state: WorkspaceState,
  name: string,
  from: number,
  to: number,
): WorkspaceState {
  const layout = findLayout(state, name)
  if (!layout) return state
  const count = layout.columns.length
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) return state
  const columns = [...layout.columns]
  const [moved] = columns.splice(from, 1)
  if (!moved) return state
  columns.splice(to, 0, moved)
  return replaceLayout(state, name, { ...layout, columns: withEqualWidths(columns) })
}

/**
 * The deep-link hop (spec §5.3): `/tasks/:id/changes` and friends open their view WITHOUT
 * disturbing the saved layouts — a new one-column card, automatically named, activated.
 *
 * Idempotent on the one case that would otherwise pile up cards: a refresh of the same deep link
 * that is already showing exactly that single-column layout re-selects it instead of minting
 * `Zmiany 2`, `Zmiany 3`… on every reload. Any other layout the user has built around that view
 * is left alone, because the spec is explicit that existing layouts remain unchanged.
 */
export function openDeepLink(state: WorkspaceState, view: ViewId): WorkspaceState {
  const current = activeLayout(state)
  if (current && current.columns.length === 1 && current.columns[0]?.view === view) {
    return state
  }
  // No adopting some OTHER saved layout that happens to show this view: spec §5.3 says the deep
  // link CREATES a new one-column layout and leaves existing layouts unchanged. The guard above
  // is what keeps a refresh idempotent — on reload the card this link made is already the active
  // one, so nothing is created — which is the only reason the create path cannot pile up.
  return addLayout(state, view)
}

/** How many cards the strip paints before the rest fold into a `Pozostałe…` menu (confirmed
 *  decision, 2026-10-07: "Maksymalnie 5-6, potem 'Pozostali...' dropdown"). */
export const MAX_VISIBLE_CARDS = 6

/**
 * Split the cards into the ones the strip paints and the ones its overflow menu lists.
 *
 * The active card is ALWAYS on screen, even when it sits past the cut: a selected tab the user
 * cannot see is the one thing a tab strip may not do. It takes the last visible slot, and the card
 * it displaces is the one that folds into the menu — so the strip's length never changes as the
 * selection moves, which is what keeps the `Nowy układ` button from jumping sideways.
 */
export function splitCards(
  layouts: readonly WorkspaceLayout[],
  active: string,
  max = MAX_VISIBLE_CARDS,
): { visible: WorkspaceLayout[]; overflow: WorkspaceLayout[] } {
  if (layouts.length <= max) return { visible: [...layouts], overflow: [] }
  const visible = layouts.slice(0, max)
  const overflow = layouts.slice(max)
  const hidden = overflow.findIndex((layout) => layout.name === active)
  if (hidden === -1) return { visible, overflow }
  const displaced = visible[max - 1]!
  const promoted = overflow[hidden]!
  return {
    visible: [...visible.slice(0, max - 1), promoted],
    overflow: overflow.map((layout, index) => (index === hidden ? displaced : layout)),
  }
}
