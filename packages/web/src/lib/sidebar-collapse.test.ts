import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isProjectCollapsed,
  normalizeCollapsed,
  readStoredCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  writeStoredCollapsed,
} from './sidebar-collapse'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('isProjectCollapsed', () => {
  it('defaults to expanding the active project and collapsing the rest', () => {
    expect(isProjectCollapsed(undefined, 'cezar', 'cezar')).toBe(false)
    expect(isProjectCollapsed(undefined, 'shop', 'cezar')).toBe(true)
  })

  it('lets a stored answer override the default in both directions', () => {
    // An explicit `false` is how a user pins a non-active project open — it must not be
    // mistaken for "no entry" and collapsed back on the next render.
    expect(isProjectCollapsed({ shop: false }, 'shop', 'cezar')).toBe(false)
    expect(isProjectCollapsed({ cezar: true }, 'cezar', 'cezar')).toBe(true)
  })
})

describe('normalizeCollapsed', () => {
  it('keeps boolean entries and drops everything else', () => {
    expect(normalizeCollapsed({ a: true, b: false, c: 'yes', d: null })).toEqual({
      a: true,
      b: false,
    })
  })

  it.each([[null], [undefined], ['{}'], [42], [['a']]])('answers {} for %s', (raw) => {
    expect(normalizeCollapsed(raw)).toEqual({})
  })
})

describe('collapse storage', () => {
  it('round-trips the map through localStorage', () => {
    writeStoredCollapsed({ cezar: true, shop: false })
    expect(readStoredCollapsed()).toEqual({ cezar: true, shop: false })
  })

  it('answers {} for an absent or hand-broken value rather than throwing', () => {
    expect(readStoredCollapsed()).toEqual({})
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'not json')
    expect(readStoredCollapsed()).toEqual({})
  })
})
