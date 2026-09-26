import { QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  act,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { DashboardEntryContext } from './state'
import { UsageCosts } from './costs'
import { collectDashboardExport } from './export'
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
function setup(visibility = { tokens: true, cost: true }, initial = fixture(), entry = '') {
  let data = initial
  let detailCost = true
  const history = new Map([[data.snapshotId, structuredClone(data)]])
  let error = false
  let expired = false
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(url)
      if (error) return new Response('{}', { status: 503 })
      if (expired && url.searchParams.has('snapshotId')) {
        expired = false
        return new Response('{}', { status: 409 })
      }
      const answer = structuredClone(
        history.get(url.searchParams.get('snapshotId') ?? '') ?? data,
      )
      if (url.searchParams.has('snapshotId') && !detailCost) answer.visibility.cost = false
      if (url.searchParams.get('offset') === '20')
        answer.tasks = {
          rows: [{ ...answer.tasks.rows[0]!, id: 'b', title: 'Second task' }],
          total: 21,
          nextOffset: null,
        }
      return new Response(JSON.stringify(answer))
    }),
  )
  const client = createQueryClient()
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardEntryContext.Provider value={entry}><UsageCosts visibility={visibility} /></DashboardEntryContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree)
  return {
    remount: (clearCache = false) => { view.rerender(<></>); if (clearCache) client.clear(); view.rerender(tree) },
    calls,
    client,
    hideDetailCost: () => {
      detailCost = false
    },
    ...view,
    setVisibility: (next: { tokens: boolean; cost: boolean }) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <UsageCosts visibility={next} />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    setData: (next: ReturnType<typeof fixture>) => {
      data = next
      history.set(next.snapshotId, structuredClone(next))
    },
    update: () => {
      data = fixture('s2')
      data.totals.costUsd!.value = 9
    },
    fail: () => {
      error = true
    },
    expire: () => {
      expired = true
    },
  }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('keeps tiny reported USD, measured zero and absent output distinct', async () => {
  setup()
  await screen.findAllByText('$0.000012')
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(screen.getByText('0 of 2 tasks report this metric')).toBeTruthy()
  expect(screen.getByText('0')).toBeTruthy()
})
it('does not request or advertise metrics when both capabilities are hidden', async () => {
  const { calls } = setup({ tokens: false, cost: false })
  expect(screen.getByText('Usage metrics are hidden by workspace settings')).toBeTruthy()
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(calls).toHaveLength(0)
})
it('honors each capability independently', async () => {
  setup({ tokens: true, cost: false })
  await screen.findAllByText('Input tokens')
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(screen.queryByText('$0.000012')).toBeNull()
})
it('opens project tasks, pages explicitly, and links to project task detail', async () => {
  const { calls } = setup()
  fireEvent.click(await screen.findByRole('button', { name: /shop/ }))
  const sheet = await screen.findByRole('dialog')
  expect(await within(sheet).findByRole('link', { name: 'Measured task' })).toHaveProperty(
    'pathname',
    '/p/shop/tasks/a',
  )
  fireEvent.click(await within(sheet).findByRole('button', { name: 'Show 20 more tasks' }))
  expect(await within(sheet).findByRole('link', { name: 'Second task' })).toBeTruthy()
  expect(
    calls.some(
      (url) =>
        url.searchParams.get('projectId') === 'shop' && url.searchParams.get('offset') === '20',
    ),
  ).toBe(true)
})
it('stages fresh totals until Show and marks retained values stale on errors', async () => {
  const { client, update, fail } = setup()
  await screen.findAllByText('$0.000012')
  update()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(screen.queryByText('$9.00')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Updates available — Show' }))
  expect(screen.getByText('$9.00')).toBeTruthy()
  fail()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(await screen.findByText(/Showing stale usage/)).toBeTruthy()
  expect(screen.getByText('$9.00')).toBeTruthy()
})
it('replaces expired detail snapshots with a fresh list', async () => {
  const { expire, calls } = setup()
  await screen.findAllByText('$0.000012')
  expire()
  fireEvent.click(screen.getByRole('button', { name: 'View tasks' }))
  expect(await screen.findByRole('link', { name: 'Measured task' })).toBeTruthy()
  await waitFor(() =>
    expect(calls.filter((url) => !url.searchParams.has('snapshotId')).length).toBeGreaterThan(
      1,
    ),
  )
})
it('removes hidden cost values immediately when the server policy changes', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  setData({ ...fixture('s2'), visibility: { tokens: true, cost: false } })
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await waitFor(() => expect(screen.queryAllByText('$0.000012')).toHaveLength(0))
  expect(screen.queryByRole('option', { name: 'Reported USD' })).toBeNull()
})
it('keeps current source warnings even when updated totals are staged', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('s2')
  next.coverage.projects[0]!.state = 'unavailable'
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(await screen.findByText('One project is unavailable.')).toBeTruthy()
})
it('disables a deleted task immediately before the next snapshot', async () => {
  const { dashboardTransition } = await import('@/api/dashboard-truth')
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const link = await screen.findByRole('link', { name: 'Measured task' })
  act(() => dashboardTransition('shop', 'a'))
  expect(link.getAttribute('aria-disabled')).toBe('true')
})
it('labels created-date cohorts honestly and sends period and metric choices', async () => {
  const { calls } = setup()
  await screen.findAllByText('$0.000012')
  fireEvent.change(screen.getByRole('combobox', { name: 'Tasks created' }), {
    target: { value: '7d' },
  })
  expect(
    await screen.findByText(
      'Lifetime usage of tasks created in this period — not spending during the period.',
    ),
  ).toBeTruthy()
  fireEvent.change(await screen.findByRole('combobox', { name: 'Sort by' }), {
    target: { value: 'output' },
  })
  await waitFor(() =>
    expect(
      calls.some(
        (url) =>
          url.searchParams.get('period') === '7d' && url.searchParams.get('sort') === 'output',
      ),
    ).toBe(true),
  )
})
it('distinguishes an empty retained cohort from tasks lacking reports', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('s3')
  next.totals.costUsd = { value: null, reportedTasks: 0 }
  next.totals.inputTokens = { value: null, reportedTasks: 0 }
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  fireEvent.click(await screen.findByRole('button', { name: 'Updates available — Show' }))
  expect(screen.getByText('No reports for the visible metrics in this cohort.')).toBeTruthy()
  expect(screen.queryByText('No retained tasks in this cohort.')).toBeNull()
})
it('does not announce an unchanged snapshot as an update', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  setData(fixture('same-content'))
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await act(() => new Promise((resolve) => setTimeout(resolve, 25)))
  expect(screen.queryByRole('button', { name: 'Updates available — Show' })).toBeNull()
})
it('pages the accepted task snapshot while a fresher candidate awaits Show', async () => {
  const { client, setData, calls } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const next = fixture('new-snapshot')
  next.tasks.rows[0]!.title = 'Renamed candidate'
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Show 20 more tasks' }))
  await within(sheet).findByRole('link', { name: 'Second task' })
  expect(within(sheet).queryByRole('link', { name: 'Renamed candidate' })).toBeNull()
  expect(
    calls
      .filter((url) => url.searchParams.get('offset') === '20')
      .at(-1)
      ?.searchParams.get('snapshotId'),
  ).toBe('s1')
})
it('applies a detail response policy immediately to previously accepted rows', async () => {
  const { client, hideDetailCost } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  expect(within(sheet).getAllByText('Reported USD: $0.00').length).toBe(20)
  hideDetailCost()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await waitFor(() =>
    expect(within(sheet).queryAllByText('Reported USD: $0.00')).toHaveLength(0),
  )
})
it('keeps an expired paged cohort visible until the fresh replacement is accepted', async () => {
  const { setData, expire } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const next = fixture('replacement')
  next.tasks.rows[0]!.title = 'Replacement cohort'
  setData(next)
  expire()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Show 20 more tasks' }))
  const show = await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  expect(within(sheet).queryByRole('link', { name: 'Replacement cohort' })).toBeNull()
  fireEvent.click(show)
  expect(await within(sheet).findByRole('link', { name: 'Replacement cohort' })).toBeTruthy()
})
it('masks conflicting cached health and fresh server policies until health reconciles', async () => {
  const { client, setData, setVisibility } = setup({ tokens: true, cost: false })
  await screen.findAllByText('Input tokens')
  const next = fixture('cost-only')
  next.visibility = { tokens: false, cost: true }
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(await screen.findByText('Usage metrics are hidden by workspace settings')).toBeTruthy()
  expect(screen.queryAllByText('$0.000012')).toHaveLength(0)
  setVisibility({ tokens: false, cost: true })
  expect((await screen.findAllByText('$0.000012')).length).toBeGreaterThan(0)
  expect(screen.queryByText('Usage metrics are hidden by workspace settings')).toBeNull()
  expect(screen.queryByText('Input tokens')).toBeNull()
})

