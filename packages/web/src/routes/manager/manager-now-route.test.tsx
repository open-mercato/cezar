import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { attentionKeys } from '@/api/attention'
import { managerKeys } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { AttentionItem } from '@open-mercato/cezar-api-client'

import { managerFixture } from './manager-fixtures'
import { ManagerNowRoute } from './manager-now'

/** `/manager/now` wired to its queries and the URL (review of #2444, findings 2 and 5). */

const managers = [
  { ...managerFixture({ id: 'scout', name: 'Scout' }), followedTasks: ['app/r1', 'app/r2'] },
  { ...managerFixture({ id: 'mobile', name: 'Mobile' }), followedTasks: ['app/r3'] },
]
const item = (over: Partial<AttentionItem> & Pick<AttentionItem, 'key' | 'kind'>): AttentionItem => ({ title: over.key, since: new Date().toISOString(), counted: true, ...over })
const run = (id: string, title: string, status: string) => ({ projectId: 'app', id, title, status, lastActivityAt: '2026-11-23T10:00:00.000Z' })

function Where() {
  const { pathname, search } = useLocation()
  return <output data-testid="where">{pathname + search}</output>
}

function renderRoute(entry: string, { managersLoaded = true, managersFail = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
  if (managersLoaded) client.setQueryData(managerKeys.list, { managers })
  client.setQueryData(attentionKeys.all, {
    items: [item({ key: 'q', kind: 'question', managerId: 'scout', managerName: 'Scout', questionKey: 'm:scout:1' }), item({ key: 'a', kind: 'approval', managerId: 'mobile', managerName: 'Mobile', actionId: 'x' })],
    counts: { total: 2, question: 1, approval: 1, task: 0, review: 0, failed: 0, message: 0 }, revision: 'r', overrides: [], olderAfterDays: 7,
  })
  client.setQueryData(workspaceQueryKeys.runsIndex, {
    runs: [run('r1', 'Bump the formula', 'running'), run('r2', 'Done already', 'done'), run('r3', 'Build iOS', 'running'), run('r9', 'Nobody follows me', 'running')],
    referenceStatuses: {}, perProjectLimit: 200, truncated: [],
  })
  // Never resolves: the managers list stays loading when it was not seeded, unless it fails.
  vi.stubGlobal('fetch', vi.fn(() => (managersFail ? Promise.reject(new TypeError('Failed to fetch')) : new Promise<Response>(() => {}))))
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/manager/now" element={<><ManagerNowRoute /><Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const where = () => screen.getByTestId('where').textContent
const running = () => [...document.querySelectorAll('[data-slot="manager-now-running-row"]')].map((row) => row.textContent)
const rows = () => [...document.querySelectorAll('[data-slot="manager-now-needs-you"] [data-slot="now-attention-row"]')].map((row) => row.getAttribute('data-key'))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ManagerNowRoute', () => {
  it('lists only the followed tasks that are running, narrowed by ?manager=', () => {
    renderRoute('/manager/now')
    expect(running()).toEqual(['Bump the formula', 'Build iOS'])
    cleanup()
    renderRoute('/manager/now?manager=mobile')
    expect(running()).toEqual(['Build iOS'])
    expect(rows()).toEqual(['a'])
  })

  it('writes and removes ?manager= and keeps the other query parameters', async () => {
    renderRoute('/manager/now?from=notch')
    fireEvent.pointerDown(document.querySelector('[data-slot="manager-now-filter"]')!, { button: 0, pointerType: 'mouse' })
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Scout/ }))
    expect(where()).toBe('/manager/now?from=notch&manager=scout')
    expect(rows()).toEqual(['q'])
    fireEvent.click(document.querySelector('[data-slot="manager-now-show-all"]')!)
    expect(where()).toBe('/manager/now?from=notch')
    expect(rows()).toEqual(['q', 'a'])
  })

  it('falls back to All managers for an unknown id once the list is loaded', () => {
    renderRoute('/manager/now?manager=deleted')
    expect(document.querySelector('[data-slot="manager-now-filter"]')?.getAttribute('data-filter')).toBe('all')
    expect(rows()).toEqual(['q', 'a'])
  })

  it('waits for the managers list instead of flashing All managers for a requested one (finding 5)', async () => {
    const client = renderRoute('/manager/now?manager=mobile', { managersLoaded: false })
    expect(document.querySelector('[data-route="manager-now"]')).toBeNull()
    expect(screen.getByText('Loading managers…')).toBeTruthy()
    act(() => { client.setQueryData(managerKeys.list, { managers }) })
    // Once the list is in, the requested manager applies: never All managers in between.
    await vi.waitFor(() => expect(document.querySelector('[data-slot="manager-now-filter"]')?.getAttribute('data-filter')).toBe('mobile'))
    expect(rows()).toEqual(['a'])
  })

  it('a managers list that fails falls back to All managers instead of loading forever (review of #2444, round 2)', async () => {
    renderRoute('/manager/now?manager=mobile', { managersLoaded: false, managersFail: true })
    await vi.waitFor(() => expect(document.querySelector('[data-slot="manager-now-filter"]')?.getAttribute('data-filter')).toBe('all'))
    expect(screen.queryByText('Loading managers…')).toBeNull()
  })
})
