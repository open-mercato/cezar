import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { DashboardInsights } from '@open-mercato/cezar-api-client'
import { AutomationOutcomes, BackendComparison, OutcomeInsights } from './insights'

const state = vi.hoisted(() => ({ cost: true, failures: true }))
const insights = (): DashboardInsights => ({
  asOf: '2026-09-30T12:00:00.000Z',
  windowStart: '2026-09-24T00:00:00.000Z',
  period: '7d',
  visibility: { cost: state.cost, tokens: true },
  coverage: { projects: [{ projectId: 'alpha', state: 'complete', omittedRuns: 0 }] },
  delivered: {
    completedTasks: 12,
    prsOpened: 4,
    prsTouched: 6,
    issues: 3,
    additions: 1200,
    deletions: 300,
    files: 41,
    measuredTasks: 10,
  },
  failures: state.failures
    ? {
        total: 3,
        reasons: [
          {
            category: 'usage-limit',
            label: 'Usage or rate limit',
            count: 2,
            latest: {
              projectId: 'alpha',
              id: 'r1',
              title: 'Fix login',
              at: '2026-09-30T10:00:00.000Z',
              message: 'HTTP 429',
            },
          },
          {
            category: 'check',
            label: 'Check failed: verify',
            count: 1,
            latest: {
              projectId: 'alpha',
              id: 'r2',
              title: 'Bump deps',
              at: '2026-09-29T10:00:00.000Z',
              step: 'verify',
              message: '3 tests failed',
            },
          },
        ],
      }
    : { total: 0, reasons: [] },
  backends: [
    {
      backend: 'claude',
      model: 'claude-opus-5-5',
      finished: 10,
      done: 9,
      failed: 1,
      timedTasks: 9,
      medianCycleHours: 0.5,
      ...(state.cost ? { costUsd: { value: 9, reportedTasks: 10 } } : {}),
    },
    {
      backend: 'codex',
      finished: 4,
      done: 2,
      failed: 2,
      timedTasks: 2,
      medianCycleHours: 1,
      ...(state.cost ? { costUsd: { value: null, reportedTasks: 0 } } : {}),
    },
  ],
  automations: [
    {
      projectId: 'alpha',
      automationId: 'nightly',
      tasks: 5,
      done: 4,
      failed: 1,
      active: 0,
      lastRunAt: '2026-09-30T02:00:00.000Z',
      lastStatus: 'done',
      ...(state.cost ? { costUsd: { value: 2.5, reportedTasks: 5 } } : {}),
    },
    {
      projectId: 'alpha',
      automationId: 'gone',
      tasks: 1,
      done: 1,
      failed: 0,
      active: 0,
      lastStatus: 'done',
    },
  ],
})
vi.mock('@/api/dashboard-insights', () => ({
  useDashboardInsights: () => ({ data: insights(), isPending: false, isError: false }),
}))
vi.mock('@/api/queries', () => ({
  useProjects: () => ({ data: { projects: [{ id: 'alpha', name: 'Alpha' }] } }),
}))
vi.mock('@/routes/automations/use-automations', () => ({
  useAutomationsGate: () => ({ known: true, off: false }),
}))
vi.mock('./automations-data', () => ({
  useDashboardAutomations: () => ({
    data: [
      {
        id: 'alpha',
        name: 'Alpha',
        data: {
          timeZone: 'UTC',
          automations: [
            { id: 'nightly', name: 'Nightly triage', enabled: true, kind: 'schedule' },
            { id: 'idle', name: 'Idle watcher', enabled: true, kind: 'schedule' },
          ],
        },
      },
    ],
  }),
}))
afterEach(() => {
  cleanup()
  state.cost = true
  state.failures = true
})
const show = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>)

it('shows delivered work and failure reasons with a link to the latest example', () => {
  show(<OutcomeInsights period="7d" active />)
  const delivered = screen.getByRole('region', { name: 'Delivered' })
  expect(within(delivered).getByText('4')).toBeTruthy()
  expect(within(delivered).getByText('6 touched')).toBeTruthy()
  expect(within(delivered).getByText('+1,200')).toBeTruthy()
  expect(within(delivered).getByText(/From 12 completed tasks · 10 with a stored diff/)).toBeTruthy()
  const failures = screen.getByRole('region', { name: 'Why tasks failed' })
  expect(within(failures).getByText('Usage or rate limit')).toBeTruthy()
  expect(within(failures).getByText('Check failed: verify')).toBeTruthy()
  expect(within(failures).getByRole('link', { name: 'Fix login' }).getAttribute('href')).toBe(
    '/p/alpha/tasks/r1',
  )
})

it('says so when nothing failed', () => {
  state.failures = false
  show(<OutcomeInsights period="7d" active />)
  expect(screen.getByText('No failed outcomes in this period')).toBeTruthy()
})

it('compares backends with success rate and per-completed cost', () => {
  show(<BackendComparison />)
  const table = screen.getByRole('region', { name: 'Backend comparison' })
  expect(within(table).getByText('Claude Code')).toBeTruthy()
  expect(within(table).getByText('claude-opus-5-5')).toBeTruthy()
  expect(within(table).getByText('default model')).toBeTruthy()
  expect(within(table).getByText('90%')).toBeTruthy()
  expect(within(table).getByText('$1.00')).toBeTruthy()
  expect(within(table).getByText('Per completed')).toBeTruthy()
})

it('hides every cost column when settings hide cost', () => {
  state.cost = false
  show(<BackendComparison />)
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(screen.queryByText('Per completed')).toBeNull()
})

it('lists automation outcomes, including idle and removed automations', () => {
  show(<AutomationOutcomes />)
  const table = screen.getByRole('region', { name: 'Automation outcomes' })
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
    'Nightly triageAlpha · Enabled',
    'goneAlpha · Removed',
    'Idle watcherAlpha · Enabled',
  ])
  expect(within(table).getByRole('link', { name: 'Nightly triage' }).getAttribute('href')).toBe(
    '/p/alpha/automations/nightly',
  )
  expect(within(table).queryByRole('link', { name: 'gone' })).toBeNull()
})
