import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { managerKeys } from '@/api/managers'
import { queryKeys } from '@/api/queries'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { managerFixture } from './manager-fixtures'
import { ManagerRail, ManagerRow } from './manager-sidebar'

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

  it('swaps the time for a dot when unread, and says so to assistive tech', () => {
    const row = renderRow({ unread: 3, preview: 'x', lastActivityAt: new Date(2026, 9, 31, 7, 34).toISOString() })
    expect(row.dataset.unread).toBe('true')
    expect(row.textContent).not.toMatch(/7:34/)
    expect(row.textContent).toContain(', unread')
  })

  it('counts a pending approval as unread', () => {
    const row = renderRow({ pendingActions: 1 })
    expect(row.dataset.unread).toBe('true')
    expect(row.textContent).toContain('1 approval waiting')
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
    expect(screen.getByRole('link', { name: 'Shop Manager, unread' }).querySelector('[data-slot="manager-unread"]')).not.toBeNull()
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
