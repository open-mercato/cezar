import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addColumn,
  addLayout,
  activeLayout,
  closeColumn,
  closeLayout,
  defaultState,
  DEFAULT_LAYOUT_NAME,
  findLayout,
  forgetTask,
  MAX_COLUMNS,
  MIN_COLUMN_WIDTH,
  moveColumn,
  normalizeWidths,
  openDeepLink,
  preferredActive,
  renameLayout,
  resizeColumns,
  reviveState,
  selectLayout,
  setColumnView,
  splitCards,
  uniqueName,
  VIEW_IDS,
  viewLabel,
  type WorkspaceState,
} from './layout-state'
import { drawerStorageKey } from './drawer-state'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

/** The widths of the active layout, which is what nearly every assertion below is about. */
const widths = (state: WorkspaceState) => activeLayout(state)?.columns.map((column) => column.width)
const views = (state: WorkspaceState) => activeLayout(state)?.columns.map((column) => column.view)
const names = (state: WorkspaceState) => state.layouts.map((layout) => layout.name)
/** The six cards a task is born with, in order: one per view. */
const BORN = ['Chat', 'Changes', 'Commits', 'Files', 'Browser', 'Graph']

describe('defaultState', () => {
  it('opens a fresh task on Chat, with one full-width card per view behind it', () => {
    const state = defaultState()
    expect(DEFAULT_LAYOUT_NAME).toBe('Chat')
    expect(state.active).toBe(DEFAULT_LAYOUT_NAME)
    expect(names(state)).toEqual(BORN)
    expect(names(state)).toEqual(VIEW_IDS.map(viewLabel))
    // Each card is one full-width column of the view it is named after — which is exactly what
    // makes it the plain layout a FIXED card stands in for.
    expect(state.layouts.map((layout) => layout.columns)).toEqual(
      VIEW_IDS.map((view) => [{ view, width: 100 }]),
    )
    expect(state.layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }])
  })

  it('is a factory, so one caller cannot mutate the default for the next', () => {
    const first = defaultState()
    first.layouts[0]!.name = 'tampered'
    expect(defaultState().layouts[0]!.name).toBe(DEFAULT_LAYOUT_NAME)
  })
})

describe('normalizeWidths', () => {
  it('leaves an already-even split alone', () => {
    expect(normalizeWidths([50, 50])).toEqual([50, 50])
  })

  it('always sums to exactly 100, with no rounding seam', () => {
    for (const input of [[1, 1, 1], [33.33, 33.33, 33.33], [70, 30], [10, 20, 70]]) {
      const result = normalizeWidths(input)
      expect(result.reduce((sum, width) => sum + width, 0)).toBe(100)
    }
  })

  it('rescues a hand-edited file: NaN, zero and negative widths get the floor', () => {
    const result = normalizeWidths([Number.NaN, 50])
    expect(result.reduce((sum, width) => sum + width, 0)).toBe(100)
    expect(result[0]).toBeGreaterThan(0)
    // The salvaged column is the narrow one — the readable half of the pair survives.
    expect(result[0]!).toBeLessThan(result[1]!)
  })

  it('falls back to an even split when nothing can be rescued', () => {
    expect(normalizeWidths([Number.NaN, Number.NaN])).toEqual([50, 50])
  })

  it('never claims a width for a row with no columns', () => {
    expect(normalizeWidths([])).toEqual([])
  })

  it('holds the floor THROUGH the scale, not just before it', () => {
    // Clamping before scaling did not survive it: `[12, 90]` is already at the floor, and
    // dividing both by 1.02 to reach a sum of 100 put the first column at 11.76 — under the
    // minimum this function exists to enforce. `[1, 1, 98]` came out at 9.84 twice.
    for (const input of [[12, 90], [5, 95], [1, 1, 98], [2, 2, 2, 94]]) {
      const result = normalizeWidths(input)
      const floor = Math.min(MIN_COLUMN_WIDTH, 100 / input.length)
      expect(result.reduce((sum, width) => sum + width, 0)).toBe(100)
      for (const width of result) {
        // One rounding unit of tolerance: the widths are stored to two places.
        expect(width).toBeGreaterThanOrEqual(floor - 0.01)
      }
    }
  })

  it('gives the rounding remainder to the widest column, never to a pinned one', () => {
    // The drift used to go to the LAST column unconditionally, which could push a column that
    // had just been pinned at the floor back underneath it.
    const result = normalizeWidths([1, 1, 98])
    expect(result[0]).toBe(MIN_COLUMN_WIDTH)
    expect(result[1]).toBe(MIN_COLUMN_WIDTH)
    expect(result.reduce((sum, width) => sum + width, 0)).toBe(100)
  })
})

