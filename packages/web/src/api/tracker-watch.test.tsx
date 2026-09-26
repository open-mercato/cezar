import { QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { TrackerItemsResponse, TrackerWatchSnapshot } from '@open-mercato/cezar-api-client'
import { createQueryClient } from './query-client'
import { useTrackerWatch } from './tracker-watch'

const mocks = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn(), refresh: vi.fn(), subscribe: vi.fn(), health: { capabilities: { localHandoff: true } } }))
vi.mock('./client', () => ({ openTrackerWatch: mocks.open, readTrackerWatch: mocks.read, refreshTrackerWatch: mocks.refresh }))
vi.mock('./queries', () => ({ useHealth: () => ({ data: mocks.health }), workspaceQueryKeys: { projects: ['workspace', 'projects'] } }))
vi.mock('./ws', () => ({ subscribeTopic: mocks.subscribe }))
afterEach(() => { mocks.health.capabilities.localHandoff = true; cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })
const input = { association: { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.com' }, externalId: '1', externalName: 'One' }, query: '', labels: [], state: 'active' as const }
const page = (title: string): TrackerItemsResponse => ({ available: true, items: [{ id: 'ONE-1', title, kind: 'issue', body: '', author: 'A', status: 'Open', createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z', url: 'https://example.com/1', labels: [], bodyTruncated: false, unsupportedContent: false }], truncated: false })
it('updates page one, preserves loaded pages with a banner, and applies the latest snapshot on demand', async () => {
  const client = createQueryClient()
  const key = ['tracker', 'default', 'items']
  client.setQueryData(key, { pages: [page('Old')], pageParams: [undefined] })
  let signal!: (data: unknown) => void
  const off = vi.fn()
  mocks.subscribe.mockImplementation((_topic, listener) => { signal = listener; return off })
  mocks.open.mockResolvedValue({ id: 'watch', topic: 'tracker:watch' })
  let snapshot: TrackerWatchSnapshot = { version: 1, checkedAt: '2026-09-19T01:00:00Z', checking: false, result: page('Fresh') }
  mocks.read.mockImplementation(async () => snapshot)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, unmount } = renderHook(() => useTrackerWatch(input, key), { wrapper })
  await waitFor(() => expect(result.current.checkedAt).toBe(snapshot.checkedAt))
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>(key)?.pages).toEqual([page('Fresh')])
  act(() => { client.setQueryData(key, { pages: [page('Fresh'), page('Second')], pageParams: [undefined, 'next'] }) })
  snapshot = { ...snapshot, version: 2, checkedAt: '2026-09-19T01:01:00Z', result: page('Changed') }
  act(() => signal({ version: 2 }))
  await waitFor(() => expect(result.current.hasChanges).toBe(true))
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>(key)?.pages).toHaveLength(2)
  await act(async () => { await result.current.applyChanges() })
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>(key)?.pages).toEqual([page('Changed')])
  unmount()
  expect(off).toHaveBeenCalledTimes(1)
})
it('releases hidden-view demand and ignores a response that arrives after hiding', async () => {
  const client = createQueryClient()
  const key = ['tracker', 'default', 'items']
  client.setQueryData(key, { pages: [page('Old')], pageParams: [undefined] })
  const off = vi.fn()
  mocks.subscribe.mockReturnValue(off)
  mocks.open.mockResolvedValue({ id: 'watch', topic: 'tracker:watch' })
  let finish!: (s: TrackerWatchSnapshot) => void
  mocks.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useTrackerWatch(input, key), { wrapper })
  await waitFor(() => expect(mocks.read).toHaveBeenCalled())
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(off).toHaveBeenCalled()
  await act(async () => finish({ version: 2, checkedAt: '2026-09-19T01:01:00Z', checking: false, result: page('Late') }))
  expect(result.current.checkedAt).toBeNull()
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>(key)?.pages).toEqual([page('Old')])
})
it('uses abortable HTTP long reads in remote mode and never subscribes to a WebSocket', async () => {
  mocks.health.capabilities.localHandoff = false
  const client = createQueryClient()
  const key = ['tracker', 'default', 'items']
  mocks.open.mockResolvedValue({ id: 'watch', topic: 'tracker:watch' })
  const snapshot: TrackerWatchSnapshot = { version: 2, checkedAt: '2026-09-19T01:00:00Z', checking: false, result: page('Remote') }
  let waitingSignal!: AbortSignal
  mocks.read.mockImplementationOnce(async () => snapshot).mockImplementation((_project, _id, signal) => { waitingSignal = signal; return new Promise(() => {}) })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, unmount } = renderHook(() => useTrackerWatch(input, key), { wrapper })
  await waitFor(() => expect(result.current.checkedAt).toBe(snapshot.checkedAt))
  expect(mocks.subscribe).not.toHaveBeenCalled()
  expect(mocks.read).toHaveBeenLastCalledWith(expect.any(String), 'watch', expect.any(AbortSignal), 2)
  unmount()
  expect(waitingSignal.aborted).toBe(true)
})
it('keeps the last success and rows on errors and ignores late results after changing filters', async () => {
  const client = createQueryClient()
  const key = ['tracker', 'default', 'items']
  let signal!: (data: unknown) => void
  mocks.subscribe.mockImplementation((_topic, listener) => { signal = listener; return () => {} })
  mocks.open.mockResolvedValue({ id: 'watch', topic: 'tracker:watch' })
  let snapshot: TrackerWatchSnapshot = { version: 2, checkedAt: '2026-09-19T01:00:00Z', checking: false, result: page('Good') }
  mocks.read.mockImplementation(async () => snapshot)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ query }) => useTrackerWatch({ ...input, query }, [...key, query]), { wrapper, initialProps: { query: '' } })
  await waitFor(() => expect(result.current.checkedAt).toBe(snapshot.checkedAt))
  snapshot = { ...snapshot, version: 3, result: { available: false, code: 'unavailable', reason: 'Offline' } }
  act(() => signal({ version: 3 }))
  await waitFor(() => expect(result.current.error).toBe('Offline'))
  expect(result.current.checkedAt).toBe('2026-09-19T01:00:00Z')
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>([...key, ''])?.pages).toEqual([page('Good')])
  let finish!: (value: TrackerWatchSnapshot) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  act(() => signal({ version: 4 }))
  rerender({ query: 'new filter' })
  await act(async () => finish({ ...snapshot, version: 4, result: page('Wrong scope') }))
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>([...key, 'new filter'])?.pages).not.toEqual([page('Wrong scope')])
})
it('a delayed manual refresh cannot overwrite a newer automatic response', async () => {
  const client = createQueryClient()
  const key = ['tracker', 'default', 'items']
  let signal!: (data: unknown) => void
  mocks.subscribe.mockImplementation((_topic, listener) => { signal = listener; return () => {} })
  mocks.open.mockResolvedValue({ id: 'watch', topic: 'tracker:watch' })
  let snapshot: TrackerWatchSnapshot = { version: 2, checkedAt: '2026-09-19T01:00:00Z', checking: false, result: page('Initial') }
  mocks.read.mockImplementation(async () => snapshot)
  let finish!: (value: TrackerWatchSnapshot) => void
  mocks.refresh.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useTrackerWatch(input, key), { wrapper })
  await waitFor(() => expect(result.current.checkedAt).toBe(snapshot.checkedAt))
  let manual!: Promise<void>
  act(() => { manual = result.current.refresh() })
  snapshot = { ...snapshot, version: 6, checkedAt: '2026-09-19T01:02:00Z', result: page('Newest') }
  act(() => signal({ version: 6 }))
  await waitFor(() => expect(result.current.checkedAt).toBe(snapshot.checkedAt))
  await act(async () => { finish({ ...snapshot, version: 4, checkedAt: '2026-09-19T01:01:00Z', result: page('Stale manual') }); await manual })
  expect(client.getQueryData<InfiniteData<TrackerItemsResponse>>(key)?.pages).toEqual([page('Newest')])
})
it('releases observation when a responsive list pane becomes hidden', async () => {
  const client = createQueryClient()
  const off = vi.fn()
  mocks.subscribe.mockReturnValue(off)
  mocks.open.mockResolvedValue({ id: 'watch', topic: 'tracker:watch' })
  mocks.read.mockResolvedValue({ version: 0, checkedAt: null, checking: false, result: null })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { rerender } = renderHook(({ enabled }) => useTrackerWatch(input, ['tracker', 'default', 'items'], enabled), { wrapper, initialProps: { enabled: true } })
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())
  rerender({ enabled: false })
  expect(off).toHaveBeenCalledTimes(1)
  expect(mocks.open).toHaveBeenCalledTimes(1)
})

it.each(['source_changed', 'credentials_missing', 'not_configured'] as const)('terminal %s reconciles connection and project navigation', async code => {
 const client=createQueryClient();
 const scope='default';
 const connectionKey=['tracker',scope,'connection'];
 const associationKey=['tracker',scope,'association'];
 client.setQueryData(['workspace','projects'], {projects:[]});
 client.setQueryData(connectionKey,{connection:{id:'old',kind:'jira'},demo:false});
 client.setQueryData(associationKey,{association:input.association});
 mocks.open.mockResolvedValue({id:'watch',topic:'tracker:watch'});
 mocks.subscribe.mockReturnValue(()=>{});
 mocks.read.mockResolvedValue({version:2,checkedAt:null,checking:false,result:{available:false,code,reason:'Connection changed'}});
 const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 const {result}=renderHook(()=>useTrackerWatch(input,['tracker',scope,'items']),{wrapper});
 await waitFor(()=>expect(result.current.error).toBe('Connection changed'));
 expect(client.getQueryState(associationKey)?.isInvalidated).toBe(true);
 expect(client.getQueryState(connectionKey)?.isInvalidated).toBe(true);
 expect(client.getQueryState(['workspace','projects'])?.isInvalidated).toBe(true);
});
