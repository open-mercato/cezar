import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { applyManagerEvent, managerKeys, type ManagerEventName } from '@/api/managers'
import { planUsageKeys } from '@/api/plan-usage'
import { __clearRememberedStatusesForTests, queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'
import { runnerSchema } from '@open-mercato/cezar-api-client'

import { AppShell } from '@/components/app-shell'
import { ThemeProvider } from '@/components/theme-provider'

import { ManagerChatRoute, forgetChatPlaces } from './manager-chat'
import { actionMessage, assistantMessage, managerFixture, userMessage } from './manager-fixtures'
import { ManagerIndexRoute } from './manager-index'
import { ManagerNewRoute, applySetupPatch, MANAGER_PRESETS, managerNameFrom } from './manager-new'
import { ManagerSidebar } from './manager-sidebar'

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
      // No root (a pulsing dot's off-screen watch) reads against the viewport.
      const root = this.options.root ? (this.options.root as Element).getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
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
      <button type="button" hidden data-testid="history-forward" onClick={() => void navigate(1)} />
    </>
  )
}

function renderAt(entry: string | string[], seed?: (client: QueryClient) => void, { shell = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: true }, defaultRunner: 'claude', bootProject: 'alpha', checks: [] })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
    bootProject: 'alpha',
    projectsDir: '',
  })
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
  seed?.(client)
  const routes = (
    <Routes>
      <Route path="/manager" element={<ManagerIndexRoute />} />
      <Route path="/manager/new" element={<ManagerNewRoute />} />
      <Route path="/manager/:id" element={<ManagerChatRoute />} />
      <Route path="/start" element={null} />
    </Routes>
  )
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={Array.isArray(entry) ? entry : [entry]}>
        <Location />
        {shell ? (
          <ThemeProvider>
            <AppShell managersAvailable managerSidebar={<ManagerSidebar />}>{routes}</AppShell>
          </ThemeProvider>
        ) : routes}
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

