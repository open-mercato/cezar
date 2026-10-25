import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNow } from '@/lib/use-now'
import { LiveNowProvider, RelativeAge } from '@/lib/live-now'

function Probe({ intervalMs, enabled = true }: { intervalMs: number; enabled?: boolean }) {
  return <output>{useNow(intervalMs, enabled)}</output>
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

  it('runs no interval when a pinned clock is supplied', () => {
    render(
      <LiveNowProvider intervalMs={30_000} now={1_000_000}>
        <RelativeAge at="1970-01-01T00:16:40.000Z" />
      </LiveNowProvider>,
    )
    // The provider still calls the hook unconditionally; a pinned clock disables its timer.
    expect(vi.getTimerCount()).toBe(0)
  })
})
