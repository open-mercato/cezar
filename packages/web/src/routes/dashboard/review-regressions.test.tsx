import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { Overview } from '@/routes/dashboard/overview'
import { DashboardRoute } from '@/routes/dashboard'
const at = '2026-09-19T12:00:00.000Z'
const coverage = { projects: [{ projectId: 'alpha', state: 'complete', omittedRuns: 0 }] }
const fixture = {
  snapshotId: 's',
  asOf: at,
  windowStart: at,
  period: '7d',
  coverage,
  metrics: {
    running: 0,
    needsYou: 0,
    completed: 40,
    failed: 0,
    timedTasks: 0,
    medianCycleHours: null,
  },
  projects: [],
  page: { rows: [], total: 40, nextOffset: 20 },
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('keeps outcome navigation mounted and focuses the loaded page', async () => {
  let resolvePage!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = new URL(String(input), 'http://localhost')
      if (u.pathname.endsWith('/projects'))
        return Response.json({ projects: [], bootProject: 'alpha' })
      if (u.searchParams.get('offset') === '20')
        return new Promise<Response>((resolve) => {
          resolvePage = resolve
        })
      return Response.json(fixture)
    }),
  )
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Overview active>
          {(m) => (
            <>
              {m.overview}
              {m.portfolio}
            </>
          )}
        </Overview>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Completed: 40' }))
  const next = await screen.findByRole('button', { name: 'Next' })
  await waitFor(() => expect(next).toHaveProperty('disabled', false))
  next.focus()
  expect(document.activeElement).toBe(next)
  fireEvent.click(next)
  expect(screen.getByRole('button', { name: 'Next' })).toBe(next)
  await act(async () =>
    resolvePage(
      Response.json({ ...fixture, page: { rows: [], total: 40, nextOffset: null } }),
    ),
  )
  await screen.findByRole('button', { name: 'Previous' })
  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain('40 tasks · Snapshot from'),
  )
  client.clear()
})
function setupRoute(error = false, partialOperations = false, partialCosts = false) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = new URL(String(input), 'http://localhost')
      calls.push(u.pathname)
      if (u.pathname.endsWith('/ui-state'))
        return Response.json({
          dashboard: {
            tiles: {
              recent: true,
              needsYou: false,
              fleet: false,
              automations: false,
              usage: false,
              trends: true,
            },
          },
        })
      if (u.pathname.endsWith('/projects'))
        return Response.json({ projects: [], bootProject: 'alpha' })
      if (u.pathname.endsWith('/overview')) return Response.json(fixture)
      if (u.pathname.endsWith('/feed'))
        return Response.json({
          asOf: at,
          windowStart: at,
          filter: u.searchParams.get('filter'),
          rows: [],
          sources: [{ key: 'github:abc:pr', state: 'ready', truncated: false }],
          coverage,
          truncated: false,
        })
      if (u.pathname.endsWith('/dashboard'))
        return error
          ? Response.json({ error: 'Offline' }, { status: 503 })
          : Response.json({
              snapshotId: 's',
              asOf: at,
              expiresAt: at,
              coverage: partialOperations
                ? { projects: [{ projectId: 'operations', state: 'partial', omittedRuns: 7 }] }
                : coverage,
              counts: {
                running: 0,
                monitoring: 0,
                questions: 0,
                reviews: 0,
                queued: 0,
                scheduled: 0,
              },
              questions: { rows: [], total: 0, nextOffset: null },
              reviews: { rows: [], total: 0, nextOffset: null },
            })
      if (u.pathname.endsWith('/costs'))
        return Response.json({
          snapshotId: 'costs',
          asOf: at,
          expiresAt: at,
          scope: 'retained-task-lifetime',
          period: '7d',
          windowStart: at,
          sort: 'cost',
          visibility: { tokens: true, cost: true },
          coverage: partialCosts
            ? { projects: [{ projectId: 'costs', state: 'partial', omittedRuns: 2 }] }
            : coverage,
          invalidDateTasks: 0,
          totals: { tasks: 0 },
          projects: [],
          tasks: { rows: [], total: 0, nextOffset: null },
          series: [],
        })
      return Response.json({})
    }),
  )
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { client, calls }
}
it('feed filter retains keyboard focus', async () => {
  const { client } = setupRoute()
  const tasks = await screen.findByRole('button', { name: 'Tasks' })
  tasks.focus()
  fireEvent.click(tasks)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Tasks' }).getAttribute('aria-pressed'),
    ).toBe('true'),
  )
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tasks' }))
  client.clear()
})
it('hides irrelevant operational errors on healthy Costs', async () => {
  const { client } = setupRoute(true)
  await screen.findByText(/Could not refresh dashboard/)
  fireEvent.click(screen.getByRole('link', { name: 'Usage & cost' }))
  await screen.findByText('No retained tasks in this period yet.')
  expect(screen.queryByText(/Could not refresh dashboard/)).toBeNull()
  client.clear()
})

it.each([false, true])('scopes operational coverage to demand while retaining cost coverage (%s)', async (partialCosts) => {
  const { client } = setupRoute(false, true, partialCosts)
  await screen.findByText(/0 tasks need you in the available data/)
  fireEvent.click(screen.getByRole('link', { name: 'Usage & cost' }))
  if (partialCosts) await screen.findByText(/One project has incomplete coverage/)
  else await screen.findByText('No retained tasks in this period yet.')
  expect(screen.queryByText(/tasks need you in the available data/)).toBeNull()
  if (partialCosts) expect(screen.getByText(/One project has incomplete coverage/)).toBeTruthy()
  else expect(screen.queryByText(/One project has incomplete coverage/)).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: 'Overview' }))
  expect(await screen.findByText(/0 tasks need you in the available data/)).toBeTruthy()
  client.clear()
})
