import { describe, expect, it } from 'vitest'

import { readSavedLayouts } from './use-saved-layouts'

describe('readSavedLayouts', () => {
  const review = { name: 'Review', columns: [{ view: 'session', width: 50 }, { view: 'changes', width: 50 }] }

  it('keeps valid entries and drops the ones a write would be refused for', () => {
    const raw = [
      review,
      { name: 'Future', columns: [{ view: 'hologram', width: 100 }] },
      { name: 'No columns' },
      { name: '', columns: review.columns },
      { name: 'Too wide', columns: Array.from({ length: 4 }, () => ({ view: 'files', width: 25 })) },
      'not a layout',
      null,
    ]
    expect(readSavedLayouts(raw)).toEqual([review])
  })

  it('answers an empty list for a missing or non-array value', () => {
    expect(readSavedLayouts(undefined)).toEqual([])
    expect(readSavedLayouts({ name: 'Review' })).toEqual([])
    expect(readSavedLayouts('Review')).toEqual([])
  })
})