/** Every manager send carries one (relay incident 2026-11-15). */
const SEND_KEY = expect.stringMatching(/^[0-9a-f-]{36}$/)
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
  forgetChatPlaces()
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
    expect(posted('/made/messages')[0]?.body).toEqual({ text: MANAGER_PRESETS[0].prompt, idempotencyKey: SEND_KEY })
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
    expect(applySetupPatch(setup, { taskRunner: 'codex' })).toMatchObject({ taskRunner: 'codex' })
    expect(applySetupPatch({ ...setup, taskRunner: 'codex' }, { taskRunner: null })).not.toHaveProperty('taskRunner')
  })

  it.each(runnerSchema.options)('includes the selected task agent %s when creating a manager from setup', async (runner) => {
    renderAt('/manager/new', (client) => {
      client.setQueryData(workspaceQueryKeys.providerStatus, { providers: runnerSchema.options.map((provider) => (
        { provider, status: 'connected', enabled: true }
      )) })
    })
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent for new tasks' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: `${runner} · Default` }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.change(screen.getByRole('textbox', { name: 'What should this manager do?' }), { target: { value: 'Coordinate my tasks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(posted('/workspace/managers')[0]?.body).toMatchObject({ taskAgents: [{ runner, agentProfile: 'default' }] }))
  })

  it('creates a manager with two Claude accounts and one Codex account from setup', async () => {
    renderAt('/manager/new', (client) => {
      client.setQueryData(workspaceQueryKeys.providerStatus, { providers: ['claude', 'codex'].map((provider) => ({ provider, status: 'connected', enabled: true })) })
      client.setQueryData(workspaceQueryKeys.agentProfiles, { profiles: [
        { provider: 'claude', id: 'one', label: 'One' }, { provider: 'claude', id: 'two', label: 'Two' }, { provider: 'codex', id: 'work', label: 'Work' },
      ] })
    })
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent for new tasks' }))
    for (const name of ['claude · One', 'claude · Two', 'codex · Work']) fireEvent.click(await screen.findByRole('menuitemcheckbox', { name }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.change(screen.getByRole('textbox', { name: 'What should this manager do?' }), { target: { value: 'Coordinate the selected accounts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(posted('/workspace/managers')[0]?.body).toMatchObject({ taskAgents: [
      { runner: 'claude', agentProfile: 'one' }, { runner: 'claude', agentProfile: 'two' }, { runner: 'codex', agentProfile: 'work' },
    ] }))
  })

  it('omits the task agent from creation after returning to Automatic', async () => {
    renderAt('/manager/new', (client) => {
      client.setQueryData(workspaceQueryKeys.providerStatus, { providers: [
        { provider: 'codex', status: 'connected', enabled: true },
      ] })
    })
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent for new tasks' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'codex · Default' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Automatic' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.change(screen.getByRole('textbox', { name: 'What should this manager do?' }), { target: { value: 'Coordinate automatically' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(posted('/workspace/managers')).toHaveLength(1))
    expect(posted('/workspace/managers')[0]?.body).not.toHaveProperty('taskRunner')
    expect(posted('/workspace/managers')[0]?.body).not.toHaveProperty('taskAgents')
  })
})

describe('/manager/:id', () => {
  const seedChat = (patch: Partial<ManagerSummary> = {}) => {
    server.managers = [managerFixture(patch)]
    server.messages = [userMessage(1), assistantMessage(2, { text: 'Reply body', commands: [{ id: 'c', tool: 'Bash', summary: 'gh pr list' }] })]
  }

  it('shows the header, the transcript and the status line', async () => {
    seedChat({ nextCheckAt: new Date(Date.now() + 9 * 60_000).toISOString() })
    renderAt('/manager/global')
    expect(await screen.findByRole('heading', { name: 'Global Manager' })).toBeTruthy()
    expect(await screen.findByText('jak progres prac')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Ran 1 command' })).toBeTruthy()
    // The gear's state, said in one line (design, Proposal 10); editing stays in the gear.
    expect(document.querySelector('[data-slot="manager-watching-line"]')?.textContent).toBe('Watching Alpha, Beta · write · every 15 min · next check in 9 min')
    expect(screen.queryByRole('button', { name: 'Connected projects' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model and effort' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Watch check cadence' })).toBeNull()
    expect(screen.queryByRole('status', { name: 'Working' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(false)
    expect(composer().getAttribute('placeholder')).toBe('Message Global Manager, or / for commands')
  })

  it('puts the manager list in a rail beside the chat, with the open one marked', async () => {
    server.managers = [managerFixture(), managerFixture({ id: 'shop', name: 'Shop Manager', pendingQuestions: 2 })]
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const rail = document.querySelector('[data-slot="manager-list-rail"]')!
    const rows = [...rail.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-row"]')]
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/manager/global', '/manager/shop'])
    expect(rows[0]!.getAttribute('aria-current')).toBe('page')
    expect(rows[1]!.querySelector('[data-slot="manager-unread"]')?.textContent).toBe('2')
    expect(rail.querySelector('[data-slot="manager-rail-summary"]')?.textContent).toBe('2 managers · 2 projects watched')
    fireEvent.click(rows[1]!)
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/shop'))
  })

  it('drops its own list while the shell sidebar lists the managers (manager mode)', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    server.managers = [managerFixture(), managerFixture({ id: 'shop', name: 'Shop Manager' })]
    renderAt('/manager/global', undefined, { shell: true })
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(document.querySelector('[data-slot="manager-list-rail"]')).toBeNull()
    // The sidebar's rows stand in for it, one list rather than two.
    const sidebar = document.querySelector('[data-slot="sidebar"]')!
    expect([...sidebar.querySelectorAll('[data-slot="manager-row"]')].map((row) => row.getAttribute('href'))).toEqual(['/manager/global', '/manager/shop'])
    expect(document.querySelectorAll('[data-slot="manager-row"]')).toHaveLength(2)
  })

  // An `sr-only` row positioned against the chat, not the scroller, sat at the transcript's
  // unscrolled tail and let the shell's <main> scroll far below the composer.
  it('positions what its scrollers hold inside them, so the page never scrolls past the composer', async () => {
    seedChat()
    server.messages = [...server.messages, assistantMessage(3, { text: 'Later', commands: [{ id: 'd', tool: 'Bash', summary: 'gh pr view' }] })]
    renderAt('/manager/global')
    await screen.findByText('Later')
    const positioned = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/
    for (const slot of ['manager-transcript', 'manager-watching']) {
      const scroller = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!
      expect(scroller.className).toMatch(/overflow-y-auto/)
      expect(scroller.className, slot).toMatch(positioned)
      for (const hidden of scroller.querySelectorAll<HTMLElement>('.sr-only')) {
        let block = hidden.parentElement
        while (block && !positioned.test(block.className)) block = block.parentElement
        expect(scroller.contains(block), `${slot}: ${hidden.textContent}`).toBe(true)
      }
    }
  })

  it('checks now from the header', async () => {
    seedChat()
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
  })

  describe('the Watching panel', () => {
    const panel = () => document.querySelector<HTMLElement>('[data-slot="manager-watching"]')
    const section = (name: string) => screen.queryByRole('region', { name })

    it('shows the connected projects with their access, the jobs, and nothing it cannot know', async () => {
      seedChat({ projectAccess: { beta: 'read' }, jobs: [{ id: 'j1', name: 'Nightly', prompt: 'x', everyMinutes: 1440, enabled: true }] })
      renderAt('/manager/global', (client) => {
        client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [
          { projectId: 'alpha', id: 'r1', title: 'Fix CI', status: 'running', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z' },
        ] })
        client.setQueryData(workspaceQueryKeys.projects, { projects: [{ id: 'alpha', name: 'Alpha', status: 'ok' }, { id: 'beta', name: 'Beta', status: 'ok' }], bootProject: 'alpha', projectsDir: '' })
      })
      await screen.findByRole('heading', { name: 'Global Manager' })
      expect(panel()?.className).toContain('max-lg:hidden')
      const watching = section('Watching')!
      expect(watching.textContent).toContain('Alphawrite · 1 running')
      expect(watching.textContent).toContain('Betaread-only')
      expect(within(watching).getByRole('button', { name: 'Edit connected projects' })).toBeTruthy()
      expect(section('Jobs')?.textContent).toContain('Nightlydaily')
      // No check has run, no card named a task, and the summary has no spend per day.
      expect(section('Last check')).toBeNull()
      expect(section('Tasks it started')).toBeNull()
      expect(section('Cost')).toBeNull()
    })

    it('reads the last check and the tasks the replies carded', async () => {
      seedChat({ lastCheckAt: '2026-10-31T09:18:00.000Z', nextCheckAt: new Date(Date.now() + 5 * 60_000).toISOString() })
      server.messages = [assistantMessage(2, { turn: 'watch', text: 'Started [[task:alpha/r1]]', at: '2026-10-31T09:18:20.000Z' })]
      renderAt('/manager/global', (client) => {
        client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [
          { projectId: 'alpha', id: 'r1', title: 'Fix CI', status: 'done', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z' },
        ] })
      })
      await screen.findByRole('heading', { name: 'Global Manager' })
      await waitFor(() => expect(section('Tasks it started')).not.toBeNull())
      const check = section('Last check')!
      expect([...check.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Ran', 'Result', 'Next'])
      expect(check.textContent).toContain('Reported')
      expect(check.textContent).toContain('in 5 min')
      const task = section('Tasks it started')!.querySelector<HTMLAnchorElement>('[data-slot="manager-watching-task"]')!
      expect(task.textContent).toContain('Fix CI')
      expect(task.getAttribute('href')).toBe('/p/alpha/tasks/r1')
    })

    it('links every task it started or follows to the Tasks table, counted as the table opens', async () => {
      seedChat({ followedTasks: ['alpha/r1', 'beta/r2', 'alpha/r3', 'alpha/gone'] })
      const run = (projectId: string, id: string, extra: object = {}) => ({
        projectId, id, title: id, status: 'done', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', ...extra,
      })
      renderAt('/manager/global', (client) => {
        client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [
          run('alpha', 'r1'),
          run('beta', 'r2', { status: 'failed' }),
          // Archived: behind the table's Archived view, so not in the count it opens on.
          run('alpha', 'r3', { archived: true }),
          run('alpha', 'other'),
        ] })
      })
      await screen.findByRole('heading', { name: 'Global Manager' })
      // No reply carded a task: the followed ones alone bring the section and its link.
      await waitFor(() => expect(section('Tasks it started')).not.toBeNull())
      const all = section('Tasks it started')!.querySelector<HTMLAnchorElement>('[data-slot="manager-watching-all-tasks"]')!
      expect(all.textContent).toBe('View all (2)')
      expect(all.getAttribute('href')).toBe('/tasks?manager=global')
    })

    it('lists each started task\'s pull requests on a line below it, with their statuses', async () => {
      onTestFinished(() => __clearRememberedStatusesForTests())
      server.messages = [assistantMessage(2, { turn: 'watch', text: 'Started [[task:alpha/r1]] [[task:alpha/r2]] [[task:beta/r3]]', at: '2026-10-31T09:18:20.000Z' })]
      const run = (projectId: string, id: string, title: string, extra: object = {}) => ({
        projectId, id, title, status: 'review', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', ...extra,
      })
      renderAt('/manager/global', (client) => {
        client.setQueryData(workspaceQueryKeys.runsIndex, {
          runs: [
            run('alpha', 'r1', 'Fix CI', { prRefs: [
              { number: 41, url: 'https://github.com/o/r/pull/41', origin: 'created', at: '2026-10-31T09:00:00Z' },
              { number: 42, url: 'https://github.com/o/r/pull/42', origin: 'marker', at: '2026-10-31T09:00:00Z' },
            ] }),
            run('alpha', 'r2', 'No PR yet'),
            run('beta', 'r3', 'Docs', { pullRequestUrl: 'https://github.com/o/b/pull/7' }),
          ],
          referenceStatuses: { alpha: { prs: { 41: 'checks-failing', 42: 'merged' }, issues: {} }, beta: { prs: { 7: 'draft' }, issues: {} } },
          perProjectLimit: 200,
          truncated: [],
        })
      })
      await screen.findByRole('heading', { name: 'Global Manager' })
      await waitFor(() => expect(section('Tasks it started')).not.toBeNull())
      const rows = [...section('Tasks it started')!.querySelectorAll('[data-slot="manager-watching-task-row"]')]
      expect(rows).toHaveLength(3)
      const chips = (row: Element) => [...row.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-watching-task-prs"] [data-slot="pr-chip"]')]
      // The standard PR chip: one per task, the rest behind the shared `+N` popover.
      await waitFor(() => expect(chips(rows[0]!).map((chip) => chip.getAttribute('data-status'))).toEqual(['checks-failing']))
      expect(chips(rows[0]!)[0]!.getAttribute('href')).toBe('https://github.com/o/r/pull/41')
      expect(chips(rows[0]!)[0]!.getAttribute('aria-label')).toBe('Open the pull request for Fix CI — Checks failing')
      const more = rows[0]!.querySelector<HTMLButtonElement>('[data-slot="reference-overflow"]')!
      expect(more.textContent).toBe('+1')
      fireEvent.click(more)
      const list = await screen.findByRole('dialog')
      expect([...list.querySelectorAll('[data-slot="pr-chip"]')].map((chip) => chip.textContent)).toEqual(['#41', '#42'])
      // The chips sit beside the task's link, never nested in it.
      expect(rows[0]!.querySelector('[data-slot="manager-watching-task"] a, [data-slot="manager-watching-task"] button')).toBeNull()
      // No PR, no second line.
      expect(rows[1]!.querySelector('[data-slot="manager-watching-task-prs"]')).toBeNull()
      expect(chips(rows[2]!).map((chip) => chip.getAttribute('data-status'))).toEqual(['draft'])
      expect(rows[2]!.querySelector('[data-slot="reference-overflow"]')).toBeNull()
    })

    it('offers Resolve conflicts on a conflicting PR, in the row and behind +N', async () => {
      onTestFinished(() => __clearRememberedStatusesForTests())
      const base = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => input.includes('/github/ref-status')
        ? json({ available: true, prs: { 41: 'ready', 42: 'ready' }, issues: {}, conflicts: [41, 42], recheckAfterMs: null })
        : base(input, init)))
      server.messages = [assistantMessage(2, { turn: 'watch', text: 'Started [[task:alpha/r1]]', at: '2026-10-31T09:18:20.000Z' })]
      renderAt('/manager/global', (client) => {
        client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [
          { projectId: 'alpha', id: 'r1', title: 'Fix CI', status: 'running', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z', prRefs: [
            { number: 41, url: 'https://github.com/o/r/pull/41', origin: 'created', at: '2026-10-31T09:00:00Z' },
            { number: 42, url: 'https://github.com/o/r/pull/42', origin: 'marker', at: '2026-10-31T09:00:00Z' },
          ] },
        ] })
        // The slim index row has no steps: the action loads the full record, as on All tasks.
        client.setQueryData(['alpha', 'runs', 'detail', 'r1'], {
          id: 'r1', title: 'Fix CI', workflow: 'quick-task', task: 'Fix CI', status: 'running', createdAt: '2026-10-31T09:00:00Z', tokensUsed: 0, archived: false, steps: [],
        })
      })
      await screen.findByRole('heading', { name: 'Global Manager' })
      const line = () => document.querySelector<HTMLElement>('[data-slot="manager-watching-task-prs"]')!
      const visible = await waitFor(() => {
        const chip = line()?.querySelector<HTMLAnchorElement>('[data-slot="pr-chip"][data-conflicting="true"]')
        expect(chip).toBeTruthy()
        return chip!
      })
      fireEvent.focus(visible)
      expect((await screen.findByRole('button', { name: 'Resolve conflicts' })).getAttribute('data-slot')).toBe('reference-conflict-action')
      fireEvent.blur(visible)

      fireEvent.click(line().querySelector('[data-slot="reference-overflow"]')!)
      const list = await screen.findByRole('dialog')
      const hidden = [...list.querySelectorAll<HTMLAnchorElement>('[data-slot="pr-chip"]')].find((chip) => chip.textContent?.includes('#42'))!
      expect(hidden.getAttribute('data-conflicting')).toBe('true')
      fireEvent.focus(hidden)
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Resolve conflicts' }).length).toBeGreaterThan(0))
    })

    it('folds from the header and remembers it', async () => {
      seedChat()
      renderAt('/manager/global')
      await screen.findByRole('heading', { name: 'Global Manager' })
      const toggle = screen.getByRole('button', { name: 'Watching panel' })
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(toggle.getAttribute('aria-controls')).toBe(panel()!.id)
      fireEvent.click(toggle)
      expect(panel()).toBeNull()
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(localStorage.getItem('cez.manager.watching')).toBe('0')
      fireEvent.click(toggle)
      expect(panel()).not.toBeNull()
    })

    it('opens the jobs dialog from its +', async () => {
      seedChat()
      renderAt('/manager/global')
      await screen.findByRole('heading', { name: 'Global Manager' })
      fireEvent.click(screen.getByRole('button', { name: 'Add job' }))
      expect(await screen.findByRole('dialog', { name: 'Jobs' })).toBeTruthy()
    })
  })

  describe('the Watching sheet below lg', () => {
    const LONG = 'Rework the relay pairing flow so a phone that lost its keychain can pair again without a reinstall'
    const sheet = () => document.querySelector<HTMLElement>('[data-slot="manager-watching-sheet"]')
    const url = () => screen.getByTestId('url').textContent
    function seedTasks() {
      seedChat()
      server.messages = [assistantMessage(2, { turn: 'watch', text: 'Started [[task:alpha/r1]] and [[task:beta/r2]]', at: '2026-10-31T09:18:20.000Z' })]
      return (client: QueryClient) => client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [
        { projectId: 'alpha', id: 'r1', title: LONG, status: 'running', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z' },
        { projectId: 'beta', id: 'r2', title: 'Fix CI', status: 'done', archived: false, createdAt: '2026-10-31T09:00:00Z', workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z' },
      ] })
    }

    it('opens from the chip above the composer, tasks first, at 44 px, and Back closes it', async () => {
      renderAt('/manager/global', seedTasks())
      const chip = await screen.findByRole('button', { name: 'Tasks · 2' })
      expect(chip.className).toContain('pointer-coarse:h-11')
      fireEvent.click(chip)
      expect(url()).toBe('/manager/global?watching=1')
      const open = await waitFor(() => sheet()!)
      expect(open.className).toContain('lg:hidden')
      expect(open.className).toContain('pb-[env(safe-area-inset-bottom)]')
      const sections = [...open.querySelectorAll('[data-slot="manager-watching-section"]')].map((node) => node.getAttribute('aria-label'))
      expect(sections[0]).toBe('Tasks it started')
      const tasks = [...open.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-watching-task"]')]
      expect(tasks.map((task) => task.getAttribute('href'))).toEqual(['/p/alpha/tasks/r1', '/p/beta/tasks/r2'])
      expect(tasks[0]!.className).toContain('group-data-[touch]/watching:min-h-11')
      // A long title keeps its words: two lines on a phone, not one cut line.
      expect(tasks[0]!.textContent).toContain(LONG)
      expect(tasks[0]!.querySelector('span:not([data-slot])')?.className).toContain('group-data-[touch]/watching:line-clamp-2')
      expect(open.querySelector('[data-touch]')).not.toBeNull()
      // Focus lands on the sheet, not on its first control.
      expect(document.activeElement).toBe(open)
      fireEvent.click(screen.getByTestId('history-back'))
      await waitFor(() => expect(sheet()).toBeNull())
      expect(url()).toBe('/manager/global')
    })

    it('opens from the header too, and its close pops the entry it pushed', async () => {
      renderAt('/manager/global', seedTasks())
      const toggle = await screen.findByRole('button', { name: 'Tasks and watching, 2 tasks' })
      expect(toggle.className).toContain('lg:hidden')
      expect(toggle.className).toContain('max-md:size-11')
      fireEvent.click(toggle)
      await waitFor(() => expect(sheet()).not.toBeNull())
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      fireEvent.click(within(sheet()!).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(sheet()).toBeNull())
      expect(url()).toBe('/manager/global')
    })

    it('a link that arrives open closes in place, without leaving the chat', async () => {
      renderAt(['/manager', '/manager/global?watching=1'], seedTasks())
      await waitFor(() => expect(sheet()).not.toBeNull())
      fireEvent.keyDown(sheet()!, { key: 'Escape' })
      await waitFor(() => expect(sheet()).toBeNull())
      expect(url()).toBe('/manager/global')
    })

    it('a link that arrives open on a wide screen mounts no sheet, so no overlay blocks the chat', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 64rem)', addEventListener() {}, removeEventListener() {} }))
      renderAt('/manager/global?watching=1', seedTasks())
      await screen.findByRole('button', { name: 'Tasks and watching, 2 tasks' })
      expect(sheet()).toBeNull()
      expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
    })

    it('in CezarBot on an iPad, the bottom bar Tasks is the one way in, landscape included', async () => {
      // Landscape: `lg` matches, yet there is no column and the sheet still opens.
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 64rem)' || query === '(min-width: 768px)', addEventListener() {}, removeEventListener() {} }))
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'x CezarMobile/0.1 (ios)' })
      renderAt('/manager/global', seedTasks(), { shell: true })
      await screen.findByRole('heading', { name: 'Global Manager' })
      const bar = screen.getByRole('navigation', { name: 'App' })
      const tab = await within(bar).findByRole('button', { name: 'Tasks, 2 started by this manager' })
      expect(screen.queryByRole('button', { name: /^Tasks and watching/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Tasks · / })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Watching panel' })).toBeNull()
      expect(document.querySelector('[data-slot="manager-watching"]')).toBeNull()
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
      fireEvent.click(tab)
      const open = await waitFor(() => sheet()!)
      expect(open.className).not.toContain('lg:hidden')
      expect(url()).toBe('/manager/global?watching=1')
    })

    it.each(['task', 'all'])('consumes sheet history on %s navigation so Back and Forward stay closed', async (destination) => {
      renderAt('/manager/global', seedTasks())
      fireEvent.click(await screen.findByRole('button', { name: 'Tasks · 2' }))
      await screen.findByRole('dialog', { name: 'Tasks · Global Manager' })
      fireEvent.click(destination === 'task'
        ? sheet()!.querySelector('[data-slot="manager-watching-task"]')!
        : within(sheet()!).getByRole('link', { name: 'View all tasks' }))
      await waitFor(() => expect(url()).not.toContain('/manager/global'))
      expect(sheet()).toBeNull()
      fireEvent.click(screen.getByTestId('history-back'))
      await waitFor(() => expect(url()).toBe('/manager/global'))
      expect(sheet()).toBeNull()
      fireEvent.click(screen.getByTestId('history-forward'))
      await waitFor(() => expect(url()).not.toContain('/manager/global'))
      expect(sheet()).toBeNull()
    })

    it('offers a visible Close and restores the opener on a legacy deep link', async () => {
      renderAt('/manager/global?watching=1&filter=mine', seedTasks())
      const dialog = await screen.findByRole('dialog', { name: 'Tasks · Global Manager' })
      expect(within(dialog).getByRole('button', { name: 'Close' }).textContent).toBe('Close')
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(url()).toBe('/manager/global?filter=mine'))
      expect(sheet()).toBeNull()
    })

    it('offers no tasks chip before a reply cards one', async () => {
      seedChat()
      renderAt('/manager/global')
      await screen.findByRole('heading', { name: 'Global Manager' })
      expect(screen.queryByRole('button', { name: /^Tasks · / })).toBeNull()
      expect(screen.getByRole('button', { name: 'Tasks and watching' })).toBeTruthy()
    })
  })

  it('keeps the prompt and message actions together, with configuration only in the header gear', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const surface = document.querySelector('[data-slot="composer"]')!
    const toolbar = surface.querySelector('[data-slot="composer-controls"]')!
    expect(surface.contains(composer())).toBe(true)
    expect(toolbar).not.toBeNull()
    expect(toolbar.contains(composer())).toBe(false)
    expect(composer().compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const name of ['Attach files', 'Send']) {
      expect(toolbar.contains(screen.getByRole('button', { name }))).toBe(true)
    }
    for (const name of ['Model and effort', 'Agent for new tasks', 'Agent account', 'Options', 'Start dictation']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(toolbar.querySelector('[data-slot="composer-send-hint"]')?.textContent).toBe('↵')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(composer(), { target: { value: 'hi' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[data-slot="composer-compact-row"]')).toBeNull()
  })

  it('keeps account choices in header settings without composer options or dictation', async () => {
    const recognition = vi.fn()
    vi.stubGlobal('SpeechRecognition', recognition)
    seedChat({ runner: 'codex' })
    renderAt('/manager/global', (client) => {
      client.setQueryData(workspaceQueryKeys.agentProfiles, { defaults: { codex: 'work' }, profiles: [
        { provider: 'codex', id: 'work', label: 'Work' },
        { provider: 'claude', id: 'personal', label: 'Personal' },
      ] })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    const settings = document.querySelector('[data-slot="manager-settings-menu"]')!
    expect(within(settings as HTMLElement).getByRole('button', { name: 'Manager agent…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model and effort' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Manager agent…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manager agent' })
    for (const name of ['Model and effort', 'Agent for new tasks', 'Agent account']) {
      expect(dialog.contains(screen.getByRole('button', { name }))).toBe(true)
    }
    expect(screen.getByRole('button', { name: 'Agent account' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Options' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start dictation' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Dictation language' })).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent account' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Work' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && JSON.stringify(call.body) === JSON.stringify({ agentProfile: 'work' }))).toBe(true))
    expect(screen.queryByRole('menuitemradio', { name: 'Personal' })).toBeNull()
    expect(recognition).not.toHaveBeenCalled()
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
    // The manager cards only: the Workspace rows above them link to Questions and Approvals.
    const names = () => [...document.querySelectorAll('[data-route="manager-list"] a[href^="/manager/"]:not([data-slot^="manager-index-"])')]
      .map((row) => row.getAttribute('href'))
      .filter((href) => href !== '/manager/new')

    it('shows responsive cards and the native connected-device picker without remote reads', async () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'CezarMobile/0.1 (ios)' })
      server.managers = [managerFixture({ pendingQuestions: 2 }), managerFixture({ id: 'other', name: 'Other' })]
      renderAt('/manager?all=1')
      const cards = await waitFor(() => {
        const found = document.querySelectorAll('[data-slot="manager-directory-card"]')
        expect(found).toHaveLength(2)
        return found
      })
      expect(cards[0]!.textContent).toContain('2 need you')
      expect(cards[0]!.getAttribute('href')).toBe('/manager/global')
      fireEvent.change(screen.getByRole('textbox', { name: 'Search managers or device' }), { target: { value: 'Other' } })
      expect(document.querySelectorAll('[data-slot="manager-directory-card"]')).toHaveLength(1)
      fireEvent.change(screen.getByRole('textbox', { name: 'Search managers or device' }), { target: { value: '' } })
      fireEvent.click(screen.getByRole('checkbox', { name: 'Needs you' }))
      expect(document.querySelectorAll('[data-slot="manager-directory-card"]')).toHaveLength(1)
      // Layout at large text: the search keeps a 12rem basis (the filter wraps instead of squeezing
      // it), Needs you is a bordered chip, and a name grows to its own width before the time wraps.
      expect(screen.getByRole('textbox', { name: 'Search managers or device' }).className).toContain('flex-[1_1_12rem]')
      const chip = document.querySelector('[data-slot="manager-needs-you-filter"]')!
      expect(chip.className).toContain('min-h-12')
      expect(chip.className.split(' ')).toEqual(expect.arrayContaining(['border', 'border-border', 'rounded-md', 'px-3']))
      const name = [...cards[0]!.querySelectorAll('span')].find((span) => span.textContent === 'Global Manager' && span.children.length === 0)!
      expect(name.className.split(' ')).toContain('flex-auto')
      expect(name.className.split(' ')).not.toContain('flex-1')
      expect(screen.getByRole('link', { name: /^Switch computer/ }).getAttribute('href')).toBe('cezar://servers')
      expect(calls.filter((call) => call.method === 'GET').every((call) => call.path.startsWith('/api/v1/workspace/managers'))).toBe(true)
    })

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
    expect(document.querySelector('[data-slot="manager-watching-line"]')?.className).toContain('max-md:hidden')
    expect(screen.getByRole('button', { name: 'Check now' }).className).toContain('max-md:hidden')
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
    expect(mascot.className.split(' ')).toEqual(expect.arrayContaining(['size-10', 'self-center', 'md:size-11']))
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

  it('keeps attachments on phones, and sizes the controls for a thumb', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(screen.getByRole('button', { name: 'Attach files' }).className).not.toContain('max-md:hidden')
    expect(composer().className).toContain('max-md:max-h-[calc((100dvh-var(--kb,0px))*0.35)]')
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('pointer-coarse:max-md:size-11')
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
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'Write my standup.', idempotencyKey: SEND_KEY }))
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
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'status please', idempotencyKey: SEND_KEY }))
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

  it('keeps one composer Stop while the keyboard opens and closes, without a status footer', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query !== '(min-width: 768px)', addEventListener() {}, removeEventListener() {} }))
    seedChat({ status: 'working' })
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.closest('[data-slot="composer"]')).not.toBeNull()
    act(() => {
      composer().focus()
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Manager settings' }).closest('header')).not.toBeNull()
    act(() => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(stop)
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
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    const picker = await screen.findByRole('button', { name: 'Connected projects' })
    expect(picker.textContent).toContain('Project removed')
    fireEvent.click(picker)
    const option = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="manager-project-option"][data-project="beta"]')!)
    fireEvent.click(option)
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

  it('comes back to where the reader left it, with its older pages, after a task opened from it', async () => {
    seedChat()
    const client = renderAt(['/start', '/manager/global'])
    await screen.findByText('Reply body')
    const box = () => document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')!
    Object.defineProperty(box(), 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(box(), 'clientHeight', { value: 500, configurable: true })
    box().scrollTop = 1500
    fireEvent.scroll(box())
    box().scrollTop = 600
    fireEvent.scroll(box())
    const pages = client.getQueryData<{ pages: unknown[] }>(managerKeys.messages('global'))!
    client.setQueryData(managerKeys.messages('global'), { pages: [...pages.pages, pages.pages[0]], pageParams: [undefined, 'older'] })
    // Away to another page (`/start` stands in for a task) and back.
    fireEvent.click(screen.getByTestId('history-back'))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/start'))
    expect(client.getQueryData<{ pages: unknown[] }>(managerKeys.messages('global'))!.pages).toHaveLength(2)
    fireEvent.click(screen.getByTestId('history-forward'))
    await screen.findAllByText('Reply body')
    expect(box().scrollTop).toBe(600)
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()
  })

  it('away from the tail, the jump button grows into "your messages", whose list pages back to an older one', async () => {
    server.pages = (path) => {
      const url = new URL(path, 'http://x')
      if (url.searchParams.get('kind') === 'user') {
        return { messages: [userMessage(20, 'Keep an eye on the release'), userMessage(100, 'What needs me?')], hasMore: false }
      }
      if (url.searchParams.get('before') === '100') return { messages: [userMessage(20, 'Keep an eye on the release'), assistantMessage(30, { text: 'Watching it' })], hasMore: false }
      return { messages: [userMessage(100, 'What needs me?'), assistantMessage(120, { text: 'Reply body' })], hasMore: true }
    }
    renderAt('/manager/global')
    await screen.findByText('Reply body')
    // At the tail: no control at all.
    expect(screen.queryByRole('group', { name: 'Your messages' })).toBeNull()
    const box = document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')!
    Object.defineProperty(box, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 500, configurable: true })
    box.scrollTop = 1500
    fireEvent.scroll(box)
    box.scrollTop = 600
    fireEvent.scroll(box)
    const group = await screen.findByRole('group', { name: 'Your messages' })
    // It replaced the round button and kept its name.
    expect(within(group).getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()
    fireEvent.click(within(group).getByRole('button', { name: 'Your messages' }))
    // The list holds the whole history from `kind=user`, the unloaded message included.
    const older = await screen.findByRole('option', { name: /Keep an eye on the release/ })
    expect(calls.some((call) => call.path.includes('kind=user'))).toBe(true)
    fireEvent.click(older)
    await waitFor(() => expect(calls.some((call) => call.path.includes('before=100') && !call.path.includes('kind=user'))).toBe(true))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Keep an eye on the release'))
    const bubble = document.activeElement as HTMLElement
    expect(bubble.getAttribute('data-slot')).toBe('manager-user-bubble')
    expect(bubble.hasAttribute('data-jump-highlight')).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
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

  it('returns focus and scroll to the decision named by a source-task return link', async () => {
    server.messages = [assistantMessage(99, { ask: { questions: [{ header: 'Ready', question: 'Publish?', options: [{ label: 'Yes' }, { label: 'No' }] }] } })]
    renderAt('/manager/global#decision-m99')
    await screen.findByRole('button', { name: 'Yes' })
    await waitFor(() => expect(document.activeElement?.id).toBe('decision-m99'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('sends a message', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('hello there')
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'hello there', idempotencyKey: SEND_KEY }))
  })

  it('expands a prompt command and routes /check and /stop', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('/status')
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'Give me a short status of my connected projects.', idempotencyKey: SEND_KEY }))
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

  it('keeps a single Stop inside the composer and removes the redundant working row', async () => {
    server.managers = [managerFixture({ status: 'working' })]
    server.messages = [userMessage(1), assistantMessage(2, { turn: 'watch', text: '', streaming: true })]
    renderAt('/manager/global')
    const spinner = await screen.findByRole('status', { name: 'Working' })
    expect(spinner.closest('header')).not.toBeNull()
    // The only working signal left, so desktop must see it too.
    expect(spinner.className).not.toContain('md:hidden')
    await waitFor(() => expect(spinner.getAttribute('title')).toBe('Working on the watch check'))
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    expect(screen.queryByText('Working on the watch check')).toBeNull()
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.closest('[data-slot="composer"]')).not.toBeNull()
    fireEvent.change(composer(), { target: { value: 'A follow-up' } })
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(stop)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(stop)
    await waitFor(() => expect(posted('/global/stop')).toHaveLength(1))
  })

  it('groups agent choices in one dialog and restores focus to the settings gear', async () => {
    seedChat()
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    expect(document.querySelector('[data-slot="manager-footer"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model and effort' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Manager settings' }))
    const menu = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="manager-settings-menu"]')!)
    expect(menu.querySelector('[data-slot="manager-chron-picker"]')?.textContent).toContain('Refresh: 15 min')
    expect(screen.queryByRole('button', { name: 'Agent account' })).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: 'Manager agent…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manager agent' })
    for (const name of ['Model and effort', 'Agent account', 'Agent for new tasks']) {
      expect(dialog.contains(screen.getByRole('button', { name }))).toBe(true)
    }
    expect(screen.getByRole('button', { name: 'Manager agent' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Manager agent' })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manager settings' }))
  })

  it('opens the agent dialog on the account field from a failed check', async () => {
    server.messages = [assistantMessage(1, { turn: 'watch', error: 'Usage limit reached until 14:00', text: '' })]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Switch account' }))
    await screen.findByRole('dialog', { name: 'Manager agent' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agent account' })))
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

  it('sends a card answer for that card alone, so other open cards stay answerable', async () => {
    const base = { questions: [{ header: 'Base', question: 'Which base?', options: [{ label: 'main' }, { label: 'dev' }] }] }
    server.messages = [userMessage(1), assistantMessage(2, { text: 'Two decisions.', ask }), assistantMessage(3, { text: 'And one more.', ask: base })]
    renderAt('/manager/global')
    const [first] = await screen.findAllByRole('button', { name: 'Send answer' })
    fireEvent.click(screen.getByRole('button', { name: /Capacitor/ }))
    fireEvent.click(screen.getByRole('button', { name: /^No/ }))
    fireEvent.click(first!)
    await waitFor(() => expect(posted('/global/messages')).toHaveLength(1))
    expect(posted('/global/messages')[0]?.body).toMatchObject({ askId: 'm2' })
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
    expect(cards).toEqual(['AnsweredShell:CapacitorTauri (chosen)Default:No (chosen)Yes', 'Answered:ShellDefault'])
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

  describe('the Needs-you strip', () => {
    const strip = () => screen.queryByRole('region', { name: 'Needs you' })
    const jump = () => document.querySelector<HTMLButtonElement>('[data-slot="manager-needs-you-jump"]')
    afterEach(() => vi.restoreAllMocks())

    it('stays away with nothing waiting, and no pill floats over the composer', async () => {
      server.messages = [userMessage(1)]
      renderAt('/manager/global')
      await screen.findByText('jak progres prac')
      expect(strip()).toBeNull()
      expect(document.querySelector('[data-slot="manager-approvals-pill"]')).toBeNull()
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

    it('counts approvals and questions from the server, wherever the cards are', async () => {
      server.managers = [managerFixture({ pendingActions: 2, pendingQuestions: 1 })]
      server.messages = [actionMessage(3)]
      renderAt('/manager/global')
      await screen.findByRole('button', { name: 'Approve' })
      expect(strip()!.querySelector('[data-slot="manager-needs-you-count"]')?.textContent).toBe('2 approvals · 1 question')
      expect(strip()!.querySelector('[data-slot="status-dot"]')?.className).toContain('bg-info')
      expect(strip()!.className).toContain('border-b')
      expect(FakeIntersectionObserver.created).toBe(0)
    })

    it('jumps to the first open question when only questions wait', async () => {
      server.managers = [managerFixture({ pendingQuestions: 1 })]
      server.messages = [userMessage(1), assistantMessage(2, { text: 'Two decisions.', ask })]
      renderAt('/manager/global')
      await screen.findByRole('button', { name: 'Send answer' })
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      fireEvent.click(jump()!)
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
      const target = vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0] as HTMLElement
      expect(target.getAttribute('data-slot')).toBe('manager-ask')
      expect(document.activeElement).toBe(target)
      expect(calls.some((call) => call.path.includes('pending=1'))).toBe(false)
    })

    it('a `#needs-you` link (a manager head) jumps to the waiting card on arrival', async () => {
      server.managers = [managerFixture({ pendingQuestions: 1 })]
      server.messages = [userMessage(1), assistantMessage(2, { text: 'Two decisions.', ask })]
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      renderAt('/manager/global#needs-you')
      await screen.findByRole('button', { name: 'Send answer' })
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
      const target = vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1) as HTMLElement
      expect(target.getAttribute('data-slot')).toBe('manager-ask')
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
      await waitFor(() => expect(strip()?.textContent).toContain('3 approvals'))
      await waitFor(() => expect(jump()?.disabled).toBe(false))
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      fireEvent.click(jump()!)
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
      expect(strip()).not.toBeNull()
      expect(jump()?.disabled).toBe(true)
    })

    it('stops paging when a page fails', async () => {
      server.managers = [managerFixture({ pendingActions: 1 })]
      server.pending = { messages: [actionMessage(10)], hasMore: false }
      server.messages = [userMessage(100)]
      server.hasMore = true
      renderAt('/manager/global')
      await waitFor(() => expect(jump()?.disabled).toBe(false))
      const paged = vi.fn()
      vi.mocked(fetch).mockImplementation(async (input) => {
        if (String(input).includes('pending=1')) return json(server.pending)
        paged()
        return json({ error: 'offline' }, 500)
      })
      fireEvent.click(jump()!)
      await waitFor(() => expect(paged).toHaveBeenCalled())
      await waitFor(() => expect(jump()?.disabled).toBe(false))
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

  it('keeps the floating jump button off the last lines by exactly its measured height', async () => {
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
    seedChat()
    renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    const body = document.querySelector<HTMLElement>('[data-slot="manager-transcript-body"]')!
    expect(body.style.paddingBottom).toBe('')
    // The reader scrolls up: the jump button appears over the tail.
    const box = document.querySelector<HTMLElement>('[data-slot="manager-transcript"]')!
    Object.defineProperty(box, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 300, configurable: true })
    // Once at the tail, then up: only a scroll that moved up counts as the reader leaving.
    box.scrollTop = 600
    fireEvent.scroll(box)
    box.scrollTop = 0
    fireEvent.scroll(box)
    await waitFor(() => expect(document.querySelector('[data-slot="manager-scroll-bottom"]')).not.toBeNull())
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
    const menu = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="manager-settings-menu"]')!)
    fireEvent.click(within(menu).getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
  })
})

describe('an inactive manager\'s chat (spec 2026-11-19-manager-deactivate)', () => {
  beforeEach(() => {
    server.managers = [managerFixture({ inactive: { since: '2026-11-18T23:40:00Z' } })]
  })

  it('shows the banner, a grey avatar, and keeps Check now off', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    const banner = document.querySelector('[data-slot="manager-inactive-banner"]')!
    expect(banner.getAttribute('role')).toBe('status')
    expect(within(banner as HTMLElement).getByRole('button', { name: 'Reactivate…' })).toBeTruthy()
    expect(document.querySelector('header [data-slot="manager-avatar-inactive"]')).not.toBeNull()
    expect((document.querySelector('[data-slot="manager-check-now"]') as HTMLButtonElement).disabled).toBe(true)
    expect(composer().placeholder).toContain('is inactive — write anyway; sending reactivates it')
  })

  it('asks before a send: a cancel keeps the draft, a confirm sends with reactivate: true', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('wake up')
    let dialog = await screen.findByRole('alertdialog', { name: /Reactivate Global Manager and send\?/ })
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(composer().value).toBe('wake up'))
    expect(posted('/global/messages')).toHaveLength(0)
    send('wake up')
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate and send' }))
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'wake up', reactivate: true, idempotencyKey: SEND_KEY }))
  })

  it('a cancelled reactivate from a question card puts focus back on the option and says “Not sent”', async () => {
    server.messages = [assistantMessage(99, { ask: { questions: [{ header: 'Ready', question: 'Publish?', options: [{ label: 'Yes' }, { label: 'No' }] }] } })]
    renderAt('/manager/global')
    const no = await screen.findByRole('button', { name: 'No' })
    no.focus()
    fireEvent.click(no)
    const dialog = await screen.findByRole('alertdialog', { name: /Reactivate Global Manager and answer\?/ })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement?.textContent).toBe('No'))
    expect(screen.getByText(/Not sent: Global Manager is still inactive/)).toBeTruthy()
    expect(posted('/global/messages')).toHaveLength(0)
  })

  it('/check asks first, then reactivates with Catch me up instead of a check the server would refuse', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('/check')
    const dialog = await screen.findByRole('alertdialog', { name: /Reactivate Global Manager and check\?/ })
    expect(dialog.textContent).toContain('A single check runs now: one model call.')
    expect(dialog.textContent).not.toContain('Your message starts its next turn')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate and check' }))
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ active: true, catchUp: true }))
    expect(posted('/global/check')).toHaveLength(0)
    expect(posted('/global/messages')).toHaveLength(0)
  })

  it('draws the deactivate line as a divider and the reactivate line with its While inactive counts', async () => {
    server.managers = [managerFixture()]
    server.messages = [
      { id: 'n1', seq: 1, at: '2026-11-18T23:40:00Z', kind: 'notice', text: 'Deactivated by you', activity: { change: 'deactivated' } },
      { id: 'n2', seq: 2, at: '2026-11-19T08:00:00Z', kind: 'notice', text: 'Reactivated by you', activity: { change: 'reactivated', since: '2026-11-18T23:40:00Z', taskUpdates: 2, automationReports: 1, checksSkipped: 5, jobRunsSkipped: 1 } },
    ]
    renderAt('/manager/global')
    const lines = await waitFor(() => {
      const found = [...document.querySelectorAll('[data-slot="manager-activity-notice"]')]
      expect(found).toHaveLength(2)
      return found
    })
    expect(lines[0]!.textContent).toContain('Deactivated by you')
    expect(lines[0]!.querySelector('[data-slot="manager-activity-summary"]')).toBeNull()
    const summary = lines[1]!.querySelector('[data-slot="manager-activity-summary"]')!.textContent
    expect(summary).toContain('While inactive')
    expect(summary).toContain('2 task updates')
    expect(summary).toContain('1 automation report')
    expect(summary).toContain('5 checks skipped')
    expect(summary).toContain('1 job run skipped')
    expect(summary).toContain('posted by cezar · no model call')
  })

  it('says the catch-up check is a model call instead of claiming none', async () => {
    server.managers = [managerFixture()]
    server.messages = [
      { id: 'n2', seq: 1, at: '2026-11-19T08:00:00Z', kind: 'notice', text: 'Reactivated by you', activity: { change: 'reactivated', since: '2026-11-18T23:40:00Z', taskUpdates: 0, automationReports: 0, checksSkipped: 5, jobRunsSkipped: 0, catchUp: true } },
    ]
    renderAt('/manager/global')
    const summary = await waitFor(() => document.querySelector('[data-slot="manager-activity-summary"]')!.textContent)
    expect(summary).toContain('catching up now')
    expect(summary).toContain('the catch-up check is one model call')
    expect(summary).not.toContain('no model call')
  })
})

