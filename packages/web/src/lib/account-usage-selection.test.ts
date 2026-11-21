import { describe, expect, it } from 'vitest'

import { sortAccountUsageEntries } from '@/lib/account-usage-selection'

const entry = (routeId: string, provider: 'claude' | 'codex', isDefault = false) => ({
  id: routeId,
  routeId,
  provider,
  label: routeId,
  isDefault,
  usage: { at: '2026-10-23T08:00:00.000Z', limits: [] },
})

describe('sortAccountUsageEntries', () => {
  it('orders by provider, named accounts before the default, then by label', () => {
    const listed = [entry('codex', 'codex', true), entry('default', 'claude', true), entry('work', 'claude'), entry('team', 'claude')]
    expect(sortAccountUsageEntries(listed).map((e) => e.routeId)).toEqual(['team', 'work', 'default', 'codex'])
  })

  it('leaves the input untouched', () => {
    const listed = [entry('work', 'claude'), entry('team', 'claude')]
    sortAccountUsageEntries(listed)
    expect(listed.map((e) => e.routeId)).toEqual(['work', 'team'])
  })
})
