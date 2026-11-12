import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { TasksOverview } from './tasks-overview'

/**
 * The calmer table (spec: attention-first cockpit (2026-11-11), Proposals 7 and 9): status colour
 * only where the state is open, row controls on hover or in selection mode, fold chevrons on
 * header hover, one Columns menu, Mem folded for new users.
 */

const NOW = Date.parse('2026-11-11T14:00:00.000Z')
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
    finishedAt: ago(30_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function renderOverview(props: Partial<ComponentProps<typeof TasksOverview>> = {}) {
  render(
    <MemoryRouter>
      <TasksOverview
        runs={[]}
        view="active"
        now={NOW}
        onViewChange={vi.fn()}
        onArchiveFinished={vi.fn()}
        onMarkAllRead={vi.fn()}
        onRename={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  )
}

const tableRow = (id: string) => document.querySelector(`[data-slot="task-table-row"][data-run-id="${id}"]`) as HTMLElement
const card = (id: string) => document.querySelector(`[data-slot="task-card"][data-run-id="${id}"]`) as HTMLElement

afterEach(cleanup)

describe('status grammar', () => {
  it('a done, cancelled, idle-closed or archived row wears a neutral dot and no word; open states keep dot + word', () => {
    renderOverview({
      runs: [
        run({ id: 'done' }),
        run({ id: 'cancelled', status: 'cancelled' }),
        run({ id: 'idle', status: 'failed', idleClosedAt: ago(30_000) }),
        run({ id: 'review', status: 'review' }),
        run({ id: 'running', status: 'running' }),
        run({ id: 'failed', status: 'failed' }),
      ],
    })
    for (const id of ['done', 'cancelled', 'idle']) {
      const cell = tableRow(id).querySelector('td[data-column-id="status"]') as HTMLElement
      expect(cell.querySelector('[data-slot="pill"]')).toBeNull()
      expect(cell.textContent).toBe('')
      expect(cell.querySelector('[data-slot="status-quiet"] [data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
      // The word survives for assistive tech and the hover.
      expect(cell.querySelector('[data-slot="status-dot"]')?.getAttribute('aria-label')).toBeTruthy()
      // The same grammar on the card.
      expect(card(id).querySelector('[data-slot="pill"]')).toBeNull()
      expect(card(id).querySelector('[data-slot="status-quiet"]')).not.toBeNull()
    }
    expect(tableRow('review').querySelector('[data-slot="pill"]')?.textContent).toBe('needs review')
    expect(tableRow('running').querySelector('[data-slot="pill"]')?.textContent).toBe('running')
    expect(tableRow('failed').querySelector('[data-slot="pill"]')?.textContent).toBe('failed')
    expect(tableRow('failed').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
  })

  it('an archived row is quiet whatever its status', () => {
    renderOverview({ view: 'archived', runs: [run({ id: 'arc', status: 'failed', archived: true })] })
    expect(tableRow('arc').querySelector('[data-slot="pill"]')).toBeNull()
    expect(tableRow('arc').querySelector('[data-slot="status-quiet"]')).not.toBeNull()
  })
})

describe('row controls — revealed on hover, focus, or in selection mode', () => {
  it('hides the three leading controls until hover/focus, and the toolbar Select keeps them shown', () => {
    renderOverview({ runs: [run({ id: 'a', title: 'Alpha' }), run({ id: 'b', title: 'Beta' })], onTaskAction: vi.fn().mockResolvedValue(undefined) })
    const controls = (id: string) => tableRow(id).querySelector('[data-slot="row-controls"]') as HTMLElement
    // jsdom has no hover: the classes are the contract, measured in Chromium on the PR.
    expect(controls('a').className).toContain('opacity-0')
    expect(controls('a').className).toContain('group-hover/row:opacity-100')
    expect(controls('a').className).toContain('group-focus-within/row:opacity-100')
    // Still in the DOM, so the keyboard reaches the checkbox without a pointer.
    expect(within(controls('a')).getByRole('checkbox', { name: 'Select Alpha' })).toBeTruthy()

    const toggle = screen.getByRole('button', { name: 'Select' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(controls('a').className).not.toContain('opacity-0')
    expect(controls('a').getAttribute('data-selection-mode')).toBe('true')
    expect(controls('b').getAttribute('data-selection-mode')).toBe('true')
    fireEvent.click(toggle)
    expect(controls('a').className).toContain('opacity-0')
  })

  it('a picked row puts the table in selection mode on its own, and the bulk actions still work', async () => {
    const onTaskAction = vi.fn().mockResolvedValue(undefined)
    renderOverview({ runs: [run({ id: 'a', title: 'Alpha' }), run({ id: 'b', title: 'Beta' })], onTaskAction })
    fireEvent.click(within(tableRow('a')).getByRole('checkbox', { name: 'Select Alpha' }))
    expect(tableRow('b').querySelector('[data-slot="row-controls"]')?.className).not.toContain('opacity-0')
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive (1)' }))
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'archive'))
  })

  it('shows no "Select tasks" bar before anything is picked', () => {
    renderOverview({ runs: [run({ id: 'a' })], onTaskAction: vi.fn() })
    expect(screen.queryByText('Select tasks')).toBeNull()
    expect(screen.queryByRole('button', { name: /Archive \(/ })).toBeNull()
  })
})

describe('column headers and the Columns menu', () => {
  it('keeps the fold chevrons for header hover/focus, with the same accessible names', () => {
    renderOverview({ runs: [run({ id: 'a' })], expandedColumns: { branch: false } })
    const fold = screen.getByRole('button', { name: 'Fold Workflow column', pressed: true })
    const chevron = fold.querySelector('svg.lucide-chevrons-left') as SVGElement
    expect(chevron.getAttribute('class')).toContain('opacity-0')
    expect(chevron.getAttribute('class')).toContain('group-hover/th:opacity-70')
    expect(chevron.getAttribute('class')).toContain('group-focus-within/th:opacity-70')
    expect(screen.getByRole('button', { name: 'Expand Branch column', pressed: false })).toBeTruthy()
  })

  it('folds Mem by default and respects a stored preference', () => {
    renderOverview({ runs: [run({ id: 'a' })] })
    expect(screen.getByRole('button', { name: 'Expand Mem column', pressed: false })).toBeTruthy()
    cleanup()
    renderOverview({ runs: [run({ id: 'a' })], expandedColumns: { memory: true } })
    expect(screen.getByRole('button', { name: 'Fold Mem column', pressed: true })).toBeTruthy()
  })

  it('one Columns menu lists every foldable column with its state, toggles through the same controller, and resets', async () => {
    const onToggleColumn = vi.fn()
    renderOverview({ runs: [run({ id: 'a' })], expandedColumns: { branch: true, memory: true }, onToggleColumn })
    const trigger = screen.getByRole('button', { name: 'Columns' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(trigger)
    const items = await screen.findAllByRole('menuitemcheckbox')
    expect(items.map((item) => item.textContent)).toEqual(['Workflow', 'Branch', '±', 'Ref', 'IN / OUT', 'Cost', 'CPU', 'Mem', 'Updated'])
    expect(items.find((item) => item.textContent === 'Branch')?.getAttribute('aria-checked')).toBe('true')
    expect(items.find((item) => item.textContent === 'Mem')?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(items.find((item) => item.textContent === 'Cost') as HTMLElement)
    expect(onToggleColumn).toHaveBeenCalledWith('cost')
    // Reset: every column off its default flips back — Branch and Mem here, nothing else.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(trigger)
    const reset = await screen.findByRole('menuitem', { name: 'Reset to defaults' })
    fireEvent.click(reset)
    expect(onToggleColumn.mock.calls.map(([id]) => id)).toEqual(['cost', 'branch', 'memory'])
  })

  it('gives the Task column the flexible remainder of a fixed table layout', () => {
    renderOverview({ runs: [run({ id: 'a' })] })
    const table = document.querySelector('[data-slot="tasks-table"] table') as HTMLElement
    expect(table.className).toContain('table-fixed')
    expect(document.querySelector('col[data-column-id="task"]')?.getAttribute('style')).toBeFalsy()
    expect(document.querySelector('col[data-column-id="branch"]')?.getAttribute('style')).toContain('width')
  })
})
