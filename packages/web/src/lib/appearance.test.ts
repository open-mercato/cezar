import { afterEach, describe, expect, it } from 'vitest'

import {
  DENSITY_STORAGE_KEY,
  WIDTH_STORAGE_KEY,
  applyAppearance,
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
    // Unknown/garbage inputs — localStorage and ui-state.json both outlive this code's vocabulary.
    for (const raw of [null, undefined, 'magenta', 42, {}]) {
      expect(normalizeDensity(raw)).toBe('comfortable')
      expect(normalizeWidth(raw)).toBe('wide')
    }
    expect(normalizeDensity('compact')).toBe('compact')
    expect(normalizeDensity('ultra')).toBe('ultra')
    expect(normalizeWidth('wide')).toBe('wide')
    expect(normalizeWidth('narrow')).toBe('narrow')
  })

  it('normalizeAppearance survives any ui-state shape', () => {
    expect(normalizeAppearance(undefined)).toEqual({ density: 'comfortable', width: 'wide' })
    expect(normalizeAppearance('not-an-object')).toEqual({ density: 'comfortable', width: 'wide' })
    expect(normalizeAppearance({ density: 'compact', width: 'wide' })).toEqual({
      density: 'compact',
      width: 'wide',
    })
  })

  it('ignores the retired accent key a pre-"Violet only" ui-state.json still carries', () => {
    // Stored state is never a parse failure: the key is simply not read.
    expect(normalizeAppearance({ accent: 'violet', density: 'compact' })).toEqual({
      density: 'compact',
      width: 'wide',
    })
    expect(normalizeAppearance({ accent: 'lime' })).toEqual({ density: 'comfortable', width: 'wide' })
    expect(normalizeAppearance({ accent: 'nope' })).not.toHaveProperty('accent')
  })
})

describe('the localStorage mirror', () => {
  it('round-trips through the same keys the index.html pre-paint script reads', () => {
    writeStoredAppearance({ density: 'compact', width: 'wide' })
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBe('wide')
    expect(readStoredAppearance()).toEqual({ density: 'compact', width: 'wide' })
  })

  it('defaults when the mirror is empty', () => {
    expect(readStoredAppearance()).toEqual({ density: 'comfortable', width: 'wide' })
  })

  it('leaves a stale cez-accent mirror unread', () => {
    localStorage.setItem('cez-accent', 'violet')
    expect(readStoredAppearance()).toEqual({ density: 'comfortable', width: 'wide' })
  })
})

describe('applyAppearance', () => {
  it('stamps only the non-default choices, exactly like the pre-paint script', () => {
    const root = document.documentElement
    applyAppearance(root, { density: 'compact', width: 'narrow' })
    expect(root.dataset.density).toBe('compact')
    expect(root.dataset.width).toBe('narrow')

    // Back to defaults: the attributes must come OFF (the stock token sheet is the default),
    // not be written as data-width="wide".
    applyAppearance(root, { density: 'comfortable', width: 'wide' })
    expect(root.hasAttribute('data-density')).toBe(false)
    expect(root.hasAttribute('data-width')).toBe(false)
  })

  it('clears a data-accent left behind by an older shell', () => {
    const root = document.documentElement
    root.dataset.accent = 'violet'
    applyAppearance(root, { density: 'comfortable', width: 'wide' })
    expect(root.hasAttribute('data-accent')).toBe(false)
  })
})
