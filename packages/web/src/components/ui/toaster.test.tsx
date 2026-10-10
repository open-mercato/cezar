import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster, resetToasts, toast } from './toaster'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.useRealTimers()
})

/**
 * The toaster is shadcn/ui Sonner now, so the DOM is sonner's: one polite live region (a
 * `<section aria-live>`), an `<ol data-sonner-toaster>` stack inside it, and an
 * `<li data-sonner-toast>` per toast. A toast's lifecycle is spelled in data attributes —
 * `data-removed="true"` is the exit (the node stays mounted so it can animate out) and the
 * node itself goes 200ms later.
 */
/** Sonner hands a new toast to its `<Toaster>` on a zero-delay timer, so showing one is the call
 *  plus that tick — the toast's own lifetime clock starts from the same instant. */
const show = (call: () => void) =>
  act(() => {
    call()
    vi.advanceTimersByTime(0)
  })
const liveRegion = () => document.querySelector('section[aria-live]')
const stack = () => document.querySelector<HTMLElement>('[data-sonner-toaster]')
const toasts = () => [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')]
/** Oldest first. Sonner paints the newest toast first (`data-index="0"`). */
const byAge = () => toasts().reverse()
const onlyToast = () => {
  const all = toasts()
  if (all.length !== 1) throw new Error(`expected exactly one toast, found ${all.length}`)
  return all[0]!
}
const text = (item: HTMLElement) => item.querySelector('[data-title]')?.textContent
/** `open` while it is on screen, `closed` once its lifetime ran out and it is animating away. */
const state = (item: HTMLElement) => (item.getAttribute('data-removed') === 'true' ? 'closed' : 'open')
/** The cockpit's two tones: sonner marks a failure `data-type="error"`, everything else is plain. */
const tone = (item: HTMLElement) => (item.getAttribute('data-type') === 'error' ? 'danger' : 'default')

describe('Toaster', () => {
  it('renders nothing while the queue is empty', () => {
    render(<Toaster />)
    expect(stack()).toBeNull()
    expect(toasts()).toEqual([])
  })

  it('shows a toast() message as a status live region and auto-dismisses it', () => {
    render(<Toaster />)
    show(() => toast('Command copied to clipboard.'))

    const item = onlyToast()
    expect(text(item)).toBe('Command copied to clipboard.')
    expect(tone(item)).toBe('default')
    // Announced, not just painted: the toast sits inside the polite live region.
    expect(liveRegion()?.getAttribute('aria-live')).toBe('polite')
    expect(liveRegion()?.contains(item)).toBe(true)

    // The lifetime timer only marks the toast as exiting — it stays mounted so the exit
    // animation has something to animate.
    act(() => vi.advanceTimersByTime(4999))
    expect(state(onlyToast())).toBe('open')
    act(() => vi.advanceTimersByTime(1))
    expect(state(onlyToast())).toBe('closed')

    // …and the second timer is what actually removes it.
    act(() => vi.advanceTimersByTime(200))
    expect(toasts()).toEqual([])
  })

  it('anchors the stack to the top-right corner, not the bottom centre', () => {
    render(<Toaster />)
    show(() => toast('anchored'))

    const anchor = stack()!
    expect(anchor.getAttribute('data-y-position')).toBe('top')
    expect(anchor.getAttribute('data-x-position')).toBe('right')
    expect(anchor.style.getPropertyValue('--offset-top')).toBe('calc(16px + env(safe-area-inset-top))')
    expect(anchor.style.getPropertyValue('--offset-right')).toBe('calc(16px + env(safe-area-inset-right))')
    // Below `md` the app shell renders its own 52px header whose right end holds the run
    // status dot and kebab; anchoring at 16px there would cover the very controls #818 is
    // about. The pair must stay a pair — and sonner's own "mobile" stops at 600px, so the
    // `max-md:` override is what carries the 61px up to where that header stops rendering.
    expect(anchor.style.getPropertyValue('--mobile-offset-top')).toBe('calc(61px + env(safe-area-inset-top))')
    expect(anchor.className).toContain('max-md:[--offset-top:calc(61px+env(safe-area-inset-top))]!')
    // The bottom-centre anchor this replaced must not linger — it is what put the toast on
    // top of the thread's action row (#818).
    expect(anchor.getAttribute('data-y-position')).not.toBe('bottom')
    expect(anchor.getAttribute('data-x-position')).not.toBe('center')
  })

  // The slide itself (and its reduced-motion opt-out) is sonner's stylesheet now, keyed off the
  // attributes below — so what this file can and must pin is that the toast is handed to that
  // stylesheet in the right state at each step: mounted to animate in, marked removed while
  // STILL in the DOM to animate out, and every toast readable at once rather than a collapsed deck.
  it('animates in on open and out on close: mounted, then marked removed while still on screen', () => {
    render(<Toaster />)
    show(() => toast('animated'))

    const item = onlyToast()
    expect(item.getAttribute('data-mounted')).toBe('true')
    expect(item.getAttribute('data-removed')).toBe('false')
    expect(item.getAttribute('data-expanded')).toBe('true')
    expect(item.getAttribute('data-y-position')).toBe('top')
    expect(item.getAttribute('data-x-position')).toBe('right')

    act(() => vi.advanceTimersByTime(5000))
    expect(onlyToast()).toBe(item)
    expect(item.getAttribute('data-removed')).toBe('true')
  })

  it('stacks multiple toasts and dismisses each on its own clock', () => {
    render(<Toaster />)
    show(() => toast('first'))
    act(() => vi.advanceTimersByTime(2000))
    show(() => toast('second', { tone: 'danger' }))

    expect(byAge().map(text)).toEqual(['first', 'second'])
    expect(byAge().map(tone)).toEqual(['default', 'danger'])

    // 3s later the first (5s old) starts exiting while the second (3s old) is untouched.
    act(() => vi.advanceTimersByTime(3000))
    expect(byAge().map((t) => [text(t), state(t)])).toEqual([
      ['first', 'closed'],
      ['second', 'open'],
    ])

    // The first one's exit timer removes only itself; the second keeps its own clock running.
    act(() => vi.advanceTimersByTime(200))
    expect(toasts().map(text)).toEqual(['second'])

    // The second reaches its own 5s at t=7000 and then leaves the same way.
    act(() => vi.advanceTimersByTime(1800))
    expect(state(onlyToast())).toBe('closed')
    act(() => vi.advanceTimersByTime(200))
    expect(toasts()).toEqual([])
  })

  describe('the optional action link', () => {
    it('renders no action by default — every existing toast is unchanged', () => {
      render(<Toaster />)
      show(() => toast('Command copied to clipboard.'))
      expect(document.querySelector('[data-slot="toast-action"]')).toBeNull()
    })

    it('appends a link that opens in a new tab without opener or referrer', () => {
      render(<Toaster />)
      show(() =>
        toast('First PR ready 🎉', {
          action: { label: 'Star on GitHub', href: 'https://github.com/open-mercato/cezar' },
        }),
      )
      const link = screen.getByRole('link', { name: 'Star on GitHub' })
      expect(link.getAttribute('href')).toBe('https://github.com/open-mercato/cezar')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
      expect(link.getAttribute('rel')).toContain('noreferrer')
      // The link lives INSIDE the live region, so a screen reader announces the ask and its
      // affordance as one utterance rather than reading a sentence with no way to act on it.
      expect(liveRegion()?.contains(link)).toBe(true)
      expect(onlyToast().contains(link)).toBe(true)
    })

    it('honours a custom lifetime, and keeps 5s as the default', () => {
      render(<Toaster />)
      show(() => toast('takes a moment to read', { durationMs: 12_000 }))
      // Still open where a default toast would already have started leaving.
      act(() => vi.advanceTimersByTime(5000))
      expect(state(onlyToast())).toBe('open')
      act(() => vi.advanceTimersByTime(7000))
      expect(state(onlyToast())).toBe('closed')
      act(() => vi.advanceTimersByTime(200))
      expect(toasts()).toEqual([])
    })

    it('gives each toast its own clock — a long one does not hold a default one open', () => {
      render(<Toaster />)
      show(() => toast('long', { durationMs: 12_000 }))
      show(() => toast('short'))
      act(() => vi.advanceTimersByTime(5000))
      expect(byAge().map((t) => [text(t), state(t)])).toEqual([
        ['long', 'open'],
        ['short', 'closed'],
      ])
    })
  })
})