describe('uniqueName', () => {
  it('appends the next free number rather than overwriting a card', () => {
    const state = { layouts: [{ name: 'Debug', columns: [] }, { name: 'Debug 2', columns: [] }], active: 'Debug' }
    expect(uniqueName('Debug', state.layouts)).toBe('Debug 3')
  })

  it('lets a layout keep its own name when renaming in place', () => {
    const layouts = [{ name: 'Debug', columns: [] }]
    expect(uniqueName('Debug', layouts, 'Debug')).toBe('Debug')
  })
})

describe('addLayout', () => {
  it('gives a new card an automatic name and activates it', () => {
    // Spec §5.2: "gives it an automatic editable name" — `Layout N`, N being the card's position.
    // The name is positional, not derived from the view, so two cards on the same view are still
    // distinct; a fresh task already holds six cards, so its first new one is the seventh.
    const state = addLayout(defaultState(), 'changes')
    expect(state.active).toBe('Layout 7')
    expect(findLayout(state)?.columns).toEqual([{ view: 'changes', width: 100 }])
  })

  it('keeps counting for each further card', () => {
    const state = addLayout(addLayout(defaultState(), 'changes'), 'changes')
    expect(names(state)).toEqual([...BORN, 'Layout 7', 'Layout 8'])
  })

  it('counts from the cards that exist, so the second card of a one-card task is Layout 2', () => {
    const one: WorkspaceState = {
      layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }],
      active: 'Chat',
    }
    expect(addLayout(one, 'changes').active).toBe('Layout 2')
  })

  it('opens EMPTY when no view is given, which is the card the strip + makes', () => {
    const state = addLayout(defaultState())
    expect(state.active).toBe('Layout 7')
    expect(findLayout(state)?.columns).toEqual([])
  })
})

describe('closeLayout', () => {
  it('selects the card to the right of the one it closed', () => {
    let state = addLayout(addLayout(defaultState(), 'changes'), 'files')
    state = selectLayout(state, 'Layout 7')
    state = closeLayout(state, 'Layout 7')
    expect(state.active).toBe('Layout 8')
  })

  it('falls back to the previous card when the closed one was last', () => {
    let state = addLayout(defaultState(), 'changes')
    state = closeLayout(state, 'Layout 7')
    // The previous card in the list: the last of the six the task was born with.
    expect(state.active).toBe('Graph')
  })

  it('leaves an inactive card selected when another is closed', () => {
    let state = addLayout(addLayout(defaultState(), 'changes'), 'files')
    expect(state.active).toBe('Layout 8')
    state = closeLayout(state, 'Layout 7')
    expect(state.active).toBe('Layout 8')
  })

  it('empties the workspace when the last card goes, and that stays empty for the visit', () => {
    // A fresh task has six cards now, so "the last card" is reached by closing every one of them.
    let state = defaultState()
    for (const name of BORN.slice(0, -1)) state = closeLayout(state, name)
    expect(names(state)).toEqual(['Graph'])
    expect(state.active).toBe('Graph')
    state = closeLayout(state, 'Graph')
    expect(state.layouts).toEqual([])
    expect(activeLayout(state)).toBeUndefined()
  })

  it('ignores a name it does not have', () => {
    const state = defaultState()
    expect(closeLayout(state, 'nope')).toBe(state)
  })
})

