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

import {
  MAX_WORKSPACE_BROWSER_TABS,
  MAX_WORKSPACE_COLUMNS,
  MAX_WORKSPACE_LAYOUT_NAME_LENGTH,
  MAX_WORKSPACE_LAYOUTS,
  MAX_WORKSPACE_TAB_URL_LENGTH,
} from '@open-mercato/cezar-api-client'

import { drawerStorageKey } from './drawer-state'

/** The surfaces a column can show. `terminal` is deliberately absent — it is the bottom drawer,
 *  not a column — and an unavailable view must never be representable in saved state (spec §5.1,
 *  no placeholder that implies it works).
 *
 *  `graph` is the task's live workflow graph. It is offered on every task, like `browser` and for
 *  the same reason: a task with no stored definition gets the view's own honest empty state
 *  ("No workflow graph") rather than a tile that silently is not there. */
export type ViewId = 'session' | 'changes' | 'commits' | 'files' | 'browser' | 'graph' | 'assets' | 'terminal'

export const VIEW_IDS: readonly ViewId[] = ['session', 'changes', 'commits', 'files', 'browser', 'graph', 'assets', 'terminal']

/** The view tabs, left to right: Chat is home and Changes is what a task is reviewed by; the
 *  rarely opened Graph sits near the end, and Notes (its own page) lands before Preview
 *  (`strip.ts`). Terminal is last; the ` key docks it as a drawer instead. */
export const FIXED_VIEW_ORDER: readonly ViewId[] = ['session', 'changes', 'commits', 'files', 'graph', 'browser', 'assets', 'terminal']

/** The route each view tab deep-links to, for pages that are not the workspace (Notes). */
export const VIEW_PATHS: Record<ViewId, string> = {
  session: 'chat',
  changes: 'changes',
  commits: 'commits',
  files: 'files',
  browser: 'preview',
  graph: 'graph',
  assets: 'assets',
  terminal: 'terminal',
}

/** What the layout cards and column headers read, and what an automatic layout name is derived
 *  from. */
const VIEW_LABELS: Record<ViewId, string> = {
  session: 'Chat',
  changes: 'Changes',
  commits: 'Commits',
  files: 'Files',
  // The task's app, with Design Mode (spec 2026-10-09-design-mode).
  browser: 'Preview',
  graph: 'Graph',
  // What the run's agent published (spec 2026-10-22-html-artifacts-and-impact).
  assets: 'Assets',
  terminal: 'Terminal',
}

/** The automatic names earlier builds minted in Polish. They are saved on the host as the
 *  layout's NAME, so they are translated where a name is displayed and never rewritten. */
const LEGACY_AUTO_NAMES: Record<string, string> = {
  Czat: 'Chat',
  Zmiany: 'Changes',
  Commity: 'Commits',
  Pliki: 'Files',
  Code: 'Files',
  Przeglądarka: 'Preview',
  Browser: 'Preview',
  Graf: 'Graph',
}

/** A layout's name as shown. Only an untouched automatic name is translated; anything the user
 *  typed is theirs. */
export function layoutDisplayName(name: string): string {
  const match = /^(.+?)( \d+)?$/.exec(name)
  if (!match) return name
  const [, base = name, suffix = ''] = match
  if (base === 'Układ') return `Layout${suffix}`
  const translated = LEGACY_AUTO_NAMES[base]
  return translated ? `${translated}${suffix}` : name
}

/** Names a view's born layout was SAVED under by earlier builds. A born layout is recognized by
 *  its name, so a relabelled view must keep answering to the old one — otherwise every existing
 *  task grows a stray `Files` card beside the `Code` one it was briefly called. */
const LEGACY_VIEW_NAMES: Partial<Record<ViewId, readonly string[]>> = {
  files: ['Code'],
  browser: ['Browser'],
}