it('excludes stale project amounts from export when the latest response hides all metrics', async () => {
  const { client, setData, container } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('hidden-export')
  next.visibility = { cost: false, tokens: false }
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await screen.findByText('Usage metrics are hidden by workspace settings')
  const rows = [...container.querySelectorAll<HTMLElement>('[data-dashboard-export]')].flatMap(
    (el) => JSON.parse(el.dataset.dashboardExport!),
  )
  expect(rows).toEqual([])
})

it('keeps accepted partial coverage in the display and export until recovery is accepted', async () => {
  const initial = fixture()
  initial.coverage.projects[0]!.state = 'partial'
  initial.coverage.projects[0]!.omittedRuns = 1
  const { client, setData, container } = setup(undefined, initial)
  await screen.findByText('One project has incomplete coverage.')
  setData(fixture('recovered'))
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  const show = await screen.findByRole('button', { name: 'Updates available — Show' })
  expect(screen.getByText('One project has incomplete coverage.')).toBeTruthy()
  container.firstElementChild!.setAttribute('data-dashboard-module', 'usage')
  expect(collectDashboardExport(container, at, 'test').modules[0]!.notes).toContain('incomplete coverage')
  fireEvent.click(show)
  expect(screen.queryByText('One project has incomplete coverage.')).toBeNull()
  expect(collectDashboardExport(container, at, 'test').modules[0]!.notes).not.toContain('incomplete coverage')
})
it('uses a compact empty state for complete zero-task usage without dropping export scope', async () => {
  const empty = fixture()
  empty.totals = { tasks: 0 }
  empty.projects = []
  empty.tasks = { rows: [], total: 0, nextOffset: null }
  const { container } = setup(undefined, empty)
  await screen.findByText('No retained tasks in this cohort.')
  expect(screen.queryByText('Unavailable')).toBeNull()
  expect(screen.queryByText('Top projects')).toBeNull()
  expect(screen.queryByRole('button', { name: 'View tasks' })).toBeNull()
  const rows = JSON.parse(container.querySelector<HTMLElement>('[data-dashboard-export]')!.dataset.dashboardExport!)
  expect(rows).toEqual([])
  expect(screen.getByText('Lifetime totals of retained tasks')).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Tasks created' })).toHaveProperty('value', 'all')
})
it('keeps zero readable tasks with partial coverage qualified as unavailable', async () => {
  const empty = fixture()
  empty.totals = { tasks: 0 }
  empty.projects = []
  empty.tasks = { rows: [], total: 0, nextOffset: null }
  empty.coverage.projects[0]!.state = 'unavailable'
  setup(undefined, empty)
  await screen.findByText('No retained tasks could be read from available sources.')
  expect(screen.getAllByText('Unavailable')).toHaveLength(3)
  expect(screen.queryByText('No retained tasks in this cohort.')).toBeNull()
})


