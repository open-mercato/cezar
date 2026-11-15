import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { deriveAttention, type Attention } from '@/lib/attention'

import { StatusDescription, StatusMark, statusMarkState } from './status-mark'

afterEach(cleanup)

const done = deriveAttention({ status: 'done' })
const failed = deriveAttention({ status: 'failed' })
const cancelled = deriveAttention({ status: 'cancelled' })
const idle = deriveAttention({ status: 'failed', idleClosedAt: '2026-11-11T00:00:00.000Z' })
const review = deriveAttention({ status: 'review' })

function markOf(attention: Attention, showLabel?: boolean) {
  const { container } = render(<StatusMark attention={attention} showLabel={showLabel} />)
  return container
}

describe('statusMarkState', () => {
  it('maps the closed states by bucket and label, never by tone', () => {
    expect(statusMarkState(done)).toBe('done')
    expect(statusMarkState(failed)).toBe('failed')
    expect(statusMarkState(cancelled)).toBe('cancelled')
    expect(statusMarkState(idle)).toBe('idle')
    expect(statusMarkState(review)).toBeUndefined()
    expect(statusMarkState(deriveAttention({ status: 'queued' }))).toBeUndefined()
    // A usage-limit wait is `failed` on the record but parked, not an outcome.
    expect(statusMarkState(deriveAttention({ status: 'failed', autoResumeAt: '2026-11-11T00:00:00.000Z' }))).toBeUndefined()
    // Same tone, different meaning: the tone alone never picks the shape.
    expect(statusMarkState({ bucket: 'none', label: 'queued' })).toBeUndefined()
  })
})

describe('StatusMark', () => {
  it('draws a different glyph per closed state, keeping the tone colour', () => {
    const cases = [
      [done, 'done', 'success', 'lucide-circle-check'],
      [failed, 'failed', 'danger', 'lucide-circle-x'],
      [cancelled, 'cancelled', 'neutral', 'lucide-circle-slash'],
      [idle, 'idle', 'idle', 'lucide-circle-pause'],
    ] as const
    for (const [attention, state, tone, glyph] of cases) {
      const container = markOf(attention)
      const mark = container.querySelector('[data-slot="status-mark"]') as HTMLElement
      expect(mark.getAttribute('data-state')).toBe(state)
      expect(mark.getAttribute('data-tone')).toBe(tone)
      const svg = mark.querySelector('svg') as SVGElement
      expect(svg.getAttribute('class')).toContain(glyph)
      expect(svg.getAttribute('class')).toContain('size-3.5')
      expect(svg.getAttribute('stroke-width')).toBe('2')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      cleanup()
    }
  })

  it('is a named image and adds no tab stop', () => {
    const container = markOf(idle)
    expect(screen.getByRole('img', { name: 'closed · idle' })).toBe(container.querySelector('[data-slot="status-mark"]'))
    expect(container.querySelector('[tabindex], button, a')).toBeNull()
  })

  it('uses ink that holds 3:1 on both themes — not the raw --success fill', () => {
    expect(markOf(done).querySelector('[data-slot="status-mark"]')?.className).toContain('text-success-strong')
    cleanup()
    expect(markOf(failed).querySelector('[data-slot="status-mark"]')?.className).toContain('text-danger')
    cleanup()
    expect(markOf(idle).querySelector('[data-slot="status-mark"]')?.className).toContain('text-conflict')
    cleanup()
    expect(markOf(cancelled).querySelector('[data-slot="status-mark"]')?.className).toContain('text-soft-foreground')
  })

  it('says the word in a one-line tooltip for pointer users', async () => {
    const container = markOf(failed)
    expect(container.textContent).toBe('')
    fireEvent.focus(container.querySelector('[data-slot="status-mark"]')!.parentElement!)
    await waitFor(() => expect(document.querySelector('[data-slot="icon-tooltip"]')?.textContent).toContain('failed'))
  })

  it('prints the word beside the mark when asked (the Archived view), said once to assistive tech', () => {
    const container = markOf(cancelled, true)
    const word = container.querySelector('[data-slot="status-mark-label"]')
    expect(word?.textContent).toBe('cancelled')
    expect(word?.getAttribute('aria-hidden')).toBe('true')
    expect(word?.className).toContain('text-label')
    expect(word?.className).toContain('text-muted-foreground')
    expect(screen.getAllByRole('img', { name: 'cancelled' })).toHaveLength(1)
  })

  it('falls back to the status dot for a state that is still open', () => {
    const container = markOf(review, true)
    expect(container.querySelector('[data-slot="status-mark"]')).toBeNull()
    const dot = container.querySelector('[data-slot="status-dot"]')
    expect(dot?.getAttribute('data-tone')).toBe('info')
    expect(screen.getByRole('img', { name: 'needs review' })).toBe(dot)
    expect(container.textContent).toBe('needs review')
  })
})

describe('StatusDescription', () => {
  it('describes a link without renaming it', () => {
    render(
      <a href="/tasks/1" aria-describedby="s1">
        Fix the login
        <StatusDescription id="s1" attention={done} />
      </a>,
    )
    expect(screen.getByRole('link', { name: 'Fix the login', description: 'done' })).toBeTruthy()
  })
})
