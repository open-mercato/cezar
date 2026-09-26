import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import type { TrackerItem } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { TrackerHandoff } from './tracker-handoff'

const ITEM: TrackerItem = {
  kind: 'issue', id: 'OPS-1', title: 'Fix it', author: 'Ada',
  createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  labels: [], body: 'Full detail', bodyTruncated: false, unsupportedContent: false,
  url: 'https://acme.atlassian.net/browse/OPS-1', status: 'Open',
}
const connected = { providers: [{ provider: 'claude', status: 'connected', enabled: true }] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['missing', 'failed'] as const)('explains a %s backend and recovers without losing the draft', async (state) => {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  let recovered = false
  let submitted: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/v1/providers/status') {
      return recovered ? json(connected) : state === 'missing'
        ? json({ providers: [{ provider: 'claude', status: 'not-installed', enabled: true }] })
        : json({ error: 'Status unavailable' }, 503)
    }
    if (path.endsWith('/runs') && init?.method === 'POST') {
      submitted = JSON.parse(String(init.body)) as Record<string, unknown>
      return json({ id: 'run-recovered' })
    }
    // Keep unrelated engine catalog/config queries pending; no real network is used.
    return new Promise<Response>(() => {})
  }))
  render(<MemoryRouter initialEntries={['/p/acme/tracker']}><QueryClientProvider client={client}>
    <TrackerHandoff item={ITEM} workflows={[]} skills={[]} />
  </QueryClientProvider></MemoryRouter>)

  const run = screen.getByRole('button', { name: /Run agent/ }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
  const explanation = state === 'missing' ? 'Connect an agent provider to run this item.' : 'Provider authentication could not be verified.'
  expect(await screen.findByText(explanation)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe('/p/acme/settings/agents#providers')
  fireEvent.change(screen.getByLabelText('Custom instruction'), { target: { value: 'Retain this draft' } })
  fireEvent.keyDown(screen.getByLabelText('Custom instruction'), { key: 'Enter', ctrlKey: true })
  expect(submitted).toBeUndefined()

  recovered = true
  await act(async () => { await client.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus }) })
  await waitFor(() => expect(run.disabled).toBe(false))
  expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
  expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('Retain this draft')
  fireEvent.click(run)
  await waitFor(() => expect(submitted).toBeDefined())
  expect(submitted?.task).toContain('Retain this draft')
})
