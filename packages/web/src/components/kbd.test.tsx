import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BranchChip } from './branch-chip'
import { Kbd } from './kbd'

afterEach(cleanup)

describe('Kbd', () => {
  it('renders a hidden-from-AT key chip in mono with a heavier bottom edge', () => {
    const { container } = render(<Kbd>⌘K</Kbd>)
    const kbd = container.querySelector('[data-slot="kbd"]')

    expect(kbd?.tagName).toBe('KBD')
    expect(kbd?.getAttribute('aria-hidden')).toBe('true')
    expect(kbd?.textContent).toBe('⌘K')
    expect(kbd?.className).toContain('font-mono')
    expect(kbd?.className).toContain('border-b-2')
    expect(kbd?.className).toContain('bg-card')
  })

  it('swaps to the contrast palette on a contrast button', () => {
    const { container } = render(<Kbd onContrast>C</Kbd>)
    const kbd = container.querySelector('[data-slot="kbd"]')

    expect(kbd?.className).toContain('bg-transparent')
    expect(kbd?.className).not.toContain('bg-card')
  })
})

describe('BranchChip', () => {
  it('renders a muted mono token that never wraps', () => {
    const { container } = render(<BranchChip>0 4 * * *</BranchChip>)
    const chip = container.querySelector('[data-slot="branch-chip"]')

    expect(chip?.textContent).toBe('0 4 * * *')
    expect(chip?.className).toContain('font-mono')
    expect(chip?.className).toContain('bg-muted')
    expect(chip?.className).toContain('whitespace-nowrap')
  })
})
