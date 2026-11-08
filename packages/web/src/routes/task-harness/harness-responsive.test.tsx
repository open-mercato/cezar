import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'

import { HarnessModelsDock } from './harness-components'
import { HarnessStatusBar } from './harness-status-bar'
import { RUN_RAIL_CONTAINER } from '../task-thread/run-shell'

const ledger: HarnessLedgerResponse = {
  version: 2,
  workflow: 'harness-fix-issue',
  requestedProfile: 'multi',
  effectiveProfile: 'multi',
  phases: [{ id: 'review', name: 'Council', kind: 'agent', status: 'running', attempts: 1, artifacts: {} }],
  councils: [{ kind: 'implementation', round: 1, reviewers: [{ id: 'codex/gpt', status: 'running', findings: [] }] }],
  models: [{ id: 'codex/gpt', family: 'openai', roles: ['reviewer'], readiness: 'ready', invocations: 1, totalDurationMs: 1000 }],
  invocations: [],
  packets: [],
  validation: [],
  decisions: [],
  pendingMessages: [],
  loops: { fixRounds: 0, maxFixRounds: 3 },
  outcome: { status: 'pending', blockingReasons: [] },
  stage: { status: 'pending' },
  roles: null,
}

afterEach(cleanup)

describe('harness surfaces in a narrow run container', () => {
  it('sizes the status progress and council readout against the run container', () => {
    render(<div className={RUN_RAIL_CONTAINER}><HarnessStatusBar ledger={ledger} onOpenTimeline={() => {}} /></div>)
    const status = document.querySelector('[data-slot="harness-status-bar"]')!
    const progress = status.querySelector('span[aria-hidden="true"]')!
    const council = screen.getByText(/council round/)
    expect(progress.className.split(/\s+/)).toContain('@sm/run:block')
    expect(progress.className.split(/\s+/)).not.toContain('sm:block')
    expect(council.className.split(/\s+/)).toContain('@max-sm/run:hidden')
    expect(council.className.split(/\s+/)).not.toContain('max-sm:hidden')
    expect(screen.getByRole('button', { name: 'Timeline' })).toBeTruthy()
  })

  it('uses the compact Models grid, binding and activity at the run container breakpoint', () => {
    render(<div className={RUN_RAIL_CONTAINER}><HarnessModelsDock ledger={ledger} /></div>)
    const model = screen.getByText('codex/gpt')
    const row = model.parentElement!
    const binding = screen.getByText('openai')
    const activity = screen.getByText('reviewer').parentElement!
    expect(row.className.split(/\s+/)).toContain('@max-sm/run:grid-cols-[auto_1fr_auto]')
    expect(binding.className.split(/\s+/)).toContain('@max-sm/run:hidden')
    expect(activity.className.split(/\s+/)).toContain('@max-sm/run:col-start-2')
    for (const element of [row, binding, activity]) {
      expect(element.className.split(/\s+/).some((name) => name.startsWith('max-sm:'))).toBe(false)
    }
    expect(row.className).toContain('grid-cols-[auto_minmax(5rem,.8fr)_minmax(7rem,1fr)_minmax(0,2fr)_auto]')
  })
})
