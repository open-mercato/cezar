import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { LIVE_USAGE_STORAGE_KEY, readLiveUsageEnabled, useLiveUsageEnabled, writeLiveUsageEnabled } from './live-usage-pref'

describe('live usage preference', () => {
  afterEach(() => localStorage.removeItem(LIVE_USAGE_STORAGE_KEY))

  it('is on by default and follows the Settings toggle live', () => {
    expect(readLiveUsageEnabled()).toBe(true)
    const { result } = renderHook(() => useLiveUsageEnabled())
    expect(result.current).toBe(true)
    act(() => writeLiveUsageEnabled(false))
    expect(result.current).toBe(false)
    expect(localStorage.getItem(LIVE_USAGE_STORAGE_KEY)).toBe('off')
    act(() => writeLiveUsageEnabled(true))
    expect(result.current).toBe(true)
  })
})