/** Whether `name` is the automatic name of `view`'s own layout, under any label it has had. */
export function isViewName(name: string, view: ViewId): boolean {
  return name === VIEW_LABELS[view] || (LEGACY_VIEW_NAMES[view]?.includes(name) ?? false)
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
  const tabs = source.tabs
    .filter((tab): tab is string => typeof tab === 'string')
    .slice(0, MAX_BROWSER_TABS)
    // Blank, not truncated: a cut address is a different address, and §7 already says a tab with
    // nothing worth keeping comes back blank.
    .map((tab) => (tab.length > MAX_TAB_URL_LENGTH ? '' : tab))
  if (tabs.length === 0) return emptyBrowserState()
  const active = typeof source.active === 'number' && Number.isFinite(source.active)
    ? Math.min(tabs.length - 1, Math.max(0, Math.trunc(source.active)))
    : 0
  return { tabs, active }
}

/** A bound on tabs per Browser column — enough for any real comparison, few enough that a
 *  hand-edited file cannot make the strip unusable. The host's own bound, like every cap below:
 *  it validates the whole document per save, so a client that outgrows one can never save again. */
export const MAX_BROWSER_TABS = MAX_WORKSPACE_BROWSER_TABS
export const MAX_TAB_URL_LENGTH = MAX_WORKSPACE_TAB_URL_LENGTH
export const MAX_LAYOUTS = MAX_WORKSPACE_LAYOUTS
export const MAX_LAYOUT_NAME_LENGTH = MAX_WORKSPACE_LAYOUT_NAME_LENGTH

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
export const MAX_COLUMNS = MAX_WORKSPACE_COLUMNS

/** The narrowest a column may be dragged, in percent. Three columns at the floor still leave a
 *  readable remainder for the one being widened, and nothing can be dragged to a sliver. */
export const MIN_COLUMN_WIDTH = 12

/** How far one arrow key moves a divider, and how far Shift+Arrow does (spec §5.2 — "Arrow keys
 *  adjust a focused divider in small steps; Shift+Arrow uses a larger step"). Percent, like the
 *  widths themselves, so a step means the same thing at every viewport. */
export const RESIZE_STEP = 2
export const RESIZE_STEP_LARGE = 10

/**
 * The narrowest either side of ONE divider may become, given what that pair has to share.
 *
 * Normally `MIN_COLUMN_WIDTH`, but never more than half the pair — two columns sharing 20% of
 * the row cannot both be 12% wide, and a floor above `pair / 2` would make the clamp
 * unsatisfiable. Exported because the divider reports this as its accessible range and
 * `resizeColumns` enforces it: one rule, read in both places, rather than the same arithmetic
 * written twice and free to drift.
 */
export function dividerFloor(pair: number): number {
  return Math.min(MIN_COLUMN_WIDTH, pair / 2)
}

/** The name a fresh task's first card carries (spec §5.2 — "A new task starts with one active
 *  card named `Czat`"). */
export const DEFAULT_LAYOUT_NAME = VIEW_LABELS.session

/** The state a task with nothing saved opens with: one card per view — Chat, Changes, Commits,
 *  Files, Browser, Graph — each a single full-width column, with Chat active. A new task has every
 *  surface one click away instead of behind the `+`; the cards are ordinary saved layouts from
 *  then on, so any of them can be closed, renamed or split.
 *
 *  Also the recovery target for state that is missing, malformed, or names views this build does
 *  not have (spec §5.3). A factory rather than a shared constant so no caller can mutate the
 *  default for everyone else. */
