import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlanUsageReport } from '@open-mercato/cezar-api-client'
import type { PlanUsageReportQuery } from '@/api/plan-usage'
import { planReport, planWindow } from './plan-limits.fixture'

const calls: PlanUsageReportQuery[] = []
let respond: (q: PlanUsageReportQuery) => PlanUsageReport | undefined = () => undefined
vi.mock('@/api/plan-usage', () => ({
  usePlanUsage: (q: PlanUsageReportQuery) => {
    calls.push(q)
    const data = respond(q)
    return { data, isPending: !data, isError: false, refetch: vi.fn() }
  },
}))
vi.mock('@/api/queries', () => ({
  useProjects: () => ({ data: { projects: [{ id: 'shop', name: 'Shop front' }] } }),
}))

const { PlanLimits } = await import('./plan-limits')

let search = ''
function Probe() {
  search = useLocation().search
  return null
}
function mount(url = '/dashboard?view=costs') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PlanLimits />
      <Probe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  calls.length = 0
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const codex = planWindow({
  id: 'codex:default|five-hour|x',
  account: { key: 'codex:default', provider: 'codex', accountId: 'default', label: 'Codex · default' },
  usedPercent: { first: 40, last: 63 },
  limitReachedAt: undefined,
  consumers: [],
  beforeTrackingPp: 40,
  outsideCezarPp: 23,
  unsplitPp: 0,
  leftPp: 37,
})

it('renders one bar per account with status, top consumers, legend and the not-listed note', () => {
  respond = () => planReport([planWindow(), codex])
  mount()
  const claude = screen.getByRole('button', { name: /Claude · default: limit reached · back at/ })
  expect(within(claude).getByText(/top: Drop waiting dot ≈ 53%/)).toBeTruthy()
  expect(claude.querySelectorAll('[data-segment]')).toHaveLength(4)
  expect(screen.getByRole('button', { name: /Codex · default: 63% used · resets/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Before tracking 40%.*Outside cezar 23%/ })).toBeTruthy()
  expect(within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem').map((li) => li.textContent))
    .toEqual(['Tasks', 'Managers', 'cezar internal', "Couldn't split", 'Not tracked', 'Before tracking', 'Outside cezar', 'Left'])
  expect(screen.getByText(/aren't listed: they don't report them/)).toBeTruthy()
  expect(calls[0]).toEqual({ kind: 'five-hour' })
})

it('switches to the weekly limit through the URL', () => {
  respond = () => planReport([planWindow()])
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Week' }))
  expect(search).toContain('planKind=weekly')
  expect(calls.at(-1)).toEqual({ kind: 'weekly' })
})

it('shows the empty and the switched-off states', () => {
  respond = () => planReport([])
  mount()
  expect(screen.getByText(/No plan-limit readings yet/)).toBeTruthy()
  cleanup()
  respond = () => planReport([], { tracking: { enabled: false, retentionDays: 90, accounts: {} } })
  mount()
  expect(screen.getByText(/tracking is off on this machine/)).toBeTruthy()
  expect(screen.getByText('CEZ_USAGE_LOG=0')).toBeTruthy()
})

it('opens the details panel from an account with chart, table, totals and hints', () => {
  const w = planWindow()
  respond = (q) => q.window === 'all'
    ? planReport([w])
    : planReport([w], q.account ? {
      hints: [{ id: 'h1', kind: 'retry-waste', text: '≈ 11% went to a first attempt that failed its test step.', windowId: w.id, evidence: {} }],
    } : {})
  mount()
  fireEvent.click(screen.getByRole('button', { name: /Claude · default: limit reached/ }))
  expect(search).toContain('planAccount=claude%3Adefault')
  const panel = screen.getByRole('dialog')
  expect(within(panel).getByRole('img', { name: /3 readings; last 100%; limit reached at/ })).toBeTruthy()
  expect(panel.querySelector('[data-limit-marker]')).toBeTruthy()
  const headers = within(panel).getAllByRole('columnheader').map((h) => h.textContent)
  expect(headers).toEqual(['Used by', 'Project', 'Share', 'Ran alone', 'Ran together with', 'Failed attempts'])
  const retry = panel.querySelector('[data-consumer="run:shop/r1"]') as HTMLElement
  expect(within(retry).getByRole('link', { name: 'Retry temp-repo removal' }).getAttribute('href')).toBe('/p/shop/tasks/r1')
  expect(retry.textContent).toContain('Shop front')
  expect(retry.textContent).toContain('≈ 25%')
  expect(retry.textContent).toContain('≈ 11%')
  const mgr = panel.querySelector('[data-consumer="mgr:m1"]') as HTMLElement
  expect(mgr.textContent).toContain('chat ≈ 4% · watch ≈ 0.6% · job ≈ 0.4%')
  expect(within(mgr).getByRole('link', { name: 'Release manager' }).getAttribute('href')).toBe('/manager/m1')
  expect([...panel.querySelectorAll('[data-remainder]')].map((r) => r.getAttribute('data-remainder'))).toEqual(['unsplit', 'outside'])
  expect(within(panel).getByText(/= what Claude reported for the account/)).toBeTruthy()
  expect(within(panel).getByRole('heading', { name: 'Worth a look' })).toBeTruthy()
  expect(within(panel).getByText(/first attempt that failed/)).toBeTruthy()
})

it('opens straight from URL params, querying the named window without a kind filter', () => {
  const w = planWindow({ id: 'claude:default|five-hour|old', current: false })
  respond = () => planReport([w])
  mount(`/dashboard?view=costs&planAccount=claude%3Adefault&planWindow=${encodeURIComponent(w.id)}`)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(calls).toContainEqual({ account: 'claude:default', window: w.id })
  expect(calls).toContainEqual({ account: 'claude:default', kind: 'five-hour', window: 'all' })
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(search).not.toContain('planAccount')
  expect(search).not.toContain('planWindow')
})

it('says so when the account has no reading in the chosen window', () => {
  respond = (q) => (q.account ? planReport([]) : planReport([planWindow()]))
  mount('/dashboard?view=costs&planAccount=claude%3Adefault&planWindow=previous')
  expect(within(screen.getByRole('dialog')).getByText('No readings for this account in this window.')).toBeTruthy()
})
