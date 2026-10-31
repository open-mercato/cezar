import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyManagerEvent, managerKeys, type ManagerEventName } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerChatRoute } from './manager-chat'
import { actionMessage, assistantMessage, managerFixture, userMessage } from './manager-fixtures'
import { ManagerIndexRoute } from './manager-index'
import { ManagerNewRoute, applySetupPatch, MANAGER_PRESETS, managerNameFrom } from './manager-new'

interface Page { messages: ManagerMessage[]; hasMore: boolean }
let server: { managers: ManagerSummary[]; messages: ManagerMessage[]; hasMore: boolean; pending: Page; pages?: (path: string) => Page }
const calls: Array<{ method: string; path: string; body?: unknown }> = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function route(path: string, method: string, body: unknown): Response {
  if (path === '/api/v1/workspace/managers') {
    if (method === 'GET') return json({ managers: server.managers })
    const created = managerFixture({ id: 'made', name: 'Made' })
    server.managers = [created]
    return json(created)
  }
  if (/\/messages\?.*pending=1/.test(path)) return json(server.pending)
  if (/\/messages\?/.test(path)) return json(server.pages?.(path) ?? { messages: server.messages, hasMore: server.hasMore })
  if (method === 'PATCH') return json({ ...server.managers[0], ...(body as object) })
  return json({ ok: true })
}

function stubServer() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    if (input.includes('/workspace/managers')) {
      calls.push({ method, path: input, body })
      return route(input, method, body)
    }
    return json({})
  }))
}

function Location() {
  return <span data-testid="at">{useLocation().pathname}</span>
}

function renderAt(entry: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: true }, defaultRunner: 'claude', bootProject: 'alpha', checks: [] })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
    bootProject: 'alpha',
    projectsDir: '',
  })
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
  seed?.(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Location />
        <Routes>
          <Route path="/manager" element={<ManagerIndexRoute />} />
          <Route path="/manager/new" element={<ManagerNewRoute />} />
          <Route path="/manager/:id" element={<ManagerChatRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const posted = (suffix: string) => calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix))
const composer = () => screen.getByRole('textbox') as HTMLTextAreaElement
function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
}

