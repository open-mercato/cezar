import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { managerKeys } from '@/api/managers'
import { queryKeys } from '@/api/queries'
import { questionKeys } from '@/api/questions'
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
    // Unread news is violet, the cockpit's attention grammar; blue is reserved for needs-you.
    expect(row.querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-violet')
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
    expect(screen.getByRole('link', { name: 'Global Manager, unread' }).querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-violet')
    // Needs-you is the blue of waiting on a person (design 2026-11 "Manager mode"), never amber.
    expect(screen.getByRole('link', { name: 'Shop Manager, needs you' }).querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-info')
    expect(screen.getByRole('link', { name: 'Shop Manager, needs you' }).querySelector('[data-slot="manager-unread"]')?.className).not.toContain('bg-pending')
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
  function renderSidebar(managers?: ManagerSummary[], capability = true, entry = '/manager/global') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: capability } })
    if (managers) client.setQueryData(managerKeys.list, { managers })
    // The list never answers: the pending frame is what is under test.
    else client.setQueryDefaults(managerKeys.list, { queryFn: () => new Promise(() => {}) })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <ManagerSidebar />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }
  const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-row"]')]
  const workspace = () => screen.getByRole('navigation', { name: 'Workspace' })

  it('leads with New manager, then "Managers · N" and one row per manager, most recent first', () => {
    renderSidebar([
      managerFixture({ lastActivityAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
      managerFixture({ id: 'shop', name: 'Shop Manager', lastActivityAt: new Date(Date.now() - 120_000).toISOString() }),
    ])
    const newManager = screen.getByRole('link', { name: 'New manager' })
    expect(newManager.getAttribute('href')).toBe('/manager/new')
    expect(newManager.getAttribute('data-variant')).toBe('primary')
    expect(screen.getByRole('heading', { name: 'Managers · 2' })).toBeTruthy()
    expect(rows().map((row) => row.getAttribute('href'))).toEqual(['/manager/shop', '/manager/global'])
    expect(rows().map((row) => row.querySelector('[data-slot="manager-row-age"]')?.textContent)).toEqual(['2m', '3h'])
    expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'page'])
  })

  it('shows the mascot portrait, the latest line, and a dot: blue text and dot when it waits on you', () => {
    renderSidebar([
      managerFixture({ mascot: 'scout', pendingActions: 2, preview: 'old news' }),
      managerFixture({ id: 'news', name: 'Release watch', unread: 1, preview: 'Tagged v0.20.0' }),
      managerFixture({ id: 'quiet', name: 'Quiet', preview: 'Next run in 40 min' }),
    ])
    const [waiting, news, quiet] = ['global', 'news', 'quiet'].map((id) => document.querySelector<HTMLElement>(`[href="/manager/${id}"]`)!)
    expect(waiting!.querySelector('[data-slot="manager-avatar"]')?.getAttribute('src')).toContain('portrait')
    const preview = (row: HTMLElement) => row.querySelector('[data-slot="manager-row-preview"]')!
    expect(preview(waiting!).textContent).toBe('2 approvals waiting')
    expect(preview(waiting!).className).toContain('text-info')
    expect(waiting!.querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-info')
    expect(waiting!.textContent).toContain(', needs you')
    expect(preview(news!).textContent).toBe('Tagged v0.20.0')
    expect(preview(news!).className).not.toContain('text-info')
    expect(news!.querySelector('[data-slot="manager-unread"]')?.className).toContain('bg-violet')
    expect(quiet!.querySelector('[data-slot="manager-unread"]')).toBeNull()
  })

  it('opens workspace approvals even when the first waiting manager is already open, counting actions only', () => {
    renderSidebar([
      managerFixture({ lastActivityAt: new Date(Date.now() - 60_000).toISOString() }),
      managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1, pendingQuestions: 1, lastActivityAt: new Date(Date.now() - 120_000).toISOString() }),
      managerFixture({ id: 'ops', name: 'Ops', pendingActions: 1, lastActivityAt: new Date(Date.now() - 180_000).toISOString() }),
    ], true, '/manager/shop')
    const links = within(workspace()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['Now', 'Approvals2 pending approvals', 'Questions', 'Manager settings'])
    expect(links[1]!.getAttribute('href')).toBe('/manager/approvals')
    expect(links[1]!.getAttribute('aria-current')).toBeNull()
    expect(links[2]!.getAttribute('href')).toBe('/manager/questions')
    expect(links[3]!.getAttribute('href')).toBe('/settings/global/manager')
    expect(within(workspace()).getByRole('button', { name: 'Jobs' }).getAttribute('aria-haspopup')).toBe('dialog')
  })

  // Questions inbox design § 01: workspace counts fill info-blue above zero, muted at zero.
  it('lists Questions between Approvals and Jobs, with the live count; counts fill blue above zero', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
    client.setQueryData(managerKeys.list, { managers: [managerFixture({ pendingActions: 0, jobs: [] })] })
    client.setQueryData(questionKeys.all, { open: [], closed: [], counts: { live: 3, older: 2 }, olderAfterDays: 7 })
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/manager/global']}><ManagerSidebar /></MemoryRouter></QueryClientProvider>)
    const nav = workspace()
    const questions = within(nav).getByRole('link', { name: 'Questions, 3 waiting' })
    expect(questions.getAttribute('href')).toBe('/manager/questions')
    const labels = [...nav.querySelectorAll('a, button')].map((node) => node.getAttribute('data-slot'))
    expect(labels.indexOf('sidebar-questions')).toBe(labels.indexOf('manager-sidebar-approvals') + 1)
    expect(labels.indexOf('manager-sidebar-jobs')).toBe(labels.indexOf('sidebar-questions') + 1)
    // Older questions are not counted.
    expect(questions.querySelector('[data-slot="sidebar-questions-count"]')?.textContent).toBe('3')
    expect(questions.querySelector('[data-slot="sidebar-questions-count"]')?.className).toContain('bg-info')
    expect(nav.querySelector('[data-slot="sidebar-approvals-count"]')?.className).toContain('bg-muted')
    act(() => client.setQueryData(questionKeys.all, { open: [], closed: [], counts: { live: 0, older: 2 }, olderAfterDays: 7 }))
    await waitFor(() => expect(questions.querySelector('[data-slot="sidebar-questions-count"]')?.className).toContain('bg-muted'))
    cleanup()
    renderSidebar([managerFixture({ pendingActions: 2 })])
    expect(document.querySelector('[data-slot="sidebar-approvals-count"]')?.className).toContain('bg-info')
  })

  it('leads the Workspace group with Manager mode\'s own Now and its badge (spec 2026-11-23-needs-you-triage)', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
    client.setQueryData(managerKeys.list, { managers: [managerFixture()] })
    const view = (count: number | null) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/manager/global']}><ManagerSidebar nowCount={count} /></MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(view(2))
    const now = within(workspace()).getAllByRole('link')[0]!
    expect(now.textContent).toBe('Now2')
    // Never a project's Now: Manager mode stays in Manager mode.
    expect(now.getAttribute('href')).toBe('/manager/now')
    expect(now.querySelector('svg.lucide-circle-dot')).not.toBeNull()
    expect(now.getAttribute('aria-current')).toBeNull()
    const badge = now.querySelector('[data-slot="nav-needs-you-badge"]')!
    expect(badge.getAttribute('title')).toBe('2 things from your managers need you')
    expect(badge.className).toContain('bg-violet')
    // Like the project nav: no badge at zero or while unknown.
    rerender(view(0))
    expect(now.querySelector('[data-slot="nav-needs-you-badge"]')).toBeNull()
    rerender(view(null))
    expect(now.textContent).toBe('Now')
  })

  it('marks its Now current on /manager/now (review of #2444)', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
    client.setQueryData(managerKeys.list, { managers: [managerFixture()] })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/manager/now']}><ManagerSidebar nowCount={1} /></MemoryRouter>
      </QueryClientProvider>,
    )
    expect(document.querySelector('[data-slot="manager-sidebar-now"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('keeps Approvals reachable with zero pending actions, and Jobs needs an open chat', () => {
    renderSidebar([managerFixture()], true, '/manager/new')
    expect(within(workspace()).getByRole('link', { name: 'Approvals, 0 pending approvals' }).getAttribute('href')).toBe('/manager/approvals')
    expect(within(workspace()).queryByRole('button', { name: 'Jobs' })).toBeNull()
    expect(within(workspace()).getByRole('link', { name: 'Manager settings' })).toBeTruthy()
  })

  it('selects only the workspace Approvals item at its deep link', () => {
    renderSidebar([managerFixture({ pendingActions: 1 })], true, '/manager/approvals')
    const approvals = within(workspace()).getByRole('link', { name: /Approvals/ })
    expect(approvals.getAttribute('aria-current')).toBe('page')
    expect(approvals.className).toContain('bg-muted')
    expect(rows().every((row) => row.getAttribute('aria-current') === null)).toBe(true)
    expect(within(workspace()).queryByRole('button', { name: 'Jobs' })).toBeNull()
    expect(rows()[0]!.textContent).toContain('1 approval waiting')
  })

  it('opens the open chat\'s jobs dialog from Jobs', async () => {
    renderSidebar([managerFixture({ jobs: [] })])
    fireEvent.click(within(workspace()).getByRole('button', { name: 'Jobs' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('holds the rows\' shape while the list loads, then shows them', () => {
    renderSidebar()
    const loading = document.querySelector('[data-slot="manager-sidebar-loading"]')
    expect(loading?.getAttribute('role')).toBe('status')
    expect(screen.getByText('Loading managers…')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Approvals' }).textContent).toBe('Approvals')
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
