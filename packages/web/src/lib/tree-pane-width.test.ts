import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TREE_PANE_WIDTH_STORAGE_KEY,
  MAX_TREE_PANE_WIDTH,
  MIN_TREE_PANE_WIDTH,
  clampTreePaneWidth,
  readStoredTreePaneWidth,
  writeStoredTreePaneWidth,
} from './tree-pane-width'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('clampTreePaneWidth', () => {
  it.each([
    [300, 300],
    [317.6, 318],
    [0, MIN_TREE_PANE_WIDTH],
    [5000, MAX_TREE_PANE_WIDTH],
    ['400', 400],
  ])('%s → %s', (raw, expected) => {
    expect(clampTreePaneWidth(raw)).toBe(expected)
  })

  // No preference is not the same claim as "too small": it means the responsive CSS defaults.
  it.each([null, undefined, '', 'wide', Number.NaN])('%s → null', (raw) => {
    expect(clampTreePaneWidth(raw)).toBeNull()
  })

  it('never lets the tree take more than 60% of the body it sits in', () => {
    expect(clampTreePaneWidth(600, 800)).toBe(480)
    // …but a tiny body still gets the minimum, never less.
    expect(clampTreePaneWidth(600, 100)).toBe(MIN_TREE_PANE_WIDTH)
  })
})

describe('stored width', () => {
  it('is null until the user sets one, and round-trips once they do', () => {
    expect(readStoredTreePaneWidth()).toBeNull()
    writeStoredTreePaneWidth(420)
    expect(localStorage.getItem(TREE_PANE_WIDTH_STORAGE_KEY)).toBe('420')
    expect(readStoredTreePaneWidth()).toBe(420)
  })

  it('writing null forgets the preference', () => {
    writeStoredTreePaneWidth(420)
    writeStoredTreePaneWidth(null)
    expect(localStorage.getItem(TREE_PANE_WIDTH_STORAGE_KEY)).toBeNull()
  })

  it('reads junk as no preference and survives a storage that throws', () => {
    localStorage.setItem(TREE_PANE_WIDTH_STORAGE_KEY, 'wide')
    expect(readStoredTreePaneWidth()).toBeNull()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readStoredTreePaneWidth()).toBeNull()
    expect(() => writeStoredTreePaneWidth(300)).not.toThrow()
  })
})