describe('renameLayout', () => {
  it('renames the card and follows the selection across', () => {
    const state = renameLayout(defaultState(), 'Chat', 'Debug')
    expect(state.layouts[0]!.name).toBe('Debug')
    expect(state.active).toBe('Debug')
  })

  it('numbers a name that is already taken', () => {
    let state = addLayout(defaultState(), 'changes')
    state = renameLayout(state, 'Layout 7', 'Chat')
    expect(names(state)).toEqual([...BORN, 'Chat 2'])
    expect(state.active).toBe('Chat 2')
  })

  it('treats an empty name as abandoning the edit', () => {
    const state = defaultState()
    expect(renameLayout(state, 'Chat', '   ')).toBe(state)
  })
})

describe('addColumn', () => {
  it('splits two columns in half and three in thirds', () => {
    let state = addColumn(defaultState(), 'Chat', 'changes')
    expect(widths(state)).toEqual([50, 50])
    state = addColumn(state, 'Chat', 'files')
    expect(widths(state)?.reduce((sum, width) => sum + width, 0)).toBe(100)
    expect(views(state)).toEqual(['session', 'changes', 'files'])
  })

  it('allows the same view in more than one column', () => {
    const state = addColumn(defaultState(), 'Chat', 'session')
    expect(views(state)).toEqual(['session', 'session'])
  })

  it('caps at three columns', () => {
    let state = defaultState()
    state = addColumn(state, 'Chat', 'changes')
    state = addColumn(state, 'Chat', 'files')
    const capped = addColumn(state, 'Chat', 'commits')
    expect(capped).toBe(state)
    expect(activeLayout(capped)?.columns).toHaveLength(MAX_COLUMNS)
  })
})

describe('closeColumn', () => {
  it('divides the remaining columns equally', () => {
    let state = addColumn(addColumn(defaultState(), 'Chat', 'changes'), 'Chat', 'files')
    state = resizeColumns(state, 'Chat', 0, 10)
    state = closeColumn(state, 'Chat', 2)
    expect(widths(state)).toEqual([50, 50])
  })

  it('leaves the card in place, empty, when the last column goes', () => {
    // Spec §5.2 and §10: an emptied layout KEEPS its card and offers `+`; it is not the same act
    // as closing the card, which has its own X.
    const state = closeColumn(defaultState(), 'Chat', 0)
    expect(names(state)).toEqual(BORN)
    expect(state.layouts[0]!.columns).toEqual([])
    expect(state.active).toBe('Chat')
  })

  it('ignores an index it does not have', () => {
    const state = defaultState()
    expect(closeColumn(state, 'Chat', 4)).toBe(state)
  })
})

describe('setColumnView', () => {
  it('repoints a column and keeps its width', () => {
    let state = addColumn(defaultState(), 'Chat', 'changes')
    state = resizeColumns(state, 'Chat', 0, 20)
    const before = widths(state)
    state = setColumnView(state, 'Chat', 1, 'files')
    expect(views(state)).toEqual(['session', 'files'])
    expect(widths(state)).toEqual(before)
  })

  it('is a no-op when the view is already showing', () => {
    const state = defaultState()
    expect(setColumnView(state, 'Chat', 0, 'session')).toBe(state)
  })
})

