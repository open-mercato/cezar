import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { managerKeys } from '@/api/managers'
import { queryKeys } from '@/api/queries'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { managerFixture } from './manager-fixtures'
import { ManagerListRail, ManagerRail, ManagerRow, ManagerSidebar } from './manager-sidebar'

afterEach(cleanup)

const now = new Date(2026, 9, 31, 12, 0)

function renderRow(overrides: Parameters<typeof managerFixture>[0], active = false) {
  render(
    <MemoryRouter>
      <ManagerRow manager={managerFixture(overrides)} active={active} now={now.getTime()} />
    </MemoryRouter>,
  )
  return document.querySelector('[data-slot="manager-row"]') as HTMLAnchorElement
}

describe('ManagerRow', () => {
  it('shows name, time and preview, and links to the chat', () => {
    const row = renderRow({ preview: 'Got it!', lastActivityAt: new Date(2026, 9, 31, 7, 34).toISOString() })
    expect(row.getAttribute('href')).toBe('/manager/global')
    expect(row.textContent).toContain('Global Manager')
    expect(row.textContent).toContain('Got it!')
    expect(row.textContent).toMatch(/7:34/)
    expect(row.dataset.unread).toBeUndefined()
  })

  it('keeps the time and adds a dot when unread, and says so to assistive tech', () => {
    const row = renderRow({ unread: 3, preview: 'x', lastActivityAt: new Date(2026, 9, 31, 7, 34).toISOString() })
    expect(row.dataset.unread).toBe('true')
    expect(row.textContent).toMatch(/7:34/)
    expect(row.textContent).toContain(', unread')
    expect(row.querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-info')
  })

  it('counts approvals and questions in a badge as needing you, not as news', () => {
    const row = renderRow({ pendingActions: 2, pendingQuestions: 1, unread: 1 })
    expect(row.dataset.unread).toBe('true')
    expect(row.dataset.attention).toBe('needs-you')
    expect(row.textContent).toContain('Waiting for your answer')
    expect(row.textContent).toContain(', needs you')
    const badge = row.querySelector('[data-slot="manager-unread"]')!
    expect(badge.textContent).toBe('3')
    // Waiting on a person is the info blue (design, Proposal 7), never the amber of a queue.
    expect(badge.className).toContain('bg-info')
    cleanup()
    expect(renderRow({ pendingQuestions: 1 }).dataset.attention).toBe('needs-you')
    cleanup()
    expect(renderRow({ unread: 1 }).querySelector('[data-slot="manager-unread"]')?.textContent).toBe('')
  })

  it('marks the open chat', () => {
    expect(renderRow({}, true).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link').className).toContain('bg-muted')
  })
})

describe('ManagerRail', () => {
  function Location() {
    return <span data-testid="at">{useLocation().pathname}</span>
  }

  function renderRail(managers: ManagerSummary[], entry = '/manager/global') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
    client.setQueryData(managerKeys.list, { managers })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <Location />
          <Routes>
            <Route path="*" element={<ManagerRail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-rail-item"]')]
  }

  it('shows one named thumbnail per manager and opens its chat on click', () => {
    const items = renderRail([managerFixture(), managerFixture({ id: 'shop', name: 'Shop Manager', avatar: 3 })])
    expect(items).toHaveLength(2)
    const shop = screen.getByRole('link', { name: 'Shop Manager' })
    expect(shop.getAttribute('title')).toBe('Shop Manager')
    expect(shop.querySelector('[data-slot="manager-avatar"]')).not.toBeNull()
    fireEvent.click(shop)
    expect(screen.getByTestId('at').textContent).toBe('/manager/shop')
    expect(shop.getAttribute('aria-current')).toBe('page')
  })

  it('marks the open manager', () => {
    renderRail([managerFixture(), managerFixture({ id: 'shop', name: 'Shop Manager' })])
    expect(screen.getByRole('link', { name: 'Global Manager' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Shop Manager' }).getAttribute('aria-current')).toBeNull()
  })

  it('dots an unread manager or one waiting on an approval, and says so', () => {
    renderRail([
      managerFixture({ unread: 2 }),
      managerFixture({ id: 'shop', name: 'Shop Manager', pendingActions: 1 }),
      managerFixture({ id: 'quiet', name: 'Quiet Manager' }),
    ])
    expect(screen.getByRole('link', { name: 'Global Manager, unread' }).querySelector('[data-slot="manager-unread"]')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Global Manager, unread' }).querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-info')
    // Needs-you takes the Tasks list's colour and its own words.
    expect(screen.getByRole('link', { name: 'Shop Manager, needs you' }).querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-pending')
    expect(screen.getByRole('link', { name: 'Quiet Manager' }).querySelector('[data-slot="manager-unread"]')).toBeNull()
  })

  it('uses the static portrait, never the animated mascot', () => {
    renderRail([managerFixture({ mascot: 'scout' })])
    const avatar = document.querySelector('[data-slot="manager-avatar"]') as HTMLElement
    expect(avatar.tagName).toBe('IMG')
    expect(avatar.getAttribute('src')).toContain('portrait')
  })

  it('renders nothing without managers', () => {
    renderRail([])
    expect(document.querySelector('[data-slot="manager-rail"]')).toBeNull()
  })
})

describe('ManagerSidebar', () => {
  function renderSidebar(managers?: ManagerSummary[], capability = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: capability } })
    if (managers) client.setQueryData(managerKeys.list, { managers })
    // The list never answers: the pending frame is what is under test.
    else client.setQueryDefaults(managerKeys.list, { queryFn: () => new Promise(() => {}) })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/manager/global']}>
          <ManagerSidebar />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('holds the rows\' shape while the list loads, then shows them', () => {
    renderSidebar()
    const loading = document.querySelector('[data-slot="manager-sidebar-loading"]')
    expect(loading?.getAttribute('role')).toBe('status')
    expect(screen.getByText('Loading managers…')).toBeTruthy()
    expect(loading?.querySelector('[data-slot="list-skeleton"]')?.children).toHaveLength(3)
    cleanup()
    renderSidebar([managerFixture()])
    expect(document.querySelector('[data-slot="manager-sidebar-loading"]')).toBeNull()
    expect(document.querySelector('[data-slot="manager-row"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="new-manager"]')).not.toBeNull()
  })

  it('shows no skeleton when managers are switched off', () => {
    renderSidebar(undefined, false)
    expect(document.querySelector('[data-slot="manager-sidebar-loading"]')).toBeNull()
  })
})

describe('ManagerListRail', () => {
  function renderRail(managers?: ManagerSummary[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
    if (managers) client.setQueryData(managerKeys.list, { managers })
    else client.setQueryDefaults(managerKeys.list, { queryFn: () => new Promise(() => {}) })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/manager/global']}>
          <ManagerListRail activeId="global" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return document.querySelector('[data-slot="manager-list-rail"]') as HTMLElement
  }

  it('lists every manager with the open one marked, a way to add one, and what they all watch', () => {
    const rail = renderRail([
      managerFixture(),
      managerFixture({ id: 'shop', name: 'Shop Manager', connectedProjectIds: ['beta', 'gamma'], pendingActions: 1 }),
    ])
    expect(rail.className).toContain('max-md:hidden')
    expect(screen.getByRole('heading', { name: 'Managers' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'New manager' }).getAttribute('href')).toBe('/manager/new')
    const rows = [...rail.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-row"]')]
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(['page', null])
    expect(rows[1]!.querySelector('[data-slot="manager-unread"]')?.textContent).toBe('1')
    // Three distinct projects across two managers; no "today" spend, since the summary has none.
    expect(rail.querySelector('[data-slot="manager-rail-summary"]')?.textContent).toBe('2 managers · 3 projects watched')
  })

  it('holds the rows\' shape while the list loads', () => {
    const rail = renderRail()
    expect(rail.querySelector('[data-slot="manager-sidebar-loading"]')).not.toBeNull()
    expect(rail.querySelector('[data-slot="manager-rail-summary"]')).toBeNull()
  })
})
