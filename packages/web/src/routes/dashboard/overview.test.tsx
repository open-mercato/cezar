import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { DashboardEntryContext } from './state'
import { dashboardTransition, dashboardProjectTransition } from '@/api/dashboard-truth'
import { Overview } from './overview'
import type { DashboardOverview } from '@open-mercato/cezar-api-client'
const at = '2026-09-19T12:00:00.000Z'
const metrics = {
  running: 1,
  needsYou: 2,
  completed: 5,
  failed: 1,
  timedTasks: 4,
  medianCycleHours: 3,
}
const fixture: DashboardOverview = {
  snapshotId: 's',
  asOf: at,
  windowStart: '2026-09-13T00:00:00.000Z',
  period: '7d',
  coverage: { projects: [{ projectId: 'alpha', state: 'complete', omittedRuns: 0 }] },
  metrics,
  projects: [{ projectId: 'alpha', ...metrics }],
  page: { total: 5, nextOffset: null, rows: [] },
}
function Location() {
  return <output data-testid="overview-location">{useLocation().search}</output>
}
function setup(active = true, entry = '', initial = fixture) {
  const calls: URL[] = []
  let expired = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(url)
      if (expired && url.searchParams.has('snapshotId')) return new Response('{}', { status: 409 })
      if (url.pathname.endsWith('/projects'))
        return new Response(JSON.stringify({ projects: [], bootProject: 'alpha' }))
      return new Response(JSON.stringify({ ...initial, page: url.searchParams.get('offset') === '20' ? { ...initial.page, nextOffset: null } : initial.page }))
    }),
  )
  const client = createQueryClient()
  const view = (isActive: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Location />
        <DashboardEntryContext.Provider value={entry}><Overview active={isActive}>
          {(modules) => (
            <>
              {modules.overview}
              <p>Attention queue</p>
              {modules.portfolio}
            </>
          )}
        </Overview></DashboardEntryContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const result = render(view(active))
  return { calls, expire: () => { expired = true }, remount: (clearCache = false) => { result.rerender(<></>); if (clearCache) client.clear(); result.rerender(view(active)) }, rerender: (isActive: boolean) => result.rerender(view(isActive)) }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('shows outcome scope and opens the exact project/group snapshot', async () => {
  const { calls } = setup()
  await screen.findByRole('button', { name: 'Completed: 5' })
  expect(screen.getByText(/Median cycle time/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'alpha: Failed outcomes: 1' }))
  await screen.findByRole('dialog')
  await waitFor(() =>
    expect(
      calls.some(
        (url) =>
          url.searchParams.get('snapshotId') === 's' &&
          url.searchParams.get('projectId') === 'alpha' &&
          url.searchParams.get('group') === 'failed',
      ),
    ).toBe(true),
  )
})
it('does not query overview while another view is active', () => {
  const { calls } = setup(false)
  expect(screen.getByText('Attention queue')).toBeTruthy()
  expect(screen.queryByText('Workspace overview')).toBeNull()
  expect(calls.filter((url) => url.pathname.includes('/dashboard/overview'))).toHaveLength(0)
})
it('closes the outcome Sheet when the view goes inactive, so it never reopens on return', async () => {
  const { rerender } = setup()
  await screen.findByRole('button', { name: 'Completed: 5' })
  fireEvent.click(screen.getByRole('button', { name: 'alpha: Failed outcomes: 1' }))
  await screen.findByRole('dialog')
  rerender(false)
  rerender(true)
  await screen.findByRole('button', { name: 'Completed: 5' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('writes the reporting period into the URL', async () => {
  setup()
  await screen.findByRole('button', { name: 'Completed: 5' })
  fireEvent.change(screen.getByLabelText('Outcomes period'), { target: { value: '30d' } })
  expect(screen.getByTestId('overview-location').textContent).toBe('?period=30d')
})

it.each(['task', 'project'])('disables historical outcome navigation after %s removal', async (kind) => {
  const row = { projectId: `outcome-${kind}`, id: 'historical', title: 'Historical outcome', status: 'done' as const, archived: true, createdAt: at, finishedAt: at }
  setup(true, '', { ...fixture, page: { total: 1, nextOffset: null, rows: [row] } })
  fireEvent.click(await screen.findByRole('button', { name: 'Completed: 5' }))
  const link = await screen.findByRole('link', { name: row.title })
  act(() => kind === 'task' ? dashboardTransition(row.projectId, row.id) : dashboardProjectTransition(row.projectId, true))
  expect(link.getAttribute('aria-disabled')).toBe('true')
  expect(link.tabIndex).toBe(-1)
  expect(fireEvent.click(link)).toBe(false)
  expect(screen.getByText('Historical outcome')).toBeTruthy()
})
it('restores outcome selection, page, scroll and task focus for the same history entry', async () => {
  const initial = { ...fixture, page: { total: 21, nextOffset: 20, rows: [{ projectId: 'return-outcome', id: 'task', title: 'Return outcome', status: 'done' as const, archived: true, createdAt: at }] } }
  const { remount, calls } = setup(true, 'outcome-return', initial)
  fireEvent.click(await screen.findByRole('button', { name: 'Completed: 5' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true))
  const link = await screen.findByRole('link', { name: 'Return outcome' })
  link.focus()
  const sheet = screen.getByRole('dialog')
  sheet.scrollTop = 140
  fireEvent.scroll(sheet)
  remount(true)
  const restored = await screen.findByRole('dialog')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Return outcome' })))
  expect(restored.scrollTop).toBe(140)
  expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true)
  expect(calls.filter(url => url.searchParams.has('snapshotId')).at(-1)?.searchParams.get('offset')).toBe('20')
})

it('offers an explicit refresh when a restored outcome snapshot has expired', async () => {
  const { remount, expire, calls } = setup(true, 'outcome-expired-return')
  fireEvent.click(await screen.findByRole('button', { name: 'Completed: 5' }))
  await screen.findByText('No tasks in this group.')
  expire()
  remount(true)
  const refresh = await screen.findByRole('button', { name: 'Refresh overview' })
  const previous = calls.filter(url => url.pathname.includes('/dashboard/overview') && !url.searchParams.has('snapshotId')).length
  fireEvent.click(refresh)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(calls.filter(url => url.pathname.includes('/dashboard/overview') && !url.searchParams.has('snapshotId')).length).toBeGreaterThan(previous))
})

it('returns focus to the metric after closing a restored outcome Sheet', async () => {
  const { remount } = setup(true, 'outcome-trigger-return')
  const trigger = await screen.findByRole('button', { name: 'Completed: 5' })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('dialog')
  remount()
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Completed: 5' })))
})
it('waits for slow restored outcome rows before restoring their focus and scroll', async () => {
  const initial = { ...fixture, page: { total: 1, nextOffset: null, rows: [{ projectId: 'slow-outcome', id: 'slow', title: 'Slow outcome', status: 'done' as const, archived: true, createdAt: at }] } }
  const { remount } = setup(true, 'outcome-slow-return', initial)
  fireEvent.click(await screen.findByRole('button', { name: 'Completed: 5' }))
  const link = await screen.findByRole('link', { name: 'Slow outcome' })
  link.focus()
  screen.getByRole('dialog').scrollTop = 240
  fireEvent.scroll(screen.getByRole('dialog'))
  const original = vi.mocked(fetch).getMockImplementation()!
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]).includes('snapshotId=')) await waiting
    return original(...args)
  })
  remount(true)
  await screen.findByText('Loading tasks…')
  await act(() => new Promise(resolve => setTimeout(resolve, 1100)))
  await act(async () => { release(); await waiting })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Slow outcome' })))
  expect(screen.getByRole('dialog').scrollTop).toBe(240)
})


