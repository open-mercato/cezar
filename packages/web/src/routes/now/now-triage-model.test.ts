import { describe, expect, it } from 'vitest'

import type { AttentionItem, RunRecord } from '@open-mercato/cezar-api-client'

import { isHidden, itemForRun, itemTarget, shortLabel, snoozeUntil, taskRowTarget } from './now-triage-model'

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
    expect(taskRowTarget(item, 'app', run, 'since', 'Ship')).toEqual({ key: question.key, label: 'Ship', questionKey: 'r:app:r1:req' })
  })

  it('keys a row the server does not list by its run and wait', () => {
    expect(taskRowTarget(undefined, 'app', run, '2026-11-20T10:00:00.000Z', 'Fix')).toEqual({ key: 'now:app:r1:2026-11-20T10:00:00.000Z', label: 'Fix' })
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
