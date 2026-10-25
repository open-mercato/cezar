import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DashboardFeed, DashboardFeedRow } from '@open-mercato/cezar-api-client'
import { Feed } from './feed'
import { collectDashboardExport, dashboardCsv, printableDashboard } from './export'

const state = vi.hoisted(() => ({ data: undefined as DashboardFeed | undefined }))
vi.mock('@/api/dashboard', () => ({
  useDashboardFeed: () => ({ data: state.data, refetch: vi.fn(), retryTasks: vi.fn(), retryFailed: vi.fn() }),
}))
afterEach(() => {
  cleanup()
  state.data = undefined
})
const at = '2026-09-25T00:00:00Z'
const issue = (repo: string): DashboardFeedRow => ({
  kind: 'github-created',
  key: `github:github.com/${repo}:issue:1`,
  at,
  repo,
  projectIds: ['shop'],
  itemKind: 'issue',
  number: 1,
  title: `${repo} issue`,
  url: `https://github.com/${repo}/issues/1`,
})
function snapshot(rows: DashboardFeedRow[]): DashboardFeed {
  return {
    asOf: at,
    windowStart: '2026-09-18T00:00:00Z',
    filter: 'all',
    rows,
    coverage: { projects: [{ projectId: 'shop', state: 'complete', omittedRuns: 0 }] },
    sources: [{ key: 'github:github.com/old/repo:issue', state: 'ready', fetchedAt: at, truncated: false }],
    truncated: false,
  }
}
const view = () => (
  <section data-dashboard-module="recent">
    <Feed filter="all" setFilter={vi.fn()} count={6} more={vi.fn()} />
  </section>
)

it('removes detached GitHub rows immediately from the screen and both exports', () => {
  state.data = snapshot([issue('old/repo')])
  const rendered = render(view())
  expect(screen.getByRole('link', { name: 'old/repo issue' })).toBeTruthy()
  state.data = { ...snapshot([]), sources: [{ key: 'github:project:shop:issue', state: 'unavailable', reason: 'No GitHub remote', truncated: false }] }
  rendered.rerender(view())
  expect(screen.queryByRole('link', { name: 'old/repo issue' })).toBeNull()
  expect(screen.getByText('No results in the last 7 days')).toBeTruthy()
  const report = collectDashboardExport(rendered.container, at, 'localhost')
  expect(dashboardCsv(report)).not.toContain('old/repo')
  expect(printableDashboard(report, [])).not.toContain('old/repo')
  expect(report.modules[0]!.filters).toContain('loaded 0 rows')
})

it('still stages inserted GitHub rows while immediately removing detached rows', () => {
  state.data = snapshot([issue('old/repo')])
  const rendered = render(view())
  state.data = snapshot([issue('new/repo')])
  rendered.rerender(view())
  expect(screen.queryByRole('link', { name: 'old/repo issue' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'new/repo issue' })).toBeNull()
  expect(screen.queryByText('No results in the last 7 days')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /updates — Show/ }))
  expect(screen.getByRole('link', { name: 'new/repo issue' })).toBeTruthy()
})

it('retains cached GitHub rows when the source explicitly returns them as stale', () => {
  state.data = snapshot([issue('old/repo')])
  const rendered = render(view())
  state.data = { ...state.data, sources: [{ ...state.data.sources[0]!, state: 'stale', reason: 'Could not read GitHub repository' }] }
  rendered.rerender(view())
  expect(screen.getByRole('link', { name: 'old/repo issue' })).toBeTruthy()
  expect(screen.getByText('GitHub needs attention')).toBeTruthy()
})


it('does not advertise shifted indices after removing an earlier GitHub row', () => {
  state.data = snapshot([issue('old/repo'), issue('kept/repo')])
  const rendered = render(view())
  state.data = snapshot([issue('kept/repo')])
  rendered.rerender(view())
  expect(screen.queryByRole('link', { name: 'old/repo issue' })).toBeNull()
  expect(screen.getByRole('link', { name: 'kept/repo issue' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /updates — Show/ })).toBeNull()
})

it('still advertises real reordering after removing a GitHub row', () => {
  state.data = snapshot([issue('old/repo'), issue('first/repo'), issue('second/repo')])
  const rendered = render(view())
  state.data = snapshot([issue('second/repo'), issue('first/repo')])
  rendered.rerender(view())
  fireEvent.click(screen.getByRole('button', { name: /updates — Show/ }))
  expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
    'second/repo issue', 'first/repo issue',
  ])
})
