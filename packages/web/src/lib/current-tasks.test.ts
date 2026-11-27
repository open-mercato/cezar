import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { CURRENT_TASKS_LIMIT, currentTaskTree, currentTasks, needsYouCount } from './current-tasks'

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
    finishedAt: `2026-07-14T1${seq % 10}:00:00.000Z`,
    seenAt: '2026-07-15T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

describe('currentTasks', () => {
  it('orders needs-you first, then running, then the most recent finished', () => {
    const done = run({ id: 'done', finishedAt: '2026-07-14T12:00:00.000Z' })
    const older = run({ id: 'older', finishedAt: '2026-07-14T09:00:00.000Z' })
    const running = run({ id: 'running', status: 'running', startedAt: '2026-07-14T08:00:00.000Z' })
    const review = run({ id: 'review', status: 'review', finishedAt: '2026-07-14T07:00:00.000Z' })
    const failed = run({ id: 'failed', status: 'failed', finishedAt: '2026-07-14T06:00:00.000Z' })
    const waiting = run({ id: 'waiting', status: 'waiting', finishedAt: '2026-07-14T05:00:00.000Z' })
    expect(currentTasks([older, done, running, review, failed, waiting]).map((r) => r.id)).toEqual([
      // Inside the needs-you tier the attention ladder decides: error outranks waiting/review.
      'failed',
      'review',
      'waiting',
      'running',
      'done',
      'older',
    ])
  })

  it('caps at six rows and never lists archived runs', () => {
    const runs = Array.from({ length: 9 }, (_, index) =>
      run({ id: `t${index}`, finishedAt: `2026-07-14T1${index}:00:00.000Z` }),
    )
    const archived = run({ id: 'archived', status: 'review', archived: true })
    const result = currentTasks([archived, ...runs])
    expect(result).toHaveLength(CURRENT_TASKS_LIMIT)
    expect(result.map((r) => r.id)).toEqual(['t8', 't7', 't6', 't5', 't4', 't3'])
  })

  it('puts a pinned task ahead of its unpinned peers within a tier, never across tiers', () => {
    const pinned = run({ id: 'pinned', pinned: true, finishedAt: '2026-07-14T01:00:00.000Z' })
    const newer = run({ id: 'newer', finishedAt: '2026-07-14T12:00:00.000Z' })
    const running = run({ id: 'running', status: 'running' })
    expect(currentTasks([newer, pinned, running]).map((r) => r.id)).toEqual(['running', 'pinned', 'newer'])
  })

  it('honours an explicit limit', () => {
    const runs = [run(), run(), run()]
    expect(currentTasks(runs, 2)).toHaveLength(2)
  })
})

describe('currentTaskTree (#2383)', () => {
  const child = (id: string, parent: string, over: Partial<RunRecord> = {}) =>
    run({ id, dispatch: { rootRunId: parent, parentRunId: parent }, ...over })

  it('keeps a child under its parent even when the child alone would outrank the parent', () => {
    const parent = run({ id: 'p', finishedAt: '2026-07-14T01:00:00.000Z' })
    const kid = child('k', 'p', { status: 'review' })
    const tree = currentTaskTree([kid, parent])
    expect(tree.map((n) => n.run.id)).toEqual(['p'])
    expect(tree[0]!.children.map((n) => n.run.id)).toEqual(['k'])
    expect(needsYouCount(tree[0]!)).toBe(1)
  })

  it('groups before the cap: the budget counts top-level groups, children are never peers', () => {
    const parent = run({ id: 'p' })
    const kids = Array.from({ length: 8 }, (_, i) => child(`k${i}`, 'p'))
    const others = Array.from({ length: 5 }, (_, i) => run({ id: `o${i}`, finishedAt: `2026-07-14T1${i}:00:00.000Z` }))
    const tree = currentTaskTree([...kids, parent, ...others])
    expect(tree).toHaveLength(6)
    expect(tree.find((n) => n.run.id === 'p')!.childCount).toBe(8)
    expect(tree.some((n) => n.run.id.startsWith('k'))).toBe(false)
  })

  it('ranks a group by its most urgent member and nests descendants', () => {
    const calm = run({ id: 'calm', finishedAt: '2026-07-14T23:00:00.000Z' })
    const p = run({ id: 'p', finishedAt: '2026-07-14T01:00:00.000Z' })
    const mid = child('mid', 'p')
    const deep = child('deep', 'mid', { status: 'waiting' })
    const tree = currentTaskTree([calm, p, mid, deep])
    expect(tree.map((n) => n.run.id)).toEqual(['p', 'calm'])
    expect(tree[0]!.children[0]!.children[0]!.run.id).toBe('deep')
    expect(tree[0]!.descendantCount).toBe(2)
  })

  it('roots a child whose parent is absent or archived', () => {
    const archived = run({ id: 'a', archived: true })
    const orphan = child('o', 'a')
    const missing = child('m', 'gone')
    expect(currentTaskTree([archived, orphan, missing]).map((n) => n.run.id).sort()).toEqual(['m', 'o'])
  })
})