export function defaultState(): WorkspaceState {
  return {
    // Terminal and Assets are not pre-seeded: their cards are minted on first use, like any deep
    // link — most tasks never publish an asset.
    layouts: VIEW_IDS.filter((view) => view !== 'terminal' && view !== 'assets').map((view) => ({ name: VIEW_LABELS[view], columns: [{ view, width: 100 }] })),
    active: DEFAULT_LAYOUT_NAME,
  }
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
  const positive = raw.map((value) => {
    const width = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(width) && width > 0 ? width : floor
  })
  const total = positive.reduce((sum, width) => sum + width, 0)
  if (!Number.isFinite(total) || total <= 0) return equalWidths(count)

  // SCALE FIRST, then hold the floor.
  //
  // Clamping before the scale does not survive it: `[12, 90]` is already at the floor, scaling
  // to 100 divides both by 1.02, and the result is `[11.76, 88.24]` — a column narrower than
  // the minimum this function exists to enforce. `[1, 1, 98]` came out at 9.84 twice. So the
  // floor is applied to the SCALED widths, and whatever that adds is taken back from the
  // columns which still have room, proportionally to how much room each has.
  //
  // The loop is a fixed point, not a search: lifting one column to the floor can push another
  // below it, so it repeats until nothing moves. It always terminates — every pass either
  // settles or pins one more column at the floor, and `floor * count <= 100` guarantees a
  // solution exists.
  let widths = positive.map((width) => (width / total) * 100)
  for (let pass = 0; pass < count; pass += 1) {
    const deficit = widths.reduce((sum, width) => sum + Math.max(0, floor - width), 0)
    if (deficit <= 0) break
    const surplus = widths.reduce((sum, width) => sum + Math.max(0, width - floor), 0)
    if (surplus <= 0) {
      widths = widths.map(() => 100 / count)
      break
    }
    const take = Math.min(deficit, surplus) / surplus
    widths = widths.map((width) => (width < floor ? floor : width - (width - floor) * take))
  }

  // The rounding remainder goes to the widest column rather than the last one: handing 0.01 to
  // a column already pinned at the floor would put it back under.
  const scaled = widths.map((width) => round2(width))
  const drift = round2(100 - scaled.reduce((sum, width) => sum + width, 0))
  if (drift !== 0) {
    let widest = 0
    for (let index = 1; index < scaled.length; index += 1) {
      if ((scaled[index] ?? 0) > (scaled[widest] ?? 0)) widest = index
    }
    scaled[widest] = round2((scaled[widest] ?? 0) + drift)
  }
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
    if (layouts.length >= MAX_LAYOUTS) break
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
  // The cap is applied to what SURVIVES, not to what arrived. Slicing first meant a layout saved
  // by a later cezar whose first three columns named views this build lacks lost the two valid
  // ones behind them — and then, having no columns left, was dropped whole by the guard below.
  for (const column of source.columns) {
    if (views.length >= MAX_COLUMNS) break
    if (typeof column !== 'object' || column === null) continue
    const candidate = column as { view?: unknown; width?: unknown; browser?: unknown }
    if (!isViewId(candidate.view)) continue
    views.push(candidate.view)
    widths.push(typeof candidate.width === 'number' ? candidate.width : Number.NaN)
    browsers.push(candidate.view === 'browser' ? reviveBrowserState(candidate.browser) : undefined)
  }
  // An EMPTY layout survives; a layout EMPTIED BY RECOVERY does not.
  //
  // A saved layout may intentionally have no columns (spec §5.2), so a card the user emptied
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
export function uniqueName(requested: string, layouts: readonly WorkspaceLayout[], ignore?: string): string {
  const isTaken = (candidate: string) =>
    layouts.some((layout) => layout.name === candidate && layout.name !== ignore)
  // Every name passes through here, so this is where the host's length cap is held — the suffix
  // included, which is why the base gives way to it.
  const fit = (suffix: string) =>
    `${requested.slice(0, MAX_LAYOUT_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`
  const name = fit('')
  if (!isTaken(name)) return name
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = fit(` ${suffix}`)
    if (!isTaken(candidate)) return candidate
  }
  return fit(` ${layouts.length + 1}`)
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
  return uniqueName(`Layout ${layouts.length + 1}`, layouts)
}

/** A new card, activated. With a `view` it opens on one full-width column of it; without one it
 *  is EMPTY — the card the strip's `+` makes, whose stage is the tile picker for its first view.
 *  `name` defaults to the next automatic `Layout N` (spec §5.2); a deep link passes the view's own
 *  label instead (§5.3). */
