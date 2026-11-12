import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'

import {
  FINISHED_TODAY_CAP,
  failureHead,
  finishedTodayRows,
  needsYouReason,
  needsYouRows,
  runningRows,
  todayLabel,
} from './now-model'

const NOW = Date.parse('2026-11-11T14:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0
function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: ago(3_600_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

describe('needsYouRows — one reason, one action per row', () => {
  it('maps each open state to its reason and the action that resolves it', () => {
    const question = run({ id: 'q', status: 'failed', awaitingAnswerSince: ago(60_000) })
    const review = run({ id: 'rv', status: 'review' })
    const budget = run({
      id: 'b',
      status: 'waiting',
      waitingSince: ago(10_000),
      costUsd: 2.5,
      dispatch: { rootRunId: 'root', parentRunId: 'root', budgetUsd: 2, overBudget: true } as RunRecord['dispatch'],
    })
    const waiting = run({ id: 'w', status: 'waiting', waitingSince: ago(20_000) })
    const lifecycle = run({
      id: 'l',
      status: 'done',
      finishedAt: ago(30_000),
      worktreeLifecycle: { worktreeId: 'wt', generation: 1, phase: 'teardown', state: 'needs_attention', needsAttention: true },
    })
    const failed = run({ id: 'f', status: 'failed', error: 'API Error: cannot reach the API server\nstack line' })

    const rows = needsYouRows([failed, waiting, lifecycle, budget, review, question])
    expect(rows.map((row) => [row.run.id, row.reason, row.action])).toEqual([
      ['q', 'question', 'answer'],
      ['rv', 'review', 'review'],
      ['b', 'budget', 'resume'],
      ['w', 'waiting', 'reply'],
      ['l', 'lifecycle', 'open'],
      ['f', 'failed', 'retry'],
    ])
    expect(rows.find((row) => row.run.id === 'f')?.detail).toBe('API Error: cannot reach the API server')
    expect(rows.find((row) => row.run.id === 'b')?.detail).toBe('$2.50 of $2.00 spent')
    expect(rows.find((row) => row.run.id === 'f')?.tone).toBe('danger')
  })

  it('orders questions first, then the review gate, then waits, then failures — newest first within', () => {
    const olderQuestion = run({ id: 'q-old', status: 'failed', awaitingAnswerSince: ago(3_600_000) })
    const newerQuestion = run({ id: 'q-new', status: 'failed', awaitingAnswerSince: ago(60_000) })
    const failed = run({ id: 'f', status: 'failed', finishedAt: ago(10_000) })
    const review = run({ id: 'rv', status: 'review', finishedAt: ago(5_000) })
    expect(needsYouRows([failed, olderQuestion, review, newerQuestion]).map((row) => row.run.id)).toEqual([
      'q-new',
      'q-old',
      'rv',
      'f',
    ])
  })

  it('leaves out what asks for nothing: done, running, queued, archived, scheduled and idle-closed', () => {
    expect(needsYouReason(run({ status: 'done' }))).toBeUndefined()
    expect(needsYouReason(run({ status: 'running' }))).toBeUndefined()
    expect(needsYouReason(run({ status: 'queued' }))).toBeUndefined()
    expect(needsYouReason(run({ status: 'review', archived: true }))).toBeUndefined()
    expect(needsYouReason(run({ status: 'failed', autoResumeAt: ago(-60_000) }))).toBeUndefined()
    expect(needsYouReason(run({ status: 'failed', idleClosedAt: ago(60_000) }))).toBeUndefined()
  })

  it('bounds the failure line to its first line and ~140 characters', () => {
    expect(failureHead(undefined)).toBeUndefined()
    expect(failureHead('\n\n  short  \nmore')).toBe('short')
    expect(failureHead('x'.repeat(200))).toHaveLength(140)
    expect(failureHead('x'.repeat(200))?.endsWith('…')).toBe(true)
  })
})

describe('runningRows', () => {
  it('reads the active step, the rail progress, and keeps queued and scheduled runs beside the live ones', () => {
    const live = run({
      id: 'live',
      status: 'running',
      startedAt: ago(720_000),
      workflow: 'implement-and-verify',
      steps: [
        { id: 'a', name: 'Implement', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 },
        { id: 'b', name: 'Verify', kind: 'check', status: 'running', iterations: 1, tokensUsed: 0 },
        { id: 'c', name: 'Review', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0 },
      ],
    })
    const queued = run({ id: 'queued', status: 'queued' })
    const scheduled = run({ id: 'sched', status: 'failed', autoResumeAt: ago(-3_600_000) })
    const rows = runningRows([scheduled, queued, live, run({ status: 'done' }), run({ status: 'running', archived: true })])
    expect(rows.map((row) => [row.run.id, row.kind])).toEqual([
      ['live', 'running'],
      ['queued', 'queued'],
      ['sched', 'scheduled'],
    ])
    expect(rows[0]?.step).toEqual({ index: 2, total: 3, name: 'Verify' })
    expect(rows[0]?.progress).toBeCloseTo(0.5)
    expect(rows[1]?.step).toBeUndefined()
  })
})

describe('finishedTodayRows', () => {
  it('keeps today’s outcomes (done, cancelled, idle-closed), newest first, never failures or archived runs', () => {
    const rows = finishedTodayRows(
      [
        run({ id: 'd1', status: 'done', finishedAt: ago(3 * 3_600_000) }),
        run({ id: 'd2', status: 'done', finishedAt: ago(60_000) }),
        run({ id: 'c', status: 'cancelled', finishedAt: ago(2 * 3_600_000) }),
        run({ id: 'idle', status: 'failed', idleClosedAt: ago(100_000), finishedAt: ago(100_000) }),
        run({ id: 'yesterday', status: 'done', finishedAt: ago(30 * 3_600_000) }),
        run({ id: 'failed', status: 'failed', finishedAt: ago(60_000) }),
        run({ id: 'archived', status: 'done', archived: true, finishedAt: ago(60_000) }),
        run({ id: 'unfinished', status: 'done' }),
      ],
      NOW,
    )
    expect(rows.map((row) => row.id)).toEqual(['d2', 'idle', 'c', 'd1'])
  })

  it('caps the section at eight on screen', () => {
    expect(FINISHED_TODAY_CAP).toBe(8)
  })
})

describe('todayLabel', () => {
  it('spells the weekday and date in the given locale', () => {
    expect(todayLabel(NOW, 'en-US')).toBe('Wednesday, November 11')
  })
})
