import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MANAGER_HEADS_STORAGE_KEY, readManagerHeadsEnabled, useManagerHeadsEnabled, writeManagerHeadsEnabled } from './manager-heads-pref'

describe('manager pop-ups preference', () => {
  afterEach(() => localStorage.removeItem(MANAGER_HEADS_STORAGE_KEY))

  it('is on by default and follows the Settings toggle live', () => {
    expect(readManagerHeadsEnabled()).toBe(true)
    const { result } = renderHook(() => useManagerHeadsEnabled())
    expect(result.current).toBe(true)
    act(() => writeManagerHeadsEnabled(false))
    expect(result.current).toBe(false)
    expect(localStorage.getItem(MANAGER_HEADS_STORAGE_KEY)).toBe('off')
    act(() => writeManagerHeadsEnabled(true))
    expect(result.current).toBe(true)
  })
})
