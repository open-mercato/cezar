import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNow } from '@/lib/use-now'

function Probe({ intervalMs }: { intervalMs: number }) {
  return <output>{useNow(intervalMs)}</output>
}

const shown = () => Number(screen.getByRole('status').textContent)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useNow', () => {
  it('starts at the current time and re-renders each tick', () => {
    vi.setSystemTime(1_000_000)
    render(<Probe intervalMs={30_000} />)
    expect(shown()).toBe(1_000_000)

    act(() => vi.advanceTimersByTime(30_000))
    expect(shown()).toBe(1_030_000)

    // Between ticks nothing moves — the hook is a slow clock, not a per-render Date.now().
    act(() => vi.advanceTimersByTime(15_000))
    expect(shown()).toBe(1_030_000)
  })

  it('stops ticking after unmount', () => {
    render(<Probe intervalMs={30_000} />)
    cleanup()
    // An orphaned interval would warn about setState on an unmounted component and leak.
    expect(vi.getTimerCount()).toBe(0)
  })
})