describe('resizeColumns', () => {
  it('trades width between the pair either side of the divider', () => {
    const state = resizeColumns(addColumn(defaultState(), 'Chat', 'changes'), 'Chat', 0, 10)
    expect(widths(state)).toEqual([60, 40])
  })

  it('leaves the far column of a three-way split untouched', () => {
    let state = addColumn(addColumn(defaultState(), 'Chat', 'changes'), 'Chat', 'files')
    const far = widths(state)?.[2]
    state = resizeColumns(state, 'Chat', 0, 10)
    expect(widths(state)?.[2]).toBe(far)
  })

  it('stops dead at the floor instead of pushing a neighbour out of the row', () => {
    const state = resizeColumns(addColumn(defaultState(), 'Chat', 'changes'), 'Chat', 0, 999)
    const [left, right] = widths(state) ?? []
    expect(right).toBe(MIN_COLUMN_WIDTH)
    expect(left! + right!).toBe(100)
  })

  it('refuses the divider after the last column, and a non-move', () => {
    const state = addColumn(defaultState(), 'Chat', 'changes')
    expect(resizeColumns(state, 'Chat', 1, 5)).toBe(state)
    expect(resizeColumns(state, 'Chat', 0, 0)).toBe(state)
    expect(resizeColumns(state, 'Chat', 0, Number.NaN)).toBe(state)
  })
})

describe('moveColumn', () => {
  it('reorders and equalizes every width', () => {
    let state = addColumn(addColumn(defaultState(), 'Chat', 'changes'), 'Chat', 'files')
    state = resizeColumns(state, 'Chat', 0, 15)
    state = moveColumn(state, 'Chat', 2, 0)
    expect(views(state)).toEqual(['files', 'session', 'changes'])
    const result = widths(state) ?? []
    expect(Math.max(...result) - Math.min(...result)).toBeLessThanOrEqual(0.02)
  })

  it('ignores an out-of-range or no-op move', () => {
    const state = addColumn(defaultState(), 'Chat', 'changes')
    expect(moveColumn(state, 'Chat', 0, 0)).toBe(state)
    expect(moveColumn(state, 'Chat', 0, 9)).toBe(state)
  })
})

describe('preferredActive', () => {
  it('prefers Chat when it is still there', () => {
    expect(preferredActive([{ name: 'Debug', columns: [] }, { name: 'Chat', columns: [] }])).toBe('Chat')
  })

  it('falls back to the first card', () => {
    expect(preferredActive([{ name: 'Debug', columns: [] }, { name: 'Review', columns: [] }])).toBe('Debug')
  })
})

describe('openDeepLink', () => {
  it('selects the card the task was born with for that view and leaves the rest alone', () => {
    // The born card — still one column of the view, still under the view's own name — IS the card
    // the link means, so nothing is minted beside it.
    const before = addColumn(defaultState(), 'Chat', 'files')
    const state = openDeepLink(before, 'changes')
    expect(state.active).toBe('Changes')
    expect(state.layouts).toEqual(before.layouts)
    expect(findLayout(state, 'Chat')?.columns).toEqual(findLayout(before, 'Chat')?.columns)
  })

  it('adds a one-column card for the requested view when that card is gone', () => {
    const before = closeLayout(addColumn(defaultState(), 'Chat', 'files'), 'Changes')
    const state = openDeepLink(before, 'changes')
    // Named after the VIEW (spec §5.3, §11), not the `Layout N` counter the strip's `+` uses.
    expect(state.active).toBe('Changes')
    expect(findLayout(state)?.columns).toEqual([{ view: 'changes', width: 100 }])
    expect(state.layouts.slice(0, -1)).toEqual(before.layouts)
  })

  it('does not mint a new card on every refresh of the same deep link', () => {
    const first = openDeepLink(defaultState(), 'changes')
    const second = openDeepLink(first, 'changes')
    expect(second).toEqual(first)
    expect(names(second)).toEqual(BORN)
  })

  it('creates another card rather than adopting a layout the user built around that view', () => {
    // Spec §5.3: "existing saved layouts remain unchanged" — a card the user renamed or split is
    // their own, and the link does not jump onto it.
    const renamed = renameLayout(defaultState(), 'Changes', 'Review')
    const split = addColumn(defaultState(), 'Changes', 'files')
    for (const built of [renamed, split]) {
      const reopened = openDeepLink(built, 'changes')
      expect(reopened.layouts).toHaveLength(7)
      expect(reopened.layouts.slice(0, 6)).toEqual(built.layouts)
      expect(findLayout(reopened)?.columns).toEqual([{ view: 'changes', width: 100 }])
    }
    // `Changes` is free once the born card was renamed…
    expect(openDeepLink(renamed, 'changes').active).toBe('Changes')
    // …and taken while the split card still carries it, so the new one gets the next suffix (§5.3).
    expect(openDeepLink(split, 'changes').active).toBe('Changes 2')
  })

  it('is idempotent on a refresh, because that card is already the active one', () => {
    // The guard against a card per reload once the link has had to MINT one: arriving at a deep
    // link whose card is already active changes nothing.
    const state = openDeepLink(addColumn(defaultState(), 'Changes', 'files'), 'changes')
    expect(state.active).toBe('Changes 2')
    expect(openDeepLink(state, 'changes')).toBe(state)
  })

  it('does not reuse a multi-column card that happens to contain the view', () => {
    const before = addColumn(defaultState(), 'Chat', 'changes')
    const state = openDeepLink(before, 'changes')
    expect(state.layouts).toHaveLength(6)
    expect(state.active).toBe('Changes')
    expect(views(state)).toEqual(['changes'])
    // And with no plain card left to select, one is made rather than landing on the split.
    const minted = openDeepLink(closeLayout(before, 'Changes'), 'changes')
    expect(minted.layouts).toHaveLength(6)
    expect(minted.active).toBe('Changes')
    expect(views(minted)).toEqual(['changes'])
    expect(findLayout(minted, 'Chat')?.columns).toEqual(findLayout(before, 'Chat')?.columns)
  })
})

