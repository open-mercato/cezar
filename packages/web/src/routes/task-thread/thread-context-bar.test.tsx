import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlanEntry, StepState } from '@open-mercato/cezar-api-client'

import { ThreadContextBar } from './thread-context-bar'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const step = (id: string, status: StepState['status'], extra: Partial<StepState> = {}): StepState => ({
  id,
  name: id,
  kind: 'agent',
  status,
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const STEPS: StepState[] = [
  step('implement', 'done', { name: 'Do the task' }),
  step('verify', 'running', { name: 'Verify', kind: 'check' }),
]

const PLAN: PlanEntry[] = [
  { content: 'Read the docs', status: 'completed' },
  { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
  { content: 'Reply', status: 'pending' },
]

describe('ThreadContextBar', () => {
  it('renders nothing when the run has neither steps nor a plan', () => {
    render(<ThreadContextBar steps={[]} plan={undefined} />)
    expect(document.querySelector('[data-slot="thread-context-bar"]')).toBeNull()
  })

  it('collapsed by default: a Steps tab that names the active step, no rail rows yet', () => {
    render(<ThreadContextBar steps={STEPS} plan={undefined} />)
    const chip = document.querySelector('[data-slot="steps-chip"]')!
    expect(chip.textContent).toContain('Verify')
    expect(chip.textContent).toContain('2/2')
    // The full rail is not mounted until the popover opens.
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })

  it('opening the Steps chip reveals the full rail in a popover', async () => {
    render(<ThreadContextBar steps={STEPS} plan={undefined} />)
    fireEvent.click(document.querySelector('[data-slot="steps-chip"]') as HTMLButtonElement)
    await screen.findByRole('dialog')
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'active'])
  })

  it('collapsed Plan tab shows the odometer; opening reveals the checklist', async () => {
    render(<ThreadContextBar steps={[]} plan={PLAN} />)
    const chip = document.querySelector('[data-slot="plan-chip"]')!
    expect(chip.querySelector('[data-slot="plan-count"]')?.textContent).toBe('1/3')

    fireEvent.click(chip as HTMLButtonElement)
    await screen.findByRole('dialog')
    expect([...document.querySelectorAll('[data-slot="plan-item"]')]).toHaveLength(3)
  })
})
