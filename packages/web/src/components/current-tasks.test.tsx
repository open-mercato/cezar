import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { CurrentTasks } from './current-tasks'

afterEach(cleanup)

const NOW = Date.parse('2026-07-14T12:00:00.000Z')

let seq = 0
function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    finishedAt: '2026-07-14T10:00:00.000Z',
    seenAt: '2026-07-15T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderList(runs: RunRecord[], props: Partial<Parameters<typeof CurrentTasks>[0]> = {}, entry = '/p/cezar/') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CurrentTasks runs={runs} now={NOW} {...props} />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const rows = () => [...document.querySelectorAll('[data-slot="task-row"]')] as HTMLElement[]

describe('CurrentTasks', () => {
  it('renders one line per task: dot, PR chip when there is one, title, age — capped at six', () => {
    const pr = run({ id: 'pr', title: '1992: resolve merge conflicts', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/1992', finishedAt: '2026-07-14T10:00:00.000Z' })
    const plain = run({ id: 'plain', title: '/om-auto-create-pr account', status: 'failed', finishedAt: '2026-07-14T11:52:00.000Z' })
    const rest = Array.from({ length: 6 }, (_, index) => run({ id: `d${index}`, finishedAt: `2026-07-14T0${index}:00:00.000Z` }))
    renderList([...rest, plain, pr])

    expect(rows()).toHaveLength(6)
    expect(rows().map((row) => row.getAttribute('data-run-id'))).toEqual(['plain', 'pr', 'd5', 'd4', 'd3', 'd2'])

    const prRow = rows()[1]!
    expect(prRow.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('info')
    expect(prRow.querySelector('[data-slot="pr-chip"]')?.textContent).toContain('1992')
    // The number is on the chip, so the title drops its `1992: ` prefix.
    expect(prRow.querySelector('[data-slot="task-row-title"]')?.textContent).toBe('resolve merge conflicts')
    expect(prRow.querySelector('[data-slot="task-row-age"]')?.textContent).toBe('2h')

    // No PR: no chip and no gap — the title follows the dot directly.
    const plainRow = rows()[0]!
    expect(plainRow.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(plainRow.querySelector('[data-slot="task-row-title"]')?.textContent).toBe('/om-auto-create-pr account')
    expect(plainRow.querySelector('[data-slot="task-row-age"]')?.textContent).toBe('8m')
    expect(plainRow.querySelector('[data-slot="task-row-title"]')?.closest('a')?.previousElementSibling?.getAttribute('data-slot')).toBe('task-row-dot-link')
  })

  it('links each row into the task, scoped to the project, and More… into the table', () => {
    renderList([run({ id: 'a' })])
    expect(screen.getByRole('link', { name: /Task 1|Task \d+/ }).getAttribute('href')).toBe('/p/cezar/tasks/a')
    const more = screen.getByRole('link', { name: 'More…' })
    expect(more.getAttribute('href')).toBe('/p/cezar/tasks')
    fireEvent.click(more)
    expect(screen.getByTestId('location').textContent).toBe('/p/cezar/tasks')
  })

  it('marks the open task current, an unread task by weight and for a screen reader', () => {
    const unread = run({ id: 'u', title: 'Fresh', seenAt: undefined, finishedAt: '2026-07-14T11:00:00.000Z' })
    const read = run({ id: 'r', title: 'Read' })
    renderList([unread, read], { currentRunId: 'r' })
    const current = rows().find((row) => row.getAttribute('data-run-id') === 'r')!
    expect(current.getAttribute('data-active')).toBe('true')
    expect(within(current).getByRole('link', { name: /Read/ }).getAttribute('aria-current')).toBe('page')
    const fresh = rows().find((row) => row.getAttribute('data-run-id') === 'u')!
    expect(fresh.querySelector('[data-slot="task-row-title"]')?.className).toContain('font-semibold')
    expect(fresh.querySelector('[data-slot="unread-marker"]')).not.toBeNull()
  })

  it('offers pin and archive from the row, exactly as the quick-list did (#935)', () => {
    const onTogglePin = vi.fn()
    const onToggleArchive = vi.fn()
    const done = run({ id: 'd', pinned: false })
    renderList([done], { onTogglePin, onToggleArchive })
    const actions = rows()[0]!.querySelector('[data-slot="task-row-actions"]') as HTMLElement
    expect(actions).not.toBeNull()
    fireEvent.click(within(actions).getByRole('button', { name: /pin/i }))
    expect(onTogglePin).toHaveBeenCalledWith(done, true)
    fireEvent.click(within(actions).getByRole('button', { name: /archive/i }))
    expect(onToggleArchive).toHaveBeenCalledWith(done, true)
  })

  it('says so when there is nothing to list', () => {
    renderList([])
    expect(screen.getByText('No tasks yet — describe one.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'More…' })).toBeTruthy()
  })
})
