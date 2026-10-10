import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DirectionalUsage, directionalUsageText } from './directional-usage'

describe('DirectionalUsage', () => {
  it('uses the same compact direction order and an expanded accessible label', () => {
    render(<DirectionalUsage inputTokens={184_700} outputTokens={2_400} />)
    // The expanded numbers are grouped for the READER's locale (`new Intl.NumberFormat()`), so
    // the separator is whatever this machine uses — `184,700` in en-US, `184 700` in pl-PL.
    const full = (value: number) => new Intl.NumberFormat().format(value)
    const label = screen.getByText('IN 184.7k · OUT 2.4k').getAttribute('aria-label')
    expect(label).toBe(`Input tokens: ${full(184_700)}; output tokens: ${full(2_400)}`)
    // …and expanded, never the compact spelling the visible text uses.
    expect(label?.replace(/\D/g, '')).toBe('1847002400')
  })

  it('shows one known side honestly and omits an entirely unknown compact value', () => {
    expect(directionalUsageText(184_700, undefined)).toBe('IN 184.7k · OUT —')
    const { container } = render(<DirectionalUsage />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps both table placeholders when requested', () => {
    render(<DirectionalUsage variant="table" omitWhenUnknown={false} />)
    expect(screen.getByText('— / —').getAttribute('aria-label')).toBe(
      'Input tokens: unknown; output tokens: unknown',
    )
  })
})
