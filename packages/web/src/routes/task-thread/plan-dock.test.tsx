import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PlanEntry } from '@open-mercato/cezar-api-client'

import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import { PlanDock, planActiveEntry, planCounts } from './plan-dock'

afterEach(cleanup)

/** The golden claude `plan.updated` snapshot (thinking-edit-write-todo) — the exact entry
 *  shapes the R2 mapper is pinned to: completed / in_progress / pending, each with an
 *  `activeForm`. Never hand-invented. */
const GOLDEN: PlanEntry[] = (thinkingEditWriteTodo as Array<{ type: string; entries?: PlanEntry[] }>).find(
  (event) => event.type === 'plan.updated',
)!.entries!

const dock = () => document.querySelector('[data-slot="plan-dock"]')!
const head = () => document.querySelector<HTMLButtonElement>('[data-slot="plan-dock"] button')!

describe('planCounts / planActiveEntry — the odometer math', () => {
  it('counts completed over total (the golden snapshot is 1/3)', () => {
    expect(planCounts(GOLDEN)).toEqual({ done: 1, total: 3 })
  })

  // opencode's `cancelled` — work dropped on purpose. Counting it would strand the
  // odometer below N/N for the rest of the run.
  it('leaves cancelled entries out of the denominator, so a plan can still read done', () => {
    expect(
      planCounts([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'cancelled' },
      ]),
    ).toEqual({ done: 2, total: 2 })
  })

  it('an all-cancelled plan is 0/0, not a division by the dropped work', () => {
    expect(planCounts([{ content: 'a', status: 'cancelled' }])).toEqual({ done: 0, total: 0 })
  })

  it.each<[string, PlanEntry[], string | undefined]>([
    ['the in-progress entry wins', GOLDEN, 'Run tests'],
    [
      'no in-progress → the next pending one',
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
      'b',
    ],
    ['fully completed → none', [{ content: 'a', status: 'completed' }], undefined],
    [
      'cancelled is never the current item — it skips to the next real pending one',
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'cancelled' },
        { content: 'c', status: 'pending' },
      ],
      'c',
    ],
    ['nothing left but cancelled → none', [{ content: 'a', status: 'cancelled' }], undefined],
  ])('%s', (_name, entries, expected) => {
    expect(planActiveEntry(entries)?.content).toBe(expected)
  })
})

describe('PlanDock', () => {
  it('renders nothing for an emptied plan (full replacement can clear it)', () => {
    render(<PlanDock runId="dock-empty" entries={[]} />)
    expect(document.querySelector('[data-slot="plan-dock"]')).toBeNull()
  })

  it('expanded by default (jsdom counts as desktop): N/M head + the three row states', () => {
    render(<PlanDock runId="dock-states" entries={GOLDEN} />)
    expect(dock().getAttribute('data-state')).toBe('open')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-slot="plan-count"]')?.textContent).toBe('· 1/3')

    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows.map((row) => row.textContent)).toEqual([
      'Patch middleware redirect',
      'Run testsin progress', // content + the "in progress" tag
      'Update changelog',
    ])
    expect(rows[0]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')?.textContent).toBe('in progress')
    expect(rows[1]!.querySelector('svg')?.getAttribute('class')).toContain('animate-pulse')
    expect(rows[2]!.querySelector('[data-slot="plan-tag"]')).toBeNull()
    // Expanded: the current-item line belongs to the collapsed head only.
    expect(document.querySelector('[data-slot="plan-current"]')).toBeNull()
    // The decorative edge is slimmer on phones, with its current desktop height restored at md.
    expect(document.querySelector('[data-slot="grad-edge"]')?.className).toContain('h-0.5')
    expect(document.querySelector('[data-slot="grad-edge"]')?.className).toContain('md:h-[3px]')
  })

  // Regression: an opencode `cancelled` todo used to be dropped by the mapper and
  // never reached the dock at all. It must render — struck through, out of the score.
  it('renders a cancelled row struck through and keeps it out of the odometer', () => {
    render(
      <PlanDock
        runId="dock-cancelled"
        entries={[
          { content: 'Ship the fix', status: 'completed' },
          { content: 'Rework the parser', status: 'cancelled' },
        ]}
      />,
    )
    expect(document.querySelector('[data-slot="plan-count"]')?.textContent).toBe('· 1/1')

    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'cancelled'])
    expect(rows.map((row) => row.textContent)).toEqual(['Ship the fix', 'Rework the parser'])
    expect(rows[1]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')).toBeNull()

    // Pin the ⊘ by its own slash path: asserting only "not animate-pulse" would
    // also pass for the pending ○, i.e. it would survive deleting the glyph.
    const cancelledIcon = rows[1]!.querySelector('svg')!
    expect(cancelledIcon.querySelector('path')?.getAttribute('d')).toBe('m8.5 15.5 7-7')
    expect(cancelledIcon.getAttribute('class')).not.toContain('animate-pulse')
  })

  it('collapsing folds the list to "Plan · N/M — {activeForm of the current item}"', () => {
    render(<PlanDock runId="dock-collapse" entries={GOLDEN} />)
    fireEvent.click(head())
    expect(dock().getAttribute('data-state')).toBe('collapsed')
    expect(document.querySelector('[data-slot="plan-list"]')).toBeNull()
    // The in-progress entry, spelled with its present-continuous activeForm.
    expect(document.querySelector('[data-slot="plan-current"]')?.textContent).toBe('— Running tests')
  })

  it('falls back to the entry content when the current item has no activeForm', () => {
    render(
      <PlanDock
        runId="dock-no-activeform"
        entries={[
          { content: 'Ship it', status: 'in_progress' },
          { content: 'Later', status: 'pending' },
        ]}
      />,
    )
    fireEvent.click(head())
    expect(document.querySelector('[data-slot="plan-current"]')?.textContent).toBe('— Ship it')
  })

  it('remembers the collapse per run id across unmounts (the module-level cache)', () => {
    const { unmount } = render(<PlanDock runId="dock-memory" entries={GOLDEN} />)
    fireEvent.click(head())
    expect(dock().getAttribute('data-state')).toBe('collapsed')
    unmount()

    // Same run: reopens collapsed. Another run: fresh default (expanded).
    const second = render(<PlanDock runId="dock-memory" entries={GOLDEN} />)
    expect(dock().getAttribute('data-state')).toBe('collapsed')
    second.unmount()
    render(<PlanDock runId="dock-memory-other" entries={GOLDEN} />)
    expect(dock().getAttribute('data-state')).toBe('open')
  })
})
