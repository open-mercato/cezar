import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { StepState, StepStatus } from '@open-mercato/cezar-api-client'

import { deriveAttention } from '@/lib/attention'

import { activeStepIndex, railProgress, railTone, railVisual, railWanted, StepRail, stepTally, WorkflowSteps, type RailVisual } from './step-rail'

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

describe('railTone — every rail colour is deriveAttention\'s answer (redesign 2026-11)', () => {
  it.each<[RailVisual, Parameters<typeof deriveAttention>[0] | null]>([
    ['done', { status: 'done' }],
    ['active', { status: 'running' }],
    ['failed', { status: 'failed' }],
    ['idle', { status: 'failed', idleClosedAt: '2026-11-04T10:00:00.000Z' }],
    ['answer', { status: 'failed', awaitingAnswerSince: '2026-11-04T10:00:00.000Z' }],
    ['pending', null],
  ])('%s wears the tone the run header would', (visual, run) => {
    const expected = run ? deriveAttention(run) : { tone: 'neutral', pulse: false }
    expect(railTone(visual)).toEqual({ tone: expected.tone, pulse: expected.pulse })
  })

  it('a running step is the violet pulse and an open question is "waiting on you" blue — never amber', () => {
    expect(railTone('active')).toEqual({ tone: 'violet', pulse: true })
    expect(railTone('answer').tone).toBe('info')
    for (const visual of ['done', 'active', 'failed', 'idle', 'answer', 'pending'] as const) {
      expect(railTone(visual).tone).not.toBe('pending')
    }
  })

  it('the dots are StatusDots in that tone, and the progress bar is the accent', () => {
    render(
      <WorkflowSteps
        runId="tone-run"
        steps={[step('a', 'done'), step('b', 'running'), step('c', 'pending')]}
      />,
    )
    const dots = [...document.querySelectorAll('[data-slot="step-dot"]')]
    expect(dots.map((dot) => dot.getAttribute('data-tone'))).toEqual(['success', 'violet', 'neutral'])
    expect(dots[1]!.getAttribute('class')).toContain('animate-pulse')
    const bar = document.querySelector('[data-slot="step-summary-progress"] > span')!
    expect(bar.getAttribute('class')).toContain('bg-violet')
    expect(bar.getAttribute('class')).not.toContain('bg-pending')
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

  describe('an idle-closed run (#2022)', () => {
    const rows = () => [...document.querySelectorAll('[data-slot="step-row"]')]

    it('the step that closed it wears the orange pause, not the danger X', () => {
      render(<StepRail closedAs="idle" steps={[step('done', 'done'), step('t', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' })]} />)
      expect(rows().map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'idle'])
      const icon = rows()[1]!.querySelector('svg')!.getAttribute('class')!
      expect(icon).toContain('lucide-circle-pause')
      expect(icon).toContain('text-conflict')
      expect(icon).not.toContain('text-danger')
    })

    it('only the step that closed it is recoloured — an earlier failure stays red', () => {
      render(
        <StepRail
          closedAs="idle"
          steps={[
            step('implement', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' }),
            step('fix', 'failed', { finishedAt: '2026-11-04T10:07:00.000Z' }),
            step('cancelled', 'cancelled', { finishedAt: '2026-11-04T10:09:00.000Z' }),
          ]}
        />,
      )
      expect(rows().map((row) => row.getAttribute('data-visual'))).toEqual(['failed', 'idle', 'failed'])
      expect(rows()[0]!.querySelector('svg')!.getAttribute('class')).toContain('text-danger')
    })

    it('without the flag the same steps render exactly as before', () => {
      render(<StepRail steps={[step('t', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' })]} />)
      expect(rows().map((row) => row.getAttribute('data-visual'))).toEqual(['failed'])
      expect(rows()[0]!.querySelector('svg')!.getAttribute('class')).toContain('text-danger')
    })
  })

  describe('a run closed on an unanswered question (#2025)', () => {
    const rows = () => [...document.querySelectorAll('[data-slot="step-row"]')]

    it('the step that closed it wears a still "waiting on you" question mark, not the danger X', () => {
      render(<StepRail closedAs="answer" steps={[step('done', 'done'), step('t', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' })]} />)
      expect(rows().map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'answer'])
      const icon = rows()[1]!.querySelector('svg')!.getAttribute('class')!
      expect(icon).toContain('lucide-circle-question-mark')
      // Blue: an open question waits on a person (status grammar), the same tone the header's
      // dot wears for the run — never amber, never the accent.
      expect(icon).toContain('text-info')
      expect(icon).not.toMatch(/\btext-pending\b/)
      expect(icon).not.toContain('text-danger')
      // Still, and not announced as running: the session is gone.
      expect(icon).not.toContain('animate-spin')
      expect(screen.queryByRole('status', { name: 'Step running' })).toBeNull()
    })

    it('only the step that closed it is recoloured — an earlier failure stays red', () => {
      render(
        <StepRail
          closedAs="answer"
          steps={[
            step('implement', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' }),
            step('ask', 'failed', { finishedAt: '2026-11-04T10:07:00.000Z' }),
            step('review', 'pending'),
          ]}
        />,
      )
      expect(rows().map((row) => row.getAttribute('data-visual'))).toEqual(['failed', 'answer', 'pending'])
      expect(rows()[0]!.querySelector('svg')!.getAttribute('class')).toContain('text-danger')
    })

    it('an idle-closed run keeps its orange pause', () => {
      render(<StepRail closedAs="idle" steps={[step('t', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' })]} />)
      expect(rows().map((row) => row.getAttribute('data-visual'))).toEqual(['idle'])
      expect(rows()[0]!.querySelector('svg')!.getAttribute('class')).toContain('text-conflict')
    })
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

describe('WorkflowSteps — the collapsible header summary', () => {
  const steps = [
    step('implement', 'done', { name: 'Do the task' }),
    step('verify', 'running', { name: 'Verify', kind: 'check' }),
    step('review', 'pending', { name: 'Review' }),
  ]
  /** Unique per test — the expand memory below is module-level and keyed by run id. */
  let seq = 0
  const freshRun = () => `run-steps-${(seq += 1)}`

  it('renders nothing without steps', () => {
    render(<WorkflowSteps runId={freshRun()} steps={[]} />)
    expect(document.querySelector('[data-slot="workflow-steps"]')).toBeNull()
  })

  it('collapsed by default: names the active step, one dot per step, and hides the full rows', () => {
    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    const summary = document.querySelector('[data-slot="workflow-steps"]')!
    const trigger = screen.getByRole('button')
    expect(summary.textContent).toContain('Verify')
    expect(summary.textContent).toContain('step 2 of 3')
    // The phone target is 44px, while -my-2 cancels its extra 16px against run-header padding.
    expect(trigger.className).toContain('min-h-11')
    expect(trigger.className).toContain('-my-2')
    expect(trigger.className).toContain('md:min-h-[30px]')
    expect(trigger.className).toContain('md:my-0')
    const dots = [...document.querySelectorAll('[data-slot="step-dot"]')]
    expect(dots.map((dot) => dot.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    // The full rows are not mounted until the user expands.
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })

  it('expands to the full rail on click', () => {
    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    fireEvent.click(screen.getByRole('button'))
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    expect(rows[1]!.textContent).toContain('check · step 2 of 3')
  })

  it('remembers an explicit expand per run across remounts — a tab switch must not collapse it', () => {
    const runId = freshRun()
    const first = render(<WorkflowSteps runId={runId} steps={steps} />)
    fireEvent.click(screen.getByRole('button'))
    expect(document.querySelector('[data-slot="step-row"]')).not.toBeNull()
    first.unmount()

    // Same run, remounted by another task route's RunHeader: still expanded.
    render(<WorkflowSteps runId={runId} steps={steps} />)
    expect(document.querySelector('[data-slot="step-row"]')).not.toBeNull()
  })

  it('an idle-closed run: the closing step is an orange dot collapsed and an orange pause expanded (#2022)', () => {
    const idleSteps = [
      step('implement', 'failed', { name: 'Do the task', finishedAt: '2026-11-04T10:00:00.000Z' }),
      step('fix', 'failed', { name: 'Fix it', finishedAt: '2026-11-04T10:05:00.000Z' }),
    ]
    render(<WorkflowSteps runId={freshRun()} steps={idleSteps} closedAs="idle" />)
    const dots = [...document.querySelectorAll('[data-slot="step-dot"]')]
    expect(dots.map((dot) => dot.getAttribute('data-visual'))).toEqual(['failed', 'idle'])
    expect(dots[0]!.getAttribute('class')).toContain('bg-danger')
    expect(dots[1]!.getAttribute('class')).toContain('bg-conflict')
    expect(dots[1]!.getAttribute('class')).not.toContain('bg-danger')

    fireEvent.click(screen.getByRole('button'))
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['failed', 'idle'])
    expect(rows[1]!.querySelector('svg')!.getAttribute('class')).toContain('text-conflict')
  })

  it('a run closed on a question: the closing step is a blue dot collapsed and a question mark expanded (#2025)', () => {
    const answerSteps = [
      step('implement', 'failed', { name: 'Do the task', finishedAt: '2026-11-04T10:00:00.000Z' }),
      step('ask', 'failed', { name: 'Ask', finishedAt: '2026-11-04T10:05:00.000Z' }),
    ]
    render(<WorkflowSteps runId={freshRun()} steps={answerSteps} closedAs="answer" />)
    const dots = [...document.querySelectorAll('[data-slot="step-dot"]')]
    expect(dots.map((dot) => dot.getAttribute('data-visual'))).toEqual(['failed', 'answer'])
    expect(dots[0]!.getAttribute('data-tone')).toBe('danger')
    // The open question is the run's "needs you" — the header dot's blue, pulsing like it.
    expect(dots[1]!.getAttribute('data-tone')).toBe('info')
    expect(dots[1]!.getAttribute('class')).toContain('animate-pulse')

    fireEvent.click(screen.getByRole('button'))
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['failed', 'answer'])
    expect(rows[1]!.querySelector('svg')!.getAttribute('class')).toContain('text-info')
  })

  it('a failed run without the idle flag keeps its red dots', () => {
    render(<WorkflowSteps runId={freshRun()} steps={[step('t', 'failed', { finishedAt: '2026-11-04T10:00:00.000Z' })]} />)
    const dot = document.querySelector('[data-slot="step-dot"]')!
    expect(dot.getAttribute('data-visual')).toBe('failed')
    expect(dot.getAttribute('class')).toContain('bg-danger')
  })

  it('does not leak that choice to a different run — a fresh run opens collapsed', () => {
    const first = render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    fireEvent.click(screen.getByRole('button'))
    first.unmount()

    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })

  it('the collapsed summary carries the current step\'s retry count — no expand needed', () => {
    render(<WorkflowSteps runId={freshRun()} steps={[step('a', 'done'), step('b', 'running', { name: 'Verify', iterations: 3 })]} />)
    expect(document.querySelector('[data-slot="step-summary-iterations"]')?.textContent).toBe('×3')
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })

  it('no ×N for a step that ran once', () => {
    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    expect(document.querySelector('[data-slot="step-summary-iterations"]')).toBeNull()
  })
})

describe('stepTally and railWanted — a retried step is never invisible', () => {
  it('counts the extra passes across steps', () => {
    expect(stepTally([step('a', 'done', { iterations: 3 }), step('b', 'done', { iterations: 2 }), step('c', 'pending')])).toEqual({
      done: 2,
      total: 3,
      retries: 3,
    })
    expect(stepTally([step('a', 'done')]).retries).toBe(0)
  })

  it('a one-step workflow that retried keeps its rail (where its ×N is)', () => {
    expect(railWanted([step('a', 'done')])).toBe(false)
    expect(railWanted([step('a', 'done', { iterations: 2 })])).toBe(true)
  })
})
