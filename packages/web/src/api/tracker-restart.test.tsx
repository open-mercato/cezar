import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TrackerItemsResponse } from '@open-mercato/cezar-api-client'

import { createQueryClient } from './query-client'
import { queryKeys, useTrackerItems } from './queries'

const association = { kind: 'jira' as const, source: { id: 'cloud', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
const params = { state: 'all' as const, labels: ['bug'], query: '' }
const page = (title: string): TrackerItemsResponse => ({ available: true, items: [{ id: 'OPS-1', title, kind: 'issue', body: '', author: 'A', status: 'Open', createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z', url: 'https://acme.atlassian.net/1', labels: [], bodyTruncated: false, unsupportedContent: false }], truncated: true, nextCursor: title })
const old = { pages: [page('First'), page('Second')], pageParams: [undefined, 'First'] }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
function deferred() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
function setup(query = '') {
  const client = createQueryClient()
  const input = { ...params, query }
  const key = queryKeys.tracker.items(association, input)
  client.setQueryData(key, old)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, key, ...renderHook(() => useTrackerItems(association, input), { wrapper }) }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('retains every loaded page and cursor when fallback refresh is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ available: false, code: 'unavailable', reason: 'Temporary vendor outage' })))
  const { client, key, result } = setup()
  await act(async () => { await result.current.restart() })
  expect(client.getQueryData(key)).toEqual(old)
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.error?.message).toBe('Temporary vendor outage')
  expect(result.current.hasNextPage).toBe(true)
})

it.each(['', 'broken build'])('preserves pages while refreshing %j and replaces them atomically on success', async query => {
  const pending = deferred()
  const fetchMock = vi.fn<typeof fetch>(() => pending.promise)
  vi.stubGlobal('fetch', fetchMock)
  const { client, key, result } = setup(query)
  let refresh!: Promise<void>
  act(() => { refresh = result.current.restart() })
  await waitFor(() => expect(result.current.isFetching).toBe(true))
  expect(client.getQueryData(key)).toEqual(old)
  expect(result.current.hasNextPage).toBe(true)
  const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost')
  expect(requestUrl.searchParams.get('refresh')).toBe('1')
  expect(requestUrl.searchParams.has('cursor')).toBe(false)
  await act(async () => { pending.resolve(json(page('New'))); await refresh })
  expect(client.getQueryData(key)).toEqual({ pages: [page('New')], pageParams: [undefined] })
})

it('ignores a cancelled older refresh after its replacement has succeeded', async () => {
  const pending = deferred()
  const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(json(page('Latest')))
  vi.stubGlobal('fetch', fetchMock)
  const { client, key, result } = setup()
  let first!: Promise<void>
  act(() => { first = result.current.restart() })
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  await act(async () => { await result.current.restart() })
  await act(async () => { pending.resolve(json(page('Stale'))); await first })
  expect(client.getQueryData(key)).toEqual({ pages: [page('Latest')], pageParams: [undefined] })
})

it('keeps cached pages when an unmounted refresh completes late', async () => {
  const pending = deferred()
  const fetchMock = vi.fn<typeof fetch>(() => pending.promise)
  vi.stubGlobal('fetch', fetchMock)
  const { client, key, result, unmount } = setup()
  let refresh!: Promise<void>
  act(() => { refresh = result.current.restart() })
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  unmount()
  await act(async () => { pending.resolve(json(page('Late'))); await refresh })
  expect(client.getQueryData(key)).toEqual(old)
})

it('retains pages on a transport error and can paginate after a successful restart', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('Network lost'))
    .mockResolvedValueOnce(json(page('New')))
    .mockResolvedValueOnce(json(page('Next')))
  vi.stubGlobal('fetch', fetchMock)
  const { client, key, result } = setup()
  await act(async () => { await result.current.restart() })
  expect(client.getQueryData(key)).toEqual(old)
  await waitFor(() => expect(result.current.error?.message).toContain('cannot reach the cezar server'))
  await act(async () => { await result.current.restart() })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  await act(async () => { await result.current.fetchNextPage() })
  expect(client.getQueryData(key)).toEqual({ pages: [page('New'), page('Next')], pageParams: [undefined, 'New'] })
  const url = new URL(String(fetchMock.mock.calls[2]?.[0]), 'http://localhost')
  expect(url.searchParams.get('cursor')).toBe('New')
  expect(url.searchParams.has('refresh')).toBe(false)
})
