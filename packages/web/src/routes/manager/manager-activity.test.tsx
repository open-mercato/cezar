import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys, orderManagers } from '@/api/managers'
import { queryKeys } from '@/api/queries'
import { managersAttention, managerRowPreview } from '@/lib/managers'
import { restingHeads } from '@/lib/manager-heads'
import { ManagerActivitySection } from '@/routes/settings/manager-section'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerAvatar } from './manager-avatar'
import { managerFixture } from './manager-fixtures'
import { ManagerSettings } from './manager-settings'
import { ManagerSidebar } from './manager-sidebar'

/** Spec 2026-11-19-manager-deactivate: the cockpit half. */

const SINCE = '2026-11-18T23:40:00Z'
const inactive = (overrides: Parameters<typeof managerFixture>[0] = {}) => managerFixture({ inactive: { since: SINCE }, ...overrides })

const patches: Array<{ path: string; body: unknown }> = []
/** What the fake server holds: the list a refetch reads back. */
let served: ManagerSummary[] = []
beforeEach(() => {
  patches.length = 0
  served = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname
    const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : undefined
    if (init?.method === 'PATCH') {
      patches.push({ path, body })
      const id = decodeURIComponent(path.split('/').pop()!)
      const { active } = body as { active: boolean }
      const was = served.find((manager) => manager.id === id) ?? managerFixture({ id, name: id })
      const { inactive: _was, ...rest } = was
      const next = active ? rest : { ...rest, inactive: { since: SINCE } }
      served = served.map((manager) => (manager.id === id ? next : manager))
      return Response.json(next)
    }
    if (path === '/api/v1/workspace/managers/activity') {
      patches.push({ path, body })
      const { active } = body as { active: boolean }
      const changed = served.filter((manager) => (manager.inactive === undefined) !== active).map((manager) => manager.id)
      served = served.map(({ inactive: _was, ...rest }) => (active ? rest : { ...rest, inactive: { since: SINCE } }))
      return Response.json({ ok: true, changed })
    }
    if (path === '/api/v1/workspace/managers') return Response.json({ managers: served })
    return Response.json({ ok: true })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function client(managers: ManagerSummary[] = []) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  query.setQueryData(queryKeys.health, { capabilities: { managers: true } })
  query.setQueryData(managerKeys.list, { managers })
  served = managers
  return query
}

describe('ManagerAvatar', () => {
  it('greys an inactive manager and adds a pause badge, so colour is never the only cue', () => {
    render(<ManagerAvatar avatar={2} inactive className="size-8" />)
    const wrap = document.querySelector('[data-slot="manager-avatar-inactive"]')!
    expect(wrap.className).toContain('size-8')
    expect(wrap.getAttribute('title')).toBe('Inactive')
    expect(wrap.querySelector('[data-slot="manager-avatar"]')!.getAttribute('class')).toContain('grayscale')
    expect(wrap.querySelector('[data-slot="manager-avatar-pause"]')).not.toBeNull()
  })

  it('leaves an active manager exactly as it was', () => {
    render(<ManagerAvatar avatar={2} className="size-8" />)
    expect(document.querySelector('[data-slot="manager-avatar-inactive"]')).toBeNull()
    expect(document.querySelector('[data-slot="manager-avatar"]')!.getAttribute('class')).not.toContain('grayscale')
  })
})

describe('ordering and attention', () => {
  it('sorts inactive managers after active ones, each by recency', () => {
    const list = [
      inactive({ id: 'a', lastActivityAt: '2026-11-19T10:00:00Z' }),
      managerFixture({ id: 'b', lastActivityAt: '2026-11-19T08:00:00Z' }),
      managerFixture({ id: 'c', lastActivityAt: '2026-11-19T09:00:00Z' }),
    ]
    expect(orderManagers(list).map((manager) => manager.id)).toEqual(['c', 'b', 'a'])
  })

  it('reads "Inactive · since …" and drops its questions from the switch dot, but not its approvals', () => {
    expect(managerRowPreview(inactive({ pendingQuestions: 1 }))).toMatch(/^Inactive · since /)
    expect(managersAttention([inactive({ pendingQuestions: 2, unread: 3 })])).toBeNull()
    expect(managersAttention([inactive({ pendingActions: 1 })])).toBe('needs-you')
  })

  it('surfaces a head for an inactive manager only for an approval', () => {
    expect(restingHeads([inactive({ unread: 1, pendingQuestions: 1 })], {})).toEqual([])
    expect(restingHeads([inactive({ unread: 1, pendingActions: 1 })], {}).map((head) => head.kind)).toEqual(['approval'])
  })
})

describe('the gear menu', () => {
  function renderGear(manager: ManagerSummary) {
    render(<QueryClientProvider client={client([manager])}><ManagerSettings manager={manager} onPatch={vi.fn()} /></QueryClientProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Manager settings' }))
  }

  it('puts Deactivate… above Delete…, confirms what stops, and PATCHes active: false', async () => {
    renderGear(managerFixture({ status: 'working' }))
    const toggle = await screen.findByRole('button', { name: 'Deactivate…' })
    expect(toggle.compareDocumentPosition(screen.getByRole('button', { name: 'Delete…' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(toggle)
    const dialog = await screen.findByRole('alertdialog', { name: /Deactivate Global Manager\?/ })
    expect(within(dialog).getByText('Stops')).toBeTruthy()
    expect(within(dialog).getByText('Keeps going')).toBeTruthy()
    expect(within(dialog).getByText(/is working right now; that turn stops/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(patches).toEqual([{ path: '/api/v1/workspace/managers/global', body: { active: false } }]))
  })

  it('cancelling a deactivate sends nothing', async () => {
    renderGear(managerFixture())
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate…' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(patches).toEqual([])
  })

  it('reactivates quietly unless Catch me up is ticked, and Check now waits for it', async () => {
    renderGear(inactive())
    expect((await screen.findByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate…' }))
    const dialog = await screen.findByRole('alertdialog', { name: /Reactivate Global Manager\?/ })
    const box = within(dialog).getByRole('checkbox', { name: /Catch me up/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }))
    await waitFor(() => expect(patches).toEqual([{ path: '/api/v1/workspace/managers/global', body: { active: true, catchUp: true } }]))
  })
})

describe('the sidebar', () => {
  const list = () => [
    managerFixture({ id: 'ops', name: 'Ops', lastActivityAt: '2026-11-19T10:00:00Z' }),
    inactive({ id: 'qa', name: 'Nightly QA', pendingQuestions: 1, lastActivityAt: '2026-11-19T11:00:00Z' }),
  ]

  function renderSidebar(managers = list()) {
    render(
      <QueryClientProvider client={client(managers)}>
        <MemoryRouter initialEntries={['/manager/ops']}><ManagerSidebar /></MemoryRouter>
      </QueryClientProvider>,
    )
    return screen.getByRole('navigation', { name: 'Managers' })
  }

  it('lists inactive managers under "Inactive · N", greyed, named inactive, with a grey dot', () => {
    const nav = renderSidebar()
    const rows = [...nav.querySelectorAll('[data-slot="manager-row"]')]
    expect(rows.map((row) => row.textContent?.match(/^(Ops|Nightly QA)/)?.[1])).toEqual(['Ops', 'Nightly QA'])
    const divider = nav.querySelector('[data-slot="manager-inactive-divider"]')!
    expect(divider.textContent).toBe('Inactive · 1')
    expect(rows[0]!.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const qa = rows[1] as HTMLElement
    expect(qa.dataset.inactive).toBe('true')
    expect(qa.textContent).toContain(', inactive')
    expect(qa.querySelector('[data-slot="manager-avatar-inactive"]')).not.toBeNull()
    expect(qa.querySelector('[data-slot="manager-row-preview"]')!.textContent).toMatch(/^Inactive · since /)
    expect(qa.querySelector('[data-slot="manager-row-preview"]')!.className).not.toContain('text-info')
    expect(qa.querySelector('[data-slot="manager-unread"]')!.className).toContain('bg-muted-foreground')
  })

  it('opens a row menu on right-click with Open chat, Settings…, Reactivate… and Delete…', async () => {
    const nav = renderSidebar()
    fireEvent.contextMenu(nav.querySelectorAll('[data-slot="manager-row"]')[1]!)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open chat', 'Settings…', 'Reactivate…', 'Delete…'])
  })

  it('the hover ⋯ deactivates an active one through the confirm', async () => {
    renderSidebar()
    const more = screen.getByRole('button', { name: 'More for Ops' })
    fireEvent.pointerDown(more, { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Deactivate…' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(patches).toEqual([{ path: '/api/v1/workspace/managers/ops', body: { active: false } }]))
  })

  it('the heading menu deactivates every active manager after one confirm, and reactivates all without one', async () => {
    renderSidebar([managerFixture({ id: 'ops', name: 'Ops' }), managerFixture({ id: 'triage', name: 'Triage' }), inactive({ id: 'qa', name: 'QA' })])
    const open = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Managers menu' }), { button: 0, pointerType: 'mouse' })
    open()
    expect(await screen.findByText('2 active · 1 inactive')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate all…' }))
    const dialog = await screen.findByRole('alertdialog', { name: /Deactivate all 2 active managers\?/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate all' }))
    await waitFor(() => expect(patches).toEqual([{ path: '/api/v1/workspace/managers/activity', body: { active: false } }]))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    patches.length = 0
    open()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reactivate all' }))
    await waitFor(() => expect(patches).toEqual([{ path: '/api/v1/workspace/managers/activity', body: { active: true } }]))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('Settings → Manager', () => {
  it('lists each manager with an active switch that confirms first, and the bulk pair', async () => {
    const managers = [managerFixture({ id: 'ops', name: 'Ops' }), inactive({ id: 'qa', name: 'QA' })]
    render(<QueryClientProvider client={client(managers)}><MemoryRouter><ManagerActivitySection /></MemoryRouter></QueryClientProvider>)
    const qa = screen.getByRole('switch', { name: 'QA active' })
    expect(qa.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Ops active' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: 'Deactivate all…' })).toBeTruthy()
    fireEvent.click(qa)
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: /Reactivate QA\?/ })).getByRole('button', { name: 'Reactivate' }))
    await waitFor(() => expect(patches).toEqual([{ path: '/api/v1/workspace/managers/qa', body: { active: true } }]))
  })
})
