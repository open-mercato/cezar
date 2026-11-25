import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import type { AttentionItem, AttentionResponse } from '@open-mercato/cezar-api-client'

import { applyOverrideLocally, attentionKeys, countAttentionItems } from './attention'

/** Needs you triage (spec 2026-11-23-needs-you-triage): the click moves the badge before the server answers. */

const item = (over: Partial<AttentionItem> & Pick<AttentionItem, 'key' | 'kind'>): AttentionItem => ({ title: over.key, since: '2026-11-23T10:00:00.000Z', counted: true, ...over })

function seeded(items: AttentionItem[]) {
  const client = new QueryClient()
  const data: AttentionResponse = { items, counts: countAttentionItems(items), revision: 'r', overrides: [], olderAfterDays: 7 }
  client.setQueryData(attentionKeys.all, data)
  return { client, read: () => client.getQueryData<AttentionResponse>(attentionKeys.all)! }
}

describe('applyOverrideLocally (review finding 8)', () => {
  it('drops a dismissed item and its count at once, keeping the run it names', () => {
    const { client, read } = seeded([item({ key: 'a', kind: 'task', projectId: 'p', runId: 'r' }), item({ key: 'b', kind: 'question' })])
    expect(read().counts.total).toBe(2)
    applyOverrideLocally(client, { key: 'a', mode: 'dismiss', projectId: 'p', runId: 'r' })
    expect(read().items.map((row) => row.key)).toEqual(['b'])
    expect(read().counts).toMatchObject({ total: 1, task: 0, question: 1 })
    expect(read().overrides[0]).toMatchObject({ key: 'a', mode: 'dismiss', projectId: 'p', runId: 'r' })
    applyOverrideLocally(client, { key: 'a', mode: 'clear' })
    expect(read().overrides).toEqual([])
  })

  it('"keep" counts a probably-done item again, but never a muted manager’s', () => {
    const settled = { why: 'quiet' as const, detail: 'Quiet for 9 days' }
    const { client, read } = seeded([
      item({ key: 'live', kind: 'task', settled }),
      item({ key: 'muted', kind: 'question', managerId: 'm', counted: false, settled }),
    ])
    expect(read().counts.total).toBe(0)
    applyOverrideLocally(client, { key: 'live', mode: 'keep' })
    applyOverrideLocally(client, { key: 'muted', mode: 'keep' })
    expect(read().items.map((row) => [row.key, row.settled, row.counted])).toEqual([['live', undefined, true], ['muted', undefined, false]])
    expect(read().counts).toMatchObject({ total: 1, task: 1, question: 1 })
  })
})
