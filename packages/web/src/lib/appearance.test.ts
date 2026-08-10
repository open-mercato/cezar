import { afterEach, describe, expect, it } from 'vitest'

import {
  ACCENT_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  WIDTH_STORAGE_KEY,
  applyAppearance,
  normalizeAccent,
  normalizeAppearance,
  normalizeDensity,
  normalizeWidth,
  readStoredAppearance,
  writeStoredAppearance,
} from './appearance'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.width
})

describe('normalize', () => {
  it('accepts the known values and defaults everything else', () => {
    expect(normalizeAccent('violet')).toBe('violet')
    expect(normalizeAccent('lime')).toBe('lime')
    // Unknown/garbage inputs — localStorage and ui-state.json both outlive this code's vocabulary.
    for (const raw of [null, undefined, 'magenta', 42, {}]) {
      expect(normalizeAccent(raw)).toBe('lime')
      expect(normalizeDensity(raw)).toBe('comfortable')
      expect(normalizeWidth(raw)).toBe('narrow')
    }
    expect(normalizeDensity('compact')).toBe('compact')
    expect(normalizeDensity('ultra')).toBe('ultra')
    expect(normalizeWidth('wide')).toBe('wide')
    expect(normalizeWidth('narrow')).toBe('narrow')
  })

  it('normalizeAppearance survives any ui-state shape', () => {
    expect(normalizeAppearance(undefined)).toEqual({
      accent: 'lime',
      density: 'comfortable',
      width: 'narrow',
    })
    expect(normalizeAppearance('not-an-object')).toEqual({
      accent: 'lime',
      density: 'comfortable',
      width: 'narrow',
    })
    expect(normalizeAppearance({ accent: 'violet' })).toEqual({
      accent: 'violet',
      density: 'comfortable',
      width: 'narrow',
    })
    expect(normalizeAppearance({ accent: 'nope', density: 'compact', width: 'wide' })).toEqual({
      accent: 'lime',
      density: 'compact',
      width: 'wide',
    })
  })
})

describe('the localStorage mirror', () => {
  it('round-trips through the same keys the index.html pre-paint script reads', () => {
    writeStoredAppearance({ accent: 'violet', density: 'compact', width: 'wide' })
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('violet')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBe('wide')
    expect(readStoredAppearance()).toEqual({ accent: 'violet', density: 'compact', width: 'wide' })
  })

  it('defaults when the mirror is empty', () => {
    expect(readStoredAppearance()).toEqual({ accent: 'lime', density: 'comfortable', width: 'narrow' })
  })
})

describe('applyAppearance', () => {
  it('stamps only the non-default choices, exactly like the pre-paint script', () => {
    const root = document.documentElement
    applyAppearance(root, { accent: 'violet', density: 'compact', width: 'wide' })
    expect(root.dataset.accent).toBe('violet')
    expect(root.dataset.density).toBe('compact')
    expect(root.dataset.width).toBe('wide')

    // Back to defaults: the attributes must come OFF (the stock token sheet is the default),
    // not be written as data-accent="lime".
    applyAppearance(root, { accent: 'lime', density: 'comfortable', width: 'narrow' })
    expect(root.hasAttribute('data-accent')).toBe(false)
    expect(root.hasAttribute('data-density')).toBe(false)
    expect(root.hasAttribute('data-width')).toBe(false)
  })
})
