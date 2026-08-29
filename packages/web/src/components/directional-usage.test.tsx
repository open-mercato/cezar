import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DirectionalUsage, directionalUsageText } from './directional-usage'

describe('DirectionalUsage', () => {
  it('uses the same compact direction order and an expanded accessible label', () => {
    render(<DirectionalUsage inputTokens={184_700} outputTokens={2_400} />)
    expect(screen.getByText('IN 184.7k / OUT 2.4k').getAttribute('aria-label')).toBe(
      'Input tokens: 184,700; output tokens: 2,400',
    )
  })

  it('shows one known side honestly and omits an entirely unknown compact value', () => {
    // No dash placeholders (house rule): the missing side drops out of the phrase, and the
    // survivor keeps its direction word so a bare number never has to be guessed at.
    expect(directionalUsageText(184_700, undefined)).toBe('IN 184.7k')
    expect(directionalUsageText(undefined, 2_400)).toBe('OUT 2.4k')
    const { container } = render(<DirectionalUsage />)
    expect(container.innerHTML).toBe('')
  })

  it('renders an entirely unknown table value as empty, never as dashes', () => {
    // The accessible label still spells the absence out; the visible cell stays blank.
    const { container } = render(<DirectionalUsage variant="table" omitWhenUnknown={false} />)
    const span = container.querySelector('[data-slot="directional-usage"]')
    expect(span?.textContent).toBe('')
    expect(span?.getAttribute('aria-label')).toBe('Input tokens: unknown; output tokens: unknown')
  })
})
