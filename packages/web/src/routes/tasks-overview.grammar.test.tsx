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
  it('a done, cancelled or idle-closed row wears a shape-coded mark and no word; open states keep dot + word', () => {
    renderOverview({
      runs: [
        run({ id: 'done', title: 'Done task' }),
        run({ id: 'cancelled', status: 'cancelled' }),
        run({ id: 'idle', status: 'failed', idleClosedAt: ago(30_000) }),
        run({ id: 'review', status: 'review' }),
        run({ id: 'running', status: 'running' }),
        run({ id: 'failed', status: 'failed' }),
      ],
    })
    // The mark keeps the state's colour (owner review, 2026-11-12) AND a shape of its own, so
    // done / cancelled / idle never differ by colour alone (WCAG 1.4.1).
    const expected = {
      done: { tone: 'success', label: 'done' },
      cancelled: { tone: 'neutral', label: 'cancelled' },
      idle: { tone: 'idle', label: 'closed · idle' },
    } as const
    const glyphs = new Set<string>()
    for (const id of ['done', 'cancelled', 'idle'] as const) {
      const cell = tableRow(id).querySelector('td[data-column-id="status"]') as HTMLElement
      expect(cell.querySelector('[data-slot="pill"]')).toBeNull()
      expect(cell.textContent).toBe('')
      const mark = cell.querySelector('[data-slot="status-quiet"] [data-slot="status-mark"]') as HTMLElement
      expect(mark.getAttribute('data-state')).toBe(id)
      expect(mark.getAttribute('data-tone')).toBe(expected[id].tone)
      // The word survives for assistive tech: the mark is a named image…
      expect(within(cell).getByRole('img', { name: expected[id].label })).toBe(mark)
      // …and the title link is described by it, without a tab stop per mark.
      expect(within(tableRow(id)).getByRole('link', { description: expected[id].label })).toBeTruthy()
      expect(within(card(id)).getByRole('link', { description: expected[id].label })).toBeTruthy()
      glyphs.add(mark.querySelector('svg')?.getAttribute('class') ?? '')
      // The same grammar on the card.
      expect(card(id).querySelector('[data-slot="pill"]')).toBeNull()
      expect(card(id).querySelector('[data-slot="status-quiet"] [data-slot="status-mark"]')?.getAttribute('data-state')).toBe(id)
      // Active view: the mark only, the word stays off (owner design).
      expect(tableRow(id).querySelector('[data-slot="status-mark-label"]')).toBeNull()
    }
    // Three different glyphs, not one shape in three colours.
    expect(glyphs.size).toBe(3)
    expect(within(tableRow('done')).getByRole('link', { name: /^Done task/, description: 'done' })).toBeTruthy()
    expect(tableRow('review').querySelector('[data-slot="pill"]')?.textContent).toBe('needs review')
    expect(tableRow('running').querySelector('[data-slot="pill"]')?.textContent).toBe('running')
    expect(tableRow('failed').querySelector('[data-slot="pill"]')?.textContent).toBe('failed')
    expect(tableRow('failed').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    // An open row's link is not described: its pill already says the word.
    expect(within(tableRow('review')).getAllByRole('link')[0]?.getAttribute('aria-describedby')).toBeNull()
  })

  it('the Archived view prints the word beside the mark, where outcomes mix', () => {
    renderOverview({
      view: 'archived',
      runs: [
        run({ id: 'arc-failed', status: 'failed', archived: true }),
        run({ id: 'arc-done', archived: true }),
        run({ id: 'arc-cancelled', status: 'cancelled', archived: true }),
        run({ id: 'arc-review', status: 'review', archived: true }),
      ],
    })
    const cell = (id: string) => tableRow(id).querySelector('td[data-column-id="status"]') as HTMLElement
    expect(cell('arc-failed').querySelector('[data-slot="pill"]')).toBeNull()
    const failed = cell('arc-failed').querySelector('[data-slot="status-quiet"] [data-slot="status-mark"]')
    expect(failed?.getAttribute('data-state')).toBe('failed')
    expect(failed?.getAttribute('data-tone')).toBe('danger')
    expect(cell('arc-failed').textContent).toBe('failed')
    expect(cell('arc-done').textContent).toBe('done')
    expect(cell('arc-cancelled').textContent).toBe('cancelled')
    // Said once to assistive tech: the image names it, the printed word is aria-hidden.
    expect(within(cell('arc-failed')).getByRole('img', { name: 'failed' })).toBeTruthy()
    expect(cell('arc-failed').querySelector('[data-slot="status-mark-label"]')?.getAttribute('aria-hidden')).toBe('true')
    // An archived run that never closed keeps the dot (no outcome shape to give it), plus its word.
    expect(cell('arc-review').querySelector('[data-slot="status-mark"]')).toBeNull()
    expect(cell('arc-review').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('info')
    expect(cell('arc-review').textContent).toBe('needs review')
  })

  it('a queued row keeps its grey dot and word; the quiet mark sits on the pill dot\'s line', () => {
    renderOverview({ runs: [run({ id: 'q', status: 'queued' }), run({ id: 'd' })] })
    expect(tableRow('q').querySelector('[data-slot="pill"] [data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
    // Same horizontal padding as the pill, so every row's dot lines up down the column.
    expect(tableRow('d').querySelector('[data-slot="status-quiet"]')?.className).toContain('px-2.5')
  })
})

describe('row controls — revealed on hover, focus, or in selection mode', () => {
  it('hides the leading controls until hover/focus, and the toolbar Select keeps them shown', () => {
    renderOverview({ runs: [run({ id: 'a', title: 'Alpha' }), run({ id: 'b', title: 'Beta' })], onTaskAction: vi.fn().mockResolvedValue(undefined) })
    const controls = (id: string) => tableRow(id).querySelector('[data-slot="row-controls"]') as HTMLElement
    // The column reserves the checkbox only; the quick actions float beside it on hover, so
    // neither the hover nor Select shifts the row (owner review, 2026-11-12).
    expect(document.querySelector('col[data-column-id="controls"]')?.getAttribute('style')).toContain('36px')
    const quick = controls('a').querySelector('[data-slot="row-quick-actions"]') as HTMLElement
    expect(quick.className).toContain('absolute')
    expect(quick.className).toContain('group-hover/row:opacity-100')
    // Invisible must also mean untappable: a touch tablet never hovers, and a tap on the status
    // cell must not land on an Archive it cannot see. Pointer events come back with the reveal.
    expect(quick.className.split(/\s+/)).toContain('pointer-events-none')
    expect(quick.className).toContain('group-hover/row:pointer-events-auto')
    expect(quick.className).toContain('group-focus-within/row:pointer-events-auto')
    expect(within(quick).getByRole('button', { name: 'Archive: Alpha' })).toBeTruthy()

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

  it('keeps Mem open by default (as main had it, so no existing user loses it) and respects a stored fold', () => {
    renderOverview({ runs: [run({ id: 'a' })] })
    expect(screen.getByRole('button', { name: 'Fold Mem column', pressed: true })).toBeTruthy()
    cleanup()
    renderOverview({ runs: [run({ id: 'a' })], expandedColumns: { memory: false } })
    expect(screen.getByRole('button', { name: 'Expand Mem column', pressed: false })).toBeTruthy()
  })

  it('one Columns menu lists every foldable column with its state, toggles through the same controller, and resets', async () => {
    const onToggleColumn = vi.fn()
    renderOverview({ runs: [run({ id: 'a' })], expandedColumns: { branch: true, memory: false }, onToggleColumn })
    const trigger = screen.getByRole('button', { name: 'Columns' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(trigger)
    const items = await screen.findAllByRole('menuitemcheckbox')
    expect(items.map((item) => item.textContent)).toEqual(['Workflow', 'Branch', '±', 'Ref', 'IN / OUT', 'Cost', 'CPU', 'Mem', 'Updated'])
    expect(items.find((item) => item.textContent === 'Branch')?.getAttribute('aria-checked')).toBe('true')
    expect(items.find((item) => item.textContent === 'Mem')?.getAttribute('aria-checked')).toBe('false')

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
