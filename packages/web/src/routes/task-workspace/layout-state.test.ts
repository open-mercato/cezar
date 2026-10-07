import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addColumn,
  addLayout,
  activeLayout,
  clearState,
  closeColumn,
  closeLayout,
  defaultState,
  DEFAULT_LAYOUT_NAME,
  findLayout,
  MAX_COLUMNS,
  MIN_COLUMN_WIDTH,
  moveColumn,
  normalizeWidths,
  openDeepLink,
  preferredActive,
  readState,
  renameLayout,
  resizeColumns,
  reviveState,
  selectLayout,
  setColumnView,
  splitCards,
  storageKey,
  uniqueName,
  viewLabel,
  writeState,
  type WorkspaceState,
} from './layout-state'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

/** The widths of the active layout, which is what nearly every assertion below is about. */
const widths = (state: WorkspaceState) => activeLayout(state)?.columns.map((column) => column.width)
const views = (state: WorkspaceState) => activeLayout(state)?.columns.map((column) => column.view)

describe('defaultState', () => {
  it('opens a fresh task on one full-width Czat column', () => {
    const state = defaultState()
    expect(state.active).toBe(DEFAULT_LAYOUT_NAME)
    expect(state.layouts).toHaveLength(1)
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
  it('names a new card after its view and activates it', () => {
    const state = addLayout(defaultState(), 'changes')
    expect(state.active).toBe(viewLabel('changes'))
    expect(findLayout(state)?.columns).toEqual([{ view: 'changes', width: 100 }])
  })

  it('numbers a second card for the same view', () => {
    const state = addLayout(addLayout(defaultState(), 'changes'), 'changes')
    expect(state.layouts.map((layout) => layout.name)).toEqual(['Czat', 'Zmiany', 'Zmiany 2'])
  })
})

describe('closeLayout', () => {
  it('selects the card to the right of the one it closed', () => {
    let state = addLayout(addLayout(defaultState(), 'changes'), 'files')
    state = selectLayout(state, 'Zmiany')
    state = closeLayout(state, 'Zmiany')
    expect(state.active).toBe('Pliki')
  })

  it('falls back to the previous card when the closed one was last', () => {
    let state = addLayout(defaultState(), 'changes')
    state = closeLayout(state, 'Zmiany')
    expect(state.active).toBe('Czat')
  })

  it('leaves an inactive card selected when another is closed', () => {
    let state = addLayout(addLayout(defaultState(), 'changes'), 'files')
    expect(state.active).toBe('Pliki')
    state = closeLayout(state, 'Zmiany')
    expect(state.active).toBe('Pliki')
  })

  it('empties the workspace when the last card goes, and that stays empty for the visit', () => {
    const state = closeLayout(defaultState(), DEFAULT_LAYOUT_NAME)
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
    const state = renameLayout(defaultState(), 'Czat', 'Debug')
    expect(state.layouts[0]!.name).toBe('Debug')
    expect(state.active).toBe('Debug')
  })

  it('numbers a name that is already taken', () => {
    let state = addLayout(defaultState(), 'changes')
    state = renameLayout(state, 'Zmiany', 'Czat')
    expect(state.layouts.map((layout) => layout.name)).toEqual(['Czat', 'Czat 2'])
  })

  it('treats an empty name as abandoning the edit', () => {
    const state = defaultState()
    expect(renameLayout(state, 'Czat', '   ')).toBe(state)
  })
})

describe('addColumn', () => {
  it('splits two columns in half and three in thirds', () => {
    let state = addColumn(defaultState(), 'Czat', 'changes')
    expect(widths(state)).toEqual([50, 50])
    state = addColumn(state, 'Czat', 'files')
    expect(widths(state)?.reduce((sum, width) => sum + width, 0)).toBe(100)
    expect(views(state)).toEqual(['session', 'changes', 'files'])
  })

  it('allows the same view in more than one column', () => {
    const state = addColumn(defaultState(), 'Czat', 'session')
    expect(views(state)).toEqual(['session', 'session'])
  })

  it('caps at three columns', () => {
    let state = defaultState()
    state = addColumn(state, 'Czat', 'changes')
    state = addColumn(state, 'Czat', 'files')
    const capped = addColumn(state, 'Czat', 'commits')
    expect(capped).toBe(state)
    expect(activeLayout(capped)?.columns).toHaveLength(MAX_COLUMNS)
  })
})

describe('closeColumn', () => {
  it('divides the remaining columns equally', () => {
    let state = addColumn(addColumn(defaultState(), 'Czat', 'changes'), 'Czat', 'files')
    state = resizeColumns(state, 'Czat', 0, 10)
    state = closeColumn(state, 'Czat', 2)
    expect(widths(state)).toEqual([50, 50])
  })

  it('closes the whole card when the last column goes', () => {
    const state = closeColumn(defaultState(), 'Czat', 0)
    expect(state.layouts).toEqual([])
  })

  it('ignores an index it does not have', () => {
    const state = defaultState()
    expect(closeColumn(state, 'Czat', 4)).toBe(state)
  })
})

describe('setColumnView', () => {
  it('repoints a column and keeps its width', () => {
    let state = addColumn(defaultState(), 'Czat', 'changes')
    state = resizeColumns(state, 'Czat', 0, 20)
    const before = widths(state)
    state = setColumnView(state, 'Czat', 1, 'files')
    expect(views(state)).toEqual(['session', 'files'])
    expect(widths(state)).toEqual(before)
  })

  it('is a no-op when the view is already showing', () => {
    const state = defaultState()
    expect(setColumnView(state, 'Czat', 0, 'session')).toBe(state)
  })
})

describe('resizeColumns', () => {
  it('trades width between the pair either side of the divider', () => {
    const state = resizeColumns(addColumn(defaultState(), 'Czat', 'changes'), 'Czat', 0, 10)
    expect(widths(state)).toEqual([60, 40])
  })

  it('leaves the far column of a three-way split untouched', () => {
    let state = addColumn(addColumn(defaultState(), 'Czat', 'changes'), 'Czat', 'files')
    const far = widths(state)?.[2]
    state = resizeColumns(state, 'Czat', 0, 10)
    expect(widths(state)?.[2]).toBe(far)
  })

  it('stops dead at the floor instead of pushing a neighbour out of the row', () => {
    const state = resizeColumns(addColumn(defaultState(), 'Czat', 'changes'), 'Czat', 0, 999)
    const [left, right] = widths(state) ?? []
    expect(right).toBe(MIN_COLUMN_WIDTH)
    expect(left! + right!).toBe(100)
  })

  it('refuses the divider after the last column, and a non-move', () => {
    const state = addColumn(defaultState(), 'Czat', 'changes')
    expect(resizeColumns(state, 'Czat', 1, 5)).toBe(state)
    expect(resizeColumns(state, 'Czat', 0, 0)).toBe(state)
    expect(resizeColumns(state, 'Czat', 0, Number.NaN)).toBe(state)
  })
})

describe('moveColumn', () => {
  it('reorders and equalizes every width', () => {
    let state = addColumn(addColumn(defaultState(), 'Czat', 'changes'), 'Czat', 'files')
    state = resizeColumns(state, 'Czat', 0, 15)
    state = moveColumn(state, 'Czat', 2, 0)
    expect(views(state)).toEqual(['files', 'session', 'changes'])
    const result = widths(state) ?? []
    expect(Math.max(...result) - Math.min(...result)).toBeLessThanOrEqual(0.02)
  })

  it('ignores an out-of-range or no-op move', () => {
    const state = addColumn(defaultState(), 'Czat', 'changes')
    expect(moveColumn(state, 'Czat', 0, 0)).toBe(state)
    expect(moveColumn(state, 'Czat', 0, 9)).toBe(state)
  })
})

describe('preferredActive', () => {
  it('prefers Czat when it is still there', () => {
    expect(preferredActive([{ name: 'Debug', columns: [] }, { name: 'Czat', columns: [] }])).toBe('Czat')
  })

  it('falls back to the first card', () => {
    expect(preferredActive([{ name: 'Debug', columns: [] }, { name: 'Review', columns: [] }])).toBe('Debug')
  })
})

describe('openDeepLink', () => {
  it('adds a one-column card for the requested view and leaves the rest alone', () => {
    const before = addColumn(defaultState(), 'Czat', 'files')
    const state = openDeepLink(before, 'changes')
    expect(state.active).toBe('Zmiany')
    expect(findLayout(state, 'Czat')?.columns).toEqual(findLayout(before, 'Czat')?.columns)
  })

  it('does not mint a new card on every refresh of the same deep link', () => {
    const first = openDeepLink(defaultState(), 'changes')
    const second = openDeepLink(first, 'changes')
    expect(second).toBe(first)
    expect(second.layouts).toHaveLength(2)
  })

  it('re-selects an existing single-column card for that view', () => {
    let state = openDeepLink(defaultState(), 'changes')
    state = selectLayout(state, 'Czat')
    const reopened = openDeepLink(state, 'changes')
    expect(reopened.active).toBe('Zmiany')
    expect(reopened.layouts).toHaveLength(2)
  })

  it('does not reuse a multi-column card that happens to contain the view', () => {
    const state = openDeepLink(addColumn(defaultState(), 'Czat', 'changes'), 'changes')
    expect(state.layouts).toHaveLength(2)
    expect(state.active).toBe('Zmiany')
  })
})

describe('storage', () => {
  it('round-trips a built workspace', () => {
    let state = addColumn(defaultState(), 'Czat', 'changes')
    state = resizeColumns(state, 'Czat', 0, 12)
    state = addLayout(state, 'files')
    writeState('run-1', state)
    expect(readState('run-1')).toEqual(state)
  })

  it('keeps the layouts of two tasks apart', () => {
    writeState('run-1', addLayout(defaultState(), 'files'))
    expect(readState('run-2')).toEqual(defaultState())
  })

  it('defaults for an empty key', () => {
    expect(readState('never-opened')).toEqual(defaultState())
  })

  it('recovers from junk rather than throwing', () => {
    localStorage.setItem(storageKey('run-1'), 'not json')
    expect(readState('run-1')).toEqual(defaultState())
  })

  it('forgets a task on clear', () => {
    writeState('run-1', addLayout(defaultState(), 'files'))
    clearState('run-1')
    expect(readState('run-1')).toEqual(defaultState())
  })
})

describe('reviveState', () => {
  it('recovers to the default for every shape that is not a workspace', () => {
    for (const junk of [null, 42, 'x', {}, { layouts: 'no' }, { layouts: [] }]) {
      expect(reviveState(junk)).toEqual(defaultState())
    }
  })

  it('drops a column naming a view this build does not have', () => {
    const state = reviveState({
      layouts: [{ name: 'Mixed', columns: [{ view: 'session', width: 50 }, { view: 'browser', width: 50 }] }],
      active: 'Mixed',
    })
    expect(state.layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }])
  })

  it('drops a layout left with no columns at all', () => {
    const state = reviveState({
      layouts: [
        { name: 'Gone', columns: [{ view: 'browser', width: 100 }] },
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

  it('repairs an active name that points nowhere, preferring Czat', () => {
    const state = reviveState({
      layouts: [
        { name: 'Debug', columns: [{ view: 'files', width: 100 }] },
        { name: 'Czat', columns: [{ view: 'session', width: 100 }] },
      ],
      active: 'missing',
    })
    expect(state.active).toBe('Czat')
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
    // The strip stays exactly `max` long, and the displaced card is reachable in the menu.
    expect(visible).toHaveLength(6)
    expect(overflow.map((layout) => layout.name)).toEqual(['L6', 'L5', 'L8'])
  })
})