it('includes each displayed project metric value in its accessible name', async () => {
  setup()
  for (const name of ['alpha: Needs you: 2', 'alpha: Running now: 1', 'alpha: Completed: 5', 'alpha: Failed outcomes: 1']) {
    expect(await screen.findByRole('button', { name })).toBeTruthy()
  }
})

it('announces unavailable project metrics instead of their stored counts', async () => {
  setup(true, '', { ...fixture, coverage: { projects: [{ projectId: 'alpha', state: 'unavailable', omittedRuns: 0 }] } })
  for (const metric of ['Needs you', 'Running now', 'Completed', 'Failed outcomes']) {
    expect(await screen.findByRole('button', { name: `alpha: ${metric}: Unavailable` })).toHaveProperty('disabled', true)
  }
})

it.each([
  ['needs-you', 'Needs you', 'waiting', 'done', false, 'No longer needs you'],
  ['needs-you', 'Needs you', 'review', 'review', true, 'No longer needs you'],
  ['running', 'Running now', 'running', 'waiting', false, 'No longer running'],
  ['running', 'Running now', 'running', 'running', true, 'No longer running'],
] as const)('reconciles %s project rows after %s status %s becomes %s (archived %s)', async (group, label, status, nextStatus, archived, message) => {
  const row = { projectId: 'alpha', id: `live-${group}-${status}-${archived}`, title: 'Operational task', status, archived: false, createdAt: at }
  setup(true, '', { ...fixture, page: { total: 1, nextOffset: null, rows: [row] } })
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^alpha: ${label}`) }))
  const link = await screen.findByRole('link', { name: row.title })
  expect(link.getAttribute('aria-disabled')).toBeNull()
  act(() => dashboardTransition(row.projectId, { id: row.id, status: nextStatus, archived }))
  expect(link.getAttribute('aria-disabled')).toBe('true')
  expect(link.tabIndex).toBe(-1)
  expect(fireEvent.click(link)).toBe(false)
  expect(screen.getByText(new RegExp(message))).toBeTruthy()
  expect(screen.getByText(/1 tasks · Snapshot/)).toBeTruthy()
})

it('updates a waiting project row to review while keeping it actionable', async () => {
  const row = { projectId: 'alpha', id: 'live-review', title: 'Reviewable task', status: 'waiting' as const, archived: false, createdAt: at }
  setup(true, '', { ...fixture, page: { total: 1, nextOffset: null, rows: [row] } })
  fireEvent.click(await screen.findByRole('button', { name: /^alpha: Needs you/ }))
  const link = await screen.findByRole('link', { name: row.title })
  act(() => dashboardTransition(row.projectId, { id: row.id, status: 'review', archived: false }))
  expect(screen.getByText(/needs review/)).toBeTruthy()
  expect(link.getAttribute('aria-disabled')).toBeNull()
})

it.each([
  ['Completed', 'done'],
  ['Failed outcomes', 'failed'],
] as const)('preserves historical %s status, archive state and snapshot count after continuation', async (label, status) => {
  const row = { projectId: 'alpha', id: `history-${status}`, title: 'Historical continued task', status, archived: true, createdAt: at, finishedAt: at }
  setup(true, '', { ...fixture, page: { total: 1, nextOffset: null, rows: [row] } })
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^alpha: ${label}`) }))
  const link = await screen.findByRole('link', { name: row.title })
  act(() => dashboardTransition(row.projectId, { id: row.id, status: 'running', archived: false }))
  expect(screen.getByText(new RegExp(`${status} · Archived`))).toBeTruthy()
  expect(screen.getByText(/1 tasks · Snapshot/)).toBeTruthy()
  expect(link.getAttribute('aria-disabled')).toBeNull()
})
