import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Kbd } from './kbd'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

describe('Kbd', () => {
  it('renders a flat kbd element on the type ramp', () => {
    const { container } = render(<Kbd>⌘K</Kbd>)
    const kbd = container.querySelector('[data-slot="kbd"]')

    expect(kbd?.tagName).toBe('KBD')
    expect(kbd?.textContent).toBe('⌘K')
    expect(kbd?.className).toContain('rounded-sm')
    expect(kbd?.className).toContain('font-mono')
    expect(kbd?.className).toContain('text-2xs')
    expect(kbd?.className).not.toContain('border-b-2')
  })

  it('merges a caller className and passes through attributes', () => {
    const { container } = render(
      <Kbd aria-hidden="true" className="ml-1">
        C
      </Kbd>
    )
    const kbd = container.querySelector('[data-slot="kbd"]')

    expect(kbd?.className).toContain('ml-1')
    expect(kbd?.getAttribute('aria-hidden')).toBe('true')
  })
})