beforeEach(() => {
  server = { managers: [managerFixture()], messages: [], hasMore: false, pending: { messages: [], hasMore: false } }
  calls.length = 0
  stubServer()
  // jsdom has neither; the chat scrolls and the popovers measure.
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('/manager', () => {
  it('opens first-run setup when there is no manager', async () => {
    server.managers = []
    renderAt('/manager')
    expect(await screen.findByRole('heading', { name: 'Setup Your first manager' })).toBeTruthy()
  })

  it('opens the most recent manager on a desktop', async () => {
    server.managers = [
      managerFixture({ id: 'old', lastActivityAt: '2026-10-01T00:00:00Z' }),
      managerFixture({ id: 'recent', lastActivityAt: '2026-10-31T00:00:00Z' }),
    ]
    renderAt('/manager')
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/recent'))
  })

  it('lists managers as a screen of its own on a phone', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    renderAt('/manager')
    await waitFor(() => expect(document.querySelector('[data-route="manager-list"]')).not.toBeNull())
    expect(screen.getByTestId('at').textContent).toBe('/manager')
    expect(screen.getByRole('link', { name: 'New manager' })).toBeTruthy()
  })
})

describe('managerNameFrom', () => {
  it('names a manager after its preset, or the first line of what it was told', () => {
    expect(managerNameFrom(MANAGER_PRESETS[1].prompt)).toBe('PR Manager')
    expect(managerNameFrom('Watch the docs.\nAnd more')).toBe('Watch the docs')
    expect(managerNameFrom('Keep the release train moving: tell me what blocks the next cut')).toBe('Keep the release train moving: tell me…')
    expect(managerNameFrom('x'.repeat(200))).toHaveLength(41)
  })
})

describe('/manager/new', () => {
  it('fills the box from a preset, creates, sends the prompt first and opens the chat', async () => {
    server.managers = []
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'Setup Your first manager' })
    fireEvent.click(screen.getByRole('button', { name: MANAGER_PRESETS[0].label }))
    expect(composer().value).toBe(MANAGER_PRESETS[0].prompt)
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    expect(posted('/workspace/managers')[0]?.body).toEqual({
      name: MANAGER_PRESETS[0].name,
      instructions: MANAGER_PRESETS[0].prompt,
      projects: 'all',
      effort: 'medium',
    })
    expect(posted('/made/messages')[0]?.body).toEqual({ text: MANAGER_PRESETS[0].prompt })
  })

  it('reads as a second manager once one exists', async () => {
    renderAt('/manager/new')
    expect(await screen.findByRole('heading', { name: 'New manager' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Setup Your first manager' })).toBeNull()
  })

  it('folds picker patches, null meaning back to the default', () => {
    const setup = { projects: 'all' as const, model: 'm', effort: 'high' as const }
    expect(applySetupPatch(setup, { model: null, effort: 'low', projects: ['a'] })).toEqual({ projects: ['a'], effort: 'low' })
  })
})

describe('/manager/:id', () => {
  const seedChat = (patch: Partial<ManagerSummary> = {}) => {
    server.managers = [managerFixture(patch)]
    server.messages = [userMessage(1), assistantMessage(2, { text: 'Reply body', commands: [{ id: 'c', tool: 'Bash', summary: 'gh pr list' }] })]
  }

  it('shows the header, the transcript and the footer', async () => {
    seedChat()
    renderAt('/manager/global')
    expect(await screen.findByRole('heading', { name: 'Global Manager' })).toBeTruthy()
    expect(await screen.findByText('jak progres prac')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Ran 1 command' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connected projects' }).textContent).toContain('All projects access')
    expect(screen.getByRole('button', { name: 'Watch check cadence' }).textContent).toContain('Refresh: 15 min')
    expect(screen.queryByRole('status')).toBeNull()
    // Drawn in the frame, inert until a runner can take files (spec § Not in v1).
    expect(screen.getByRole('button', { name: 'Attach files' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('renders the composer as one row, with Send only once there is a draft', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const row = document.querySelector('[data-slot="composer-compact-row"]')
    expect(row?.contains(composer())).toBe(true)
    // Desktop waits for a draft; the phone's Send pill is always drawn.
    expect(row?.querySelector('[data-slot="composer-compact-send"]')?.className).toContain('md:hidden')
    fireEvent.change(composer(), { target: { value: 'hi' } })
    expect(row?.querySelector('[data-slot="composer-compact-send"]')?.className).toBe('contents')
    expect(row?.contains(screen.getByRole('button', { name: 'Send' }))).toBe(true)
  })

  it('leaves for the list when the manager it shows is deleted', async () => {
    seedChat()
    const client = renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    server.managers = []
    act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', deleted: true })))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager'))
    expect(screen.queryByText('This manager no longer exists')).toBeNull()
  })

  it('keeps the dead end for a link that never resolved', async () => {
    renderAt('/manager/nope')
    expect(await screen.findByText('This manager no longer exists')).toBeTruthy()
  })

  it('merges the phone header into one row: back to the whole list, projects in the gear', async () => {
    seedChat()
    renderAt('/manager/global')
    const heading = await screen.findByRole('heading', { name: 'Global Manager' })
    expect(heading.closest('header')?.className).toContain('max-md:h-13')
    expect(screen.getByRole('link', { name: 'All managers' }).getAttribute('href')).toBe('/manager?all=1')
    expect(screen.getByRole('button', { name: 'Connected projects' }).parentElement?.className).toBe('max-md:hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Manager settings' }))
    const menu = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="manager-settings-menu"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(menu.querySelector('[data-slot="manager-projects-picker"]')).not.toBeNull()
  })

  it('hides the shell top bar only while the chat is on screen', async () => {
    const bar = document.body.appendChild(document.createElement('header'))
    bar.dataset.slot = 'mobile-top-bar'
    seedChat()
    const client = renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(bar.hidden).toBe(true)
    server.managers = []
    act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', deleted: true })))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager'))
    expect(bar.hidden).toBe(false)
    bar.remove()
  })

  it('drops the inert + on phones, and sizes the controls for a thumb', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(screen.getByRole('button', { name: 'Attach files' }).className).toContain('max-md:hidden')
    expect(composer().className).toContain('max-md:max-h-[calc((100dvh-var(--kb,0px))*0.35)]')
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('pointer-coarse:max-md:h-11')
  })

  it('offers chips on an empty draft only, and a chip sends its command once', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const chips = () => [...document.querySelectorAll('[data-slot="manager-chips"] button')].map((chip) => chip.textContent)
    fireEvent.change(composer(), { target: { value: 'x' } })
    expect(chips()).toEqual([])
    fireEvent.change(composer(), { target: { value: '' } })
    expect(chips()).toEqual(['status', 'attention', 'prs'])
    const chip = screen.getByRole('button', { name: /^attention/ })
    fireEvent.click(chip)
    fireEvent.click(chip)
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'What needs my attention right now?' }))
    expect(posted('/global/messages')).toHaveLength(1)
  })

  it('hides the Refresh footer while the keyboard is open', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query !== '(min-width: 768px)', addEventListener() {}, removeEventListener() {} }))
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(document.querySelector('[data-slot="manager-footer"]')).not.toBeNull()
    act(() => {
      composer().focus()
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    act(() => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-slot="manager-footer"]')).not.toBeNull()
  })

  it('re-pins a reader at the tail once the keyboard settles, and writes --kb', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    seedChat()
    renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    const box = document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')!
    Object.defineProperty(box, 'scrollHeight', { value: 900, configurable: true })
    viewport.height = 460
    act(() => {
      viewport.dispatchEvent(new Event('resize'))
      vi.advanceTimersByTime(250)
    })
    expect(document.documentElement.style.getPropertyValue('--kb')).toBe('340px')
    expect(box.scrollTop).toBe(900)
    cleanup()
    expect(document.documentElement.style.getPropertyValue('--kb')).toBe('0px')
    Object.defineProperty(window, 'visualViewport', { value: null, configurable: true })
    vi.useRealTimers()
  })

  it('does not let the second click of a double-click on Send stop the turn it started', async () => {
    seedChat({ status: 'working' })
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('go')
    await waitFor(() => expect(posted('/messages')).toHaveLength(1))
    fireEvent.click(document.querySelector('[data-slot="composer-stop"]')!)
    expect(posted('/stop')).toHaveLength(0)
  })

  it('names a project that is gone instead of showing its id, and unticks it on the next pick', async () => {
    seedChat({ projects: ['gone'] })
    renderAt('/manager/global')
    const picker = await screen.findByRole('button', { name: 'Connected projects' })
    expect(picker.textContent).toContain('Project removed')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByText('Beta'))
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ projects: ['beta'] }))
  })

  it('stays at the tail when a row grows after its first paint', async () => {
    let grow = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { grow = callback }
      observe() {}
      disconnect() {}
    })
    seedChat()
    renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    const box = document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')!
    Object.defineProperty(box, 'scrollHeight', { value: 900, configurable: true })
    grow()
    expect(box.scrollTop).toBe(900)
  })

  it('watches the transcript box as well, which shrinks when the chips come back', async () => {
    const watched = new Set<Element>()
    vi.stubGlobal('ResizeObserver', class {
      observe(target: Element) { watched.add(target) }
      disconnect() {}
    })
    seedChat()
    renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    expect(watched.has(document.querySelector('[data-slot="manager-transcript"]')!)).toBe(true)
  })

  it('tells an empty chat what to do', async () => {
    seedChat()
    server.messages = []
    renderAt('/manager/global')
    expect((await screen.findByText(/what needs you/)).closest('[data-slot="manager-empty"]')).toBeTruthy()
  })

  it('sends a message', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('hello there')
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'hello there' }))
  })

  it('expands a prompt command and routes /check and /stop', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('/status')
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'Give me a short status of my connected projects.' }))
    await waitFor(() => expect(composer().value).toBe(''))
    send('/check')
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
    await waitFor(() => expect(composer().value).toBe(''))
    send('/stop')
    await waitFor(() => expect(posted('/global/stop')).toHaveLength(1))
    expect(posted('/global/messages')).toHaveLength(1)
  })

  it('offers the commands in the / menu, not skills', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    fireEvent.change(composer(), { target: { value: '/att' } })
    const item = await waitFor(() => {
      const found = document.querySelector('[data-slot="composer-menu-item"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(item.textContent).toContain('/attention')
  })

  it('shows Stop and the spinner while working, and posts the stop', async () => {
    server.managers = [managerFixture({ status: 'working' })]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy()
    await waitFor(() => expect(posted('/global/stop')).toHaveLength(1))
  })

  it('approves through the decision route, never as a chat message', async () => {
    server.messages = [actionMessage(3)]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(posted('/global/actions/a3/decision')).toEqual([])
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))
    await waitFor(() => {
      expect(posted('/global/actions/a3/decision')[0]?.body).toEqual({ decision: 'approve' })
    })
    expect(posted('/global/messages')).toEqual([])
  })

  it('sends the identical decision request with the step switched off', async () => {
    const seed = (managerConfirm?: object) => (client: QueryClient) => client.setQueryData(workspaceQueryKeys.uiState, { managerConfirm })
    server.messages = [actionMessage(3)]
    renderAt('/manager/global', seed())
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(posted('/global/actions/a3/decision')).toHaveLength(1))
    const confirmed = posted('/global/actions/a3/decision')[0]
    cleanup()
    calls.length = 0
    renderAt('/manager/global', seed({ 'merge-pr': false }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(posted('/global/actions/a3/decision')).toHaveLength(1))
    expect(posted('/global/actions/a3/decision')[0]).toEqual(confirmed)
  })

  it('decides each card on its own: one in flight leaves the other live', async () => {
    server.messages = [actionMessage(3), actionMessage(4)]
    renderAt('/manager/global')
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
    const rejects = await screen.findAllByRole('button', { name: 'Reject' }) as HTMLButtonElement[]
    fireEvent.click(rejects[0]!)
    expect(rejects[0]!.disabled).toBe(true)
    expect(rejects[1]!.disabled).toBe(false)
  })

  describe('the approvals pill', () => {
    const pill = () => document.querySelector<HTMLButtonElement>('[data-slot="manager-approvals-pill"]')
    const near = { top: 0, bottom: 100 }
    const place = (rects: (element: Element) => { top: number; bottom: number }) => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
        return rects(this) as DOMRect
      })
    }
    afterEach(() => vi.restoreAllMocks())

    it('stays away with nothing waiting', async () => {
      server.messages = [userMessage(1)]
      renderAt('/manager/global')
      await screen.findByText('jak progres prac')
      expect(pill()).toBeNull()
    })

    it('stays away while every waiting card is on screen', async () => {
      place(() => near)
      server.managers = [managerFixture({ pendingActions: 1 })]
      server.messages = [actionMessage(3)]
      renderAt('/manager/global')
      await screen.findByRole('button', { name: 'Approve' })
      expect(pill()).toBeNull()
    })

    it('shows the server count while a card is off screen, and a singular', async () => {
      place((element) => (element.getAttribute('data-slot') === 'manager-action' ? { top: 500, bottom: 600 } : near))
      server.managers = [managerFixture({ pendingActions: 1 })]
      server.messages = [actionMessage(3)]
      renderAt('/manager/global')
      await waitFor(() => expect(pill()?.textContent).toBe('1 approval waiting'))
    })

    it('jumps to the oldest waiting card, paging back with `before` until it is loaded', async () => {
      const older = actionMessage(10)
      server.managers = [managerFixture({ pendingActions: 3 })]
      server.pending = { messages: [older, actionMessage(70), actionMessage(120)], hasMore: false }
      server.pages = (path) => {
        const before = new URL(path, 'http://x').searchParams.get('before')
        if (before === '100') return { messages: [userMessage(60), actionMessage(70)], hasMore: true }
        if (before === '60') return { messages: [older, userMessage(20)], hasMore: false }
        return { messages: [userMessage(100), actionMessage(120)], hasMore: true }
      }
      renderAt('/manager/global')
      await waitFor(() => expect(pill()?.textContent).toBe('3 approvals waiting'))
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      fireEvent.click(pill()!)
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1))
      const target = vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0] as HTMLElement
      expect(target.dataset.actionId).toBe('a10')
      expect(document.activeElement).toBe(target)
      expect(calls.some((call) => call.path.includes('pending=1'))).toBe(true)
    })

    it('stops paging when a page fails', async () => {
      server.managers = [managerFixture({ pendingActions: 1 })]
      server.pending = { messages: [actionMessage(10)], hasMore: false }
      server.messages = [userMessage(100)]
      server.hasMore = true
      renderAt('/manager/global')
      await waitFor(() => expect(pill()).not.toBeNull())
      const paged = vi.fn()
      vi.mocked(fetch).mockImplementation(async (input) => {
        if (String(input).includes('pending=1')) return json(server.pending)
        paged()
        return json({ error: 'offline' }, 500)
      })
      fireEvent.click(pill()!)
      await waitFor(() => expect(paged).toHaveBeenCalled())
      await waitFor(() => expect(pill()?.disabled).toBe(false))
      expect(paged).toHaveBeenCalledTimes(1)
    })
  })

  it('clears unread on open, and optimistically', async () => {
    server.managers = [managerFixture({ unread: 2 })]
    const client = renderAt('/manager/global')
    await waitFor(() => expect(posted('/global/read')).toHaveLength(1))
    expect(client.getQueryData<{ managers: ManagerSummary[] }>(managerKeys.list)?.managers[0]?.unread).toBe(0)
  })

  it('patches a live reply in from the stream without a refetch', async () => {
    server.messages = [userMessage(1)]
    const client = renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    const frame = (name: ManagerEventName, payload: unknown) => applyManagerEvent(client, name, JSON.stringify(payload))
    frame('manager-message', { managerId: 'global', message: assistantMessage(2, { text: 'Stre', streaming: true }) })
    expect(await screen.findByText('Stre')).toBeTruthy()
    frame('manager-message', { managerId: 'global', message: assistantMessage(2, { text: 'Streamed', streaming: true }) })
    expect(await screen.findByText('Streamed')).toBeTruthy()
    expect(calls.filter((call) => call.path.includes('/messages?'))).toHaveLength(1)
  })

  it('pages older history with the oldest seq it holds', async () => {
    server.messages = [userMessage(40), userMessage(41, 'newest')]
    server.hasMore = true
    renderAt('/manager/global')
    const more = await screen.findByRole('button', { name: 'Load earlier messages' })
    server.messages = [userMessage(39, 'older')]
    server.hasMore = false
    fireEvent.click(more)
    expect(await screen.findByText('older')).toBeTruthy()
    expect(calls.some((call) => call.path.includes('before=40'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
  })

  it('says a manager is gone rather than loading forever', async () => {
    renderAt('/manager/nobody')
    expect(await screen.findByRole('heading', { name: 'This manager no longer exists' })).toBeTruthy()
  })

  it('reports an unavailable server through the shared state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Managers are off' }, 409)))
    renderAt('/manager/global')
    expect(await screen.findByRole('heading', { name: 'Managers are unavailable' })).toBeTruthy()
    expect(screen.getByText('Managers are off')).toBeTruthy()
  })

  it('renames and deletes from the gear, deleting only after confirmation', async () => {
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete Global Manager?')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/global'))).toBe(true))
  })

  it('checks now from the gear', async () => {
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
  })
})
