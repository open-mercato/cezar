import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Chip, chipVariants } from './chip'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function chipOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const chip = container.querySelector('[data-slot="chip"]')
  if (!chip) throw new Error('Chip did not render')
  return chip
}

describe('Chip', () => {
  it('defaults to the filled variant at size sm', () => {
    const chip = chipOf(<Chip>3 running</Chip>)

    expect(chip.textContent).toBe('3 running')
    expect(chip.className).toContain('bg-muted')
    expect(chip.className).toContain('rounded-full')
    expect(chip.className).toContain('h-6.5')
  })

  it.each([
    { variant: 'filled', expected: ['bg-muted', 'text-muted-foreground'] },
    { variant: 'outline', expected: ['border-border', 'text-muted-foreground'] },
    { variant: 'interactive', expected: ['border-border', 'bg-card', 'hover:bg-muted'] },
  ] as const)('maps the $variant variant to its classes', ({ variant, expected }) => {
    const chip = chipOf(<Chip variant={variant}>Label</Chip>)

    for (const cls of expected) expect(chip.className).toContain(cls)
  })

  it('maps size md to h-7', () => {
    const chip = chipOf(<Chip size="md">Label</Chip>)

    expect(chip.className).toContain('h-7')
  })

  it('carries the focus grammar in every variant', () => {
    for (const variant of ['filled', 'outline', 'interactive'] as const) {
      const classes = chipVariants({ variant })

      expect(classes).toContain('outline-none')
      expect(classes).toContain('focus-visible:ring-[3px]')
      expect(classes).toContain('focus-visible:ring-ring/50')
    }
  })

  it('has no dot unless one is requested', () => {
    const chip = chipOf(<Chip>Idle</Chip>)

    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('composes a StatusDot in the requested tone and forwards pulse', () => {
    const chip = chipOf(
      <Chip dot="pending" pulse>
        Working
      </Chip>
    )
    const dot = chip.querySelector('[data-slot="status-dot"]')

    expect(dot?.getAttribute('data-tone')).toBe('pending')
    expect(dot?.className).toContain('animate-pulse')
  })
})
