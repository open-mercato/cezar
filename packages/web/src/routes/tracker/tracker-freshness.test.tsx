import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { TrackerRoute } from './tracker'

vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@/components/engine-pills', () => ({
  EnginePills: () => null, engineRunBody: () => ({}), useResolvedEngine: () => ({ canRun: true }),
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const association = { kind: 'jira' as const, source: { id: 'cloud', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
const item = { kind: 'issue' as const, id: 'OPS-1', title: 'Issue', body: 'Original detail', bodyTruncated: false, unsupportedContent: false, author: 'Ada', labels: [], status: 'Open', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', url: 'https://acme.atlassian.net/browse/OPS-1' }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
function mount(client: ReturnType<typeof createQueryClient>, path: string) {
  return render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={client}><Routes><Route path="/tracker/:id?" element={<TrackerRoute />} /></Routes></QueryClientProvider></MemoryRouter>)
}

describe('tracker snapshot freshness', () => {
  it('shows setup for a disconnected saved scope without starting list or watch requests', async () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.tracker.association(), { association: { ...association, connectionId: '00000000-0000-4000-8000-000000000001' } });
    client.setQueryData(queryKeys.tracker.connection(), { connection: null, demo: false });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Promise<never>(() => {});
    }));
    mount(client, '/tracker');
    expect(await screen.findByText('Connect an issue tracker')).toBeTruthy();
    expect(requests.some(url => /\/tracker(?:\?|$|\/watch)/.test(url))).toBe(false);
  });

  it('preserves the draft across a background refetch failure and retry (no manual snapshot refresh, GitHub parity)', async () => {
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.association(), { association })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/tracker/OPS-1')) {
        calls++
        return calls === 2
          ? json({ available: false, code: 'unavailable', reason: 'Temporary outage' })
          : json({ available: true, item })
      }
      return new Promise<never>(() => {})
    }))
    mount(client, '/tracker/OPS-1')
    expect(await screen.findByLabelText('Custom instruction')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh issue' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Custom instruction'), { target: { value: 'Keep through outage' } })
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.tracker.detail(association, item.id) }) })
    expect(await screen.findByText('Temporary outage')).toBeTruthy()
    expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('Keep through outage')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Temporary outage')).toBeNull())
    expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('Keep through outage')
  })

  it.each(['not_found', 'unauthorized', 'transport'])('blocks launch after %s until a successful retry and keeps the draft', async (failureKind) => {
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { retry: false } })
    client.setQueryData(queryKeys.tracker.association(), { association })
    let calls = 0
    let finishRetry!: (response: Response) => void
    const launches: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-1')) {
        calls++
        if (calls === 1) return json({ available: true, item })
        if (calls === 2) {
          if (failureKind === 'transport') throw new Error('Detail unavailable')
          return json({ available: false, code: failureKind, reason: 'Detail unavailable' })
        }
        return new Promise<Response>(resolve => { finishRetry = resolve })
      }
      if (url.endsWith('/tracker/association')) return json({ association })
      if (url.endsWith('/runs')) launches.push(url)
      return new Promise<never>(() => {})
    }))
    mount(client, '/tracker/OPS-1')
    const instruction = await screen.findByLabelText('Custom instruction')
    fireEvent.change(instruction, { target: { value: 'Keep this draft' } })
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.tracker.detail(association, item.id) }) })
    expect(await screen.findByText(failureKind === 'transport' ? /cannot reach the cezar server/ : 'Detail unavailable')).toBeTruthy()
    const launch = screen.getByRole('button', { name: /Run agent/ }) as HTMLButtonElement
    expect(launch.disabled).toBe(true)
    fireEvent.click(launch)
    fireEvent.keyDown(instruction, { key: 'Enter', ctrlKey: true })
    expect(launches).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(calls).toBe(3))
    expect(launch.disabled).toBe(true)
    await act(async () => finishRetry(json({ available: true, item: { ...item, body: 'Recovered detail' } })))
    expect(await screen.findByText('Recovered detail')).toBeTruthy()
    expect(launch.disabled).toBe(false)
    expect((instruction as HTMLTextAreaElement).value).toBe('Keep this draft')
  })

  it('preserves two mobile pages after a minute in detail and remount, applying watch changes only on request', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.association(), { association })
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true } })
    const first = { available: true, items: [item], truncated: true, nextCursor: 'next' }
    let changed = false
    const listCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/tracker/watch')) return json({ id: '00000000-0000-4000-8000-000000000001', topic: 'tracker:test' })
      if (url.pathname.includes('/tracker/watch/')) return json({ version: changed ? 2 : 1, checkedAt: changed ? '2026-09-19T01:02:00Z' : '2026-09-19T01:00:00Z', checking: false, result: changed ? { available: true, items: [{ ...item, title: 'Changed issue' }], truncated: false } : first })
      if (url.pathname.endsWith('/tracker/OPS-1')) return json({ available: true, item })
      if (url.pathname.endsWith('/tracker')) {
        listCalls.push(url.searchParams.get('cursor') ?? 'first')
        if (changed) return json({ available: true, items: [{ ...item, title: 'Unwanted automatic replacement' }], truncated: false })
        return json(url.searchParams.has('cursor') ? { available: true, items: [{ ...item, id: 'OPS-2', title: 'Second page' }], truncated: false } : first)
      }
      return new Promise<never>(() => {})
    }))
    const view = mount(client, '/tracker')
    expect(await screen.findByText('Issue')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Second page')).toBeTruthy()
    fireEvent.click(screen.getByText('Issue'))
    expect(await screen.findByLabelText('Custom instruction')).toBeTruthy()
    changed = true
    const later = Date.now() + 61_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    fireEvent.click(screen.getByRole('link', { name: 'Back to the list' }))
    await act(async () => {})
    expect(listCalls).toEqual(['first', 'next'])
    expect(await screen.findByRole('button', { name: 'Show changes' })).toBeTruthy()
    expect(screen.getByText('Second page')).toBeTruthy()
    view.unmount()
    mount(client, '/tracker')
    await act(async () => {})
    expect(listCalls).toEqual(['first', 'next'])
    expect(await screen.findByRole('button', { name: 'Show changes' })).toBeTruthy()
    expect(screen.getByText('Second page')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }))
    expect(await screen.findByText('Changed issue')).toBeTruthy()
    expect(screen.queryByText('Second page')).toBeNull()
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.tracker.items(association, { state: 'active', labels: [], query: '' }) }) })
    expect(await screen.findByText('Unwanted automatic replacement')).toBeTruthy()
    expect(listCalls).toEqual(['first', 'next', 'first'])
  })

  it('leaves launch enabled while a background refetch of the open detail is pending (GitHub parity, no staleness gate)', async () => {
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.association(), { association })
    client.setQueryData(queryKeys.tracker.detail(association, item.id), { available: true, item }, { updatedAt: Date.now() - 301_000 })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').pathname.endsWith('/tracker/OPS-1')) return new Promise<Response>(() => {})
      return new Promise<never>(() => {})
    }))
    mount(client, '/tracker/OPS-1')
    expect(await screen.findByText(item.body)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Run agent/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('repeated search bypasses successful server cache and restarts pagination', async () => {
    const client = createQueryClient()
    client.setQueryData(queryKeys.tracker.association(), { association })
    const requests: URL[] = []
    let firstPages = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/tracker/search')) {
        requests.push(url)
        if (url.searchParams.has('cursor')) return json({ available: true, items: [{ ...item, id: 'OPS-2', title: 'Second page' }], truncated: false })
        firstPages++
        return json({ available: true, items: [{ ...item, title: firstPages === 1 ? 'Old match' : 'New match' }], truncated: firstPages === 1, ...(firstPages === 1 ? { nextCursor: 'next' } : {}) })
      }
      if (url.pathname.endsWith('/tracker')) return json({ available: true, items: [], truncated: false })
      return new Promise<never>(() => {})
    }))
    mount(client, '/tracker')
    fireEvent.change(await screen.findByLabelText('Search tracker'), { target: { value: 'billing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Old match')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Second page')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('New match')).toBeTruthy()
    expect(firstPages).toBe(2)
    expect(requests.at(-1)?.searchParams.get('refresh')).toBe('1')
    expect(requests.at(-1)?.searchParams.has('cursor')).toBe(false)
    expect(screen.queryByText('Second page')).toBeNull()
  })
})

