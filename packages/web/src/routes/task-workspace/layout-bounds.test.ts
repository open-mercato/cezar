import { describe, expect, it } from 'vitest'

import { workspaceLayoutsSchema } from '@open-mercato/cezar-api-client'

import {
  addLayout,
  defaultState,
  openBeside,
  renameLayout,
  reviveBrowserState,
  setColumnBrowser,
  type WorkspaceState,
} from './layout-state'

/**
 * The host validates the WHOLE layouts document on every PUT, so one over-limit value makes every
 * later save fail. Each transition that grows state must therefore stay inside the contract's
 * bounds — checked here against the very schema the route validates with.
 */
const accepted = (state: WorkspaceState) => workspaceLayoutsSchema.safeParse(state).success

describe('layout transitions stay inside the contract bounds', () => {
  it('clamps a renamed card to the name cap', () => {
    const state = renameLayout(defaultState(), 'Chat', 'x'.repeat(81))
    expect(state.active.length).toBeLessThanOrEqual(80)
    expect(accepted(state)).toBe(true)
  })

  it('keeps a de-duplicated long name inside the cap, and still unique', () => {
    const long = 'y'.repeat(80)
    let state = renameLayout(defaultState(), 'Chat', long)
    state = renameLayout(state, 'Changes', long)
    const taken = state.layouts.map((layout) => layout.name)
    expect(new Set(taken).size).toBe(taken.length)
    expect(accepted(state)).toBe(true)
  })

  it('refuses a card past the cap', () => {
    let state = defaultState()
    for (let count = 0; count < 60; count += 1) state = addLayout(state)
    expect(state.layouts).toHaveLength(50)
    expect(addLayout(state)).toBe(state)
    expect(openBeside(state, 'files')).toBeNull()
    expect(accepted(state)).toBe(true)
  })

  it('bounds what a Browser column is handed: tab count, active index, address length', () => {
    const base = { ...defaultState(), active: 'Preview' }
    const tabs = Array.from({ length: 13 }, (_, index) => `http://localhost:${3000 + index}/`)
    const many = setColumnBrowser(base, 'Preview', 0, { tabs, active: 12 })
    expect(many.layouts.find((layout) => layout.name === 'Preview')!.columns[0]!.browser).toEqual({
      tabs: tabs.slice(0, 12),
      active: 11,
    })
    expect(accepted(many)).toBe(true)

    const long = setColumnBrowser(base, 'Preview', 0, { tabs: [`https://x.test/?q=${'a'.repeat(2048)}`], active: 0 })
    expect(accepted(long)).toBe(true)
  })

  it('revives an over-long stored address as a blank tab', () => {
    expect(reviveBrowserState({ tabs: [`https://x.test/?q=${'a'.repeat(2048)}`, 'https://ok.test/'], active: 1 })).toEqual({
      tabs: ['', 'https://ok.test/'],
      active: 1,
    })
  })
})
