import type { RunRecord } from '@open-mercato/cezar-api-client'
import { describe, expect, it } from 'vitest'

import {
  automationIndex,
  filterTaskTable,
  NO_TASK_FILTERS,
  originCounts,
  taskFacetCounts,
} from './task-filters'

let seq = 0
function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-10-01T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const trigger = (automationId: string) => ({
  automationId,
  automationRevision: 1,
  receiptId: 'rc',
  trigger: 'schedule' as const,
  occurrenceAt: '2026-10-01T00:00:00.000Z',
})

const mine = run({ id: 'mine', status: 'running' })
const nightly = run({ id: 'nightly', automationTrigger: trigger('auto-nightly') })
const nightlyChild = run({ id: 'nightly-child', dispatch: { rootRunId: 'nightly', parentRunId: 'nightly' } as RunRecord['dispatch'] })
const triage = run({ id: 'triage', status: 'failed', workflow: 'review', automationTrigger: trigger('auto-triage') })
const runs = [mine, nightly, nightlyChild, triage]
const index = automationIndex(runs)
const ids = (list: RunRecord[]) => list.map((r) => r.id)

describe('filterTaskTable', () => {
  it('shows only a person’s tasks under Regular — and an automation’s children go with it', () => {
    expect(ids(filterTaskTable(runs, 'regular', NO_TASK_FILTERS, index))).toEqual(['mine'])
    expect(ids(filterTaskTable(runs, 'automation', NO_TASK_FILTERS, index))).toEqual([
      'nightly',
      'nightly-child',
      'triage',
    ])
    expect(ids(filterTaskTable(runs, 'all', NO_TASK_FILTERS, index))).toHaveLength(4)
  })

  it('ANDs facets and ORs values inside one', () => {
    const filters = { ...NO_TASK_FILTERS, statuses: ['done', 'failed'], workflows: ['review'] }
    expect(ids(filterTaskTable(runs, 'all', filters, index))).toEqual(['triage'])
  })

  it('narrows to one automation, but ignores that pick under Regular', () => {
    const filters = { ...NO_TASK_FILTERS, automations: ['auto-nightly'] }
    expect(ids(filterTaskTable(runs, 'automation', filters, index))).toEqual(['nightly', 'nightly-child'])
    expect(ids(filterTaskTable(runs, 'regular', filters, index))).toEqual(['mine'])
  })
})

describe('counts', () => {
  it('counts each origin under the current facets', () => {
    expect(originCounts(runs, NO_TASK_FILTERS, index)).toEqual({ regular: 1, automation: 3, all: 4 })
    expect(originCounts(runs, { ...NO_TASK_FILTERS, statuses: ['done'] }, index)).toEqual({
      regular: 0,
      automation: 2,
      all: 2,
    })
  })

  it('counts a facet against the OTHER facets, never its own ticks', () => {
    const filters = { ...NO_TASK_FILTERS, statuses: ['failed'] }
    const counts = taskFacetCounts(runs, 'all', filters, index, 'statuses')
    expect(counts.get('done')).toBe(2)
    expect(counts.get('running')).toBe(1)
    expect(counts.get('failed')).toBe(1)
  })
})

describe('the tag facet (spec 2026-11-23-task-tags § 7.5)', () => {
  const a = run({ tags: [{ id: 'tt-aaaaaaaa01', name: 'a' }] })
  const ab = run({ tags: [{ id: 'tt-aaaaaaaa01', name: 'a' }, { id: 'tt-bbbbbbbb01', name: 'b' }] })
  const none = run()
  const deletedOnly = run({ tags: [{ id: 'tt-deleted0001', name: 'gone' }] })
  const runs = [a, ab, none, deletedOnly]
  const autos = automationIndex(runs)
  const hidden = new Set(['tt-deleted0001'])
  const ids = (list: RunRecord[]) => list.map((r) => r.id)

  it('ORs selected tags and offers "No tag"', () => {
    expect(ids(filterTaskTable(runs, 'all', { ...NO_TASK_FILTERS, tags: ['tt-bbbbbbbb01', 'tt-aaaaaaaa01'] }, autos, hidden))).toEqual([a.id, ab.id])
    expect(ids(filterTaskTable(runs, 'all', { ...NO_TASK_FILTERS, tags: [' no-task-tag'] }, autos, hidden))).toEqual([none.id, deletedOnly.id])
  })

  it('counts each tag and the untagged bucket', () => {
    const counts = taskFacetCounts(runs, 'all', NO_TASK_FILTERS, autos, 'tags', hidden)
    expect(counts.get('tt-aaaaaaaa01')).toBe(2)
    expect(counts.get('tt-bbbbbbbb01')).toBe(1)
    expect(counts.get(' no-task-tag')).toBe(2)
    expect(counts.has('tt-deleted0001')).toBe(false)
  })
})
