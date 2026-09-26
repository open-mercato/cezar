import { afterEach, describe, expect, it } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'

import { queryKeys } from './queries'

describe('tracker query identity', () => {
  afterEach(() => setApiScope(null))

  it('prefixes project data with tracker and includes the saved association identity', () => {
    setApiScope('alpha')
    const association = {
      kind: 'jira' as const,
      source: { id: 'tenant-a', webUrl: 'https://a.atlassian.net' },
      externalId: '10001',
      externalName: 'OPS',
    }
    expect(queryKeys.tracker.items(association, { state: 'active', labels: ['bug'] })).toEqual([
      'tracker', 'alpha', 'items', 'jira', 'tenant-a', 'https://a.atlassian.net', '10001', null, 'active', ['bug'], '',
    ])
    expect(queryKeys.tracker.detail(association, 'OPS-7')).toEqual([
      'tracker', 'alpha', 'detail', 'jira', 'tenant-a', 'https://a.atlassian.net', '10001', null, 'OPS-7',
    ])
  })

  it('does not collide comma-bearing labels or sources with the same organization id', () => {
    setApiScope('alpha')
    const association = {
      kind: 'jira' as const,
      source: { id: 'tenant-a', webUrl: 'https://a.atlassian.net' },
      externalId: '10001', externalName: 'OPS',
    }
    expect(queryKeys.tracker.items(association, { state: 'active', labels: ['a,b'] }))
      .not.toEqual(queryKeys.tracker.items(association, { state: 'active', labels: ['a', 'b'] }))
    expect(queryKeys.tracker.detail(association, 'OPS-7')).not.toEqual(
      queryKeys.tracker.detail({ ...association, source: { ...association.source, webUrl: 'https://moved.atlassian.net' } }, 'OPS-7'),
    )
  })

  it('scopes provider candidates to the current project', () => {
    expect(queryKeys.tracker.candidates('linear', 'platform')).toEqual([
      'tracker', 'default', 'candidates', 'linear', 'platform',
    ])
  })
})
