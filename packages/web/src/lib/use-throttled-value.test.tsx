import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useThrottledValue } from './use-throttled-value'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('useThrottledValue', () => {
  it('publishes the first value, and the first change after a quiet stretch, immediately', () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 120, 'run-1'), {
      initialProps: { value: 'a' },
    })
    expect(result.current).toBe('a')

    // Nothing has been published inside the window yet, so this is a leading edge: no delay.
    rerender({ value: 'b' })
    expect(result.current).toBe('b')

    act(() => vi.advanceTimersByTime(500))
    rerender({ value: 'c' })
    expect(result.current).toBe('c')
  })

  it('coalesces a burst into one publish per window, and it is the LATEST value', () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 120, 'run-1'), {
      initialProps: { value: 0 },
    })
    rerender({ value: 1 }) // leading edge — published now
    expect(result.current).toBe(1)

    for (const value of [2, 3, 4, 5]) rerender({ value })
    expect(result.current).toBe(1) // still inside the window: the burst is held

    act(() => vi.advanceTimersByTime(120))
    expect(result.current).toBe(5) // …and lands as one update carrying the newest value
  })

  it('never leaves the last frame of a burst unpublished', () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 120, 'run-1'), {
      initialProps: { value: 'start' },
    })
    rerender({ value: 'mid' })
    act(() => vi.advanceTimersByTime(60))
    rerender({ value: 'end' })

    act(() => vi.advanceTimersByTime(120))
    expect(result.current).toBe('end')
  })

  it('adopts a new subject synchronously — no frame of the previous run’s value', () => {
    const { result, rerender } = renderHook(
      ({ value, key }: { value: string; key: string }) => useThrottledValue(value, 120, key),
      { initialProps: { value: 'run-1 tail', key: 'run-1' } },
    )
    rerender({ value: 'run-1 more', key: 'run-1' })

    // Switching runs must not show run-1's transcript while run-2's window elapses.
    rerender({ value: 'run-2 tail', key: 'run-2' })
    expect(result.current).toBe('run-2 tail')
  })

  it('drops a pending flush on unmount', () => {
    const { rerender, unmount } = renderHook(({ value }) => useThrottledValue(value, 120, 'run-1'), {
      initialProps: { value: 'a' },
    })
    rerender({ value: 'b' })
    rerender({ value: 'c' }) // scheduled, not yet published
    unmount()

    // A timer firing into an unmounted hook is React's "update on an unmounted component" warning
    // at best and a leak at worst; the cleanup must have cleared it.
    expect(() => act(() => vi.advanceTimersByTime(500))).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