describe('round trip through the host', () => {
  // Layouts live on the cezar that owns the task now (spec §5.3), so the browser's half of the
  // contract is simply that whatever it sends comes back meaning the same thing.
  const throughHost = (state: WorkspaceState) => reviveState(JSON.parse(JSON.stringify(state)))
  /**
   * What a state means once read back. The one thing a read adds: the Browser card a task is born
   * with carries no tabs of its own (`defaultState` builds it bare, and the view paints a missing
   * `browser` as one blank tab), and `reviveState` writes that blank tab out. Same workspace.
   */
  const asRead = (state: WorkspaceState): WorkspaceState => ({
    ...state,
    layouts: state.layouts.map((layout) => ({
      ...layout,
      columns: layout.columns.map((column) =>
        column.view === 'browser' && !column.browser ? { ...column, browser: { tabs: [''], active: 0 } } : column,
      ),
    })),
  })

  it('survives a round trip through JSON unchanged', () => {
    let state = addColumn(defaultState(), 'Chat', 'changes')
    state = resizeColumns(state, 'Chat', 0, 12)
    state = addLayout(state, 'files')
    const read = throughHost(state)
    expect(read).toEqual(asRead(state))
    // …and from then on it is a fixed point: a second trip changes nothing at all.
    expect(throughHost(read)).toEqual(read)
  })

  it('round-trips a Browser column with the tabs it was given', () => {
    const state = addLayout(defaultState(), 'browser')
    expect(findLayout(state)?.columns).toEqual([{ view: 'browser', width: 100, browser: { tabs: [''], active: 0 } }])
    expect(throughHost(state).layouts.at(-1)).toEqual(state.layouts.at(-1))
  })

  it('round-trips a workspace the user emptied on purpose', () => {
    // §5.2: a saved layout may intentionally have no columns — so an emptied card must come
    // back as an emptied card, not as a fresh default.
    const emptied = closeColumn(defaultState(), 'Chat', 0)
    expect(emptied.layouts[0]!.columns).toEqual([])
    expect(throughHost(emptied)).toEqual(asRead(emptied))
    expect(throughHost(emptied).layouts[0]).toEqual({ name: 'Chat', columns: [] })
  })

  it('recovers from junk rather than throwing', () => {
    expect(reviveState('not a workspace')).toEqual(defaultState())
  })
})

