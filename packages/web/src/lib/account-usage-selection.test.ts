import { describe, expect, it } from 'vitest'

import { COCKPIT_USAGE_STALE_MS } from '@/components/live-usage'
import { isAccountUsageStale, mergeAccountUsageEntries } from '@/lib/account-usage-selection'

const entry = (routeId: string, provider: 'claude' | 'codex', at: string) => ({
  id: routeId,
  routeId,
  provider,
  label: routeId,
  isDefault: false,
  usage: {
    at,
    limits: [{ window: 'five_hour', utilization: 0.3, resetsAt: new Date(Date.parse(at) + 3_600_000).toISOString() }],
  },
})

describe('mergeAccountUsageEntries', () => {
  it('dedupes by routeId and keeps the fetched snapshot', () => {
    const listed = [entry('work', 'claude', '2026-10-23T08:00:00.000Z')]
    const fetched = [entry('work', 'claude', '2026-10-23T09:00:00.000Z')]
    expect(mergeAccountUsageEntries(listed, fetched)[0]?.usage.at).toBe(fetched[0]!.usage.at)
  })

  it('falls back to listed rows when fetch is empty', () => {
    const listed = [entry('work', 'claude', '2026-10-23T08:00:00.000Z'), entry('team', 'claude', '2026-10-23T08:00:00.000Z')]
    expect(mergeAccountUsageEntries(listed, []).map((e) => e.routeId)).toEqual(['team', 'work'])
  })
})

describe('isAccountUsageStale', () => {
  const now = Date.parse('2026-10-23T10:00:00.000Z')

  it('marks readings older than the cockpit stale bound', () => {
    const at = new Date(now - COCKPIT_USAGE_STALE_MS - 1).toISOString()
    expect(isAccountUsageStale(at, now, COCKPIT_USAGE_STALE_MS)).toBe(true)
    expect(isAccountUsageStale(new Date(now - COCKPIT_USAGE_STALE_MS + 60_000).toISOString(), now, COCKPIT_USAGE_STALE_MS)).toBe(false)
  })
})