export function addLayout(state: WorkspaceState, view?: ViewId, name?: string): WorkspaceState {
  // A no-op at the host's card cap, like `addColumn` at its own.
  if (state.layouts.length >= MAX_LAYOUTS) return state
  const chosen = name === undefined ? nextAutomaticName(state.layouts) : uniqueName(name, state.layouts)
  const columns = view === undefined ? [] : [{ ...newColumn(view), width: 100 }]
  return { layouts: [...state.layouts, { name: chosen, columns }], active: chosen }
}

/**
 * Close a card, immediately and permanently — no confirmation, no undo (spec §5.2).
 *
 * Closing the ACTIVE card selects the one to its right, or the previous one when there is none,
 * which is the tab grammar every editor uses. Closing the last card leaves no layouts at all:
 * that empty workspace is the user's own state and stays empty for this visit, and the next
 * `readState` for the task hands back a fresh `Czat` because an empty saved list is unreadable
 * (see `reviveState`). Those two rules are both §5.3's, and they only agree because
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
  // The backstop for every writer of tabs: whatever arrives is stored inside the host's bounds.
  const bounded = reviveBrowserState(browser)
  return replaceLayout(state, name, {
    ...layout,
    columns: layout.columns.map((entry, position) =>
      position === index ? { ...entry, browser: bounded } : entry,
    ),
  })
}

/**
 * Open an address in a Browser tab of the active layout (spec §7, the terminal's detected-URL
 * list). `null` when there is no room — a full layout, a full tab strip, an address the host would
 * refuse — so the caller can say so.
 *
 * A layout with a Browser column gets a tab there; one the user built gets a Browser column. A
 * FIXED card stays the one view it stands for, so it goes to its pair layout (`Chat + Browser`),
 * exactly as `openBeside` places a file: adding a column to it made `Chat` a stray custom card.
 */
