import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { TrackerRoute, trackerDetailReadyForDrag } from './tracker'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Tracker route', () => {
  it('uses vendor search and appends cursor pages without losing earlier issues', async () => {
    // This case exercises the mobile list; desktop detail also observes the detail cache.
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url.endsWith('/tracker/association')) return json({ association: {
        kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS',
      } })
      if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-1')) return json({ available: true, item: { ...issue('OPS-1', 'First page'), body: 'FULL_DETAIL_FOR_DRAG' } })
      if (url.includes('/tracker/search')) return json({ available: true, items: [issue('OPS-9', 'Search result')], truncated: false })
      if (url.includes('cursor=next')) return json({ available: true, items: [issue('OPS-2', 'Second page')], truncated: false })
      if (url.includes('/tracker')) return json({ available: true, items: [issue('OPS-1', 'First page')], truncated: true, nextCursor: 'next' })
      return new Promise<never>(() => {})
    }))
    const client = createQueryClient()
    render(
      <MemoryRouter initialEntries={['/tracker']}>
        <QueryClientProvider client={client}>
          <Routes><Route path="/tracker" element={<TrackerRoute />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('First page')).toBeTruthy()
    const firstRow = screen.getByText('First page').closest('a') as HTMLAnchorElement
    fireEvent.mouseEnter(firstRow)
    await waitFor(() => expect(requests.some((url) => new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-1'))).toBe(true))
    const setData = vi.fn()
    fireEvent.dragStart(firstRow, { dataTransfer: { setData, effectAllowed: 'none' } })
    expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('FULL_DETAIL_FOR_DRAG'))
    const association = { kind: 'jira' as const, source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
    const detailKey = queryKeys.tracker.detail(association, 'OPS-1')
    await client.invalidateQueries({ queryKey: detailKey, refetchType: 'none' })
    await client.fetchQuery({ queryKey: detailKey, queryFn: async () => { throw new Error('offline') } }).catch(() => {})
    const afterError = vi.fn()
    fireEvent.dragStart(firstRow, { dataTransfer: { setData: afterError, effectAllowed: 'none' } })
    expect(afterError).not.toHaveBeenCalled()
    client.setQueryData(detailKey, { available: true, item: { ...issue('OPS-1', 'First page'), body: 'STALE_DETAIL' } }, { updatedAt: Date.now() - 60_001 })
    const stale = vi.fn()
    fireEvent.dragStart(firstRow, { dataTransfer: { setData: stale, effectAllowed: 'none' } })
    expect(stale).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    expect(await screen.findByText('Second page')).toBeTruthy()
    expect(screen.getByText('First page')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/search tracker/i), { target: { value: 'closed regression' } })
    expect(requests.some((url) => url.includes('/tracker/search'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^Search$/i }))
    await waitFor(() => expect(requests.some((url) => url.includes('/tracker/search') && url.includes('q=closed') && url.includes('state=all'))).toBe(true))
    expect(await screen.findByText('Search result')).toBeTruthy()
  })

  it('blocks the drag payload while a retained successful detail is refreshing', async () => {
    const client = createQueryClient()
    const key = ['tracker', 'project', 'detail', 'OPS-1'] as const
    const response = { available: true as const, item: issue('OPS-1', 'First page') }
    client.setQueryData(key, response)
    await client.invalidateQueries({ queryKey: key, refetchType: 'none' })
    let finish!: (value: typeof response) => void
    const refreshing = client.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise<typeof response>((resolve) => { finish = resolve }),
    })
    await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('fetching'))

    expect(client.getQueryState(key)?.status).toBe('success')
    expect(trackerDetailReadyForDrag(client, key)).toBeNull()
    finish(response)
    await refreshing
  })

  it('renders full safe detail and gates lossy handoff on acknowledgement', async () => {
    const tail = 'DETAIL_AFTER_PREVIEW_BOUNDARY'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url.endsWith('/tracker/association')) return json({ association: {
        kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS',
      } })
      if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-7')) return json({ available: true, item: {
        ...issue('OPS-7', 'Long issue'), body: `${'x'.repeat(8_100)}${tail}\n\n<script>evil(1)</script>`,
        bodyTruncated: true, unsupportedContent: true,
      } })
      return new Promise<never>(() => {})
    }))
    render(
      <MemoryRouter initialEntries={['/tracker/OPS-7']}>
        <QueryClientProvider client={createQueryClient()}>
          <Routes><Route path="/tracker/:id" element={<TrackerRoute />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(new RegExp(tail))).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText(/description was truncated/i)).toBeTruthy()
    expect(screen.getByText(/unsupported content/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Run agent/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/i }))
    expect(screen.getByRole('textbox', { name: /Custom instruction/i })).toBeTruthy()
  })

  it('offers supplemental context when the description is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url.endsWith('/tracker/association')) return json({ association: {
        kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app/acme' }, externalId: 'team', externalName: 'Platform',
      } })
      if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/LIN-2')) return json({ available: true, item: { ...issue('LIN-2', 'Needs context'), body: '' } })
      return new Promise<never>(() => {})
    }))
    render(
      <MemoryRouter initialEntries={['/tracker/LIN-2']}>
        <QueryClientProvider client={createQueryClient()}>
          <Routes><Route path="/tracker/:id" element={<TrackerRoute />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/No description was provided/i)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Supplemental context/i })).toBeTruthy()
    expect(screen.queryByText(/I understand the agent receives/i)).toBeNull()
  })

  it('disables a rate-limited detail retry during its cooldown and links settings', async () => {
    let detailCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/tracker/association')) return new Response(JSON.stringify({ association: {
        kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS',
      } }), { status: 200 })
      if (new URL(url, 'http://localhost').pathname.endsWith('/tracker/OPS-8')) { detailCalls += 1; return new Response(JSON.stringify({ available: false, code: 'rate_limited', reason: 'Slow down', retryAfterSeconds: 1 }), { status: 200 }) }
      return new Promise<never>(() => {})
    }))
    render(<MemoryRouter initialEntries={['/tracker/OPS-8']}><QueryClientProvider client={createQueryClient()}><Routes><Route path="/tracker/:id" element={<TrackerRoute />} /></Routes></QueryClientProvider></MemoryRouter>)
    const retry = await screen.findByRole('button', { name: 'Retry in 1s' }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    expect(screen.getByRole('link', { name: /Tracker settings/i }).getAttribute('href')).toBe('/settings/tracker')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy(), { timeout: 1_500 })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(detailCalls).toBe(2))
    expect((await screen.findByRole('button', { name: 'Retry in 1s' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

function issue(id: string, title: string) {
  return {
    kind: 'issue', id, title, author: 'Ada', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
    labels: ['bug'], body: 'description', bodyTruncated: false, unsupportedContent: false,
    url: `https://acme.atlassian.net/browse/${id}`, status: 'Open',
  }
}
