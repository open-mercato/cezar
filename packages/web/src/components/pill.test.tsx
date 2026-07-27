import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Pill } from './pill'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function pillOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const pill = container.querySelector('[data-slot="pill"]')
  if (!pill) throw new Error('Pill did not render')
  return pill
}

describe('Pill', () => {
  it('renders its children as a neutral chip', () => {
    const pill = pillOf(<Pill>3 running</Pill>)

    expect(pill.textContent).toBe('3 running')
    expect(pill.className).toContain('bg-muted')
    expect(pill.className).toContain('rounded-full')
  })

  it('has no dot unless one is requested', () => {
    const pill = pillOf(<Pill>Idle</Pill>)

    expect(pill.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('composes a StatusDot in the requested tone', () => {
    const pill = pillOf(<Pill dot="success">Passed</Pill>)
    const dot = pill.querySelector('[data-slot="status-dot"]')

    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('data-tone')).toBe('success')
    expect(pill.textContent).toBe('Passed')
  })

  it('forwards pulse to the dot', () => {
    const pill = pillOf(
      <Pill dot="pending" pulse>
        Working
      </Pill>
    )

    expect(pill.querySelector('[data-slot="status-dot"]')?.className).toContain('animate-pulse')
  })

  // The design system's grammar: status is expressed by the dot, so the chip's own fill never changes.
  it.each(['success', 'pending', 'danger', 'violet', 'neutral'] as const)(
    'keeps the chip neutral when the dot is %s',
    (tone) => {
      const pill = pillOf(<Pill dot={tone}>Label</Pill>)

      expect(pill.className).toContain('bg-muted')
      expect(pill.className).toContain('text-muted-foreground')
    }
  )

  it('passes through span attributes', () => {
    render(<Pill title="tooltip">Label</Pill>)

    expect(screen.getByTitle('tooltip').textContent).toBe('Label')
  })
})