export function openInBrowser(state: WorkspaceState, url: string): WorkspaceState | null {
  const active = activeLayout(state)
  if (!active || url.length > MAX_TAB_URL_LENGTH) return null
  let next = state
  let name = active.name
  let index = active.columns.findIndex((column) => column.view === 'browser')
  if (index < 0 && fixedViewOf(active) !== null) {
    const placed = openBeside(state, 'browser')
    if (!placed) return null
    ;({ state: next, name, index } = placed)
  } else if (index < 0) {
    next = addColumn(state, name, 'browser')
    if (next === state) return null
    index = active.columns.length
  }
  const browser = findLayout(next, name)?.columns[index]?.browser ?? emptyBrowserState()
  // A blank tab is a slot, not a tab worth keeping beside the new one.
  const tabs = browser.tabs.filter((tab) => tab !== '')
  if (tabs.length >= MAX_BROWSER_TABS) return null
  return setColumnBrowser(next, name, index, { tabs: [...tabs, url], active: tabs.length })
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
  // another view" — confirmed again in §11. Closing the CARD is a separate, explicit act (its X,
  // or its context menu).
  //
  // §10 used to assert the opposite in its acceptance list, and both this comment and §5.2 cited
  // §10 for a sentence it did not contain. The spec was corrected on 2026-10-08 toward the
  // behaviour built here; the invented quote is gone from all three places that carried it.
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
  const floor = dividerFloor(pair)
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
/**
 * Whether a saved layout is the plain card of one view: a single column of it, still under the
 * view's own name. Those are what the workspace's FIXED cards stand in for — one per view, always
 * on the strip, not closable or renamable — so they are never drawn as cards of their own.
 */
export function fixedViewOf(layout: WorkspaceLayout): ViewId | null {
  const view = layout.columns.length === 1 ? layout.columns[0]?.view : undefined
  return view !== undefined && isViewName(layout.name, view) ? view : null
}

export function openDeepLink(state: WorkspaceState, view: ViewId): WorkspaceState {
  // The card a new task is born with for this view — still one column of it, still under the
  // view's own name — is the card the link means: select it rather than minting `Changes 2`
  // beside an untouched `Changes`. Renamed or split, it is the user's own layout and is left alone.
  const born = state.layouts.find(
    (layout) => isViewName(layout.name, view) && layout.columns.length === 1 && layout.columns[0]?.view === view,
  )
  if (born) return selectLayout(state, born.name)
  const current = activeLayout(state)
  if (current && current.columns.length === 1 && current.columns[0]?.view === view) {
    return state
  }
  // No adopting some OTHER saved layout that happens to show this view: spec §5.3 says the deep
  // link CREATES a new one-column layout and leaves existing layouts unchanged. The guard above
  // is what keeps a refresh idempotent — on reload the card this link made is already the active
  // one, so nothing is created — which is the only reason the create path cannot pile up.
  //
  // NAMED AFTER THE VIEW, not `Układ N`: §5.3 asks for "an automatic unique layout name (e.g.
  // `Zmiany` if doesn't exist, else `Zmiany 2`)" and §11 spells it out per route — `Zmiany`,
  // `Pliki`, `Commity`. `uniqueName` inside `addLayout` settles a collision with a card the user
  // already has under that name.
  return addLayout(state, view, viewLabel(view))
}

/**
 * Where a view asked for from ANOTHER window should appear — a file path clicked in the chat —
 * and the state that puts it there. "Beside what I am looking at" is the whole rule:
 *
 *  - the active layout already shows that view: there;
 *  - it is a layout the user built and has room: a new window at its right;
 *  - otherwise (a fixed card, which stays the one view it stands for, or a full layout): the
 *    task's working arrangement (`WORKING_LAYOUT_NAME`) with the two of them.
 */
export function openBeside(
  state: WorkspaceState,
  view: ViewId,
): { state: WorkspaceState; name: string; index: number } | null {
  const current = activeLayout(state)
  if (current) {
    const existing = current.columns.findIndex((column) => column.view === view)
    if (existing >= 0) return { state, name: current.name, index: existing }
    if (fixedViewOf(current) === null && current.columns.length > 0 && current.columns.length < MAX_COLUMNS) {
      return { state: addColumn(state, current.name, view), name: current.name, index: current.columns.length }
    }
  }
  const from = current?.columns[0]?.view ?? 'session'
  const next = toWorking(state, [newColumn(from), newColumn(view)])
  return next ? { state: next, name: WORKING_LAYOUT_NAME, index: 1 } : null
}

/**
 * A view tab dropped onto the workspace: beside column `at` (`insert`, `at` is the slot) or over it
 * (`replace`). A view already on screen MOVES there rather than appearing twice.
 *
 * A layout the user built is edited in place. A fixed card stays the one view it stands for, so
 * the result becomes the task's working arrangement, as `openBeside` does.
 */
export function dropView(
  state: WorkspaceState,
  view: ViewId,
  at: number,
  mode: 'insert' | 'replace',
): WorkspaceState {
  const current = activeLayout(state)
  const columns: WorkspaceColumn[] = current?.columns.map((column) => ({ ...column })) ?? []
  const from = columns.findIndex((column) => column.view === view)
  const moved = from >= 0 ? columns[from]! : newColumn(view)
  let next: WorkspaceColumn[]
  if (mode === 'replace') {
    if (at < 0 || at >= columns.length) return state
    next = [...columns]
    if (from >= 0) next[from] = columns[at]!
    next[at] = moved
  } else {
    next = from >= 0 ? columns.filter((_, index) => index !== from) : [...columns]
    next.splice(Math.max(0, Math.min(from >= 0 && from < at ? at - 1 : at, next.length)), 0, moved)
  }
  if (next.length > MAX_COLUMNS) return state
  if (current && fixedViewOf(current) === null) {
    return replaceLayout(state, current.name, { ...current, columns: withEqualWidths(next) })
  }
  if (next.length === 1) return openDeepLink(state, next[0]!.view)
  return toWorking(state, next) ?? state
}

/**
 * The task's ONE unsaved arrangement. Splitting a view tab (a drag, ⌥-click, a file opened from
 * the chat) lands here instead of minting a named layout each time; naming it — and keeping it for
 * every task — is the user's explicit "Save current view as layout…".
 */
export const WORKING_LAYOUT_NAME = 'Custom'

/** Names a saved layout may not take: they belong to a view tab or to the working arrangement. */
export function isReservedLayoutName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed === WORKING_LAYOUT_NAME || VIEW_IDS.some((view) => isViewName(trimmed, view))
}

