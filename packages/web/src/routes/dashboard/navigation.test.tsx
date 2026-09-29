import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router'
import { afterEach, it, expect, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { DashboardRoute } from './index'
import { readEntry, saveEntry } from './state'
import type { DashboardCosts } from '@open-mercato/cezar-api-client'
const at = '2026-09-19T00:00:00.000Z'
function fixture(id = 's1'): DashboardCosts {
  return {
    snapshotId: id,
    asOf: at,
    expiresAt: '2026-09-19T00:01:00.000Z',
    scope: 'retained-task-lifetime',
    period: 'all',
    windowStart: null,
    sort: 'cost',
    visibility: { tokens: true, cost: true },
    coverage: { projects: [{ projectId: 'shop', state: 'complete', omittedRuns: 0 }] },
    invalidDateTasks: 0,
    totals: {
      tasks: 2,
      costUsd: { value: 0.000012, reportedTasks: 1 },
      inputTokens: { value: 0, reportedTasks: 1 },
      outputTokens: { value: null, reportedTasks: 0 },
    },
    series: [],
    projects: [{ projectId: 'shop', tasks: 2, costUsd: { value: 0.000012, reportedTasks: 1 } }],
    tasks: {
      rows: Array.from({ length: 20 }, (_, i) => ({
        projectId: 'shop',
        id: i === 0 ? 'a' : `task-${i}`,
        title: i === 0 ? 'Measured task' : `Task ${i}`,
        status: 'done',
        archived: true,
        subtask: true,
        createdAt: at,
        costUsd: 0,
      })),
      total: 21,
      nextOffset: 20,
    },
  }
}

let sequence = 0
function Back() {
  const go = useNavigate()
  return <button onClick={() => go(-1)}>Back</button>
}
function Location() {
  const go = useNavigate()
  return <><output data-testid="location">{useLocation().search}</output><button onClick={() => go(-1)}>History back</button></>
}
function setup(view = 'costs', restoredScroll?: number) {
  const entry = `navigation-${++sequence}`
  if (restoredScroll !== undefined)
    saveEntry(entry, { questions: 0, reviews: 0, feed: 6, scroll: restoredScroll })
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/ui-state')) return Response.json({ dashboard: { tiles: {
      trends: false, fleet: false, needsYou: false, recent: false, automations: false,
    } } })
    if (url.includes('/dashboard/costs')) return Response.json(fixture())
    if (url.includes('/dashboard/overview')) return Response.json({
      snapshotId: 'overview', asOf: at, windowStart: at, period: '7d',
      coverage: fixture().coverage,
      metrics: { running: 0, needsYou: 0, completed: 0, failed: 0, timedTasks: 0, medianCycleHours: null },
      projects: [], page: { rows: [], total: 0, nextOffset: null },
    })
    if (url.includes('/projects')) return Response.json({ projects: [], bootProject: 'shop' })
    return Response.json({})
  }))
  const client = createQueryClient()
  render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[{ pathname: '/dashboard', search: `?view=${view}&feed=github`, key: entry }]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardRoute />} />
        <Route path="*" element={<Back />} />
      </Routes>
      <Location />
    </MemoryRouter>
  </QueryClientProvider>)
  return { calls, client, entry }
}
function dashboard() {
  return document.querySelector<HTMLElement>('[data-route="dashboard"]')!
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('restores direct Costs Back scroll and filter replacements without requesting hidden operational data', async () => {
  const { calls, client, entry } = setup()
  await screen.findByRole('button', { name: 'View tasks' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Tasks created' }), { target: { value: '7d' } })
  dashboard().scrollTop = 321
  fireEvent.scroll(dashboard())
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  fireEvent.click(await screen.findByRole('link', { name: 'Measured task' }))
  expect(readEntry(entry)?.scroll).toBe(321)
  fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
  await screen.findByRole('dialog')
  await waitFor(() => expect(dashboard().scrollTop).toBe(321))
  expect(screen.getByTestId('location').textContent).toContain('usagePeriod=7d')
  expect(screen.getByTestId('location').textContent).toContain('feed=github')
  expect(calls.filter(url => url.endsWith('/dashboard'))).toHaveLength(0)
  await screen.findByRole('dialog')
  fireEvent.click(await screen.findByRole('link', { name: 'Measured task' }))
  expect(readEntry(entry)?.scroll).toBe(321)
  client.clear()
})
it.each(['costs', 'overview'])('retries %s scroll restoration when async content initially clamps the scroll position', async view => {
  const { calls, client } = setup(view, 450)
  const root = dashboard()
  let position = 0
  let maximum = 20
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (value: number) => { position = Math.min(value, maximum) },
  })
  if (view === 'costs') await screen.findByRole('button', { name: 'View tasks' })
  else await screen.findByRole('button', { name: 'Completed: 0' })
  await waitFor(() => expect(root.scrollTop).toBe(20))
  maximum = 600
  // An asynchronously populated module grows after the first animation frame.
  await act(async () => { root.appendChild(document.createElement('div')) })
  await waitFor(() => expect(root.scrollTop).toBe(450))
  expect(calls.filter(url => url.endsWith('/dashboard'))).toHaveLength(0)
  client.clear()
})

it('lets a user scroll take over while waiting for async layout', async () => {
  const { client } = setup('costs', 450)
  const root = dashboard()
  let position = 0
  let maximum = 20
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (value: number) => { position = Math.min(value, maximum) },
  })
  await waitFor(() => expect(root.scrollTop).toBe(20))
  fireEvent.wheel(root)
  maximum = 600
  root.scrollTop = 100
  await act(async () => { root.appendChild(document.createElement('div')) })
  expect(root.scrollTop).toBe(100)
  client.clear()
})
it('retries restoration after layout grows without a DOM mutation', async () => {
  let notifyResize: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback }
    observe() {}
    disconnect() {}
  })
  const { client } = setup('costs', 450)
  const root = dashboard()
  let position = 0
  let maximum = 20
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (value: number) => { position = Math.min(value, maximum) },
  })
  await screen.findByRole('button', { name: 'View tasks' })
  await waitFor(() => expect(root.scrollTop).toBe(20))
  maximum = 600
  await act(async () => { notifyResize!() })
  expect(root.scrollTop).toBe(450)
  client.clear()
})

it('restores separate scroll positions across Overview and Usage history entries', async () => {
  const { client, entry } = setup('overview')
  await screen.findByRole('button', { name: 'Completed: 0' })
  dashboard().scrollTop = 100
  fireEvent.scroll(dashboard())
  fireEvent.click(screen.getByRole('link', { name: /^Usage & cost$/ }))
  await screen.findByRole('button', { name: 'View tasks' })
  dashboard().scrollTop = 321
  fireEvent.scroll(dashboard())
  fireEvent.click(screen.getByRole('button', { name: 'History back' }))
  await screen.findByRole('button', { name: 'Completed: 0' })
  await waitFor(() => expect(dashboard().scrollTop).toBe(100))
  expect(readEntry(entry)?.scroll).toBe(100)
  client.clear()
})
