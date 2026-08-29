import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PlanEntry } from '@open-mercato/cezar-api-client'

import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import { PlanList, planActiveEntry, planCounts } from './plan-dock'

afterEach(cleanup)

/** The golden claude `plan.updated` snapshot (thinking-edit-write-todo) — the exact entry
 *  shapes the R2 mapper is pinned to: completed / in_progress / pending, each with an
 *  `activeForm`. Never hand-invented. */
const GOLDEN: PlanEntry[] = (thinkingEditWriteTodo as Array<{ type: string; entries?: PlanEntry[] }>).find(
  (event) => event.type === 'plan.updated',
)!.entries!

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

describe('PlanList', () => {
  it('renders the three row states with the golden snapshot', () => {
    render(<PlanList entries={GOLDEN} />)
    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows.map((row) => row.textContent)).toEqual([
      'Patch middleware redirect',
      'Run testsin progress', // content + the "in progress" tag
      'Update changelog',
    ])
    expect(rows[0]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')?.textContent).toBe('in progress')
    expect(rows[1]!.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
    expect(rows[2]!.querySelector('[data-slot="plan-tag"]')).toBeNull()
  })

  // Regression: an opencode `cancelled` todo used to be dropped by the mapper and
  // never reached the list at all. It must render — struck through, out of the score.
  it('renders a cancelled row struck through', () => {
    render(
      <PlanList
        entries={[
          { content: 'Ship the fix', status: 'completed' },
          { content: 'Rework the parser', status: 'cancelled' },
        ]}
      />,
    )
    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'cancelled'])
    expect(rows.map((row) => row.textContent)).toEqual(['Ship the fix', 'Rework the parser'])
    expect(rows[1]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')).toBeNull()

    // Pin the ⊘ by lucide's own class: asserting only "not spinning" would also pass
    // for the pending ○ (lucide-circle), i.e. it would survive deleting the glyph.
    const cancelledIcon = rows[1]!.querySelector('svg')!
    expect(cancelledIcon.getAttribute('class')).toContain('lucide-circle-slash')
    expect(cancelledIcon.getAttribute('class')).not.toContain('animate-spin')
  })

  // Audit A2: once the run has settled, the frozen snapshot must stop reading as live.
  it('settled: the in-progress row keeps its text but drops the pulse and the tag', () => {
    render(<PlanList entries={GOLDEN} settled />)
    const inProgress = [...document.querySelectorAll('[data-slot="plan-item"]')][1]!
    expect(inProgress.getAttribute('data-status')).toBe('in_progress')
    expect(inProgress.textContent).toBe('Run tests') // no "in progress" tag appended
    expect(inProgress.querySelector('[data-slot="plan-tag"]')).toBeNull()
    expect(inProgress.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin')
  })
})