/** Show `columns` as the working arrangement, made the first time and overwritten after. */
function toWorking(state: WorkspaceState, columns: WorkspaceColumn[]): WorkspaceState | null {
  const layout = { name: WORKING_LAYOUT_NAME, columns: withEqualWidths(columns) }
  if (findLayout(state, WORKING_LAYOUT_NAME)) {
    return { ...replaceLayout(state, WORKING_LAYOUT_NAME, layout), active: WORKING_LAYOUT_NAME }
  }
  if (state.layouts.length >= MAX_LAYOUTS) return null
  return { layouts: [...state.layouts, layout], active: WORKING_LAYOUT_NAME }
}

/** A layout saved for every task: its arrangement only (`savedWorkspaceLayoutSchema`). */
export interface SavedLayout {
  name: string
  columns: readonly { view: ViewId; width: number }[]
}

/** The active layout as a saved one, or `null` when there is nothing to save. */
export function toSavedLayout(state: WorkspaceState, name: string): SavedLayout | null {
  const current = activeLayout(state)
  const trimmed = name.trim().slice(0, MAX_LAYOUT_NAME_LENGTH)
  if (!current || current.columns.length === 0 || trimmed === '' || isReservedLayoutName(trimmed)) return null
  return { name: trimmed, columns: current.columns.map(({ view, width }) => ({ view, width })) }
}

/**
 * Open a saved layout in this task. The task keeps its own copy (a Preview's tabs live there), so
 * coming back to it finds the same columns — unless the saved arrangement changed since, which
 * starts the copy afresh from it.
 */
export function applySavedLayout(state: WorkspaceState, saved: SavedLayout): WorkspaceState {
  if (isReservedLayoutName(saved.name)) return state
  const existing = findLayout(state, saved.name)
  const views = saved.columns.map((column) => column.view).join('|')
  if (existing && existing.columns.map((column) => column.view).join('|') === views) {
    return selectLayout(state, saved.name)
  }
  const widths = normalizeWidths(saved.columns.map((column) => column.width))
  const layout = {
    name: saved.name,
    columns: saved.columns.slice(0, MAX_COLUMNS).map((column, index) => ({ ...newColumn(column.view), width: widths[index] ?? 0 })),
  }
  if (existing) return { ...replaceLayout(state, saved.name, layout), active: saved.name }
  if (state.layouts.length >= MAX_LAYOUTS) return state
  return { layouts: [...state.layouts, layout], active: saved.name }
}

/**
 * The task's side of "Save current view as layout…": the arrangement on screen now goes by that
 * name here too (replacing a copy under it), so the Layout button names what was saved. A view
 * tab stays the view it stands for, so its columns are copied rather than renamed.
 */
export function keepAs(state: WorkspaceState, name: string): WorkspaceState {
  const current = activeLayout(state)
  const trimmed = name.trim().slice(0, MAX_LAYOUT_NAME_LENGTH)
  if (!current || trimmed === '' || isReservedLayoutName(trimmed) || current.name === trimmed) return state
  const others = state.layouts.filter((layout) => layout.name !== trimmed)
  if (fixedViewOf(current) !== null) {
    const copy = { name: trimmed, columns: current.columns.map((column) => ({ ...column })) }
    return { layouts: [...others, copy], active: trimmed }
  }
  return { layouts: others.map((layout) => (layout === current ? { ...layout, name: trimmed } : layout)), active: trimmed }
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
  const promoted = overflow[hidden]!
  const shown = [...visible.slice(0, max - 1), promoted]
  // The menu keeps CREATION order. Swapping the displaced card into the promoted one's slot was
  // simpler but listed it out of order — with `A…H` and `H` selected, the menu read `G, F` — so
  // the remainder is taken from the original list instead. Names are unique within a task, so
  // they identify a card.
  const shownNames = new Set(shown.map((layout) => layout.name))
  return { visible: shown, overflow: layouts.filter((layout) => !shownNames.has(layout.name)) }
}
