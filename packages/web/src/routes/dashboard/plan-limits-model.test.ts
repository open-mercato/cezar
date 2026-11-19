import { describe, expect, it } from 'vitest'
import {
  chartGeometry,
  managerParts,
  panelQuery,
  ranTogether,
  remainderRows,
  topConsumersLine,
  windowChoices,
  windowSegments,
  windowStatus,
} from './plan-limits-model'
import { consumer, planWindow } from './plan-limits.fixture'

describe('plan limits model', () => {
  it('splits the bar into tasks, managers, unsplit, outside and left', () => {
    const segments = windowSegments(planWindow())
    expect(segments.map((s) => [s.id, s.pp])).toEqual([['tasks', 78], ['managers', 5], ['unsplit', 8], ['outside', 9]])
    expect(segments.reduce((n, s) => n + s.width, 0)).toBeCloseTo(100)
  })

  it('keeps before-tracking (unknown) apart from outside cezar, and shows what is left', () => {
    const w = planWindow({ consumers: [], usedPercent: { first: 40, last: 63 }, limitReachedAt: undefined, beforeTrackingPp: 40, outsideCezarPp: 4, unsplitPp: 0, leftPp: 37 })
    expect(windowSegments(w).find((s) => s.id === 'outside')).toMatchObject({ label: 'Outside cezar', pp: 4 })
    expect(windowSegments(w).find((s) => s.id === 'before')).toMatchObject({ label: 'Before tracking', pp: 40 })
    expect(windowSegments(w).find((s) => s.id === 'left')?.pp).toBe(37)
  })

  it('never draws wider than 100% when a correction inflates the parts', () => {
    const w = planWindow({ correctionPp: 10, unsplitPp: 18 })
    expect(windowSegments(w).reduce((n, s) => n + s.width, 0)).toBeCloseTo(100)
  })

  it('fills the bar to the reading when a provider correction lowered it (QA F5)', () => {
    const w = planWindow({ consumers: [], usedPercent: { first: 5, last: 30 }, limitReachedAt: undefined, beforeTrackingPp: 5, outsideCezarPp: 27, unsplitPp: 0, correctionPp: 2, leftPp: 70 })
    const used = windowSegments(w).filter((s) => s.id !== 'left').reduce((n, s) => n + s.width, 0)
    expect(used).toBeCloseTo(30)
  })

  it('shows usage across a recording gap as Not tracked, with why and when (QA F1)', () => {
    const w = planWindow({
      untrackedPp: 8,
      trackingGaps: [{ from: '2026-11-19T10:02:00.000Z', to: '2026-11-19T10:09:00.000Z', reason: 'tracking-off' }],
    })
    expect(windowSegments(w).find((s) => s.id === 'untracked')).toMatchObject({ label: 'Not tracked', pp: expect.any(Number) })
    const row = remainderRows(w).find((r) => r.id === 'untracked')!
    expect(row.value).toBe('8%')
    expect(row.label).toMatch(/^Not tracked · tracking was off .+–.+$/)
  })

  it('reads the header as a reading, not an estimate', () => {
    expect(windowStatus(planWindow())).toMatch(/^limit reached · back at /)
    const open = planWindow({ usedPercent: { first: 1, last: 18 }, limitReachedAt: undefined, leftPp: 82 })
    expect(windowStatus(open)).toMatch(/^18% used · resets /)
    expect(windowStatus(planWindow({ usedPercent: null, limitReachedAt: undefined }))).toMatch(/^no reading yet/)
  })

  it('lists top consumers with ≈, also for a task that ran alone', () => {
    expect(topConsumersLine(planWindow())).toBe('2 tasks · 1 manager · top: Drop waiting dot ≈ 53%, Retry temp-repo removal ≈ 25%, Release manager ≈ 5%')
    const alone = planWindow({ consumers: [consumer({ id: 'run:a/b', title: 'Solo', estimatePp: 18, aloneInferredPp: 18 })] })
    expect(topConsumersLine(alone)).toBe('1 task · top: Solo ≈ 18%')
    expect(topConsumersLine(planWindow({ consumers: [] }))).toBeNull()
  })

  it('describes who a consumer ran with and a manager’s parts', () => {
    const [retry, drop, mgr] = planWindow().consumers
    expect(ranTogether(retry!)).toBe('3 tasks')
    expect(ranTogether(drop!)).toBe('3 tasks, manager')
    expect(ranTogether(consumer({ id: 'x', title: 'x', estimatePp: 1 }))).toBe('—')
    expect(managerParts(mgr!)).toBe('chat ≈ 4% · watch ≈ 0.6% · job ≈ 0.4%')
    expect(managerParts(retry!)).toBeNull()
  })

  it('shows only remainder rows above zero, correction as a negative', () => {
    expect(remainderRows(planWindow()).map((r) => r.label)).toEqual(["Couldn't be split", 'Outside cezar'])
    const rows = remainderRows(planWindow({ beforeTrackingPp: 3, correctionPp: 2 }))
    expect(rows.map((r) => [r.id, r.value])).toEqual([['unsplit', '8%'], ['outside', '9%'], ['before', '3%'], ['correction', '−2%']])
  })

  it('draws a step path across the window with the limit marker', () => {
    const g = chartGeometry(planWindow({ current: false }), 500, 100)
    expect(g.path).toBe('M8.3,95 H200 V50 H433.3 V0 H500')
    expect(g.limit?.x).toBeCloseTo(433.3)
    expect(g.ticks).toHaveLength(6)
    expect(chartGeometry(planWindow({ readings: [] }), 500, 100).path).toBe('')
  })

  it('parses the panel URL params', () => {
    expect(panelQuery(null, null)).toEqual({ kind: 'five-hour', window: 'current' })
    expect(panelQuery('previous', 'weekly')).toEqual({ kind: 'weekly', window: 'previous' })
    expect(panelQuery('claude:default|five-hour|x', 'weekly')).toEqual({ window: 'claude:default|five-hour|x' })
    expect(panelQuery(null, 'bogus')).toEqual({ kind: 'five-hour', window: 'current' })
  })

  it('offers current, previous, week and older windows without repeating previous', () => {
    const older = [
      planWindow({ id: 'w1', current: false, startsAt: '2026-11-19T05:00:00.000Z', resetsAt: '2026-11-19T10:00:00.000Z' }),
      planWindow({ id: 'w0', current: false, startsAt: '2026-11-18T05:00:00.000Z', resetsAt: '2026-11-18T10:00:00.000Z' }),
      planWindow({ id: 'now' }),
    ]
    const choices = windowChoices('five-hour', older, undefined, new Date('2026-11-19T14:00:00.000Z'))
    expect(choices.map((c) => c.value)).toEqual(['five-hour:current', 'five-hour:previous', 'weekly:current', 'weekly:previous', 'w0'])
    expect(choices.at(-1)!.label).toMatch(/^5h · .*–/)
    expect(windowChoices('five-hour', [], 'gone').at(-1)).toEqual({ value: 'gone', label: 'Selected window' })
  })
})
