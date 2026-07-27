import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HScroller } from './h-scroller'

/**
 * User feedback 2026-07-27: "horizontal scrollbar is awkward to use, it only
 * catches mouse if we click at the very top of it, there should also be some
 * arrows on left and right side", plus "there is some weird like vertical
 * scrollbar to be removed".
 *
 * The native overlay scrollbar is a ~3px pointer target and, because the strip
 * could scroll on both axes, the browser also drew a scrollbar corner at its
 * end. Both are gone: the bar is hidden, the y axis is pinned, and overflow is
 * expressed as buttons.
 */

/** jsdom reports every element as 0×0, so the overflow has to be stubbed. */
function stubMetrics(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return this.dataset.scroller === 'true' ? scrollWidth : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.dataset.scroller === 'true' ? clientWidth : 0
    },
  })
}

const strip = () => document.querySelector<HTMLElement>('[data-scroller="true"]')!

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  HTMLElement.prototype.scrollBy = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const view = () =>
  render(
    <HScroller ariaLabel="Run tabs" contentClassName="test-strip">
      <span>Session</span>
      <span>Review</span>
    </HScroller>,
  )

/** The scroller's inner div is the one carrying the aria-label. */
function markStrip() {
  const el = document.querySelector<HTMLElement>('[aria-label="Run tabs"]')
  if (el) el.dataset.scroller = 'true'
}

describe('HScroller', () => {
  it('shows no arrows when everything already fits', () => {
    stubMetrics(300, 300)
    view()
    markStrip()
    fireEvent.scroll(strip())

    expect(document.querySelector('[data-slot="h-scroller-left"]')).toBeNull()
    expect(document.querySelector('[data-slot="h-scroller-right"]')).toBeNull()
  })

  it('offers arrows once the strip overflows, and scrolls on click', () => {
    stubMetrics(900, 300)
    view()
    markStrip()
    fireEvent.scroll(strip())

    const right = document.querySelector<HTMLButtonElement>('[data-slot="h-scroller-right"]')
    expect(right).not.toBeNull()
    // At the start there is nowhere left to go, so that arrow is inert.
    const left = document.querySelector<HTMLButtonElement>('[data-slot="h-scroller-left"]')
    expect(left?.disabled).toBe(true)
    expect(right?.disabled).toBe(false)

    right!.click()
    expect(strip().scrollBy).toHaveBeenCalledWith({ left: 200, behavior: 'smooth' })
  })

  it('pins the vertical axis so no scrollbar corner is drawn', () => {
    stubMetrics(900, 300)
    view()
    const inner = document.querySelector<HTMLElement>('[aria-label="Run tabs"]')!

    expect(inner.className).toContain('overflow-y-hidden')
    expect(inner.className).toContain('overflow-x-auto')
  })

  it('hides the native scrollbar in both engines', () => {
    stubMetrics(900, 300)
    view()
    const inner = document.querySelector<HTMLElement>('[aria-label="Run tabs"]')!

    expect(inner.className).toContain('[scrollbar-width:none]')
    expect(inner.className).toContain('[&::-webkit-scrollbar]:hidden')
  })

  it('keeps arrows out of the tab order — they duplicate scrolling, they do not add a stop', () => {
    stubMetrics(900, 300)
    view()
    markStrip()
    fireEvent.scroll(strip())

    for (const side of ['left', 'right']) {
      const button = document.querySelector<HTMLButtonElement>(`[data-slot="h-scroller-${side}"]`)
      expect(button?.getAttribute('tabindex')).toBe('-1')
      expect(button?.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('renders without ResizeObserver rather than throwing', () => {
    vi.unstubAllGlobals()
    stubMetrics(900, 300)

    expect(() => view()).not.toThrow()
    expect(screen.getByText('Session')).not.toBeNull()
  })
})