it.each(['View tasks', 'shop'])('restores focus to the %s trigger after closing usage tasks', async (name) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const { client } = setup()
  const trigger = await screen.findByRole('button', { name: name === 'shop' ? /shop/ : name })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('dialog')
  await screen.findByText('Measured task')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  client.clear()
})

it.each(['View tasks', 'project'])('opens the displayed cohort from %s while an update awaits acceptance', async (opener) => {
  const { client, setData, calls } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('new-snapshot')
  next.tasks.rows[0]!.title = 'New candidate task'
  next.tasks.rows[0]!.costUsd = 50
  next.totals.costUsd!.value = 50
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await screen.findByRole('button', { name: 'Updates available — Show' })
  fireEvent.click(screen.getByRole('button', { name: opener === 'project' ? /shop/ : 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await waitFor(() => expect(calls.some(url => url.searchParams.has('snapshotId'))).toBe(true))
  expect(calls.filter(url => url.searchParams.has('snapshotId')).at(-1)?.searchParams.get('snapshotId')).toBe('s1')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  expect(within(sheet).queryByRole('link', { name: 'New candidate task' })).toBeNull()
})

it('qualifies nonempty partial task details recovered after snapshot expiry', async () => {
  const { setData, expire } = setup()
  await screen.findAllByText('$0.000012')
  const partial = fixture('recovered-partial')
  partial.coverage.projects[0] = {
    projectId: 'shop', state: 'partial', omittedRuns: 3,
    reason: 'Some tasks could not be read',
  }
  setData(partial)
  expire()
  fireEvent.click(screen.getByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  expect(within(sheet).getByText('20 of 21 retained tasks')).toBeTruthy()
  expect(within(sheet).getByText('Coverage of displayed tasks:')).toBeTruthy()
  expect(within(sheet).getByText(/Some tasks could not be read.*3 omitted tasks/)).toBeTruthy()
})

it('shows worsening task-source coverage immediately and retains accepted warnings until Show', async () => {
  const { client, setData } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const partial = fixture('partial')
  partial.coverage.projects[0] = {
    projectId: 'shop', state: 'partial', omittedRuns: 3,
    reason: 'Some tasks could not be read',
  }
  setData(partial)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  expect(within(sheet).getByText('Current source availability:')).toBeTruthy()
  expect(within(sheet).queryByText('Coverage of displayed tasks:')).toBeNull()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Updates available — Show' }))
  expect(within(sheet).getByText('Coverage of displayed tasks:')).toBeTruthy()
  expect(within(sheet).queryByText('Current source availability:')).toBeNull()
  setData(fixture('recovered'))
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  expect(within(sheet).getByText(/3 omitted tasks/)).toBeTruthy()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Updates available — Show' }))
  expect(within(sheet).queryByText(/3 omitted tasks/)).toBeNull()
  expect(within(sheet).queryByText('Coverage of displayed tasks:')).toBeNull()
})

it('sorts the accepted task cohort without accepting a pending update', async () => {
  const { client, setData, calls } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const next = fixture('candidate')
  next.tasks.rows[0]!.title = 'Unaccepted candidate'
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  const sort = within(sheet).getByRole('combobox', { name: 'Sort by' })
  sort.focus()
  fireEvent.change(sort, { target: { value: 'input' } })
  await waitFor(() => expect(calls.filter(url => url.searchParams.get('sort') === 'input').at(-1)?.searchParams.get('snapshotId')).toBe('s1'))
  expect(within(sheet).queryByRole('link', { name: 'Unaccepted candidate' })).toBeNull()
  expect(within(sheet).getByRole('link', { name: 'Measured task' })).toBeTruthy()
  expect(document.activeElement).toBe(sort)
})

it('keeps keyboard focus when changing the usage period and ranking metric', async () => {
  setup()
  const period = await screen.findByRole('combobox', { name: 'Tasks created' })
  period.focus()
  fireEvent.change(period, { target: { value: '7d' } })
  expect(document.activeElement).toBe(period)
  const sort = await screen.findByRole('combobox', { name: 'Sort by' })
  sort.focus()
  fireEvent.change(sort, { target: { value: 'input' } })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveProperty('value', 'input'))
  expect(document.activeElement).toBe(sort)
})

it('keeps expired task rows until explicitly accepting the replacement after sorting', async () => {
  const { setData, expire } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const next = fixture('replacement-sort')
  next.tasks.rows[0]!.title = 'Replacement after sorting'
  setData(next)
  expire()
  fireEvent.change(within(sheet).getByRole('combobox', { name: 'Sort by' }), { target: { value: 'input' } })
  const show = await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  expect(within(sheet).queryByRole('link', { name: 'Replacement after sorting' })).toBeNull()
  expect(within(sheet).getByRole('link', { name: 'Measured task' })).toBeTruthy()
  fireEvent.click(show)
  expect(await within(sheet).findByRole('link', { name: 'Replacement after sorting' })).toBeTruthy()
})

it('loads a new cohort when changing period without retaining the prior totals', async () => {
  const { setData } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('seven-days')
  next.period = '7d'
  next.totals.costUsd!.value = 17
  next.projects = []
  setData(next)
  fireEvent.change(screen.getByRole('combobox', { name: 'Tasks created' }), { target: { value: '7d' } })
  expect(await screen.findByText('$17.00')).toBeTruthy()
  expect(screen.queryAllByText('$0.000012')).toHaveLength(0)
})

it('keeps the last server visibility policy while a new ranking request is pending', async () => {
  const { client, setData, container } = setup()
  await screen.findAllByText('$0.000012')
  setData({ ...fixture('hidden-cost'), visibility: { tokens: true, cost: false } })
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await waitFor(() => expect(screen.queryAllByText('$0.000012')).toHaveLength(0))
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
  fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'output' } })
  expect(screen.queryAllByText('$0.000012')).toHaveLength(0)
  expect(container.querySelector('[data-dashboard-export]')?.getAttribute('data-dashboard-export')).not.toContain('costUsd')
})

