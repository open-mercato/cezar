import { describe, expect, it } from 'vitest'

import type { AttentionItem, RunRecord } from '@open-mercato/cezar-api-client'

import { isHidden, isRunHidden, itemForRun, itemTarget, keyedQueue, orderNeedsYou, shortLabel, snoozeUntil, taskRowTarget } from './now-triage-model'

/** Needs you triage (spec 2026-11-23-needs-you-triage). */

const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime()
const run = { id: 'r1' } as RunRecord
const question: AttentionItem = { key: 'question:r:app:r1:req', kind: 'question', title: 'Ship it?', since: '', counted: true, projectId: 'app', runId: 'r1', questionKey: 'r:app:r1:req' }

describe('snoozeUntil', () => {
  it('ends an hour, an evening, a morning or a week later, in local time', () => {
    const wednesdayNoon = local(2026, 10, 25, 12)
    expect(snoozeUntil('hour', wednesdayNoon).getTime()).toBe(wednesdayNoon + 3_600_000)
    expect(snoozeUntil('evening', wednesdayNoon).getTime()).toBe(local(2026, 10, 25, 18))
    expect(snoozeUntil('evening', local(2026, 10, 25, 19)).getTime()).toBe(local(2026, 10, 26, 18))
    expect(snoozeUntil('tomorrow', wednesdayNoon).getTime()).toBe(local(2026, 10, 26, 9))
    expect(snoozeUntil('week', wednesdayNoon).getTime()).toBe(local(2026, 10, 30, 9))
    // A Monday snoozed "until next week" is the next Monday, never today.
    expect(snoozeUntil('week', local(2026, 10, 30, 8)).getTime()).toBe(local(2026, 11, 7, 9))
  })
})

describe('row targets', () => {
  it('borrows the server item’s key and question for a task row, by project and run', () => {
    expect(itemForRun([question], 'other', 'r1')).toBeUndefined()
    const item = itemForRun([question], 'app', 'r1')
    expect(taskRowTarget(item, 'app', run, 'since', 'Ship')).toEqual({ key: question.key, label: 'Ship', questionKey: 'r:app:r1:req', projectId: 'app', runId: 'r1' })
  })

  it('keys a row the server does not list by its run and wait', () => {
    expect(taskRowTarget(undefined, 'app', run, '2026-11-20T10:00:00.000Z', 'Fix')).toEqual({ key: 'now:app:r1:2026-11-20T10:00:00.000Z', label: 'Fix', projectId: 'app', runId: 'r1' })
  })

  it('closes the card only for a question', () => {
    expect(itemTarget(question).questionKey).toBe('r:app:r1:req')
    expect(itemTarget({ ...question, kind: 'task' }).questionKey).toBeUndefined()
  })

  it('hides a dismissed key and a question waiting out its undo window, never a kept one', () => {
    const target = itemTarget(question)
    expect(isHidden(target, [], new Set())).toBe(false)
    expect(isHidden(target, [{ key: question.key, mode: 'dismiss', at: '' }], new Set())).toBe(true)
    expect(isHidden(target, [{ key: question.key, mode: 'keep', at: '' }], new Set())).toBe(false)
    expect(isHidden(target, undefined, new Set(['r:app:r1:req']))).toBe(true)
  })
})

describe('shortLabel', () => {
  it('names references plainly and stays on one line', () => {
    expect(shortLabel('Send notes on [[pr:cezar/2426]] to [[task:cezar/abc]]')).toBe('Send notes on #2426 to task')
    expect(shortLabel('x'.repeat(60))).toHaveLength(48)
  })
})

describe('keyedQueue', () => {
  it('starts an undo only after the dismiss it undoes has settled, even a failed one', async () => {
    const run = keyedQueue()
    const order: string[] = []
    let finishDismiss!: () => void
    const dismiss = run('k', () => new Promise<void>((resolve) => { finishDismiss = () => { order.push('dismiss'); resolve() } }))
    const clear = run('k', async () => { order.push('clear') })
    const other = run('other', async () => { order.push('other') })
    await other
    expect(order).toEqual(['other'])
    finishDismiss()
    await Promise.all([dismiss, clear])
    expect(order).toEqual(['other', 'dismiss', 'clear'])

    const failed = run('k', () => Promise.reject(new Error('offline')))
    await expect(failed).rejects.toThrow('offline')
    await expect(run('k', async () => 'after')).resolves.toBe('after')
  })
})

describe('orderNeedsYou', () => {
  it('puts a row past half the Older days below the fresh ones of its tier, whatever its kind', () => {
    const now = Date.parse('2026-11-23T12:00:00.000Z')
    const row = (id: string, tier: number, rank: number, hours: number) => ({ id, tier, rank, since: new Date(now - hours * 3_600_000).toISOString() })
    // An approval (rank 0) waiting 100 h, a question (rank 1) 2 h old, a review in the next tier.
    const rows = [row('review', 1, 3, 1), row('old-approval', 0, 0, 100), row('fresh-question', 0, 1, 2)]
    // Off: approvals lead their tier, as the kind rank says.
    expect(orderNeedsYou(rows, 0, now).map((entry) => entry.id)).toEqual(['old-approval', 'fresh-question', 'review'])
    // Older 7 days: half is 84 h, so the approval is aging and drops below the fresh question, never below its tier.
    expect(orderNeedsYou(rows, 7, now).map((entry) => entry.id)).toEqual(['fresh-question', 'old-approval', 'review'])
    // Older 10 days: half is 120 h, the approval is still fresh.
    expect(orderNeedsYou(rows, 10, now).map((entry) => entry.id)).toEqual(['old-approval', 'fresh-question', 'review'])
  })
})

describe('isRunHidden (review finding 3)', () => {
  it('hides the run’s waits that began before the dismissal, never a later one', () => {
    const overrides = [{ key: 'question:r:app:r1:q', mode: 'dismiss' as const, at: '2026-11-23T12:00:00.000Z', projectId: 'app', runId: 'r1' }]
    expect(isRunHidden('app', 'r1', '2026-11-23T11:00:00.000Z', overrides)).toBe(true)
    expect(isRunHidden('app', 'r1', '2026-11-23T13:00:00.000Z', overrides)).toBe(false)
    expect(isRunHidden('app', 'r2', '2026-11-23T11:00:00.000Z', overrides)).toBe(false)
    expect(isRunHidden(undefined, 'r1', '2026-11-23T11:00:00.000Z', overrides)).toBe(false)
  })
})

