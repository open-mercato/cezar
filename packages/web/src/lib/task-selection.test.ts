import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import {
  bulkActionTargets,
  bulkResultMessage,
  selectionSummary,
  toggleAllVisible,
  toggleSelected,
} from '@/lib/task-selection'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const ids = (runs: readonly RunRecord[]) => runs.map((r) => r.id)

describe('toggleSelected', () => {
  it('ticks an unticked row and unticks a ticked one', () => {
    expect([...toggleSelected(new Set(), 'a')]).toEqual(['a'])
    expect([...toggleSelected(new Set(['a', 'b']), 'a')]).toEqual(['b'])
  })

  it('never mutates the set it was given', () => {
    const before = new Set(['a'])
    toggleSelected(before, 'b')
    expect([...before]).toEqual(['a'])
  })
})

describe('selectionSummary', () => {
  const visible = [run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c' })]

  it('reports none, some and all for the header checkbox', () => {
    expect(selectionSummary(visible, new Set()).state).toBe('none')
    expect(selectionSummary(visible, new Set(['a'])).state).toBe('some')
    expect(selectionSummary(visible, new Set(['a', 'b', 'c'])).state).toBe('all')
  })

  it('ignores an id whose row is no longer on screen — a stale pick can never act', () => {
    // The row was filtered away, archived, or patched out from under the selection.
    const summary = selectionSummary(visible, new Set(['a', 'gone']))
    expect(ids(summary.runs)).toEqual(['a'])
    expect(summary.count).toBe(1)
    // …and it does not count towards "all", or the header box would claim a full list it has not got.
    expect(selectionSummary(visible, new Set(['a', 'b', 'c', 'gone'])).state).toBe('all')
  })

  it('keeps the visible order rather than the order rows were clicked in', () => {
    expect(ids(selectionSummary(visible, new Set(['c', 'a'])).runs)).toEqual(['a', 'c'])
  })

  it('is empty, not "all", when nothing is on screen at all', () => {
    const summary = selectionSummary([], new Set(['a']))
    expect(summary.state).toBe('none')
    expect(summary.count).toBe(0)
  })
})

describe('bulkActionTargets', () => {
  const finished = run({ id: 'done', status: 'done', finishedAt: '2026-07-14T10:30:00.000Z', seenAt: '2026-07-14T10:31:00.000Z' })
  const unreadRun = run({ id: 'unread', status: 'failed', finishedAt: '2026-07-14T10:30:00.000Z' })
  const review = run({ id: 'review', status: 'review' })
  const running = run({ id: 'running', status: 'running' })
  const archived = run({ id: 'archived', status: 'done', archived: true, finishedAt: '2026-07-14T09:00:00.000Z' })
  const cancelled = run({ id: 'cancelled', status: 'cancelled', finishedAt: '2026-07-14T10:30:00.000Z' })

  const targets = bulkActionTargets([finished, unreadRun, review, running, archived, cancelled])

  it('archives only unarchived, finished rows — a review gate is not swept by a checkbox', () => {
    expect(ids(targets.archive)).toEqual(['done', 'unread', 'cancelled'])
  })

  it('restores exactly the archived rows, with no status gate', () => {
    expect(ids(targets.restore)).toEqual(['archived'])
  })

  it('marks read only what is currently unread', () => {
    expect(ids(targets.read)).toEqual(['unread'])
  })

  it('marks unread only what is read AND could be unread — never a cancelled or archived row', () => {
    expect(ids(targets.unread)).toEqual(['done'])
  })

  it('answers with empty lists for an empty selection rather than throwing', () => {
    const none = bulkActionTargets([])
    expect([none.archive, none.restore, none.read, none.unread]).toEqual([[], [], [], []])
  })
})

describe('bulkResultMessage', () => {
  it('names the action in the past tense, counts in tasks, and reads as a sentence', () => {
    expect(bulkResultMessage('archive', 3, [])).toBe('Archived 3 tasks.')
    expect(bulkResultMessage('restore', 1, [])).toBe('Restored 1 task.')
    // The object goes in the MIDDLE of "marked … read" — this string is shown to a person.
    expect(bulkResultMessage('read', 2, [])).toBe('Marked 2 tasks read.')
    expect(bulkResultMessage('unread', 1, [])).toBe('Marked 1 task unread.')
  })

  it('reports the half that landed AND the half that did not, with the first reason', () => {
    // The failure mode this exists for: a flat "Archived 5 tasks." over two refused writes is a
    // claim the list will contradict a second later.
    expect(bulkResultMessage('archive', 5, ['run is locked', 'run is locked'])).toBe(
      'Archived 3 of 5 tasks — 2 failed: run is locked',
    )
  })

  it('does not pretend a total failure was a success', () => {
    expect(bulkResultMessage('archive', 2, ['409 conflict', '409 conflict'])).toBe(
      'Archived 0 of 2 tasks — 2 failed: 409 conflict',
    )
  })

  it('still reads as a sentence when the reason is empty', () => {
    expect(bulkResultMessage('read', 1, [''])).toBe('Marked 0 of 1 task read — 1 failed')
  })
})

describe('toggleAllVisible', () => {
  const visible = [run({ id: 'a' }), run({ id: 'b' })]

  it('selects every visible row from empty', () => {
    expect([...toggleAllVisible(visible, new Set())].sort()).toEqual(['a', 'b'])
  })

  it('clears from a partial selection — the escape from an indeterminate box is emptying it', () => {
    expect([...toggleAllVisible(visible, new Set(['a']))]).toEqual([])
  })

  it('clears from a full selection', () => {
    expect([...toggleAllVisible(visible, new Set(['a', 'b']))]).toEqual([])
  })

  it('only ever touches what is on screen — a filtered-away pick is neither swept in nor dropped', () => {
    // Selecting all under a filter must mean "all of these", not "every task in the project".
    expect([...toggleAllVisible(visible, new Set(['hidden']))].sort()).toEqual(['a', 'b', 'hidden'])
    expect([...toggleAllVisible(visible, new Set(['a', 'b', 'hidden']))]).toEqual(['hidden'])
  })
})
