import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { StatusDot, type StatusDotTone } from './status-dot'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function renderDot(ui: React.ReactElement) {
  const { container } = render(ui)
  const dot = container.querySelector('[data-slot="status-dot"]')
  if (!dot) throw new Error('StatusDot did not render')
  return dot
}

describe('StatusDot', () => {
  describe('tone → class mapping', () => {
    it.each([
      { tone: 'success', expected: 'bg-success' },
      { tone: 'pending', expected: 'bg-pending' },
      { tone: 'danger', expected: 'bg-danger' },
      { tone: 'violet', expected: 'bg-violet' },
      { tone: 'neutral', expected: 'bg-soft-foreground' },
    ] as const satisfies readonly { tone: StatusDotTone; expected: string }[])(
      '$tone',
      ({ tone, expected }) => {
        const dot = renderDot(<StatusDot tone={tone} />)

        expect(dot.className).toContain(expected)
        expect(dot.getAttribute('data-tone')).toBe(tone)
      }
    )
  })

  it('defaults to the neutral tone', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.getAttribute('data-tone')).toBe('neutral')
    expect(dot.className).toContain('bg-soft-foreground')
  })

  it('renders at the design system 7px size', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.className).toContain('size-[7px]')
    expect(dot.className).toContain('rounded-full')
  })

  it('pulses only when asked to', () => {
    expect(renderDot(<StatusDot tone="success" pulse />).className).toContain('animate-pulse')
    expect(renderDot(<StatusDot tone="success" />).className).not.toContain('animate-pulse')
    expect(renderDot(<StatusDot tone="success" pulse={false} />).className).not.toContain(
      'animate-pulse'
    )
  })

  it('lets a caller className override the tone', () => {
    const dot = renderDot(<StatusDot tone="success" className="bg-violet" />)

    expect(dot.className).toContain('bg-violet')
    expect(dot.className).not.toContain('bg-success')
  })
})
