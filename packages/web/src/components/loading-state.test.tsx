import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatSkeleton, LOADING_REVEAL_DELAY_MS, ListSkeleton, LoadingState, ScreenLoading } from './loading-state'
import { Skeleton } from './ui/skeleton'
import { Spinner } from './ui/spinner'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LoadingState', () => {
  it('is a named, busy status with a visually hidden label', () => {
    render(<LoadingState label="Loading managers…"><ListSkeleton /></LoadingState>)
    const status = screen.getByRole('status', { name: 'Loading managers…' })
    expect(status.getAttribute('aria-busy')).toBe('true')
    const hidden = status.querySelector('.sr-only')
    expect(hidden?.textContent).toBe('Loading managers…')
    // The placeholder is decoration: the label is the only thing a screen reader hears.
    expect(status.querySelector('[data-slot="list-skeleton"]')?.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('holds the placeholder invisible for the reveal delay, keeping its space', () => {
    vi.useFakeTimers()
    render(<LoadingState label="Loading…"><ChatSkeleton /></LoadingState>)
    const status = screen.getByRole('status')
    const holder = status.querySelector('[aria-hidden="true"]')!
    // Rendered from the first frame (no layout shift), just not painted.
    expect(status.querySelector('[data-slot="chat-skeleton"]')).not.toBeNull()
    expect(holder.className).toContain('[&>*]:invisible')
    expect(status.hasAttribute('data-revealed')).toBe(false)

    act(() => vi.advanceTimersByTime(LOADING_REVEAL_DELAY_MS - 1))
    expect(status.hasAttribute('data-revealed')).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(status.getAttribute('data-revealed')).toBe('true')
    expect(holder.className).not.toContain('invisible')
  })

  it('shows at once with no delay', () => {
    render(<LoadingState label="Loading…" delayMs={0} />)
    expect(screen.getByRole('status').getAttribute('data-revealed')).toBe('true')
    // With nothing to sketch, the region falls back to a spinner.
    expect(screen.getByRole('status').querySelector('[data-slot="spinner"]')).not.toBeNull()
  })

  it('renders as a list item inside a list', () => {
    render(<ul><LoadingState as="li" label="Loading folder…" /></ul>)
    expect(screen.getByRole('status').tagName).toBe('LI')
  })

  it('ScreenLoading fills its column and centers a spinner', () => {
    render(<ScreenLoading label="Opening project…" />)
    const status = screen.getByRole('status', { name: 'Opening project…' })
    expect(status.className).toContain('min-h-full')
    expect(status.querySelector('[data-slot="spinner"]')).not.toBeNull()
  })
})

describe('Skeleton', () => {
  it('is decorative and pulses only when motion is welcome', () => {
    const { container } = render(<Skeleton className="h-4" />)
    const block = container.querySelector('[data-slot="skeleton"]')!
    expect(block.getAttribute('aria-hidden')).toBe('true')
    expect(block.className).toContain('motion-safe:animate-pulse')
    expect(block.className.split(' ')).not.toContain('animate-pulse')
  })
})

describe('Spinner', () => {
  it('is decorative inside a control that names the action', () => {
    const { container } = render(<button type="button" aria-busy="true"><Spinner />Connect</button>)
    const spinner = container.querySelector('[data-slot="spinner"]')!
    expect(spinner.getAttribute('aria-hidden')).toBe('true')
    expect(spinner.getAttribute('class')).toContain('motion-safe:animate-spin')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('is its own status when given a label', () => {
    render(<Spinner label="Saving…" />)
    expect(screen.getByRole('status', { name: 'Saving…' })).toBeTruthy()
  })
})