it('preserves a bound connection draft across transport failure and recovery', async () => {
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
 Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
 const client=createQueryClient(); client.setDefaultOptions({queries:{retry:false,staleTime:300000}});
 const bound={...association,connectionId:'00000000-0000-4000-8000-000000000001'};
 let failing = true;
 client.setQueryData(queryKeys.workflows, { workflows: [{ name: 'review-only', steps: [] }] });
 const connected={connection:{id:bound.connectionId,kind:'jira'},demo:false};
 client.setQueryData(queryKeys.tracker.association(),{association:bound});
 client.setQueryData(queryKeys.tracker.connection(),connected);
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  if(new URL(String(input), 'http://localhost').pathname.endsWith('/tracker/OPS-1')) return json({available:true,item});
  if(String(input).endsWith('/tracker/connection')) { if(failing) throw new Error('temporary transport outage'); return json(connected); }
  return new Promise<never>(()=>{});
 }));
 mount(client,'/tracker/OPS-1');
 fireEvent.change(await screen.findByLabelText('Custom instruction'),{target:{value:'Do not lose my instruction'}});
 fireEvent.click(screen.getByRole('button', { name: 'Choose a workflow' }));
 fireEvent.click(await screen.findByRole('option', { name: 'review-only' }));
 await act(async()=>{await client.refetchQueries({queryKey:queryKeys.tracker.connection()});});
 expect(await screen.findByText('Could not verify the tracker connection.')).toBeTruthy();
 expect(screen.queryByRole('button', {name:/Run agent/})).toBeNull();
 failing = false;
 fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
 expect((await screen.findByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('Do not lose my instruction');
 expect(screen.getByRole('button', { name: 'Choose a workflow' }).textContent).toContain('review-only');
 await act(async()=>{
  const nextId='00000000-0000-4000-8000-000000000002';
  client.setQueryData(queryKeys.tracker.association(), {association:{...bound,connectionId:nextId}});
  client.setQueryData(queryKeys.tracker.connection(), {connection:{...connected.connection,id:nextId},demo:false});
 });
 await waitFor(() => expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe(''));
 expect(screen.getByRole('button', { name:'Choose a workflow' }).textContent).not.toContain('review-only');
});