describe('reviveState', () => {
  it('recovers to the default for every shape that is not a workspace', () => {
    for (const junk of [null, 42, 'x', {}, { layouts: 'no' }, { layouts: [] }]) {
      expect(reviveState(junk)).toEqual(defaultState())
    }
  })

  it('drops a column naming a view this build does not have', () => {
    // A layout saved by a LATER cezar, carrying a view this build has never heard of.
    const state = reviveState({
      layouts: [{ name: 'Mixed', columns: [{ view: 'session', width: 50 }, { view: 'hologram', width: 50 }] }],
      active: 'Mixed',
    })
    expect(state.layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }])
  })

  it('applies the column cap to what SURVIVES, not to what arrived', () => {
    // The cap used to be a `slice(0, MAX_COLUMNS)` taken before unknown views were filtered. A
    // layout from a later cezar whose first three columns named views this build lacks therefore
    // lost the two VALID ones behind them — and then, having nothing left, was dropped whole and
    // the task recovered to the default cards. Two real columns is the honest reading.
    const state = reviveState({
      layouts: [{
        name: 'Piec',
        columns: [
          { view: 'hologram', width: 20 },
          { view: 'telepathy', width: 20 },
          { view: 'ansible', width: 20 },
          { view: 'changes', width: 20 },
          { view: 'files', width: 20 },
        ],
      }],
      active: 'Piec',
    })
    expect(state.layouts[0]!.name).toBe('Piec')
    expect(state.layouts[0]!.columns).toEqual([
      { view: 'changes', width: 50 },
      { view: 'files', width: 50 },
    ])
  })

  it('still takes only the first three when more than three are valid', () => {
    const state = reviveState({
      layouts: [{
        name: 'Cztery',
        columns: [
          { view: 'session', width: 25 },
          { view: 'changes', width: 25 },
          { view: 'files', width: 25 },
          { view: 'commits', width: 25 },
        ],
      }],
      active: 'Cztery',
    })
    expect(state.layouts[0]!.columns.map((column) => column.view)).toEqual(['session', 'changes', 'files'])
  })

  it('restores a Browser column together with its own tabs', () => {
    const state = reviveState({
      layouts: [{
        name: 'Podgląd',
        columns: [{ view: 'browser', width: 100, browser: { tabs: ['http://localhost:3000', ''], active: 1 } }],
      }],
      active: 'Podgląd',
    })
    expect(state.layouts[0]!.columns[0]).toEqual({
      view: 'browser',
      width: 100,
      browser: { tabs: ['http://localhost:3000', ''], active: 1 },
    })
  })

  it('repairs a Browser column whose stored tabs are junk', () => {
    const state = reviveState({
      layouts: [{ name: 'P', columns: [{ view: 'browser', width: 100, browser: { tabs: 'nope', active: 7 } }] }],
      active: 'P',
    })
    expect(state.layouts[0]!.columns[0]!.browser).toEqual({ tabs: [''], active: 0 })
  })

  it('clamps a stored active tab that points past the end', () => {
    const state = reviveState({
      layouts: [{ name: 'P', columns: [{ view: 'browser', width: 100, browser: { tabs: ['a'], active: 9 } }] }],
      active: 'P',
    })
    expect(state.layouts[0]!.columns[0]!.browser).toEqual({ tabs: ['a'], active: 0 })
  })

  it('drops a layout whose every column was recovered away', () => {
    const state = reviveState({
      layouts: [
        { name: 'Gone', columns: [{ view: 'hologram', width: 100 }] },
        { name: 'Kept', columns: [{ view: 'files', width: 100 }] },
      ],
      active: 'Gone',
    })
    expect(state.layouts.map((layout) => layout.name)).toEqual(['Kept'])
    expect(state.active).toBe('Kept')
  })

  it('salvages per entry: one junk layout never costs the others', () => {
    const state = reviveState({
      layouts: [null, { name: '', columns: [] }, { name: 'Kept', columns: [{ view: 'commits', width: 100 }] }],
      active: 'Kept',
    })
    expect(state.layouts.map((layout) => layout.name)).toEqual(['Kept'])
  })

  it('repairs impossible widths', () => {
    const state = reviveState({
      layouts: [{ name: 'Wide', columns: [{ view: 'session', width: 900 }, { view: 'files', width: 900 }] }],
      active: 'Wide',
    })
    expect(state.layouts[0]!.columns.map((column) => column.width)).toEqual([50, 50])
  })

  it('caps a saved layout at three columns', () => {
    const state = reviveState({
      layouts: [
        {
          name: 'Four',
          columns: [
            { view: 'session', width: 25 },
            { view: 'changes', width: 25 },
            { view: 'files', width: 25 },
            { view: 'commits', width: 25 },
          ],
        },
      ],
      active: 'Four',
    })
    expect(state.layouts[0]!.columns).toHaveLength(MAX_COLUMNS)
  })

  it('de-duplicates names a hand-edited file collided', () => {
    const state = reviveState({
      layouts: [
        { name: 'Same', columns: [{ view: 'session', width: 100 }] },
        { name: 'Same', columns: [{ view: 'files', width: 100 }] },
      ],
      active: 'Same',
    })
    expect(state.layouts.map((layout) => layout.name)).toEqual(['Same', 'Same 2'])
  })

  it('repairs an active name that points nowhere, preferring Chat', () => {
    const state = reviveState({
      layouts: [
        { name: 'Debug', columns: [{ view: 'files', width: 100 }] },
        { name: 'Chat', columns: [{ view: 'session', width: 100 }] },
      ],
      active: 'missing',
    })
    expect(state.active).toBe('Chat')
  })
})

