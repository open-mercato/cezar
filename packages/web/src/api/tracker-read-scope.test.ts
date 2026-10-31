import { afterEach, expect, it, vi } from 'vitest'
import { setApiScope, type TrackerAssociation } from '@open-mercato/cezar-api-client'
import { getTrackerItem, getTrackerItems, searchTrackerItems } from './client'

afterEach(() => { vi.unstubAllGlobals(); setApiScope(null) })

it('sends captured source identity for list, search and detail reads', async () => {
  setApiScope('alpha')
  const association: TrackerAssociation = {
    kind: 'jira', source: { id: 'cloud-a', webUrl: 'https://a.atlassian.net' },
    externalId: '100', externalName: 'Project A', connectionId: '00000000-0000-4000-8000-000000000001',
  }
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requests.push(new URL(String(input), 'http://localhost'))
    return new Response(JSON.stringify({ available: false, code: 'source_changed', reason: 'Reconnect' }), { status: 200 })
  }))
  await getTrackerItems({ association })
  await searchTrackerItems('bug', { association })
  await getTrackerItem('OPS-1', { association })
  expect(requests.map(url => url.pathname)).toEqual([
    '/api/v1/p/alpha/tracker', '/api/v1/p/alpha/tracker/search', '/api/v1/p/alpha/tracker/OPS-1',
  ])
  expect(requests.map(url => url.searchParams.get('expectedScope'))).toEqual(Array(3).fill(
    JSON.stringify(['jira', 'cloud-a', 'https://a.atlassian.net', '100', association.connectionId]),
  ))
})
