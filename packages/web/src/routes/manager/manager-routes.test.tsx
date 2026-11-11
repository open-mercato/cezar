import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

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

/** jsdom has no IntersectionObserver: this one reports each target against its root's rect once. */
class FakeIntersectionObserver {
  static created = 0
  private targets: Element[] = []
  private live = true
  constructor(private callback: IntersectionObserverCallback, private options: IntersectionObserverInit = {}) {
    FakeIntersectionObserver.created += 1
  }
  observe(target: Element) {
    this.targets.push(target)
    queueMicrotask(() => {
      if (!this.live) return
      const root = (this.options.root as Element).getBoundingClientRect()
      const rect = target.getBoundingClientRect()
      const isIntersecting = rect.bottom > root.top && rect.top < root.bottom
      act(() => this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver))
    })
  }
  unobserve() {}
  disconnect() {
    this.live = false
  }
  takeRecords() {
    return []
  }
}

function Location() {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  return (
    <>
      <span data-testid="at">{pathname}</span>
      <span data-testid="url" hidden>{pathname + search}</span>
      {/* The system Back, out of the accessibility tree so role queries never see it. */}
      <button type="button" hidden data-testid="history-back" onClick={() => void navigate(-1)} />
    </>
  )
}

function renderAt(entry: string | string[], seed?: (client: QueryClient) => void) {
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
      <MemoryRouter initialEntries={Array.isArray(entry) ? entry : [entry]}>
        <Location />
        <Routes>
          <Route path="/manager" element={<ManagerIndexRoute />} />
          <Route path="/manager/new" element={<ManagerNewRoute />} />
          <Route path="/manager/:id" element={<ManagerChatRoute />} />
          <Route path="/start" element={null} />
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
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  FakeIntersectionObserver.created = 0
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('/manager', () => {
  it('opens first-run setup when there is no manager', async () => {
    server.managers = []
    renderAt('/manager')
    expect(await screen.findByRole('heading', { name: 'Set up your first manager' })).toBeTruthy()
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
    server.managers = [...server.managers, managerFixture({ id: 'second' })]
    renderAt('/manager')
    await waitFor(() => expect(document.querySelector('[data-route="manager-list"]')).not.toBeNull())
    expect(screen.getByTestId('at').textContent).toBe('/manager')
    expect(screen.getByRole('link', { name: 'New manager' })).toBeTruthy()
  })

  it('hands the first chat\'s composer the focus after a first-run create on a desktop', async () => {
    server.managers = []
    renderAt('/manager')
    await screen.findByRole('heading', { name: 'Set up your first manager' })
    send('Watch the repositories')
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Made' })))
  })

  it('leaves focus alone after a first-run create on a phone', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse'), addEventListener() {}, removeEventListener() {} }))
    server.managers = []
    renderAt('/manager')
    await screen.findByRole('heading', { name: 'Set up your first manager' })
    expect(document.activeElement).not.toBe(composer())
    fireEvent.click(screen.getByRole('button', { name: MANAGER_PRESETS[0].label }))
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    await waitFor(() => expect(posted('/made/messages')).toHaveLength(1))
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Message Made' }))
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
    await screen.findByRole('heading', { name: 'Set up your first manager' })
    fireEvent.click(screen.getByRole('button', { name: MANAGER_PRESETS[0].label }))
    expect(composer().value).toBe(MANAGER_PRESETS[0].prompt)
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    expect(posted('/workspace/managers')[0]?.body).toEqual({
      name: MANAGER_PRESETS[0].name,
      instructions: MANAGER_PRESETS[0].prompt,
      projects: 'all',
      effort: 'medium',
      mascot: 'base',
    })
    expect(posted('/made/messages')[0]?.body).toEqual({ text: MANAGER_PRESETS[0].prompt })
  })

  it('sends the chosen mascot when creating a manager', async () => {
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'New manager' })
    fireEvent.click(screen.getByRole('radio', { name: 'Scout' }))
    send('Watch the repositories')
    await waitFor(() => expect(posted('/workspace/managers')[0]?.body).toMatchObject({ mascot: 'scout' }))
  })

  it('hands the new chat\'s composer the focus on a desktop', async () => {
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'New manager' })
    send('Watch the repositories')
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Made' })))
  })

  it('leaves the new chat\'s composer alone on a phone, where focus raises the keyboard', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse'), addEventListener() {}, removeEventListener() {} }))
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'New manager' })
    fireEvent.click(screen.getByRole('button', { name: MANAGER_PRESETS[0].label }))
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    await screen.findByRole('textbox', { name: 'Message Made' })
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Message Made' }))
  })

  it('focuses the field on a desktop but not on a phone, where focus raises the keyboard', async () => {
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'New manager' })
    expect(document.activeElement).toBe(composer())
    cleanup()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse'), addEventListener() {}, removeEventListener() {} }))
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'New manager' })
    expect(document.activeElement).not.toBe(composer())
  })

  it('gives presets, pickers and the composer\'s buttons thumb-sized targets on a touch screen', async () => {
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'New manager' })
    for (const preset of MANAGER_PRESETS) expect(screen.getByRole('button', { name: preset.label }).className).toContain('pointer-coarse:min-h-11')
    expect(screen.getByRole('button', { name: 'Connected projects' }).className).toContain('pointer-coarse:min-h-11')
    expect(screen.getByRole('button', { name: 'Attach files' }).className).toContain('pointer-coarse:max-md:size-11')
    expect(screen.getByRole('button', { name: 'Create manager' }).className).toContain('pointer-coarse:max-md:h-11')
  })

  it('reads as a second manager once one exists', async () => {
    renderAt('/manager/new')
    expect(await screen.findByRole('heading', { name: 'New manager' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up your first manager' })).toBeNull()
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
    expect(screen.getByRole('button', { name: 'Connected projects' }).textContent).toContain('All projects · write')
    expect(screen.getByRole('button', { name: 'Watch check cadence' }).textContent).toContain('Refresh: 15 min')
    expect(screen.queryByRole('status', { name: 'Working' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(false)
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

  describe('/manager on a phone', () => {
    beforeEach(() => {
      vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    })
    const names = () => [...document.querySelectorAll('[data-route="manager-list"] a[href^="/manager/"]')]
      .map((row) => row.getAttribute('href'))
      .filter((href) => href !== '/manager/new')

    it('opens the only manager straight in its chat', async () => {
      server.managers = [managerFixture({ id: 'solo' })]
      renderAt('/manager')
      await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/solo'))
    })

    it('all=1 always shows the list, so the back arrow cannot loop into the same chat', async () => {
      server.managers = [managerFixture({ id: 'solo' })]
      renderAt('/manager?all=1')
      await waitFor(() => expect(names()).toEqual(['/manager/solo']))
      expect(screen.getByRole('link', { name: 'New manager' })).toBeTruthy()
    })

    it('all=1 shows the list on a desktop too', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
      server.managers = [managerFixture({ id: 'solo' })]
      renderAt('/manager?all=1')
      await waitFor(() => expect(names()).toEqual(['/manager/solo']))
    })

    it('shows several as a list, managers holding approvals first and otherwise most recent', async () => {
      server.managers = [
        managerFixture({ id: 'newest', lastActivityAt: '2026-10-31T12:00:00.000Z' }),
        managerFixture({ id: 'older', lastActivityAt: '2026-10-31T11:00:00.000Z' }),
        managerFixture({ id: 'pending-old', lastActivityAt: '2026-10-31T09:00:00.000Z', pendingActions: 1 }),
        managerFixture({ id: 'pending-new', lastActivityAt: '2026-10-31T10:00:00.000Z', pendingActions: 2 }),
      ]
      renderAt('/manager')
      await waitFor(() => expect(names()).toEqual([
        '/manager/pending-new',
        '/manager/pending-old',
        '/manager/newest',
        '/manager/older',
      ]))
    })

    it('sorts a manager waiting on an answer with those holding approvals', async () => {
      server.managers = [
        managerFixture({ id: 'newest', lastActivityAt: '2026-10-31T12:00:00.000Z' }),
        managerFixture({ id: 'asking', lastActivityAt: '2026-10-31T09:00:00.000Z', pendingQuestions: 1 }),
        managerFixture({ id: 'approving', lastActivityAt: '2026-10-31T10:00:00.000Z', pendingActions: 1 }),
      ]
      renderAt('/manager')
      await waitFor(() => expect(names()).toEqual(['/manager/approving', '/manager/asking', '/manager/newest']))
    })

    const url = () => screen.getByTestId('url').textContent
    const historyBack = () => fireEvent.click(screen.getByTestId('history-back'))

    it('goes back to the list it came from, so the system Back never reopens the chat', async () => {
      server.managers = [managerFixture({ id: 'one', name: 'One' }), managerFixture({ id: 'two', name: 'Two' })]
      renderAt(['/start', '/manager?all=1'])
      await waitFor(() => expect(names()).toHaveLength(2))
      fireEvent.click(document.querySelector('a[href="/manager/two"]')!)
      fireEvent.click(await screen.findByRole('link', { name: 'All managers' }))
      await waitFor(() => expect(url()).toBe('/manager?all=1'))
      historyBack()
      await waitFor(() => expect(url()).toBe('/start'))
    })

    it('puts the list in a deep-linked chat\'s place instead of pushing it', async () => {
      server.managers = [managerFixture({ id: 'one', name: 'One' }), managerFixture({ id: 'two', name: 'Two' })]
      renderAt(['/start', '/manager/two'])
      fireEvent.click(await screen.findByRole('link', { name: 'All managers' }))
      await waitFor(() => expect(url()).toBe('/manager?all=1'))
      historyBack()
      await waitFor(() => expect(url()).toBe('/start'))
    })

    it('shows the first-manager setup with no managers', async () => {
      server.managers = []
      renderAt('/manager')
      expect(await screen.findByRole('heading', { name: 'Set up your first manager' })).toBeTruthy()
    })
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

  it('leads the header with the mascot at avatar size, inside the 52 px phone bar', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    onTestFinished(() => getContext.mockRestore())
    seedChat({ mascot: 'base' })
    renderAt('/manager/global')
    const heading = await screen.findByRole('heading', { name: 'Global Manager' })
    const header = heading.closest('header')!
    const mascot = header.querySelector<HTMLElement>('[data-slot="manager-mascot"]')!
    expect(mascot.className.split(' ')).toEqual(expect.arrayContaining(['size-10', 'self-center', 'md:size-14']))
    expect(mascot.className).not.toMatch(/(^| )size-(1[1-9]|[2-9]\d)\b/)
    expect(mascot.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it('hides the shell top bar under the loading chat too, so the header never jumps up when it lands', async () => {
    const bar = document.body.appendChild(document.createElement('header'))
    bar.dataset.slot = 'mobile-top-bar'
    onTestFinished(() => bar.remove())
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderAt('/manager/global')
    expect(screen.getByRole('status', { name: 'Loading conversation…' })).toBeTruthy()
    expect(bar.hidden).toBe(true)
  })

  it('keeps the working + on phones, and sizes the controls for a thumb', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(screen.getByRole('button', { name: 'Attach files' }).className).not.toContain('max-md:hidden')
    expect(composer().className).toContain('max-md:max-h-[calc((100dvh-var(--kb,0px))*0.35)]')
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('pointer-coarse:max-md:h-11')
  })

  it('draws no chip row, and keeps no room for one, until the user defines quick prompts', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    fireEvent.change(composer(), { target: { value: '' } })
    expect(document.querySelector('[data-slot="manager-chips"]')).toBeNull()
  })

  it('offers the user\'s own chips on an empty draft only, and a chip sends its prompt once', async () => {
    seedChat({ quickPrompts: [{ label: 'Standup', prompt: 'Write my standup.' }, { label: 'Check', prompt: '/check' }] })
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const chips = () => [...document.querySelectorAll('[data-slot="manager-chips"] button')].map((chip) => chip.textContent)
    fireEvent.change(composer(), { target: { value: 'x' } })
    expect(chips()).toEqual([])
    fireEvent.change(composer(), { target: { value: '' } })
    expect(chips()).toEqual(['Standup', 'Check'])
    const chip = screen.getByRole('button', { name: 'Standup' })
    fireEvent.click(chip)
    fireEvent.click(chip)
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'Write my standup.' }))
    expect(posted('/global/messages')).toHaveLength(1)
  })

  it('a chip spelling a / command runs the command', async () => {
    seedChat({ quickPrompts: [{ label: 'Check', prompt: '/check' }] })
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
    expect(posted('/global/messages')).toHaveLength(0)
  })

  it('saves prompt buttons from the gear', async () => {
    seedChat()
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Prompt buttons…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add prompt button' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Button label' }), { target: { value: ' Standup ' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Write my standup.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ quickPrompts: [{ label: 'Standup', prompt: 'Write my standup.' }] }))
  })

  it('a failed reply says what to do and offers to send the question again', async () => {
    server.messages = [userMessage(1, 'status please'), assistantMessage(2, { text: '', error: 'Sign in to Claude Code again.' })]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'status please' }))
  })

  it('offers no retry once a newer reply landed, or for a background check', async () => {
    server.messages = [
      userMessage(1, 'status please'),
      assistantMessage(2, { text: '', error: 'Sign in to Claude Code again.' }),
      userMessage(3, 'again'),
      assistantMessage(4, { text: 'Fine now.' }),
      assistantMessage(5, { text: '', turn: 'watch', error: 'Old watch failure' }),
    ]
    renderAt('/manager/global')
    await screen.findByText('Fine now.')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
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

  it('keeps a reader away from the tail on the same row while rows above it grow', async () => {
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
    const row = box.firstElementChild!.lastElementChild!
    let rowTop = 40
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { top: this === row ? rowTop : 0, bottom: 0, left: 0, right: 0, width: 0, height: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    Object.defineProperty(document, 'elementFromPoint', { value: () => row, configurable: true })
    onTestFinished(() => {
      rect.mockRestore()
      Reflect.deleteProperty(document, 'elementFromPoint')
    })
    Object.defineProperty(box, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 500, configurable: true })
    box.scrollTop = 1500
    fireEvent.scroll(box)
    // The reader scrolls up from the tail.
    box.scrollTop = 600
    fireEvent.scroll(box)
    // Markdown or a session card above the reader filled in: 120 px taller.
    rowTop = 160
    grow()
    expect(box.scrollTop).toBe(720)
  })

  it('keeps a reader at the tail pinned when the composer grows, even if a scroll lands first', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    const box = document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')!
    let clientHeight = 500
    let scrollHeight = 900
    Object.defineProperty(box, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    Object.defineProperty(box, 'clientHeight', { get: () => clientHeight, configurable: true })
    box.scrollTop = 400
    fireEvent.scroll(box)
    // Attachments grew the composer by 120 px: the box shrank, its scrollTop did not move.
    clientHeight = 380
    fireEvent.scroll(box)
    expect(box.scrollTop).toBe(900)
    // A scroll queued by a restick (reply grew to 1,000) lands after another 120 px of composer.
    box.scrollTop = 520
    fireEvent.scroll(box)
    scrollHeight = 1000
    box.scrollTop = 620
    clientHeight = 260
    fireEvent.scroll(box)
    expect(box.scrollTop).toBe(1000)
    expect(document.querySelector('[data-slot="manager-scroll-bottom"]')).toBeNull()
    // The reader scrolling up still lets go of the tail.
    box.scrollTop = 200
    fireEvent.scroll(box)
    expect(await screen.findByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()
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

  it('skips rendering only rows off screen: an on-screen row turned `auto` blanks for a frame', async () => {
    seedChat()
    server.messages = [userMessage(1, 'above the fold'), userMessage(2, 'on screen')]
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON() {} }) as DOMRect
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.slot === 'manager-transcript') return rect(0, 500)
      if (this.textContent?.includes('above the fold')) return rect(-400, 100)
      if (this.textContent?.includes('on screen')) return rect(100, 100)
      return rect(0, 0)
    })
    onTestFinished(() => spy.mockRestore())
    renderAt('/manager/global')
    await screen.findByText('on screen')
    const row = (text: string) => screen.getByText(text).closest('[data-slot="manager-user"]') as HTMLElement
    await waitFor(() => expect(row('above the fold').dataset.sized).toBe(''))
    expect(row('on screen').dataset.sized).toBeUndefined()
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
    // One beside the name for phones, one in the desktop footer: CSS shows exactly one.
    const spinners = screen.getAllByRole('status', { name: 'Working' })
    expect(spinners.map((spinner) => spinner.closest('header') ? 'header' : 'footer')).toEqual(['header', 'footer'])
    expect(spinners[0]!.className).toContain('md:hidden')
    expect(spinners[1]!.closest('[data-slot="manager-footer"]')!.className).toContain('max-md:hidden')
    await waitFor(() => expect(posted('/global/stop')).toHaveLength(1))
  })

  it('leaves Refresh to the gear menu on a phone, keeping the desktop footer', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const footer = document.querySelector('[data-slot="manager-footer"]')!
    expect(footer.className).toContain('max-md:hidden')
    expect(footer.querySelector('[data-slot="manager-chron-picker"]')).not.toBeNull()
  })

  const ask = { questions: [
    { header: 'Shell', question: 'Which shell?', options: [{ label: 'Capacitor' }, { label: 'Tauri' }] },
    { header: 'Default', question: 'Open on Manager?', options: [{ label: 'No' }, { label: 'Yes' }] },
  ] }
  const chips = () => document.querySelector('[data-slot="manager-chips"]')

  it('hides the chips while a question waits, and spaces them above the composer otherwise', async () => {
    server.managers = [managerFixture({ quickPrompts: [{ label: 'Standup', prompt: 'Write my standup.' }] })]
    server.messages = [userMessage(1), assistantMessage(2, { text: 'Two decisions.', ask })]
    renderAt('/manager/global')
    await screen.findByRole('button', { name: 'Send answer' })
    fireEvent.change(composer(), { target: { value: '' } })
    expect(chips()).toBeNull()
    cleanup()
    seedChat({ quickPrompts: [{ label: 'Standup', prompt: 'Write my standup.' }] })
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    fireEvent.change(composer(), { target: { value: '' } })
    expect(chips()!.className).toMatch(/\bpt-1\b.*\bpb-2\.5\b/)
  })

  it('hides the chips while an approval waits', async () => {
    seedChat({ pendingActions: 1, quickPrompts: [{ label: 'Standup', prompt: 'Write my standup.' }] })
    server.messages = [actionMessage(3)]
    renderAt('/manager/global')
    await screen.findByRole('button', { name: 'Approve' })
    fireEvent.change(composer(), { target: { value: '' } })
    expect(chips()).toBeNull()
  })

  it('draws a card answer once, on the card, and a typed answer as its own bubble', async () => {
    server.messages = [
      userMessage(1, 'questions please'),
      assistantMessage(2, { text: 'Two decisions.', ask, askAnswer: 'Shell: Tauri\nDefault: No' }),
      userMessage(3, 'Shell: Tauri\nDefault: No'),
      assistantMessage(4, { text: 'Two more.', ask, askAnswer: 'cheapest one' }),
      userMessage(5, 'cheapest one'),
    ]
    renderAt('/manager/global')
    await screen.findByText('Two more.')
    const bubbles = [...document.querySelectorAll('[data-slot="manager-user"]')].map((row) => row.textContent)
    expect(bubbles).toEqual(['questions please', 'cheapest one'])
    const cards = [...document.querySelectorAll('[data-slot="manager-ask"][data-resolved="true"]')].map((card) => card.textContent)
    expect(cards).toEqual(['AnsweredShell:TauriDefault:No', 'Answered:Shell · Default'])
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

    it('measures nothing while nothing waits, however the chat streams or scrolls', async () => {
      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      // A card the server already decided: the pill counts the server's pending, which is 0.
      server.messages = [userMessage(1), { ...actionMessage(3), status: 'done' } as ManagerMessage]
      const client = renderAt('/manager/global')
      await screen.findByText('jak progres prac')
      rect.mockClear()
      act(() => applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'global', message: assistantMessage(4, { text: 'Grow', streaming: true }) })))
      await screen.findByText('Grow')
      fireEvent.scroll(document.querySelector('[data-slot="manager-transcript"]')!)
      const measured = rect.mock.contexts.filter((element) => /^manager-(action|transcript)$/.test((element as Element).getAttribute('data-slot') ?? ''))
      expect(measured).toHaveLength(0)
      expect(FakeIntersectionObserver.created).toBe(0)
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

    it('waits for the first page: there is nothing to page back from before it', async () => {
      server.managers = [managerFixture({ pendingActions: 1 })]
      server.pages = () => new Promise<never>(() => {}) as never
      vi.mocked(fetch).mockImplementation(async (input) => {
        if (String(input).includes('/messages?')) return new Promise<Response>(() => {})
        return json({ managers: server.managers })
      })
      renderAt('/manager/global')
      await screen.findByRole('textbox')
      expect(pill()).toBeNull()
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

  it('announces a reply once, when it settles, and never history', async () => {
    server.messages = [userMessage(1), assistantMessage(2, { text: 'Old news' })]
    const client = renderAt('/manager/global')
    await screen.findByText('Old news')
    const announcer = () => document.querySelector('[data-slot="manager-announcer"]')?.textContent
    expect(announcer()).toBe('')
    const frame = (message: unknown) => applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'global', message }))
    act(() => frame(assistantMessage(3, { text: 'Work', streaming: true })))
    await screen.findByText('Work')
    expect(announcer()).toBe('')
    act(() => frame(assistantMessage(3, { text: 'Work is **done**', streaming: false })))
    await waitFor(() => expect(announcer()).toBe('Global Manager replied: Work is done'))
  })

  it('keeps the floating pill off the last lines by exactly its measured height', async () => {
    const observed: Array<{ target: Element; options: ResizeObserverOptions | undefined; fire: () => void }> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(target: Element, options?: ResizeObserverOptions) { observed.push({ target, options, fire: () => this.callback() }) }
      unobserve() {}
      disconnect() {}
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.slot === 'manager-floating' && this.childElementCount > 0 ? 52 : 0
      return { height, width: 0, top: 0, bottom: height, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    onTestFinished(() => rect.mockRestore())
    server.managers = [managerFixture({ pendingActions: 1 })]
    server.messages = [actionMessage(3)]
    renderAt('/manager/global')
    await screen.findByRole('button', { name: 'Approve' })
    const body = document.querySelector<HTMLElement>('[data-slot="manager-transcript-body"]')!
    expect(body.style.paddingBottom).toBe('')
    await waitFor(() => expect(document.querySelector('[data-slot="manager-approvals-pill"]')).not.toBeNull())
    act(() => observed.filter(({ target }) => target.getAttribute('data-slot') === 'manager-floating').forEach(({ fire }) => fire()))
    expect(body.style.paddingBottom).toMatch(/^calc\((1\.5rem \+ 52px|52px \+ 1\.5rem)\)$/)
    // The padding grows under a pinned reader: the box watches the border box so it re-pins.
    expect(observed.find(({ target }) => target === body)?.options).toEqual({ box: 'border-box' })
  })

  it('keeps only the newest page of a chat the reader leaves, so coming back re-mounts one page', async () => {
    server.messages = [userMessage(40), userMessage(41, 'newest')]
    server.hasMore = true
    const client = renderAt('/manager/global')
    const more = await screen.findByRole('button', { name: 'Load earlier messages' })
    server.messages = [userMessage(39, 'older')]
    server.hasMore = false
    fireEvent.click(more)
    await screen.findByText('older')
    expect(client.getQueryData<{ pages: unknown[] }>(managerKeys.messages('global'))?.pages).toHaveLength(2)
    cleanup()
    const kept = client.getQueryData<{ pages: Array<{ messages: ManagerMessage[] }> }>(managerKeys.messages('global'))
    expect(kept?.pages).toHaveLength(1)
    expect(kept?.pages[0]?.messages.map((message) => message.seq)).toEqual([40, 41])
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

  it('draws the transcript skeleton from the first frame: the header is already real', async () => {
    server.managers = [managerFixture()]
    const answer = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => (input.includes('/messages?') ? new Promise(() => {}) : answer(input, init))))
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const loading = screen.getByRole('status', { name: 'Loading messages…' })
    expect(loading.getAttribute('data-revealed')).toBe('true')
    expect(loading.querySelector('[data-slot="chat-skeleton"]')).not.toBeNull()
  })

  describe('a transcript that failed to load', () => {
    const failMessages = () => {
      const answer = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => (
        input.includes('/messages?') ? Promise.resolve(json({ error: 'Server unreachable' }, 500)) : answer(input, init))))
      return () => vi.stubGlobal('fetch', answer)
    }

    it('offers Retry, which loads it once the server is back', async () => {
      seedChat()
      const restore = failMessages()
      renderAt('/manager/global')
      expect((await screen.findByRole('alert')).textContent).toBe('Server unreachable')
      restore()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByText('Reply body')).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('keeps keyboard focus on Retry while it fetches, then hands it to the transcript', async () => {
      seedChat()
      const restore = failMessages()
      renderAt('/manager/global')
      await screen.findByRole('alert')
      const retry = screen.getByRole('button', { name: 'Retry' })
      retry.focus()
      restore()
      fireEvent.click(retry)
      expect(retry.hasAttribute('disabled')).toBe(false)
      expect(await screen.findByText('Reply body')).toBeTruthy()
      await waitFor(() => expect(document.activeElement?.getAttribute('data-slot')).toBe('manager-transcript'))
    })

    it('recovers by itself when the tab comes back or the network does', async () => {
      for (const wake of ['visibility', 'online']) {
        seedChat()
        const restore = failMessages()
        renderAt('/manager/global')
        await screen.findByRole('alert')
        restore()
        if (wake === 'online') window.dispatchEvent(new Event('online'))
        else document.dispatchEvent(new Event('visibilitychange'))
        expect(await screen.findByText('Reply body')).toBeTruthy()
        cleanup()
      }
    })

    it('retries on a backoff with nobody touching it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      onTestFinished(() => { vi.useRealTimers() })
      seedChat()
      const restore = failMessages()
      renderAt('/manager/global')
      await screen.findByRole('alert')
      restore()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
      expect(await screen.findByText('Reply body')).toBeTruthy()
    })
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

  it('opens the next manager with its composer focused after a delete', async () => {
    server.managers = [
      managerFixture({ id: 'global', lastActivityAt: '2026-10-31T00:00:00Z' }),
      managerFixture({ id: 'next', name: 'Next Manager', lastActivityAt: '2026-10-01T00:00:00Z' }),
    ]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/next'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Next Manager' })))
  })

  it('does not take focus on an ordinary open', async () => {
    renderAt('/manager/global')
    await screen.findByRole('textbox', { name: 'Message Global Manager' })
    expect(document.activeElement).toBe(document.body)
  })

  it('checks now from the gear', async () => {
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
  })
})