describe('splitCards', () => {
  const cards = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `L${index}`, columns: [] }))

  it('paints every card while they fit', () => {
    const { visible, overflow } = splitCards(cards(4), 'L0', 6)
    expect(visible).toHaveLength(4)
    expect(overflow).toEqual([])
  })

  it('folds the tail into the overflow menu', () => {
    const { visible, overflow } = splitCards(cards(9), 'L0', 6)
    expect(visible.map((layout) => layout.name)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
    expect(overflow.map((layout) => layout.name)).toEqual(['L6', 'L7', 'L8'])
  })

  it('keeps a selected card on screen by displacing the last visible one', () => {
    const { visible, overflow } = splitCards(cards(9), 'L7', 6)
    expect(visible.map((layout) => layout.name)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L7'])
    // The strip stays exactly `max` long, and the displaced card is reachable in the menu —
    // in CREATION order. The swap used to drop it into the promoted card's slot, so the menu
    // read `L6, L5, L8`.
    expect(visible).toHaveLength(6)
    expect(overflow.map((layout) => layout.name)).toEqual(['L5', 'L6', 'L8'])
  })
})

describe('forgetTask', () => {
  // The layouts themselves are the host's now and go with the run-delete route; what is left in
  // the browser is the drawer preference.
  it('drops the drawer preference of a deleted task', () => {
    localStorage.setItem(drawerStorageKey('run-1'), JSON.stringify({ open: true, height: 300 }))
    forgetTask('run-1')
    expect(localStorage.getItem(drawerStorageKey('run-1'))).toBeNull()
  })

  it('leaves every other task alone', () => {
    localStorage.setItem(drawerStorageKey('run-1'), JSON.stringify({ open: true, height: 300 }))
    localStorage.setItem(drawerStorageKey('run-2'), JSON.stringify({ open: true, height: 420 }))
    forgetTask('run-1')
    expect(localStorage.getItem(drawerStorageKey('run-2'))).not.toBeNull()
  })
})