describe('plan usage in the chat (spec 2026-11-20-manager-plan-usage-popover, footnote restored 2026-11-22)', () => {
  it('puts a reply’s footnote on that reply only, joined by its message id, beside the header chip', async () => {
    server.managers = [managerFixture({ id: 'global', runner: 'claude' })]
    server.messages = [userMessage(0, 'status?'), assistantMessage(1, { text: 'First answer.' }), assistantMessage(2, { text: 'Second answer.' })]
    const now = new Date()
    const entry = {
      windowId: 'w-now',
      account: { key: 'claude:default', provider: 'claude' as const, accountId: 'default', label: 'Claude · default' },
      kind: 'five-hour' as const,
      startsAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      resetsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(),
      current: true,
      consumer: {
        id: 'mgr:global', kind: 'manager' as const, title: 'Global Manager', estimatePp: 0.7, aloneInferredPp: 0.7, sharedEstimatePp: 0,
        retryWasteEstimatePp: 0, ranTogetherWith: { tasks: 0, managers: 0, internal: 0 }, evidence: 'account-level' as const,
        messages: [{ messageId: 'm2', part: 'chat' as const, at: now.toISOString(), estimatePp: 0.7, aloneInferredPp: 0.7, sharedEstimatePp: 0 }],
      },
    }
    renderAt('/manager/global', (client) => client.setQueryData(planUsageKeys.consumers, { entries: [entry] }))
    const second = (await screen.findByText('Second answer.')).closest('[data-slot="manager-assistant"]')!
    const first = screen.getByText('First answer.').closest('[data-slot="manager-assistant"]')!
    expect(within(second as HTMLElement).getByRole('button', { name: /^This reply ≈ 0.7% of 5h/ })).toBeTruthy()
    expect(first.querySelector('[data-slot="manager-reply-usage"]')).toBeNull()
    expect(document.querySelectorAll('[data-slot="manager-reply-usage"]')).toHaveLength(1)
    expect(document.querySelector('[data-slot="manager-usage-chip"]')).toBeTruthy()
  })
})
