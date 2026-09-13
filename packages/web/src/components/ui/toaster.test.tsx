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

describe('Toaster', () => {
  it('renders nothing while the queue is empty', () => {
    render(<Toaster />)
    expect(document.querySelector('[data-slot="toaster"]')).toBeNull()
  })

  it('shows a toast() message as a status live region and auto-dismisses it', () => {
    render(<Toaster />)
    act(() => toast('Command copied to clipboard.'))

    const item = screen.getByRole('status')
    expect(item.textContent).toBe('Command copied to clipboard.')
    expect(item.getAttribute('data-tone')).toBe('default')

    // The lifetime timer only marks the toast as exiting — it stays mounted so the exit
    // animation has something to animate.
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')

    // …and the second timer is what actually removes it.
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('anchors the stack to the top-right corner, not the bottom centre', () => {
    render(<Toaster />)
    act(() => toast('anchored'))

    const stack = document.querySelector('[data-slot="toaster"]')!
    const className = stack.className
    expect(className).toContain('fixed')
    expect(className).toContain('md:top-[calc(16px+env(safe-area-inset-top))]')
    expect(className).toContain('right-[calc(16px+env(safe-area-inset-right))]')
    expect(className).toContain('items-end')
    // Below `md` the app shell renders its own 52px header whose right end holds the run
    // status dot and kebab; anchoring at 16px there would cover the very controls #818 is
    // about. The pair must stay a pair.
    expect(className).toContain('top-[calc(61px+env(safe-area-inset-top))]')
    // The bottom-centre anchor this replaced must not linger — it is what put the toast on
    // top of the thread's action row (#818).
    expect(className).not.toContain('items-center')
    expect(className).not.toContain('bottom-')
    expect(className).not.toContain('inset-x-0')
  })

  it('animates in on open and out on close, only when motion is allowed', () => {
    render(<Toaster />)
    act(() => toast('animated'))

    const item = screen.getByRole('status')
    expect(item.getAttribute('data-state')).toBe('open')
    expect(item.className).toContain('motion-safe:animate-in')
    expect(item.className).toContain('motion-safe:slide-in-from-right-4')
    expect(item.className).toContain('motion-safe:data-[state=closed]:animate-out')
    expect(item.className).toContain('motion-safe:data-[state=closed]:slide-out-to-right-4')
    // The animation duration and the store's EXIT_MS (200ms) remove the node together. Raise
    // one without the other and the slide-out is unmounted mid-flight, so pin the class here:
    // a failure points the editor straight at EXIT_MS in toaster.tsx.
    expect(item.className).toContain('motion-safe:duration-200')

    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
  })

  it('stacks multiple toasts and dismisses each on its own clock', () => {
    render(<Toaster />)
    act(() => toast('first'))
    act(() => vi.advanceTimersByTime(2000))
    act(() => toast('second', { tone: 'danger' }))

    const toasts = screen.getAllByRole('status')
    expect(toasts.map((t) => t.textContent)).toEqual(['first', 'second'])
    expect(toasts[1]!.getAttribute('data-tone')).toBe('danger')

    // 3s later the first (5s old) starts exiting while the second (3s old) is untouched.
    act(() => vi.advanceTimersByTime(3000))
    expect(
      screen.getAllByRole('status').map((t) => [t.textContent, t.getAttribute('data-state')]),
    ).toEqual([
      ['first', 'closed'],
      ['second', 'open'],
    ])

    // The first one's exit timer removes only itself; the second keeps its own clock running.
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getAllByRole('status').map((t) => t.textContent)).toEqual(['second'])

    // The second reaches its own 5s at t=7000 and then leaves the same way.
    act(() => vi.advanceTimersByTime(1800))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })
})
