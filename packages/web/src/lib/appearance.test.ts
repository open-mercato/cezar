import { afterEach, describe, expect, it } from 'vitest'

import {
  ACCENT_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  applyAppearance,
  normalizeAccent,
  normalizeAppearance,
  normalizeDensity,
  readStoredAppearance,
  writeStoredAppearance,
} from './appearance'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
})

describe('normalize', () => {
  it('accepts the known values and defaults everything else', () => {
    expect(normalizeAccent('violet')).toBe('violet')
    expect(normalizeAccent('lime')).toBe('lime')
    // Unknown/garbage inputs — localStorage and ui-state.json both outlive this code's vocabulary.
    for (const raw of [null, undefined, 'magenta', 42, {}]) {
      expect(normalizeAccent(raw)).toBe('lime')
      expect(normalizeDensity(raw)).toBe('comfortable')
    }
    expect(normalizeDensity('compact')).toBe('compact')
    expect(normalizeDensity('ultra')).toBe('ultra')
  })

  it('normalizeAppearance survives any ui-state shape', () => {
    expect(normalizeAppearance(undefined)).toEqual({ accent: 'lime', density: 'comfortable' })
    expect(normalizeAppearance('not-an-object')).toEqual({ accent: 'lime', density: 'comfortable' })
    expect(normalizeAppearance({ accent: 'violet' })).toEqual({
      accent: 'violet',
      density: 'comfortable',
    })
    expect(normalizeAppearance({ accent: 'nope', density: 'compact' })).toEqual({
      accent: 'lime',
      density: 'compact',
    })
  })
})

describe('the localStorage mirror', () => {
  it('round-trips through the same keys the index.html pre-paint script reads', () => {
    writeStoredAppearance({ accent: 'violet', density: 'compact' })
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('violet')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(readStoredAppearance()).toEqual({ accent: 'violet', density: 'compact' })
  })

  it('defaults when the mirror is empty', () => {
    expect(readStoredAppearance()).toEqual({ accent: 'lime', density: 'comfortable' })
  })
})

describe('applyAppearance', () => {
  it('stamps only the non-default choices, exactly like the pre-paint script', () => {
    const root = document.documentElement
    applyAppearance(root, { accent: 'violet', density: 'compact' })
    expect(root.dataset.accent).toBe('violet')
    expect(root.dataset.density).toBe('compact')

    // Back to defaults: the attributes must come OFF (the stock token sheet is the default),
    // not be written as data-accent="lime".
    applyAppearance(root, { accent: 'lime', density: 'comfortable' })
    expect(root.hasAttribute('data-accent')).toBe(false)
    expect(root.hasAttribute('data-density')).toBe(false)
  })
})
