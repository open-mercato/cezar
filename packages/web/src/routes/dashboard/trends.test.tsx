import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { Trends } from './trends'
import type { DashboardCosts, DashboardCostSeriesPoint } from '@open-mercato/cezar-api-client'
const at = '2026-09-19T00:00:00.000Z'
function point(
  date: string,
  extra: Partial<DashboardCostSeriesPoint> = {},
): DashboardCostSeriesPoint {
  return {
    date,
    tasks: 0,
    completed: 0,
    avgCycleHours: null,
    medianCycleHours: null,
    ...extra,
  }
}
function fixture(period: DashboardCosts['period'] = '7d'): DashboardCosts {
  const series =
    period === 'all'
      ? []
      : Array.from({ length: period === '7d' ? 7 : 30 }, (_, i) =>
          point(`2026-09-${String(13 + i).padStart(2, '0')}`),
        )
  if (series.length) {
    series[series.length - 1] = point(series.at(-1)!.date, {
      tasks: 2,
      completed: 1,
      avgCycleHours: 2,
      medianCycleHours: 2,
      costUsd: { value: 3, reportedTasks: 2 },
      inputTokens: { value: 10, reportedTasks: 1 },
      outputTokens: { value: 20, reportedTasks: 1 },
    })
  }
  return {
    snapshotId: 's1',
    asOf: at,
    expiresAt: '2026-09-19T00:01:00.000Z',
    scope: 'retained-task-lifetime',
    period,
    windowStart: period === 'all' ? null : at,
    sort: 'cost',
    visibility: { tokens: true, cost: true },
    coverage: { projects: [{ projectId: 'shop', state: 'complete', omittedRuns: 0 }] },
    invalidDateTasks: 0,
    totals: { tasks: 2, costUsd: { value: 3, reportedTasks: 2 } },
    series,
    projects: [],
    tasks: { rows: [], total: 0, nextOffset: null },
  }
}
function setup(visibility = { tokens: true, cost: true }, initial?: DashboardCosts) {
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(url)
      const period = (url.searchParams.get('period') as DashboardCosts['period']) ?? '7d'
      return new Response(JSON.stringify(initial ?? fixture(period)))
    }),
  )
  const client = createQueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Trends visibility={visibility} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { calls, ...view }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('renders per-metric trend charts and the throughput summary', async () => {
  setup()
  expect((await screen.findAllByText('Reported USD')).length).toBeGreaterThan(0)
  expect(screen.getAllByText('Input tokens').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Output tokens').length).toBeGreaterThan(0)
  expect(screen.getByText('Completed tasks')).toBeTruthy()
  expect(screen.getByText(/1 done · avg cycle 2\.0h/)).toBeTruthy()
})
it('hides gated metrics but still shows throughput', async () => {
  setup({ tokens: false, cost: false })
  expect(await screen.findByText('Completed tasks')).toBeTruthy()
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(screen.queryByText('Input tokens')).toBeNull()
})
it('renders daily values for the screen disclosure and PDF report', async () => {
  setup()
  await screen.findByText('Completed tasks')
  const table = document.querySelector('table')
  expect(table).toBeTruthy()
  expect(table?.className).not.toContain('hidden')
  expect(table?.textContent).toContain('$3.00')
  expect(table?.textContent).toContain('10')
  expect(table?.textContent).toContain('20')
})
it('requests only 7d/30d and refetches on period change', async () => {
  const { calls } = setup()
  await screen.findByText('Completed tasks')
  expect(calls.every((u) => u.searchParams.get('period') !== 'all')).toBe(true)
  fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30d' } })
  await waitFor(() =>
    expect(calls.some((u) => u.searchParams.get('period') === '30d')).toBe(true),
  )
})

it('keeps unknown daily amounts distinct from zero and names chart controls', async () => {
  setup()
  await screen.findByText('Completed tasks')
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
  const bars = document.querySelectorAll('button[data-export-keep]')
  expect(bars.length).toBeGreaterThan(0)
  for (const bar of bars) expect(bar.getAttribute('aria-label')).toBeTruthy()
  expect(document.querySelector('.print\\:hidden')).toBeNull()
})

// Match the project date convention in both Polish and English browser locales.
it.each([
  ['pl-PL', '19 wrz', '13 wrz'],
  ['en-US', 'Sep 19', 'Sep 13'],
])('uses browser locale %s across daily tables, chart axes and tooltips', async (browserLocale, lastDay, firstDay) => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  const original = Date.prototype.toLocaleDateString
  const locale = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (
    this: Date, locales, options,
  ) {
    return original.call(this, locales ?? browserLocale, options)
  })
  try {
    setup()
    await screen.findByText('Completed tasks')
    const table = screen.getByRole('table')
    expect(table.textContent).toContain(lastDay)
    expect(screen.getAllByText(firstDay).length).toBeGreaterThan(1)
    fireEvent.focus(screen.getByRole('button', { name: /^2026-09-19: 1 completed tasks/ }))
    expect((await screen.findAllByText(`${lastDay} · 1 completed`)).length).toBeGreaterThan(0)
  } finally {
    locale.mockRestore()
  }
})

it('replaces empty daily charts with a compact state without exporting hidden daily metrics', async () => {
  const empty = fixture()
  empty.totals = { tasks: 0 }
  empty.series = empty.series.map(({ date }) => point(date))
  const { container } = setup(undefined, empty)
  await screen.findByText('No retained tasks in this period yet.')
  expect(screen.queryByText('Completed tasks')).toBeNull()
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  const rows = JSON.parse(container.querySelector<HTMLElement>('[data-dashboard-export]')!.dataset.dashboardExport!)
  expect(rows).toEqual([])
  expect(screen.getByRole('combobox', { name: 'Period' })).toHaveProperty('value', '7d')
})
it('shows throughput for completed tasks created before the selected period', async () => {
  const older = fixture()
  older.totals = { tasks: 0 }
  older.series = older.series.map(({ date, completed }) => point(date, { completed }))
  setup(undefined, older)
  await screen.findByText('Completed tasks')
  expect(screen.queryByText('No retained tasks in this period yet.')).toBeNull()
})
it('does not present partial zero-task trends as a complete empty period', async () => {
  const partial = fixture()
  partial.totals = { tasks: 0 }
  partial.series = partial.series.map(({ date }) => point(date))
  partial.coverage.projects[0]!.state = 'unavailable'
  setup(undefined, partial)
  await screen.findByText('One project is unavailable.')
  expect(screen.queryByText('No retained tasks in this period yet.')).toBeNull()
  expect(screen.getByText('Completed tasks')).toBeTruthy()
})
