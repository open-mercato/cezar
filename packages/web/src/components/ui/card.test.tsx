import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Card } from './card'

afterEach(cleanup)

describe('Card', () => {
  it('pads and spaces its children by default', () => {
    const { container } = render(<Card>body</Card>)
    const card = container.querySelector('[data-slot="card"]')

    expect(card?.className).toContain('py-6')
    expect(card?.className).toContain('gap-6')
    expect(card?.getAttribute('data-flush')).toBeNull()
  })

  it('is flush — no padding, clipped to the rounded edge — for a table or calendar frame', () => {
    const { container } = render(<Card flush>body</Card>)
    const card = container.querySelector('[data-slot="card"]')

    expect(card?.getAttribute('data-flush')).toBe('true')
    expect(card?.className).toContain('py-0')
    expect(card?.className).toContain('overflow-hidden')
    expect(card?.className).not.toContain('py-6')
  })
})
