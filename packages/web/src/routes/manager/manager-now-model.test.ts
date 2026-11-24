import { describe, expect, it } from 'vitest'

import type { AttentionItem } from '@open-mercato/cezar-api-client'

import { countLive, managerFilter, managerNowEntries, managerNowHref, ownedBy } from './manager-now-model'

/** Manager mode's Now (spec 2026-11-23-needs-you-triage § Manager mode). */

const item = (over: Partial<AttentionItem> & Pick<AttentionItem, 'key' | 'kind'>): AttentionItem => ({ title: over.key, since: '', counted: true, ...over })
const managers = [
  { id: 'scout', name: 'Scout', followedTasks: ['app/r1', 'app/r2'] },
  { id: 'mobile', name: 'Mobile', followedTasks: ['app/r2'] },
]

describe('managerNowEntries', () => {
  const items = [
    item({ key: 'q', kind: 'question', managerId: 'scout' }),
    item({ key: 'a', kind: 'approval', managerId: 'mobile' }),
    item({ key: 'gone', kind: 'question', managerId: 'deleted' }),
    item({ key: 't1', kind: 'review', projectId: 'app', runId: 'r1' }),
    item({ key: 't2', kind: 'task', projectId: 'app', runId: 'r2' }),
    item({ key: 'mine', kind: 'task', projectId: 'app', runId: 'r9' }),
  ]

  it('keeps a manager’s own items and the tasks it started or follows, nothing else', () => {
    expect(managerNowEntries(items, managers).map((entry) => [entry.item.key, entry.owners])).toEqual([
      ['q', ['scout']],
      ['a', ['mobile']],
      ['t1', ['scout']],
      ['t2', ['scout', 'mobile']],
    ])
  })

  it('filters to one manager, a shared task included; all by default', () => {
    const entries = managerNowEntries(items, managers)
    expect(ownedBy(entries, undefined)).toHaveLength(4)
    expect(ownedBy(entries, 'mobile').map((entry) => entry.item.key)).toEqual(['a', 't2'])
    expect(ownedBy(entries, 'scout').map((entry) => entry.item.key)).toEqual(['q', 't1', 't2'])
  })

  it('counts as Now counts: not probably done, not uncounted', () => {
    const entries = managerNowEntries([
      ...items,
      item({ key: 'done', kind: 'question', managerId: 'scout', settled: { why: 'quiet', detail: 'Quiet for 9 days' } }),
      item({ key: 'muted', kind: 'question', managerId: 'scout', counted: false }),
    ], managers)
    expect(countLive(entries)).toBe(4)
    expect(countLive(ownedBy(entries, 'scout'))).toBe(3)
  })
})

describe('the filter', () => {
  it('reads a known manager, and falls back to All for one that is gone', () => {
    expect(managerFilter(new URLSearchParams('manager=scout'), managers)).toBe('scout')
    expect(managerFilter(new URLSearchParams('manager=deleted'), managers)).toBeUndefined()
    expect(managerFilter(new URLSearchParams(''), managers)).toBeUndefined()
    expect(managerNowHref()).toBe('/manager/now')
    expect(managerNowHref('scout')).toBe('/manager/now?manager=scout')
  })
})
