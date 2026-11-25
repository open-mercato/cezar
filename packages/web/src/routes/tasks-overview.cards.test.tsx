import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import { cardRun } from '@/lib/card-fixtures'
import { TasksOverview } from './tasks-overview'

/** The Tasks list with framework cards (spec 2026-11-15-framework-board § Tasks view). */

const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const noop = () => undefined

function adHoc(id: string): RunRecord {
  return { id, title: `Task ${id}`, task: id, workflow: 'default', status: 'running', createdAt: '2026-11-23T11:00:00.000Z', tokensUsed: 0, archived: false, steps: [] }
}

function overview(runs: RunRecord[]) {
  return (
    <MemoryRouter>
      <TasksOverview runs={runs} view="active" now={NOW} onViewChange={noop} onArchiveFinished={noop} onMarkAllRead={noop} onRename={noop} />
    </MemoryRouter>
  )
}

const rowIds = () => [...document.querySelectorAll('[data-slot="task-table-row"]')].map((row) => row.getAttribute('data-run-id'))

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('tasks list — framework cards', () => {
  // Guard (passes both ways): with no card the list is today's list — no chips, no group, same rows.
  it('renders today’s rows unchanged when no card exists', () => {
    const runs = [adHoc('a'), adHoc('b'), { ...adHoc('q'), status: 'queued' as const }]
    render(overview(runs))
    expect(document.querySelector('[data-slot="card-filters"]')).toBeNull()
    expect(document.querySelector('[data-slot="card-backlog"]')).toBeNull()
    expect(document.querySelector('[data-slot="card-badge"]')).toBeNull()
    expect(rowIds().sort()).toEqual(['a', 'b', 'q'])
  })

  const runs = () => [
    adHoc('a'),
    cardRun({ id: 'plan', title: 'Plan card' }, { stage: 'plan' }),
    cardRun({ id: 'build', title: 'Build card' }, { stage: 'build', stages: { plan: 'done', build: 'running', review: 'pending' } }),
    cardRun({ id: 'held', title: 'Held card', status: 'queued' }, { held: true }),
    cardRun({ id: 'ready', title: 'Ready card', status: 'queued' }),
  ]

  it('marks card rows and folds not-started cards into a collapsed Backlog group', () => {
    render(overview(runs()))
    expect(rowIds().sort()).toEqual(['a', 'build', 'plan'])
    const planRow = document.querySelector('[data-slot="task-table-row"][data-run-id="plan"]') as HTMLElement
    expect(within(planRow).getByText('Plan · 1/3')).toBeTruthy()
    expect(within(planRow).getByText('◆')).toBeTruthy()

    const group = document.querySelector('[data-slot="card-backlog"]') as HTMLElement
    expect(group.textContent).toContain('Backlog — 2 cards not started · 1 Ready')
    expect(within(group).queryByText('Held card')).toBeNull()
    fireEvent.click(within(group).getByRole('button', { expanded: false }))
    expect(within(group).getByText('Held card')).toBeTruthy()
  })

  it('keeps a card re-queued mid-walk in the table with its stage, out of the Backlog group', () => {
    const requeued = cardRun(
      { id: 'requeued', title: 'Requeued card', status: 'queued', graphState: { loops: {}, taken: [], cursor: 'build-agent' } },
      { stage: 'build', stages: { plan: 'done', build: 'running', review: 'pending' } },
    )
    render(overview([...runs(), requeued]))
    expect(rowIds().sort()).toEqual(['a', 'build', 'plan', 'requeued'])
    const row = document.querySelector('[data-slot="task-table-row"][data-run-id="requeued"]') as HTMLElement
    expect(within(row).getByText('Build · 2/3')).toBeTruthy()
    expect(document.querySelector('[data-slot="card-backlog"]')!.textContent).toContain('2 cards not started')
  })

  it('filters All · Framework · Other, and Framework adds a stage filter', () => {
    render(overview(runs()))
    const chips = document.querySelector('[data-slot="card-kind"]') as HTMLElement
    expect(document.querySelector('[data-slot="facet-card-stage-filter"]')).toBeNull()

    fireEvent.click(within(chips).getByRole('button', { name: /Other/ }))
    expect(rowIds()).toEqual(['a'])
    expect(document.querySelector('[data-slot="card-backlog"]')).toBeNull()

    fireEvent.click(within(chips).getByRole('button', { name: /Framework/ }))
    expect(rowIds().sort()).toEqual(['build', 'plan'])
    expect(document.querySelector('[data-slot="facet-card-stage-filter"]')).not.toBeNull()

    fireEvent.click(within(chips).getByRole('button', { name: /All/ }))
    expect(rowIds().sort()).toEqual(['a', 'build', 'plan'])
  })

  it('links card rows to the card wizard', () => {
    render(overview(runs()))
    const row = document.querySelector('[data-slot="task-table-row"][data-run-id="build"]') as HTMLElement
    const hrefs = within(row).getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs.every((href) => href === '/cards/build')).toBe(true)
    expect(screen.getAllByRole('link', { name: 'Open card Build card' })[0]!.getAttribute('href')).toBe('/cards/build')
    const adHocRow = document.querySelector('[data-slot="task-table-row"][data-run-id="a"]') as HTMLElement
    expect(within(adHocRow).getAllByRole('link')[0]!.getAttribute('href')).toBe('/tasks/a')
  })
})
