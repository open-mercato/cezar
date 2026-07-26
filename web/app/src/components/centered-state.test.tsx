import { cleanup, render, screen } from '@testing-library/react'
import { SearchXIcon } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'

import { CenteredState } from './centered-state'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function tileOf(container: HTMLElement): Element {
  const tile = container.querySelector('[data-slot="centered-state-tile"]')
  if (!tile) throw new Error('CenteredState rendered no icon tile')
  return tile
}

describe('CenteredState', () => {
  // The design system's tile grammar, tone by tone (spec, "Design system": tinted border+fill).
  it.each([
    ['primary', ['border-primary/25', 'bg-primary/15', 'text-primary']],
    ['neutral', ['border-border', 'bg-card', 'shadow-xs']],
    ['danger', ['border-danger/20', 'bg-danger/15', 'text-danger']],
  ] as const)('tints the tile for the %s tone', (tone, classes) => {
    const { container } = render(<CenteredState icon={<SearchXIcon />} tone={tone} title="T" />)

    expect(container.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe(tone)
    for (const cls of classes) expect(tileOf(container).className).toContain(cls)
  })

  it('defaults to the neutral tone', () => {
    const { container } = render(<CenteredState icon={<SearchXIcon />} title="T" />)

    expect(container.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('renders the title, subtitle, children and actions', () => {
    render(
      <CenteredState icon={<SearchXIcon />} title="Nothing here" subtitle="Truly nothing." actions={<button>Go home</button>}>
        <p>extra detail</p>
      </CenteredState>
    )

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nothing here')
    expect(screen.getByText('Truly nothing.')).not.toBeNull()
    expect(screen.getByText('extra detail')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Go home' })).not.toBeNull()
  })

  it('omits the subtitle and actions rows when not given', () => {
    const { container } = render(<CenteredState icon={<SearchXIcon />} title="T" />)

    expect(container.querySelector('p')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  // A state under an existing page heading must not mint a second h1.
  it('demotes the title to h2 on request', () => {
    render(<CenteredState icon={<SearchXIcon />} title="Sub state" heading="h2" />)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Sub state')
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  // The motion budget has no line for decoration — the twinkle scatter is gone for good.
  it('renders no backdrop, ever', () => {
    const { container } = render(<CenteredState icon={<SearchXIcon />} title="T" />)

    expect(container.querySelector('[data-slot="twinkle-backdrop"]')).toBeNull()
  })
})
