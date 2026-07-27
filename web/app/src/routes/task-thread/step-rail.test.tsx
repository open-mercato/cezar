import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { StepState, StepStatus } from '@/api/types'

import { railProgress, railVisual, StepRail, type RailVisual } from './step-rail'

afterEach(cleanup)

/** A store-shaped step (`RunRecord.steps` entry) with sensible defaults. */
const step = (id: string, status: StepStatus, extra: Partial<StepState> = {}): StepState => ({
  id,
  name: id,
  kind: 'agent',
  status,
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

describe('railVisual — the full StepStatus → glyph table', () => {
  it.each<[StepStatus, RailVisual]>([
    ['done', 'done'],
    ['running', 'active'],
    ['waiting', 'active'], // paused mid-step: still the live one
    ['review', 'active'], // parked at the gate: in flight until accepted
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['pending', 'pending'],
    ['skipped', 'pending'], // never ran — the empty circle is honest
  ])('%s → %s', (status, visual) => {
    expect(railVisual(status)).toBe(visual)
  })
})

describe('railProgress — (terminal + 0.5·active) / total', () => {
  it.each<[string, StepStatus[], number]>([
    ['no steps', [], 0],
    ['all pending', ['pending', 'pending'], 0],
    ['one running of two (the mockup state)', ['running', 'pending'], 0.25],
    ['done + running + pending', ['done', 'running', 'pending'], 0.5],
    ['waiting and review are active too', ['done', 'waiting', 'review', 'pending'], 0.5],
    ['terminal failures still advance the bar', ['done', 'failed'], 1],
    ['skipped and cancelled are terminal', ['skipped', 'cancelled'], 1],
    ['all done', ['done', 'done'], 1],
  ])('%s → %d', (_name, statuses, fraction) => {
    expect(railProgress(statuses.map((status, i) => step(`s${i}`, status)))).toBe(fraction)
  })
})

describe('StepRail', () => {
  it('renders nothing without steps (worktree-less oddities stay honest)', () => {
    render(<StepRail steps={[]} />)
    expect(document.querySelector('[data-slot="step-rail"]')).toBeNull()
  })

  it('one row per step with the mapped glyph, name, kind and position', () => {
    render(
      <StepRail
        steps={[
          step('implement', 'done', { name: 'Do the task' }),
          step('verify', 'running', { name: 'Verify', kind: 'check' }),
          step('review', 'pending', { name: 'Review' }),
        ]}
      />,
    )
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    expect(rows[0]!.textContent).toContain('Do the task')
    expect(rows[0]!.textContent).toContain('agent · step 1 of 3')
    expect(rows[1]!.textContent).toContain('check · step 2 of 3')
    // The amber spinner announces itself; done/pending rows carry no live status.
    expect(screen.getAllByRole('status', { name: 'Step running' })).toHaveLength(1)
  })

  it('a failed step wears the danger X', () => {
    render(<StepRail steps={[step('t', 'failed', { name: 'Do the task' })]} />)
    expect(document.querySelector('[data-slot="step-row"]')?.getAttribute('data-visual')).toBe('failed')
    expect(document.querySelector('[data-slot="step-row"] svg')?.getAttribute('class')).toContain('text-danger')
  })

  it('shows ×N only when a step actually iterated', () => {
    render(
      <StepRail
        steps={[step('a', 'done', { iterations: 3 }), step('b', 'done')]}
      />,
    )
    const marks = [...document.querySelectorAll('[data-slot="step-iterations"]')]
    expect(marks).toHaveLength(1)
    expect(marks[0]!.textContent).toBe('×3')
  })

  it('draws the thin progress bar at the formula width', () => {
    render(<StepRail steps={[step('a', 'done'), step('b', 'running'), step('c', 'pending'), step('d', 'pending')]} />)
    const bar = document.querySelector<HTMLElement>('[data-slot="step-progress"] > div')!
    expect(bar.style.width).toBe('37.5%') // (1 + 0.5) / 4
  })

  it('starts compact on request, names the active step, and expands the full history on demand', () => {
    render(
      <StepRail
        defaultExpanded={false}
        steps={[
          step('capture', 'done', { name: 'Capture' }),
          step('implement', 'running', { name: 'Implement' }),
          step('review', 'pending', { name: 'Review' }),
        ]}
      />,
    )

    expect(document.querySelector('[data-slot="step-rail"]')?.getAttribute('data-state')).toBe(
      'collapsed',
    )
    expect(document.querySelector('[data-slot="step-summary"]')?.textContent).toBe('Implement')
    expect(document.querySelector('[data-slot="step-summary-position"]')?.textContent).toBe(
      '· Step 2 of 3',
    )
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /show steps/i }))
    expect(document.querySelector('[data-slot="step-rail"]')?.getAttribute('data-state')).toBe(
      'open',
    )
    expect(document.querySelectorAll('[data-slot="step-row"]')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /hide steps/i }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  it('keeps a terminal failure visible in the compact summary', () => {
    render(
      <StepRail
        defaultExpanded={false}
        steps={[
          step('implement', 'done', { name: 'Implement' }),
          step('fix', 'failed', { name: 'Fix (round 3)' }),
        ]}
      />,
    )
    expect(document.querySelector('[data-slot="step-summary"]')?.textContent).toBe(
      'Fix (round 3) failed',
    )
    expect(document.querySelector('[data-slot="step-summary-position"]')?.textContent).toBe(
      '· Step 2 of 2',
    )
  })

  it('automatically folds a short workflow when its session closes', () => {
    const steps = [
      step('implement', 'running', { name: 'Implement' }),
      step('validate', 'pending', { name: 'Validate' }),
    ]
    const view = render(<StepRail defaultExpanded steps={steps} />)
    expect(document.querySelector('[data-slot="step-row"]')).not.toBeNull()

    view.rerender(
      <StepRail
        defaultExpanded={false}
        steps={steps.map((entry) => ({ ...entry, status: 'done' }))}
      />,
    )
    expect(document.querySelector('[data-slot="step-rail"]')?.getAttribute('data-state')).toBe(
      'collapsed',
    )
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })
})