it('retains loaded rows and pagination through fallback refresh and a failed Retry', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const client = createQueryClient()
  client.setQueryData(queryKeys.tracker.association(), { association })
  const key = queryKeys.tracker.items(association, { state: 'active', labels: [], query: '' })
  const loaded = {
    pages: [
      { available: true, items: [item], truncated: true, nextCursor: 'next' },
      { available: true, items: [{ ...item, id: 'OPS-2', title: 'Second page' }], truncated: true, nextCursor: 'third' },
    ],
    pageParams: [undefined, 'next'],
  }
  client.setQueryData(key, loaded)
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (new URL(String(input), 'http://localhost').pathname.endsWith('/tracker')) {
      calls++
      return json({ available: false, code: 'unavailable', reason: `Outage ${calls}` })
    }
    return new Promise<never>(() => {})
  }))
  mount(client, '/tracker')
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText('Outage 1')).toBeTruthy()
  expect(screen.getByText('Second page')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Outage 2')).toBeTruthy()
  expect(client.getQueryData(key)).toEqual(loaded)
  expect(screen.getByText('Second page')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
})


it('counts down a rate-limited fallback Retry while retaining loaded pages', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const client = createQueryClient()
  client.setQueryData(queryKeys.tracker.association(), { association })
  const key = queryKeys.tracker.items(association, { state: 'active', labels: [], query: '' })
  const loaded = {
    pages: [
      { available: true, items: [item], truncated: true, nextCursor: 'next' },
      { available: true, items: [{ ...item, id: 'OPS-2', title: 'Second page' }], truncated: true, nextCursor: 'third' },
    ],
    pageParams: [undefined, 'next'],
  }
  client.setQueryData(key, loaded)
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (new URL(String(input), 'http://localhost').pathname.endsWith('/tracker')) {
      calls++
      return json({ available: false, code: 'rate_limited', reason: 'Vendor rate limit', retryAfterSeconds: 2 })
    }
    return new Promise<never>(() => {})
  }))
  mount(client, '/tracker')
  const refresh = await screen.findByRole('button', { name: 'Refresh' })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  fireEvent.click(refresh)
  await screen.findByText('Vendor rate limit')
  const retry = screen.getByRole('button', { name: 'Retry in 2s' }) as HTMLButtonElement
  expect(retry.disabled).toBe(true)
  fireEvent.click(retry)
  expect(calls).toBe(1)
  expect(client.getQueryData(key)).toEqual(loaded)
  expect(screen.getByText('Second page')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect((screen.getByRole('button', { name: 'Retry in 1s' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'Retry in 2s' })).toBeTruthy()
  expect(calls).toBe(2)
  expect(client.getQueryData(key)).toEqual(loaded)
})
