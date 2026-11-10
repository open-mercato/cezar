import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { TrackerAssociation, TrackerItem } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { TrackerRoute } from './tracker'

vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
vi.mock('@/components/engine-pills', () => ({
  EnginePills: () => null, engineRunBody: () => ({}), useResolvedEngine: () => ({ canRun: true }),
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each([true, false])('blocks handoff during metadata reconciliation (source changed: %s)', async changed => {
  const client = createQueryClient()
  const a: TrackerAssociation = {
    kind: 'jira', source: { id: 'cloud-a', webUrl: 'https://a.atlassian.net' },
    externalId: '100', externalName: 'A OPS', connectionId: '00000000-0000-4000-8000-000000000001',
  }
  const b: TrackerAssociation = {
    ...a, source: { id: 'cloud-b', webUrl: 'https://b.atlassian.net' },
    externalName: 'B OPS', connectionId: '00000000-0000-4000-8000-000000000002',
  }
  const item: TrackerItem = {
    kind: 'issue', id: 'OPS-1', title: 'A issue', body: 'A description',
    bodyTruncated: false, unsupportedContent: false, author: 'Ada', labels: [], status: 'Open',
    createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
    url: 'https://a.atlassian.net/browse/OPS-1',
  }
  const replacement = changed ? { ...item, title: 'B issue', body: 'B description', url: 'https://b.atlassian.net/browse/OPS-1' } : item
  const connection = (association: TrackerAssociation) => ({ connection: { id: association.connectionId, kind: 'jira' }, demo: false })
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  client.setQueryData(queryKeys.tracker.association(), { association: a })
  client.setQueryData(queryKeys.tracker.connection(), connection(a))
  let replaced = false
  let resolveAssociation!: (response: Response) => void
  let resolveConnection!: (response: Response) => void
  const launches: string[] = []
  const detailScopes: Array<string | null> = []
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/tracker/association')) return new Promise<Response>(resolve => { resolveAssociation = resolve })
    if (url.pathname.endsWith('/tracker/connection')) return new Promise<Response>(resolve => { resolveConnection = resolve })
    if (url.pathname.endsWith('/tracker/OPS-1')) {
      detailScopes.push(url.searchParams.get('expectedScope'))
      // Deliberately emulate an old server without the scope guard: UI must still block launch.
      return json({ available: true, item: replaced ? replacement : item })
    }
    if (url.pathname.endsWith('/tracker')) return json({ available: true, items: [replaced ? replacement : item], truncated: false })
    if (url.pathname.endsWith('/runs')) launches.push(String(init?.body))
    return new Promise<Response>(() => {})
  }))
  render(<MemoryRouter initialEntries={['/tracker/OPS-1']}><QueryClientProvider client={client}>
    <Routes><Route path="/tracker/:id?" element={<TrackerRoute />} /></Routes>
  </QueryClientProvider></MemoryRouter>)
  fireEvent.change(await screen.findByLabelText('Custom instruction'), { target: { value: 'A-only instruction' } })
  replaced = true
  // Same sequence as the tracker-changed SSE handler, with metadata deliberately delayed.
  let invalidation!: Promise<void>
  await act(async () => {
    await client.cancelQueries({ queryKey: ['tracker'] })
    invalidation = client.invalidateQueries({ queryKey: ['tracker'] })
  })
  await waitFor(() => expect(detailScopes).toHaveLength(2))
  expect(detailScopes).toEqual(Array(2).fill(JSON.stringify(['jira', 'cloud-a', 'https://a.atlassian.net', '100', a.connectionId])))
  expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('A-only instruction')
  const button = screen.getByRole('button', { name: 'Run agent on this issue' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  fireEvent.keyDown(screen.getByLabelText('Custom instruction'), { key: 'Enter', ctrlKey: true })
  expect(launches).toEqual([])
  const row = document.querySelector('[data-slot="tracker-row"]')!
  const transfer = { setData: vi.fn(), effectAllowed: 'none' }
  expect(fireEvent.dragStart(row, { dataTransfer: transfer })).toBe(false)
  expect(transfer.setData).not.toHaveBeenCalled()
  // A fast connection response alone must not re-enable a still-unreconciled scope.
  await act(async () => { resolveConnection(json(connection(changed ? b : a))) })
  const interimButton = screen.queryByRole('button', { name: 'Run agent on this issue' }) as HTMLButtonElement | null
  expect(interimButton === null || interimButton.disabled).toBe(true)
  await act(async () => {
    const next = changed ? b : a
    resolveAssociation(json({ association: next }))
    await invalidation
  })
  await waitFor(() => expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe(changed ? '' : 'A-only instruction'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run agent on this issue' }) as HTMLButtonElement).disabled).toBe(false))
  client.clear()
})
