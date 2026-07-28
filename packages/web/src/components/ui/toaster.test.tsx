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

    act(() => vi.advanceTimersByTime(5000))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('stacks multiple toasts and dismisses each on its own clock', () => {
    render(<Toaster />)
    act(() => toast('first'))
    act(() => vi.advanceTimersByTime(2000))
    act(() => toast('second', { tone: 'danger' }))

    const toasts = screen.getAllByRole('status')
    expect(toasts.map((t) => t.textContent)).toEqual(['first', 'second'])
    expect(toasts[1]!.getAttribute('data-tone')).toBe('danger')

    // 3s later the first (5s old) is gone, the second (3s old) remains.
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getAllByRole('status').map((t) => t.textContent)).toEqual(['second'])
  })
})
