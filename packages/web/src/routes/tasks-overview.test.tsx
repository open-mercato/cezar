import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalEventsProvider } from '@/api/global-events'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ProcessUsage, RunRecord } from '@open-mercato/cezar-api-client'
import { ListViewProvider } from '@/components/list-view'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { TasksOverview, TasksOverviewRoute } from '@/routes/tasks-overview'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: ago(60_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** Where the router currently is — the probe row-click and don't-hijack assertions read. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

function renderOverview(props: Partial<ComponentProps<typeof TasksOverview>> = {}) {
  const onViewChange = props.onViewChange ?? vi.fn()
  const onArchiveFinished = props.onArchiveFinished ?? vi.fn()
  const onMarkAllRead = props.onMarkAllRead ?? vi.fn()
  const onRename = props.onRename ?? vi.fn()
  const utils = render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <Routes>
        <Route
          path="/"
          element={
            <TasksOverview
              runs={[]}
              view="active"
              now={NOW}
              expandedColumns={{ branch: true }}
              {...props}
              onViewChange={onViewChange}
              onArchiveFinished={onArchiveFinished}
              onMarkAllRead={onMarkAllRead}
              onRename={onRename}
            />
          }
        />
        {/* Row clicks land here; the probe above says where we ended up. */}
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  )
  return { ...utils, onViewChange, onArchiveFinished, onMarkAllRead, onRename }
}

const location = () => screen.getByTestId('location').textContent
const tableRow = (id: string) => document.querySelector(`[data-slot="task-table-row"][data-run-id="${id}"]`)
const card = (id: string) => document.querySelector(`[data-slot="task-card"][data-run-id="${id}"]`)
const cellsOf = (id: string): string[] => [...(tableRow(id)?.querySelectorAll('td') ?? [])].map((td) => td.textContent ?? '')

afterEach(cleanup)

