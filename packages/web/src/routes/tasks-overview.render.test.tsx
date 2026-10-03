import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import { deriveAttention } from '@/lib/attention'
import { TasksOverview } from '@/routes/tasks-overview'

// Every row and card derives its attention once per render, which makes the call count a
// render count for the rows without reaching into React internals.
vi.mock('@/lib/attention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attention')>()
  return { ...actual, deriveAttention: vi.fn(actual.deriveAttention) }
})

const NOW = Date.parse('2026-07-14T12:00:00.000Z')

function runs(count: number): RunRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${index}`,
    title: `Task ${index}`,
    workflow: 'default',
    task: `task ${index}`,
    status: 'done' as const,
    createdAt: new Date(NOW - index * 60_000).toISOString(),
    tokensUsed: 0,
    archived: false,
    steps: [],
  }))
}

const noop = () => undefined
function overview(list: RunRecord[], now = NOW) {
  return (
    <MemoryRouter>
      <TasksOverview
        runs={list}
        view="active"
        now={now}
        onViewChange={noop}
        onArchiveFinished={noop}
        onMarkAllRead={noop}
        onRename={noop}
      />
    </MemoryRouter>
  )
}

const tableRows = () => document.querySelectorAll('[data-slot="task-table-row"]')
const cards = () => document.querySelectorAll('[data-slot="task-card"]')
const rowRenders = vi.mocked(deriveAttention)

beforeEach(() => {
  rowRenders.mockClear()
  // virtua measures with a ResizeObserver; jsdom has none and lays nothing out — it mounts the
  // virtualized tier, but windows down to zero items.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('tasks table — cost of a long list', () => {
  it('re-renders only the row whose run changed', () => {
    const list = runs(20)
    const view = render(overview(list))
    const next = [...list]
    next[3] = { ...list[3]!, status: 'running', tokensUsed: 5 }
    rowRenders.mockClear()

    act(() => view.rerender(overview(next)))

    expect(rowRenders.mock.calls.map(([run]) => (run as RunRecord).id)).toEqual(['r3', 'r3'])
  })

  it('lets the age tick re-render no row at all, while the ages still move', () => {
    const list = runs(20)
    const view = render(overview(list))
    const ageOf = () => tableRows()[0]?.querySelector('[data-column-id="started"]')?.textContent
    const before = ageOf()
    rowRenders.mockClear()

    act(() => view.rerender(overview(list, NOW + 2 * 60 * 60_000)))

    expect(rowRenders).not.toHaveBeenCalled()
    expect(ageOf()).not.toBe(before)
  })

  it('mounts only the rows near the viewport past the window threshold', () => {
    render(overview(runs(300)))
    expect(tableRows().length).toBeGreaterThan(0)
    expect(tableRows().length).toBeLessThan(300)
    expect(document.querySelector('[data-row-spacer]')).not.toBeNull()
    // The spacers are aria-hidden: the table must still tell assistive tech its full size.
    expect(document.querySelector('[data-slot="tasks-table"] table')?.getAttribute('aria-rowcount')).toBe('301')
    expect(tableRows()[0]?.getAttribute('aria-rowindex')).toBe('2')
  })

  it('mounts every row under the threshold', () => {
    render(overview(runs(60)))
    expect(tableRows()).toHaveLength(60)
    expect(document.querySelector('[data-row-spacer]')).toBeNull()
  })

  it('mounts every card under the card-list threshold', () => {
    render(overview(runs(60)))
    expect(document.querySelector('[data-slot="task-cards"]')?.getAttribute('data-virtualized')).toBe('false')
    expect(cards()).toHaveLength(60)
  })

  it('switches the card list to virtua past the threshold', () => {
    render(overview(runs(150)))
    // The `<md` tier vitest cannot lay out: the switch to the virtualized list is what is pinned
    // here, not the windowing itself (jsdom has no ResizeObserver layout to window by).
    expect(document.querySelector('[data-slot="task-cards"]')?.getAttribute('data-virtualized')).toBe('true')
    expect(cards().length).toBeLessThan(150)
  })
})
