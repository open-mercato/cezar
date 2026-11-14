import { afterEach, describe, expect, it } from 'vitest'

import { managerFixture } from '@/routes/manager/manager-fixtures'

import {
  HEADS_SEEN_KEY,
  diffArrivals,
  headAnnouncement,
  headKind,
  headLine,
  readHeadMemory,
  restingHeads,
  settleLater,
  writeHeadMemory,
} from './manager-heads'

afterEach(() => sessionStorage.clear())

describe('headKind', () => {
  it('a request needs you until its chat is opened; news is only what was judged important', () => {
    expect(headKind(managerFixture({ unread: 1, pendingActions: 1 }))).toBe('approval')
    expect(headKind(managerFixture({ unread: 1, pendingQuestions: 2 }))).toBe('question')
    expect(headKind(managerFixture({ unread: 0, pendingActions: 1 }))).toBeNull()
    expect(headKind(managerFixture({ unread: 1, important: 1 }))).toBe('news')
    expect(headKind(managerFixture({ unread: 5 }))).toBeNull()
  })
})

describe('copy', () => {
  it('quotes the latest line for a request, the headline for news', () => {
    const manager = managerFixture({ name: 'Scout', preview: 'Merge #2081?', headline: 'Old news', unread: 1, pendingActions: 1 })
    expect(headLine(manager, 'approval')).toBe('Merge #2081?')
    expect(headLine(manager, 'news')).toBe('Old news')
    expect(headLine(managerFixture({ unread: 1, pendingActions: 2 }), 'approval')).toBe('2 approvals waiting')
    expect(headAnnouncement(manager, 'approval')).toBe('Scout asks for an approval: Merge #2081?')
  })
})

describe('Later marks', () => {
  it('drop once nothing waits and lower with the count, so the next rise shows', () => {
    const later = { a: 2, b: 1, gone: 3 }
    const settled = settleLater(later, [
      managerFixture({ id: 'a', pendingActions: 1 }),
      managerFixture({ id: 'b' }),
    ])
    expect(settled).toEqual({ a: 1 })
    expect(settleLater(settled, [managerFixture({ id: 'a', pendingActions: 1 })])).toBe(settled)
  })
})

describe('arrivals', () => {
  it('only a count past what this tab showed is an arrival; the oldest head comes first', () => {
    const a = managerFixture({ id: 'a', unread: 1, pendingActions: 1, lastActivityAt: '2026-11-13T10:00:00.000Z' })
    const b = managerFixture({ id: 'b', unread: 1, important: 1, lastActivityAt: '2026-11-13T09:00:00.000Z' })
    const heads = restingHeads([a, b], {})
    expect(heads.map((head) => head.manager.id)).toEqual(['b', 'a'])
    const { arrivals, seen } = diffArrivals({ b: 1 }, [a, b], heads)
    expect(arrivals.map((head) => head.manager.id)).toEqual(['a'])
    expect(seen).toEqual({ a: 1, b: 1 })
    expect(restingHeads([a, b], { a: 1 }).map((head) => head.manager.id)).toEqual(['b'])
  })

  it('memory survives a reload and tolerates junk', () => {
    writeHeadMemory(HEADS_SEEN_KEY, { a: 2 })
    expect(readHeadMemory(HEADS_SEEN_KEY)).toEqual({ a: 2 })
    sessionStorage.setItem(HEADS_SEEN_KEY, '{"a":"x","b":1}')
    expect(readHeadMemory(HEADS_SEEN_KEY)).toEqual({ b: 1 })
    sessionStorage.setItem(HEADS_SEEN_KEY, 'nope')
    expect(readHeadMemory(HEADS_SEEN_KEY)).toEqual({})
  })
})