describe('TasksOverview — the table', () => {
  it('starts with Branch folded while keeping fixed columns and an in-place restore control', () => {
    const onToggleColumn = vi.fn()
    renderOverview({
      expandedColumns: {},
      onToggleColumn,
      runs: [run({ id: 'fresh', branch: 'feat/fresh-workspace' })],
    })

    const branchHeader = document.querySelector<HTMLElement>('th[data-column-id="branch"]')
    expect(branchHeader?.getAttribute('data-folded')).toBe('true')
    const restore = within(branchHeader as HTMLElement).getByRole('button', {
      name: 'Expand Branch column',
      pressed: false,
    })
    expect(restore.tagName).toBe('BUTTON')
    fireEvent.click(restore)
    expect(onToggleColumn).toHaveBeenCalledWith('branch')
    expect(location()).toBe('/')

    expect(tableRow('fresh')?.querySelector('td[data-column-id="branch"]')?.textContent).toBe('')
    expect(tableRow('fresh')?.querySelector('td[data-column-id="branch"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(document.querySelector('col[data-column-id="branch"]')?.getAttribute('style')).toContain('42px')
    expect(document.querySelector('th[data-column-id="status"] button')).toBeNull()
    expect(document.querySelector('th[data-column-id="task"] button')).toBeNull()
    expect(document.querySelector('[data-slot="tasks-table"] table')?.className).not.toContain('min-w-[1040px]')
  })

  it('disables optional headers while workspace column state is loading', () => {
    const onToggleColumn = vi.fn()
    renderOverview({
      columnsPending: true,
      onToggleColumn,
      runs: [run({ id: 'pending-columns' })],
    })

    const branch = screen.getByRole('button', { name: 'Fold Branch column', pressed: true })
    expect((branch as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(branch)
    expect(onToggleColumn).not.toHaveBeenCalled()
  })

  it('renders one row per run, in the sidebar order (needs-you first, then recency)', () => {
    renderOverview({
      runs: [
        run({ id: 'done1', title: 'Old done', createdAt: ago(3 * 3_600_000) }),
        run({ id: 'rev1', title: 'Needs review', status: 'review' }),
        run({ id: 'run1', title: 'Running now', status: 'running' }),
      ],
    })
    const ids = [...document.querySelectorAll('[data-slot="task-table-row"]')].map((el) =>
      el.getAttribute('data-run-id')
    )
    expect(ids).toEqual(['rev1', 'run1', 'done1'])
  })

  it('says the run status through the attention pill', () => {
    renderOverview({
      runs: [
        run({ id: 'w', status: 'waiting' }),
        run({ id: 'v', status: 'review' }),
        run({ id: 'd', status: 'done' }),
        run({ id: 'f', status: 'failed' }),
      ],
    })
    const pillOf = (id: string) => tableRow(id)?.querySelector('[data-slot="pill"]')
    expect(pillOf('w')?.textContent).toBe('needs you')
    expect(pillOf('v')?.textContent).toBe('needs review')
    expect(pillOf('d')?.textContent).toBe('done')
    expect(pillOf('f')?.textContent).toBe('failed')
    expect(pillOf('w')?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
    expect(pillOf('d')?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
  })

  it('shows a usage-limit wait as "scheduled" with its time, not as a red failure', () => {
    // The record is `failed`, but the task has an appointment (spec
    // 2026-08-03-auto-resume-after-usage-limit): amber, still, and carrying the instant the way
    // a queued row carries its position.
    renderOverview({
      runs: [
        run({ id: 'sched', status: 'failed', autoResumeAt: new Date(NOW + 45 * 60_000).toISOString() }),
        run({ id: 'broke', status: 'failed' }),
      ],
    })
    const pillOf = (id: string) => tableRow(id)?.querySelector('[data-slot="pill"]')
    expect(pillOf('sched')?.textContent).toContain('scheduled')
    // The time itself, locale-formatted — assert it is there rather than its spelling.
    expect(pillOf('sched')?.querySelector('.tabular-nums')?.textContent).toMatch(/\d{1,2}[:.]\d{2}/)
    expect(pillOf('sched')?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
    // …and an ordinary failure is untouched.
    expect(pillOf('broke')?.textContent).toBe('failed')
    expect(pillOf('broke')?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
  })

  it('shows a queued issue reference before the agent starts', () => {
    renderOverview({
      runs: [
        run({
          id: 'queued-issue',
          status: 'queued',
          issueNumber: 554,
          referencedIssueUrl: 'https://github.com/open-mercato/cezar/issues/554',
        }),
      ],
    })
    const chip = tableRow('queued-issue')?.querySelector('[data-slot="issue-chip"]')
    expect(chip?.textContent).toBe('Issue #554')
    expect(chip?.getAttribute('href')).toBe('https://github.com/open-mercato/cezar/issues/554')
  })

  it('fills the columns with the run facts, and honest dashes where no fact exists', () => {
    renderOverview({
      runs: [
        run({
          id: 'full',
          title: 'Structured changes endpoint',
          status: 'review',
          workflow: 'feat',
          branch: 'cez/8f31ab02',
          diffStat: { adds: 128, dels: 14, files: 6 },
          tokensUsed: 184_700,
          inputTokens: 184_700,
          outputTokens: 2_400,
          costUsd: 0.31,
          pullRequestUrl: 'https://github.com/o/r/pull/402',
          createdAt: ago(40 * 60_000),
          startedAt: ago(12 * 60_000),
        }),
        run({ id: 'bare', title: 'Bare minimum', status: 'waiting', createdAt: ago(26 * 60_000) }),
      ],
    })

    // Status | Task | Workflow | Branch | ± | PR | IN/OUT | Cost | CPU | Mem | Started
    expect(cellsOf('full')).toEqual([
      'needs review',
      'Structured changes endpoint',
      'feat',
      'cez/8f31ab02',
      '+128 −14', // the ± column (R2 #389) — adds and dels, the mockup's pair
      '#402',
      '184.7k / 2.4k',
      '$0.31',
      '—', // no live sample, CPU has no persisted peak
      '—',
      '12m',
    ])
    // No branch, no PR, no diff recorded, no cost yet — dashes, not zeros (a pre-R2 record has
    // no diffStat, and `+0 −0` would claim a measurement that never happened). Started falls
    // back to createdAt.
    expect(cellsOf('bare')).toEqual(['needs you', 'Bare minimum', 'default', '—', '—', '—', '— / —', '—', '—', '—', '26m'])
    // The pair is two colored halves, not one string — green adds, red dels (design tokens).
    const diff = tableRow('full')?.querySelector('[data-slot="diff-stat"]')
    expect(diff?.querySelector('.text-success')?.textContent).toBe('+128')
    expect(diff?.querySelector('.text-danger')?.textContent).toBe('−14')
    expect(diff?.getAttribute('title')).toBe('+128 −14 across 6 files')
    // Nothing was narrowed here, so nothing claims it was (#751).
    expect(diff?.getAttribute('data-repointed')).toBeNull()
  })

  it('annotates the ± column when the stat was measured on a repointed worktree (#751)', () => {
    renderOverview({
      runs: [
        run({
          id: 'reviewer',
          title: 'Review PR 694',
          status: 'review',
          branch: 'cez/d8ff6490',
          diffStat: { adds: 1, dels: 0, files: 1, repointed: true },
          createdAt: ago(20 * 60_000),
        }),
      ],
    })

    const diff = tableRow('reviewer')?.querySelector('[data-slot="diff-stat"]')
    // The numbers stay the numbers — the column still reads as a diff pair.
    expect(diff?.textContent).toBe('+1 −0')
    expect(diff?.getAttribute('data-repointed')).toBe('true')
    expect(diff?.getAttribute('title')).toBe(
      "+1 −0 across 1 file — measured against another branch checked out in this task's worktree, as this task found it"
    )
  })

  it('removes token/cost headers and cells while preserving table and queue semantics', () => {
    renderOverview({
      showTokens: false,
      showCost: false,
      runs: [
        run({ id: 'hidden', title: 'Hidden metrics', tokensUsed: 184_700, costUsd: 0.31 }),
        run({ id: 'queued-hidden', status: 'queued', tokensUsed: 12_000, costUsd: 0.02 }),
      ],
    })

    const headers = [...document.querySelectorAll('[data-slot="tasks-table"] th')].map(
      (cell) => cell.textContent,
    )
    expect(headers).toEqual(['Status', 'Task', 'Workflow', 'Branch', '±', 'Ref', 'CPU', 'Mem', 'Started'])
    expect(cellsOf('hidden')).toEqual([
      'done',
      'Hidden metrics',
      'default',
      '—',
      '—',
      '—',
      '—',
      '—',
      '1m',
    ])

    const queued = tableRow('queued-hidden') as HTMLElement
    expect(queued.querySelectorAll('td')).toHaveLength(8)
    expect(queued.querySelector('[data-slot="queue-note"]')?.getAttribute('colspan')).toBe('2')
    expect(queued.textContent).not.toContain('12.0k')
    expect(queued.textContent).not.toContain('$0.02')
  })

  it('keeps headers and normal/queued rows logically aligned when several columns are folded', () => {
    renderOverview({
      expandedColumns: { branch: false, workflow: false, cpu: false, memory: false },
      runs: [
        run({ id: 'aligned', branch: 'feat/aligned' }),
        run({ id: 'aligned-queue', status: 'queued', branch: 'feat/queued' }),
      ],
    })

    const headerIds = [...document.querySelectorAll('[data-slot="tasks-table"] th')].map((header) =>
      header.getAttribute('data-column-id'),
    )
    const logicalRowIds = (id: string) =>
      [...(tableRow(id)?.querySelectorAll('td') ?? [])].flatMap((cell) =>
        cell.getAttribute('data-column-id') === 'cpu-memory'
          ? ['cpu', 'memory']
          : [cell.getAttribute('data-column-id')],
      )

    expect(logicalRowIds('aligned')).toEqual(headerIds)
    expect(logicalRowIds('aligned-queue')).toEqual(headerIds)
    expect(tableRow('aligned-queue')?.querySelector('[data-slot="queue-note"]')?.getAttribute('colspan')).toBe('2')
    expect(document.querySelector('th[data-column-id="cpu"]')?.getAttribute('data-folded')).toBe('true')
    expect(document.querySelector('th[data-column-id="memory"]')?.getAttribute('data-folded')).toBe('true')
  })

  it('uses action-oriented names and pressed state on every optional header', () => {
    renderOverview({
      expandedColumns: { workflow: false, branch: true },
      runs: [run({ id: 'accessible' })],
    })

    expect(screen.getByRole('button', { name: 'Expand Workflow column', pressed: false })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Fold Branch column', pressed: true })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Fold CPU column', pressed: true })).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="tasks-table"] thead button')).toHaveLength(9)
    expect(document.querySelector('th[data-column-id="status"]')?.textContent).toBe('Status')
    expect(document.querySelector('th[data-column-id="task"]')?.textContent).toBe('Task')
  })

  it('does not render capability-hidden columns or disturb their saved choices', () => {
    const expandedColumns = { tokens: false, cost: false, branch: true } as const
    renderOverview({
      expandedColumns,
      showTokens: false,
      showCost: false,
      runs: [run({ id: 'capability-hidden', inputTokens: 123, costUsd: 0.42 })],
    })

    expect(document.querySelector('th[data-column-id="tokens"]')).toBeNull()
    expect(document.querySelector('th[data-column-id="cost"]')).toBeNull()
    expect(tableRow('capability-hidden')?.querySelector('td[data-column-id="tokens"]')).toBeNull()
    expect(tableRow('capability-hidden')?.querySelector('td[data-column-id="cost"]')).toBeNull()
    expect(expandedColumns).toEqual({ tokens: false, cost: false, branch: true })
  })

  it('reuses the same folded state for archived rows and filtered results', () => {
    renderOverview({
      view: 'archived',
      expandedColumns: { workflow: false, branch: false },
      runs: [run({ id: 'archived-folded', archived: true, title: 'Needle task', workflow: 'autofix' })],
    })

    expect(screen.getByRole('button', { name: 'Expand Workflow column', pressed: false })).not.toBeNull()
    expect(tableRow('archived-folded')?.querySelector('td[data-column-id="workflow"]')?.textContent).toBe('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'needle' } })
    expect(tableRow('archived-folded')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand Workflow column', pressed: false })).not.toBeNull()
  })

  it.each([
    { name: 'both visible', showTokens: true, showCost: true, headers: ['IN / OUT', 'Cost'], tokens: true, cost: true },
    { name: 'tokens only', showTokens: true, showCost: false, headers: ['IN / OUT'], tokens: true, cost: false },
    { name: 'cost only', showTokens: false, showCost: true, headers: ['Cost'], tokens: false, cost: true },
    { name: 'both hidden', showTokens: false, showCost: false, headers: [], tokens: false, cost: false },
  ])('keeps desktop and mobile metrics independent when $name', ({ showTokens, showCost, headers, tokens, cost }) => {
    renderOverview({
      showTokens,
      showCost,
      runs: [
        run({
          id: 'visibility',
          branch: 'cez/visibility',
          inputTokens: 184_700,
          outputTokens: 2_400,
          costUsd: 0.31,
        }),
      ],
    })

    const allHeaders = [...document.querySelectorAll('[data-slot="tasks-table"] th')].map(
      (cell) => cell.textContent,
    )
    expect(allHeaders.filter((header) => header === 'IN / OUT' || header === 'Cost')).toEqual(headers)
    const rowText = tableRow('visibility')?.textContent ?? ''
    const cardText = card('visibility')?.textContent ?? ''
    expect(rowText.includes('184.7k / 2.4k')).toBe(tokens)
    expect(cardText.includes('IN 184.7k · OUT 2.4k')).toBe(tokens)
    expect(rowText.includes('$0.31')).toBe(cost)
    expect(cardText.includes('$0.31')).toBe(cost)
  })

  it('shows the auto-summary title once a turn produced one, falling back to the raw title', () => {
    renderOverview({
      runs: [
        run({
          id: 'sum',
          title: 'fix the login bug plz',
          titleSummary: 'Catch AuthError in the login handler',
        }),
        run({ id: 'raw', title: 'fix the search crash' }),
      ],
    })
    // The displayed name, the link's accessible name and the truncation tooltip all agree.
    const link = within(tableRow('sum') as HTMLElement).getByRole('link', {
      name: 'Catch AuthError in the login handler',
    })
    expect(link.getAttribute('title')).toBe('Catch AuthError in the login handler')
    expect(tableRow('sum')?.textContent).not.toContain('fix the login bug plz')
    expect(
      within(tableRow('raw') as HTMLElement).getByRole('link', { name: 'fix the search crash' })
    ).not.toBeNull()
  })

  it('links the PR chip out without hijacking it, while a row click opens the task', () => {
    renderOverview({
      runs: [run({ id: 'pr1', title: 'Has a PR', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/7' })],
    })

    const chip = within(tableRow('pr1') as HTMLElement).getByRole('link', {
      name: 'Open the pull request for Has a PR',
    })
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
    expect(chip.getAttribute('target')).toBe('_blank')
    expect(chip.getAttribute('rel')).toBe('noopener noreferrer')

    // Clicking the chip must not also trigger the row's SPA navigation.
    const stopJsdomNav = (event: Event) => event.preventDefault()
    document.addEventListener('click', stopJsdomNav)
    fireEvent.click(chip)
    document.removeEventListener('click', stopJsdomNav)
    expect(location()).toBe('/')

    fireEvent.click(tableRow('pr1') as HTMLElement)
    expect(location()).toBe('/tasks/pr1')
  })

  it('gives the title a real link, so keyboards and middle-clicks work too', () => {
    renderOverview({ runs: [run({ id: 'k1', title: 'Keyboard reachable' })] })
    expect(
      within(tableRow('k1') as HTMLElement).getByRole('link', { name: 'Keyboard reachable' }).getAttribute('href')
    ).toBe('/tasks/k1')
  })

  it('shows a queued run its place in the queue, spanning the live columns', () => {
    renderOverview({
      runs: [
        run({ id: 'q1', status: 'queued', createdAt: ago(120_000) }),
        run({ id: 'q2', status: 'queued', createdAt: ago(60_000) }),
      ],
    })
    const note = tableRow('q2')?.querySelector('[data-slot="queue-note"]')
    expect(note?.textContent).toBe('#2 in queue')
    expect(note?.getAttribute('colspan')).toBe('2')
    // The note replaces the CPU/Mem cells — a queued run has no process to measure.
    expect(tableRow('q2')?.querySelectorAll('[data-usage]')).toHaveLength(0)
    expect(tableRow('q1')?.querySelector('[data-slot="queue-note"]')?.textContent).toBe('#1 in queue')
  })

  it('keeps queue numbers stable under search — the engine does not care what you typed', () => {
    renderOverview({
      runs: [
        run({ id: 'q1', title: 'Alpha', status: 'queued', createdAt: ago(120_000) }),
        run({ id: 'q2', title: 'Beta', status: 'queued', createdAt: ago(60_000) }),
      ],
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'beta' } })
    expect(tableRow('q1')).toBeNull()
    expect(tableRow('q2')?.querySelector('[data-slot="queue-note"]')?.textContent).toBe('#2 in queue')
  })
})

describe('TasksOverview — inline rename from the table (spec step 15)', () => {
  const pencilOf = (id: string) =>
    within(tableRow(id) as HTMLElement).getByRole('button', { name: 'Rename task' })
  const openEditor = (id: string) => {
    fireEvent.click(pencilOf(id))
    return within(tableRow(id) as HTMLElement).getByLabelText('Task title') as HTMLInputElement
  }

  it('flips the Task cell into an input seeded with the DISPLAYED title, and Enter commits the trim', () => {
    const { onRename } = renderOverview({
      runs: [run({ id: 'e1', title: 'raw prompt text', titleSummary: 'Displayed summary' })],
    })
    const input = openEditor('e1')
    expect(input.value).toBe('Displayed summary') // never the raw title behind the summary

    fireEvent.change(input, { target: { value: '  Renamed from the table  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Enter is typically followed by the blur of the unmounting input — one commit, not two.
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith('e1', 'Renamed from the table')
    // Back to the resting cell immediately — the edit UI does not wait for the server.
    expect(within(tableRow('e1') as HTMLElement).queryByLabelText('Task title')).toBeNull()
  })

  it('blur commits like Enter', () => {
    const { onRename } = renderOverview({ runs: [run({ id: 'e2', title: 'Before' })] })
    const input = openEditor('e2')
    fireEvent.change(input, { target: { value: 'After blur' } })
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith('e2', 'After blur')
  })

  it('Escape abandons the draft — nothing reported, the old title stays', () => {
    const { onRename } = renderOverview({ runs: [run({ id: 'e3', title: 'Keep me' })] })
    const input = openEditor('e3')
    fireEvent.change(input, { target: { value: 'Never sent' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(within(tableRow('e3') as HTMLElement).getByRole('link', { name: 'Keep me' })).not.toBeNull()
  })

  it('an unchanged or emptied draft is not worth a request', () => {
    const { onRename } = renderOverview({ runs: [run({ id: 'e4', title: 'Same' })] })
    for (const value of ['Same', '   ']) {
      const input = openEditor('e4')
      fireEvent.change(input, { target: { value } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    expect(onRename).not.toHaveBeenCalled()
  })

  it('neither the pencil nor the open editor hands the click to the row navigation', () => {
    renderOverview({ runs: [run({ id: 'e5', title: 'Stay here' })] })
    fireEvent.click(pencilOf('e5'))
    expect(location()).toBe('/') // the pencil began an edit, it did not open the task

    fireEvent.click(within(tableRow('e5') as HTMLElement).getByLabelText('Task title'))
    expect(location()).toBe('/') // clicking into the input is editing, not navigating
  })

  it('offers no rename affordance on the mobile cards — hover pencils do not exist on touch', () => {
    renderOverview({ runs: [run({ id: 'e6' })] })
    expect(within(card('e6') as HTMLElement).queryByRole('button', { name: 'Rename task' })).toBeNull()
  })
})

describe('TasksOverview — usage cells', () => {
  const SAMPLE: ProcessUsage = { cpuPct: 38.4, rssBytes: 612 * 1024 ** 2, procCount: 5 }

  /** Just enough EventSource for the provider to hold and for a test to feed one usage tick. */
  class FakeEventSource {
    static last: FakeEventSource | undefined
    readyState = 0
    private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
    constructor(readonly url: string) {
      FakeEventSource.last = this
    }
    addEventListener(name: string, fn: (event: MessageEvent<string>) => void): void {
      const set = this.listeners.get(name) ?? new Set()
      set.add(fn)
      this.listeners.set(name, set)
    }
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2
    }
    emit(name: string, data: string): void {
      for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data }))
    }
  }

  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    FakeEventSource.last = undefined
  })

  function renderWithUsage(runs: RunRecord[]) {
    const client = createQueryClient()
    // The workspace stream stamps every frame with its owner (step 3.1); unscoped, the filter
    // compares stamps against health's bootProject — seed what the first fetch would establish.
    client.setQueryData(queryKeys.health, { bootProject: 'boot' })
    render(
      <QueryClientProvider client={client}>
        <GlobalEventsProvider>
          <MemoryRouter>
            <TasksOverview
              runs={runs}
              view="active"
              onViewChange={vi.fn()}
              onArchiveFinished={vi.fn()}
              onMarkAllRead={vi.fn()}
              onRename={vi.fn()}
              now={NOW}
            />
          </MemoryRouter>
        </GlobalEventsProvider>
      </QueryClientProvider>
    )
  }

  const usageCell = (id: string, column: 'cpu' | 'mem') =>
    tableRow(id)?.querySelector(`[data-usage="${column}"]`)

  it('emphasizes live CPU/Mem for a running run, from the usage stream', () => {
    renderWithUsage([run({ id: 'live1', status: 'running' })])

    // Before the first tick: nothing to say, honestly.
    expect(usageCell('live1', 'cpu')?.textContent).toBe('—')

    act(() => FakeEventSource.last?.emit('usage', JSON.stringify({ project: 'boot', usage: { live1: SAMPLE } })))

    expect(usageCell('live1', 'cpu')?.textContent).toBe('38%')
    expect(usageCell('live1', 'cpu')?.getAttribute('data-usage-kind')).toBe('live')
    expect(usageCell('live1', 'mem')?.textContent).toBe('612 MB')
    expect(usageCell('live1', 'mem')?.getAttribute('data-usage-kind')).toBe('live')
  })

  it('shows a finished run its dimmed peaks, and never a live sample', () => {
    renderWithUsage([run({ id: 'done1', status: 'done', peakRssBytes: 401 * 1024 ** 2, peakProcCount: 7 })])

    // Even a stale tick that still names the run must not paint it live — it is done.
    act(() => FakeEventSource.last?.emit('usage', JSON.stringify({ project: 'boot', usage: { done1: SAMPLE } })))

    expect(usageCell('done1', 'cpu')?.textContent).toBe('—')
    expect(usageCell('done1', 'mem')?.textContent).toBe('peak 401 MB')
    expect(usageCell('done1', 'mem')?.getAttribute('data-usage-kind')).toBe('peak')
    expect(usageCell('done1', 'mem')?.getAttribute('title')).toBe('peak — run finished · 7 procs')
  })
})

describe('TasksOverview — header', () => {
  it('shows the shared tabs with counts and reports a flip', () => {
    const { onViewChange } = renderOverview({
      runs: [run({ status: 'running' }), run({ status: 'done' }), run({ status: 'done', archived: true })],
    })
    const active = screen.getByRole('button', { name: /^Active/ })
    const archived = screen.getByRole('button', { name: /^Archived/ })
    expect(active.textContent).toBe('Active2')
    expect(archived.textContent).toBe('Archived1')
    expect(active.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(archived)
    expect(onViewChange).toHaveBeenCalledWith('archived')
  })

  it('offers Archive finished only while finished runs exist, and only on the Active tab', () => {
    const { onArchiveFinished, unmount } = renderOverview({
      runs: [run({ status: 'done' }), run({ status: 'running' })],
    })
    fireEvent.click(screen.getByRole('button', { name: /Archive finished/ }))
    expect(onArchiveFinished).toHaveBeenCalledTimes(1)
    unmount()

    // Nothing finished → no broom.
    renderOverview({ runs: [run({ status: 'running' }), run({ status: 'waiting' })] })
    expect(screen.queryByRole('button', { name: /Archive finished/ })).toBeNull()
    cleanup()

    // Archived view → the sweep acts on the other tab; offering it here would be misleading.
    renderOverview({ runs: [run({ status: 'done' })], view: 'archived' })
    expect(screen.queryByRole('button', { name: /Archive finished/ })).toBeNull()
  })

  // Read/unread (#unread-done-items). The rule itself is table-tested in lib/read-state.test.ts;
  // what these cover is the PAINT — that the table actually wears the marker the rule decides,
  // and that the sweep control is offered exactly when there is unread history to sweep.
  it('marks an unread done row with a violet dot and leaves read history unmarked', () => {
    const FINISHED = ago(60_000)
    renderOverview({
      runs: [
        run({ id: 'unread', status: 'done', finishedAt: FINISHED }),
        run({ id: 'read', status: 'done', finishedAt: FINISHED, seenAt: ago(30_000) }),
        // Cancelled is never unread — you stopped it yourself.
        run({ id: 'cancelled', status: 'cancelled', finishedAt: FINISHED }),
      ],
    })
    // Keyed on the aria-label, not on the violet tone alone: the attention pill's OWN dot is
    // violet for the live states (running/waiting/review), so a tone-only selector would be
    // matching two different signals and would quietly stop meaning what it says.
    const unreadDot = (id: string) =>
      tableRow(id)?.querySelector('[data-slot="status-dot"][aria-label="unread"]')
    expect(unreadDot('unread')).not.toBeNull()
    expect(unreadDot('unread')?.getAttribute('data-tone')).toBe('violet')
    expect(unreadDot('read')).toBeNull()
    expect(unreadDot('cancelled')).toBeNull()
  })

  it('offers Mark all read only while something is unread, and calls back on click', () => {
    const FINISHED = ago(60_000)
    const { onMarkAllRead, unmount } = renderOverview({
      runs: [run({ status: 'done', finishedAt: FINISHED })],
    })
    fireEvent.click(screen.getByRole('button', { name: /Mark all read/ }))
    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
    unmount()

    // Everything already seen → nothing left to sweep, so no control.
    renderOverview({
      runs: [run({ status: 'done', finishedAt: FINISHED, seenAt: ago(30_000) })],
    })
    expect(screen.queryByRole('button', { name: /Mark all read/ })).toBeNull()
  })

  it('filters by title, branch and workflow through the search box', () => {
    renderOverview({
      runs: [
        run({ id: 'a', title: 'Bump zod to v4', branch: 'cez/99aa11bb' }),
        run({ id: 'b', title: 'README tagline', workflow: 'plan-then-do' }),
      ],
    })
    const search = screen.getByRole('textbox', { name: 'Search tasks' })

    fireEvent.change(search, { target: { value: 'zod' } })
    expect(tableRow('a')).not.toBeNull()
    expect(tableRow('b')).toBeNull()

    fireEvent.change(search, { target: { value: 'plan-then' } })
    expect(tableRow('a')).toBeNull()
    expect(tableRow('b')).not.toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    expect(document.querySelectorAll('[data-slot="task-table-row"]')).toHaveLength(2)
  })
})

describe('TasksOverview — empty and loading states', () => {
  it('renders nothing while the run list is unknown — no premature empty state', () => {
    renderOverview({ runs: undefined })
    expect(document.querySelector('[data-slot="tasks-empty"]')).toBeNull()
    expect(document.querySelector('[data-slot="tasks-table"]')).toBeNull()
    // The header is still there: the surface exists, only its data is pending.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Tasks')
  })

  it('celebrates no-tasks-yet: primary tone, the twinkle backdrop, a New-task action', () => {
    renderOverview({ runs: [] })
    const empty = document.querySelector<HTMLElement>('[data-slot="tasks-empty"]')
    if (!empty) throw new Error('no empty state rendered')

    expect(empty.getAttribute('data-empty-kind')).toBe('no-tasks')
    expect(empty.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('primary')
    expect(within(empty).getByRole('heading', { name: 'No tasks yet' })).not.toBeNull()
    expect(within(empty).getByText('Describe a task to get started.')).not.toBeNull()
    // Scoped inside the state — the mobile FAB is also a link named "New task".
    expect(within(empty).getByRole('link', { name: 'New task' }).getAttribute('href')).toBe('/new')
    // The hero moment: this is the one overview state that gets the decorative backdrop.
    expect(empty.querySelector('[data-slot="twinkle-backdrop"]')).not.toBeNull()
  })

  it('says the archive is empty, plainly — neutral, no backdrop', () => {
    renderOverview({ runs: [run({ status: 'done' })], view: 'archived' })
    const empty = document.querySelector<HTMLElement>('[data-slot="tasks-empty"]')
    if (!empty) throw new Error('no empty state rendered')

    expect(empty.getAttribute('data-empty-kind')).toBe('archive')
    expect(empty.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(within(empty).getByRole('heading', { name: 'Nothing archived yet' })).not.toBeNull()
    expect(empty.querySelector('[data-slot="twinkle-backdrop"]')).toBeNull()
  })

  it('says what the search missed, quoting it, with no backdrop', () => {
    renderOverview({ runs: [run({ title: 'Something' })] })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'quaternion' } })
    const empty = document.querySelector<HTMLElement>('[data-slot="tasks-empty"]')
    if (!empty) throw new Error('no empty state rendered')

    expect(empty.getAttribute('data-empty-kind')).toBe('search-miss')
    expect(empty.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.getByText('No tasks match “quaternion”.')).not.toBeNull()
    // A missed search is not a hero surface.
    expect(empty.querySelector('[data-slot="twinkle-backdrop"]')).toBeNull()
  })
})

describe('TasksOverview — mobile cards and FAB', () => {
  it('keeps mobile metadata unchanged when its desktop columns are folded', () => {
    renderOverview({
      expandedColumns: { workflow: false, branch: false },
      runs: [run({ id: 'folded-mobile', workflow: 'autofix', branch: 'feat/mobile-stays' })],
    })

    expect(tableRow('folded-mobile')?.querySelector('td[data-column-id="workflow"]')?.textContent).toBe('')
    expect(tableRow('folded-mobile')?.querySelector('td[data-column-id="branch"]')?.textContent).toBe('')
    expect(card('folded-mobile')?.textContent).toContain('autofix')
    expect(card('folded-mobile')?.textContent).toContain('feat/mobile-stays')
  })

  it('renders the same runs as cards, in the same order', () => {
    renderOverview({
      runs: [
        run({ id: 'rev1', status: 'review' }),
        run({ id: 'done1', status: 'done' }),
        run({ id: 'q1', status: 'queued' }),
      ],
    })
    const rowIds = [...document.querySelectorAll('[data-slot="task-table-row"]')].map((el) =>
      el.getAttribute('data-run-id')
    )
    const cardIds = [...document.querySelectorAll('[data-slot="task-card"]')].map((el) =>
      el.getAttribute('data-run-id')
    )
    expect(cardIds).toEqual(rowIds)
  })

  it('packs a card with the pill, the meta row and the age', () => {
    renderOverview({
      runs: [
        run({
          id: 'c1',
          title: 'add a structured changes endpoint',
          titleSummary: 'Structured changes endpoint',
          status: 'review',
          workflow: 'feat',
          branch: 'cez/8f31ab02',
          diffStat: { adds: 128, dels: 14, files: 6 },
          tokensUsed: 184_700,
          inputTokens: 184_700,
          outputTokens: 2_400,
          costUsd: 0.31,
          pullRequestUrl: 'https://github.com/o/r/pull/402',
          createdAt: ago(40 * 60_000),
          finishedAt: ago(12 * 60_000),
        }),
      ],
    })
    const c = card('c1') as HTMLElement
    expect(c.querySelector('[data-slot="pill"]')?.textContent).toBe('needs review')
    // The card names the run by the summary too — every surface reads through runTitle.
    expect(within(c).getByRole('link', { name: 'Structured changes endpoint' }).getAttribute('href')).toBe(
      '/tasks/c1'
    )
    expect(c.textContent).toContain('feat')
    expect(c.textContent).toContain('cez/8f31ab02')
    // The meta row carries the diff pair, like the mockup card (branch · ± · tokens).
    expect(c.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+128 −14')
    expect(c.textContent).toContain('IN 184.7k · OUT 2.4k')
    expect(c.textContent).toContain('$0.31')
    expect(c.textContent).toContain('12m')
    expect(c.querySelector('[data-slot="pr-chip"]')?.getAttribute('href')).toBe('https://github.com/o/r/pull/402')
  })

  it('removes token text and its separator from cards when metrics are hidden', () => {
    renderOverview({
      showTokens: false,
      showCost: false,
      runs: [
        run({
          id: 'hidden-card',
          branch: 'cez/hidden',
          diffStat: { adds: 2, dels: 1, files: 1 },
          tokensUsed: 184_700,
        }),
      ],
    })
    const hidden = card('hidden-card') as HTMLElement
    expect(hidden.textContent).not.toContain('184.7k')
    expect(hidden.textContent).toContain('cez/hidden')
    expect(hidden.querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+2 −1')
  })

  it('shows no diff pair on a card whose run recorded none', () => {
    renderOverview({ runs: [run({ id: 'c2', branch: 'cez/x' })] })
    expect(card('c2')?.querySelector('[data-slot="diff-stat"]')).toBeNull()
  })

  it('shows a queued card its queue place instead of branch/tokens', () => {
    renderOverview({ runs: [run({ id: 'q1', status: 'queued' })] })
    expect(card('q1')?.querySelector('[data-slot="queue-note"]')?.textContent).toBe('#1 in queue')
  })

  it('navigates on card tap, except through the PR chip', () => {
    renderOverview({
      runs: [run({ id: 'c1', title: 'Tap me', pullRequestUrl: 'https://github.com/o/r/pull/9' })],
    })
    const stopJsdomNav = (event: Event) => event.preventDefault()
    document.addEventListener('click', stopJsdomNav)
    fireEvent.click(card('c1')?.querySelector('[data-slot="pr-chip"]') as HTMLElement)
    document.removeEventListener('click', stopJsdomNav)
    expect(location()).toBe('/')

    fireEvent.click(card('c1') as HTMLElement)
    expect(location()).toBe('/tasks/c1')
  })

  it('floats the New task FAB, linking to /new', () => {
    // A non-empty list, so the FAB is the only "New task" link (the empty state carries its own).
    renderOverview({ runs: [run()] })
    const fab = document.querySelector('[data-slot="new-task-fab"]')
    expect(fab?.getAttribute('href')).toBe('/new')
    expect(fab?.getAttribute('aria-label')).toBe('New task')
  })
})

describe('TasksOverview — compare-variants strip', () => {
  const pair = (status: RunRecord['status']) => [
    run({ id: 'va', groupId: 'g1', variant: 'A', title: 'Add autocomplete (A)', status }),
    run({ id: 'vb', groupId: 'g1', variant: 'B', title: 'Add autocomplete (B)', status }),
  ]

  it('offers Compare once every variant is terminal', () => {
    renderOverview({ runs: pair('review') })
    const strip = document.querySelector('[data-slot="compare-strip"]') as HTMLElement
    expect(strip.textContent).toContain('Add autocomplete')
    expect(strip.textContent).toContain('2 variants finished')
    expect(within(strip).getByRole('link', { name: 'Compare' }).getAttribute('href')).toBe('/compare/g1')
  })

  it('offers nothing while a variant is still working', () => {
    renderOverview({ runs: pair('running') })
    expect(document.querySelector('[data-slot="compare-strip"]')).toBeNull()
  })
})

describe('TasksOverviewRoute — wired to the app', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  function renderApp(runs: RunRecord[]) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/v1/runs') return new Response(JSON.stringify(runs), { status: 200 })
      if (url === '/api/v1/runs/archive-finished')
        return new Response(JSON.stringify({ archived: 1 }), { status: 200 })
      return new Response('[]', { status: 200 })
    })
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ListViewProvider>
            {/* The sidebar and the overview together, under ONE provider — the point under test. */}
            <TaskQuickListContainer />
            <TasksOverviewRoute />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const sidebarTab = (view: string) =>
    document.querySelector(`[data-slot="view-tab"][data-view="${view}"]`) as HTMLElement
  const overviewTab = (view: string) =>
    document.querySelector(`[data-slot="overview-tab"][data-view="${view}"]`) as HTMLElement
  const sidebarRow = (id: string) => document.querySelector(`[data-slot="task-row"][data-run-id="${id}"]`)

  it('shares the Active/Archived state with the sidebar — either set of tabs flips both', async () => {
    renderApp([run({ id: 'act', status: 'running' }), run({ id: 'arc', status: 'done', archived: true })])
    await waitFor(() => expect(tableRow('act')).not.toBeNull())
    expect(sidebarRow('act')).not.toBeNull()

    // Flip in the table header → the sidebar follows.
    fireEvent.click(overviewTab('archived'))
    expect(sidebarTab('archived').getAttribute('aria-pressed')).toBe('true')
    expect(tableRow('arc')).not.toBeNull()
    expect(tableRow('act')).toBeNull()
    expect(sidebarRow('arc')).not.toBeNull()
    expect(sidebarRow('act')).toBeNull()

    // Flip back in the sidebar → the table follows.
    fireEvent.click(sidebarTab('active'))
    expect(overviewTab('active').getAttribute('aria-pressed')).toBe('true')
    expect(tableRow('act')).not.toBeNull()
    expect(tableRow('arc')).toBeNull()
  })

  it('adopts persisted workspace choices, updates optimistically, and reloads the server answer', async () => {
    let workspaceState = {
      taskTable: {
        expandedColumns: { branch: false },
        futureSibling: 'preserve',
      },
    }
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/v1/workspace/ui-state') {
        if (init?.method === 'PUT') {
          workspaceState = { ...workspaceState, ...JSON.parse(String(init.body)) }
        }
        return json(workspaceState)
      }
      if (url === '/api/v1/runs') return json([run({ id: 'persisted', branch: 'feat/persisted' })])
      return json({})
    })

    const first = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ListViewProvider>
            <TasksOverviewRoute />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const restore = await screen.findByRole('button', { name: 'Expand Branch column', pressed: false })
    restore.focus()
    fireEvent.click(restore)
    const fold = await screen.findByRole('button', { name: 'Fold Branch column', pressed: true })
    expect(document.activeElement).toBe(fold)
    const put = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([path, options]) => String(path) === '/api/v1/workspace/ui-state' && options?.method === 'PUT',
      )
      if (!call) throw new Error('workspace PUT missing')
      return call
    })
    expect(JSON.parse(String(put[1]?.body))).toEqual({
      taskTable: {
        expandedColumns: { branch: true },
        futureSibling: 'preserve',
      },
    })
    expect(put[1]?.keepalive).toBe(true)

    first.unmount()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ListViewProvider>
            <TasksOverviewRoute />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Fold Branch column', pressed: true })).not.toBeNull()
  })

  it('posts to /api/v1/runs/archive-finished and refetches the authoritative list', async () => {
    renderApp([run({ id: 'd1', status: 'done' })])
    fireEvent.click(await screen.findByRole('button', { name: /Archive finished/ }))

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([path]) => String(path) === '/api/v1/runs/archive-finished')
      expect(posted?.[1]?.method).toBe('POST')
    })
    // The doctrine: after the mutation, ask the endpoint again rather than trusting the cache.
    await waitFor(() => {
      const listFetches = fetchMock.mock.calls.filter(([path]) => String(path) === '/api/v1/runs')
      expect(listFetches.length).toBeGreaterThan(1)
    })
  })

  it('PATCHes a table rename to /api/v1/runs/:id and refetches the authoritative list', async () => {
    renderApp([run({ id: 'rn1', title: 'Old name', status: 'done' })])
    await waitFor(() => expect(tableRow('rn1')).not.toBeNull())

    fireEvent.click(within(tableRow('rn1') as HTMLElement).getByRole('button', { name: 'Rename task' }))
    const input = within(tableRow('rn1') as HTMLElement).getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      const patched = fetchMock.mock.calls.find(([path]) => String(path) === '/api/v1/runs/rn1')
      expect(patched?.[1]?.method).toBe('PATCH')
      expect(JSON.parse(String(patched?.[1]?.body))).toEqual({ title: 'New name' })
    })
    // Same doctrine as archive: the endpoint's answer is the truth — refetch, don't trust.
    await waitFor(() => {
      const listFetches = fetchMock.mock.calls.filter(([path]) => String(path) === '/api/v1/runs')
      expect(listFetches.length).toBeGreaterThan(1)
    })
  })
})