it('restores usage project selection, sort, page, scroll and focus for a history entry', async () => {
  const { remount } = setup(undefined, fixture(), 'usage-return')
  fireEvent.click(await screen.findByRole('button', { name: /shop/ }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  fireEvent.change(within(sheet).getByRole('combobox', { name: 'Sort by' }), { target: { value: 'input' } })
  await waitFor(() => expect(within(sheet).getByRole('button', { name: 'Show 20 more tasks' })).toHaveProperty('disabled', false))
  fireEvent.click(within(sheet).getByRole('button', { name: 'Show 20 more tasks' }))
  const link = await within(sheet).findByRole('link', { name: 'Second task' })
  link.focus()
  sheet.scrollTop = 170
  fireEvent.scroll(sheet)
  remount()
  const restored = await screen.findByRole('dialog')
  expect(within(restored).getByText('shop tasks')).toBeTruthy()
  expect(within(restored).getByRole('combobox', { name: 'Sort by' })).toHaveProperty('value', 'input')
  await waitFor(() => expect(document.activeElement).toBe(within(restored).getByRole('link', { name: 'Second task' })))
  expect(restored.scrollTop).toBe(170)
})

it('starts a new usage selection on page one after explicitly closing its restored Sheet', async () => {
  const { remount } = setup(undefined, fixture(), 'usage-close-reset')
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Show 20 more tasks' }))
  await screen.findByRole('link', { name: 'Second task' })
  remount()
  await screen.findByRole('link', { name: 'Second task' })
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  await screen.findByRole('link', { name: 'Measured task' })
  expect(screen.queryByRole('link', { name: 'Second task' })).toBeNull()
})

it('keeps restored usage rows until accepting a replacement after snapshot expiry', async () => {
  const { remount, setData, expire } = setup(undefined, fixture(), 'usage-expired-return')
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  await screen.findByRole('link', { name: 'Measured task' })
  const replacement = fixture('return-replacement')
  replacement.tasks.rows[0]!.title = 'New return cohort'
  setData(replacement)
  expire()
  remount(true)
  const sheet = await screen.findByRole('dialog')
  const show = await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  expect(within(sheet).getByRole('link', { name: 'Measured task' })).toBeTruthy()
  expect(within(sheet).queryByRole('link', { name: 'New return cohort' })).toBeNull()
  fireEvent.click(show)
  expect(await within(sheet).findByRole('link', { name: 'New return cohort' })).toBeTruthy()
})
it('does not restore revoked detail metric values from history while refetching', async () => {
  const { remount, client, hideDetailCost } = setup(undefined, fixture(), 'usage-policy-return')
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  await screen.findByRole('link', { name: 'Measured task' })
  hideDetailCost()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await waitFor(() => expect(screen.queryAllByText('Reported USD: $0.00')).toHaveLength(0))
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
  remount(true)
  await screen.findByRole('dialog')
  expect(screen.queryAllByText('Reported USD: $0.00')).toHaveLength(0)
})

it.each(['View tasks', 'shop'])('returns focus to the %s trigger after closing a restored usage Sheet', async name => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const { remount } = setup(undefined, fixture(), `usage-trigger-return-${name}`)
  const trigger = await screen.findByRole('button', { name: name === 'shop' ? /shop/ : name })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('link', { name: 'Measured task' })
  remount()
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: name === 'shop' ? /shop/ : name })))
})
