import { cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, LandingCheck } from '@open-mercato/cezar-api-client'

import { TasksOverview } from './tasks-overview'

afterEach(cleanup)

function check(over: Partial<LandingCheck> = {}): LandingCheck {
  return {
    ofRunId: 'parent',
    subject: {
      baseRef: 'cez/parent',
      baseSha: 'a'.repeat(40),
      sources: [],
      order: 'ledger',
    },
    ...over,
  }
}

function run(over: Partial<ApiRun> = {}): ApiRun {
  return {
    id: 'r1',
    title: 'Landing check — parent',
    workflow: 'landing-check',
    task: 'landing check',
    status: 'done',
    createdAt: '2026-09-29T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function renderOverview(runs: ApiRun[]) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <TasksOverview
              runs={runs}
              view="active"
              now={Date.parse('2026-09-29T12:00:00.000Z')}
              onViewChange={vi.fn()}
              onArchiveFinished={vi.fn()}
              onMarkAllRead={vi.fn()}
              onRename={vi.fn()}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const chipOf = (id: string) =>
  document.querySelector(`[data-slot="task-table-row"][data-run-id="${id}"] [data-slot="landing-check-chip"]`)

describe('TasksOverview — the landing-check chip (sign-off b)', () => {
  const states: [string, Partial<ApiRun>][] = [
    ['checking', { status: 'running', landingCheck: check() }],
    ['passed', { landingCheck: check({ verdict: 'passed' }) }],
    ['failed', { landingCheck: check({ verdict: 'failed', reason: 'command-failed' }) }],
    ['conflict', { landingCheck: check({ verdict: 'conflict', reason: 'merge-conflict' }) }],
    ['nothing-to-check', { landingCheck: check({ verdict: 'nothing-to-check', reason: 'no-commands' }) }],
    ['could-not-run', { landingCheck: check({ verdict: 'could-not-run', reason: 'install-failed' }) }],
    ['stale', { landingCheckStale: true, landingCheck: check({ verdict: 'passed' }) }],
  ]

  it.each(states)('renders the %s state on the task row', (state, over) => {
    renderOverview([run({ id: state, ...over })])
    const chip = chipOf(state)
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('data-state')).toBe(state)
    expect(chip?.querySelector('[data-slot="status-dot"]')).not.toBeNull()
  })

  it('marks the stale chip beside the verdict it still reports', () => {
    renderOverview([run({ id: 'stale-chip', landingCheckStale: true, landingCheck: check({ verdict: 'passed' }) })])
    const chip = chipOf('stale-chip')
    expect(chip?.textContent).toContain('passed')
    expect(chip?.querySelector('[data-slot="landing-check-stale"]')?.textContent).toContain('stale')
  })

  it('never paints nothing-to-check or could-not-run with the success tone', () => {
    renderOverview([
      run({ id: 'ntc', landingCheck: check({ verdict: 'nothing-to-check' }) }),
      run({ id: 'cnr', landingCheck: check({ verdict: 'could-not-run' }) }),
    ])
    for (const id of ['ntc', 'cnr']) {
      expect(chipOf(id)?.querySelector('[data-tone="success"]')).toBeNull()
    }
  })

  it('renders nothing at all for a run that is not a landing check', () => {
    renderOverview([run({ id: 'plain', landingCheck: undefined, title: 'Just a task', workflow: 'default' })])
    expect(chipOf('plain')).toBeNull()
  })
})
