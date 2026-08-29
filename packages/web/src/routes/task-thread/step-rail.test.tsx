import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { StepState, StepStatus } from '@open-mercato/cezar-api-client'

import {
  activeStepIndex,
  railBarTone,
  railProgress,
  railVisual,
  StepRail,
  type RailBarTone,
  type RailVisual,
} from './step-rail'

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
    // Kind is a tag now, not dot-joined to the position — no middot (house rule).
    expect(rows[0]!.textContent).toContain('agent')
    expect(rows[0]!.textContent).toContain('step 1 of 3')
    expect(rows[1]!.textContent).toContain('check')
    expect(rows[1]!.textContent).toContain('step 2 of 3')
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

  // Audit A2: the bar tone must settle when the run does — amber is the RUNNING color.
  it.each<[string, RailBarTone, string]>([
    ['a running step keeps the amber bar', 'active', 'bg-pending'],
    ['all steps done → success bar', 'done', 'bg-success'],
    ['a cancelled step → danger bar', 'failed', 'bg-danger'],
  ])('%s', (_label, _tone, cls) => {
    const steps =
      cls === 'bg-pending'
        ? [step('a', 'done'), step('b', 'running')]
        : cls === 'bg-success'
          ? [step('a', 'done'), step('b', 'done')]
          : [step('a', 'done'), step('b', 'cancelled')]
    render(<StepRail steps={steps} />)
    const bar = document.querySelector<HTMLElement>('[data-slot="step-progress"] > div')!
    expect(bar.className).toContain(cls)
    expect(bar.className).not.toContain(cls === 'bg-pending' ? 'bg-success' : 'bg-pending')
  })
})

describe('railBarTone — the bar settles with the run', () => {
  it.each<[StepStatus[], RailBarTone]>([
    [['done', 'done'], 'done'],
    [['done', 'running'], 'active'],
    [['done', 'waiting'], 'active'],
    [['done', 'review'], 'active'],
    [['done', 'cancelled'], 'failed'],
    [['failed'], 'failed'],
  ])('%j → %s', (statuses, tone) => {
    expect(railBarTone(statuses.map((status, i) => step(`s${i}`, status)))).toBe(tone)
  })
})

describe('activeStepIndex — who the summary speaks for', () => {
  it('points at the first in-flight step, else the last (a finished run reads "N of N")', () => {
    expect(activeStepIndex([step('a', 'done'), step('b', 'running'), step('c', 'pending')])).toBe(1)
    expect(activeStepIndex([step('a', 'done'), step('b', 'done')])).toBe(1)
    expect(activeStepIndex([step('a', 'pending'), step('b', 'pending')])).toBe(0)
    // An empty list has no index to point at; 0 keeps `steps[index]` undefined rather than
    // handing back a -1 that would silently address the wrong element.
    expect(activeStepIndex([])).toBe(0)
  })
})

// The collapsed chip that hosts this rail now lives in the context bar
// (thread-context-bar.test.tsx); the rail itself is exercised above.
