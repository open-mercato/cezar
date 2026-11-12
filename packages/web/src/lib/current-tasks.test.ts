import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import { CURRENT_TASKS_LIMIT, currentTasks } from './current-tasks'

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
