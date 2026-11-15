import { describe, expect, it } from 'vitest'
import { AUTOMATION_ORDER_LIMIT } from '@open-mercato/cezar-api-client'
import { moveAutomation, nextAutomationRun, normalizeAutomationOrder, orderAutomations } from './automation-order'
import { entry, NOW, TIME_ZONE } from './automations-list.fixtures'

const a = entry({ id: 'a', name: 'Alpha', kind: 'schedule', nextRunAt: '2026-09-17T04:00:00Z' })
const b = entry({ id: 'b', name: 'Beta', kind: 'schedule', nextRunAt: '2026-09-16T11:00:00Z' })
const ids = (items: typeof a[]) => items.map((item) => item.id)
const sorted = (items: typeof a[], prefs: unknown) => orderAutomations(items, normalizeAutomationOrder(prefs), TIME_ZONE, NOW)

describe('automation list ordering', () => {
  it('keeps the alphabetical default without mutating the live list', () => {
    const input = [b, a]
    expect(ids(sorted(input, undefined))).toEqual(['a', 'b'])
    expect(ids(input)).toEqual(['b', 'a'])
  })

  it('normalizes absent, malformed, duplicate and oversized saved IDs', () => {
    expect(normalizeAutomationOrder(null)).toEqual({ sort: 'name', order: [] })
    expect(normalizeAutomationOrder({ sort: 'bad', order: [null, '', ' a ', 'a', 2, 'x'.repeat(201), 'b'] }))
      .toEqual({ sort: 'name', order: ['a', 'b'] })
    expect(normalizeAutomationOrder({ order: Array.from({ length: 300 }, (_, i) => `id${i}`) }).order)
      .toHaveLength(AUTOMATION_ORDER_LIMIT)
  })

  it('ignores removed IDs without hiding rows and puts new rows above placed ones', () => {
    const c = entry({ id: 'c', name: 'New', kind: 'github' })
    expect(ids(sorted([a, c, b], { sort: 'manual', order: ['gone', 'b', 'a'] }))).toEqual(['c', 'b', 'a'])
    expect(ids(sorted([{ ...a, name: 'Zed', enabled: false }, b], { sort: 'manual', order: ['a', 'b'] })))
      .toEqual(['a', 'b'])
  })

  it('breaks equal names and equal next times by ID', () => {
    const twin = { ...a, id: 'z' }
    expect(ids(sorted([twin, a], { sort: 'name' }))).toEqual(['a', 'z'])
    expect(ids(sorted([twin, a], { sort: 'nextRun' }))).toEqual(['a', 'z'])
  })

  it('sorts scheduled instants before continuous polls and unavailable rows', () => {
    const poll = entry({ id: 'poll', name: 'Poll', kind: 'tracker' })
    const paused = { ...b, id: 'paused', enabled: false }
    const invalid = { ...a, id: 'invalid', nextRunAt: 'invalid' }
    expect(ids(sorted([poll, paused, a, invalid, b], { sort: 'nextRun' })))
      .toEqual(['b', 'a', 'poll', 'invalid', 'paused'])
    expect(nextAutomationRun(invalid, TIME_ZONE, NOW)).toBeNull()
    expect(nextAutomationRun(paused, TIME_ZONE, NOW)).toBeNull()
  })

  it('uses the same computed schedule fallback as the Next run display', () => {
    const scheduled = entry({ id: 's', name: 'Scheduled', kind: 'schedule', schedule: { type: 'daily', hour: 11, minute: 0 } })
    expect(nextAutomationRun(scheduled, TIME_ZONE, NOW)).toBe(Date.parse('2026-09-16T11:00:00Z'))
    expect(ids(sorted([a, scheduled], { sort: 'nextRun' }))).toEqual(['s', 'a'])
  })

  it('uses an earlier secondary schedule from a newer response when no next instant is supplied', () => {
    const scheduled = { ...entry({ id: 's', name: 'Scheduled', kind: 'schedule', schedule: { type: 'daily', hour: 16 } }),
      schedules: [{ type: 'daily' as const, hour: 16 }, { type: 'daily' as const, hour: 11 }] }
    expect(nextAutomationRun(scheduled, TIME_ZONE, NOW)).toBe(Date.parse('2026-09-16T11:00:00Z'))
  })

  it('moves a chosen position and ignores drops outside the current list', () => {
    expect(moveAutomation(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveAutomation(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
    expect(moveAutomation(['a', 'b'], 0, 2)).toEqual(['a', 'b'])
    expect(sorted([], { sort: 'manual', order: ['gone'] })).toEqual([])
  })
})
