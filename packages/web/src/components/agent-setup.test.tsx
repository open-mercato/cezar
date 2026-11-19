import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { FirstRun } from '@/components/first-run'

/**
 * The first-run agent step (spec 2026-10-26-first-run-onboarding, "Set up an agent here"). What is
 * pinned is every way out of a running terminal: an install that lands, one that fails, one cezar
 * then cannot find, a login that lands and one that does not, and a terminal that disappears.
 */

vi.mock('@/api/global-events', () => ({ onWorkspaceEvent: () => () => undefined }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
// The emulator needs a real canvas; what its bytes do is the task terminal's own suite.
vi.mock('@/routes/task-workspace/terminal-pane', () => ({
  TerminalPane: ({ session }: { session: { id: string } }) => <div data-testid="terminal" data-session={session.id} />,
}))

type Status = 'connected' | 'disconnected' | 'not-installed'
const fetchMock = vi.fn<typeof fetch>()
let available = true
let statuses: Record<string, Status> = {}
let session: Record<string, unknown> | null = null
let started: Array<{ provider: string; action: string }> = []
let stoppedIds: string[] = []
let startError: string | null = null
let sessionCount = 0

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const agents = ['claude', 'codex'].map((provider) => ({
  provider,
  installCommand: `npm install -g ${provider}`,
  installHint: `Install ${provider}.`,
  loginCommand: `${provider} login`,
}))
const finish = (exitCode: number) => {
  session = { ...session, exitCode }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/v1/providers/status') {
      return json({ providers: Object.entries(statuses).map(([provider, status]) => ({ provider, status, enabled: true })) })
    }
    if (url.pathname === '/api/v1/providers/setup') {
      return json(available ? { available: true, agents, session } : { available: false, reason: 'Set up agents on the machine hosting cezar.' })
    }
    if (url.pathname === '/api/v1/providers/setup/sessions' && method === 'POST') {
      if (startError) return json({ error: startError }, 409)
      const body = JSON.parse(String(init?.body)) as { provider: string; action: string }
      started.push(body)
      sessionCount += 1
      session = {
        id: `s${sessionCount}`, runId: 'agent-setup', cwd: '/home/me', shell: '/bin/sh', cols: 80, rows: 24, startedAt: 'now', exitCode: null,
        label: 'x', busy: false, topic: `terminal:s${sessionCount}`, provider: body.provider, action: body.action,
        command: body.action === 'install' ? `npm install -g ${body.provider}` : `${body.provider} login`,
      }
      return json(session, 201)
    }
    if (url.pathname.startsWith('/api/v1/providers/setup/sessions/') && method === 'DELETE') {
      stoppedIds.push(url.pathname.split('/').pop() ?? '')
      session = null
      return json({ stopped: true })
    }
    if (url.pathname === '/api/v1/workspace/ui-state') return json({})
    if (url.pathname === '/api/v1/health') return json({ repoRoot: '/work', bootProject: 'boot', capabilities: {} })
    if (url.pathname === '/api/v1/projects') return json({ projects: [], bootProject: 'boot', projectsDir: '~' })
    return json({ error: 'not stubbed' }, 404)
  })
})

afterEach(() => {
  available = true
  statuses = {}
  session = null
  started = []
  stoppedIds = []
  startError = null
  sessionCount = 0
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const renderStep = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectScopeContext.Provider value={{ projectId: null, apiBase: '/api/v1' }}>
        <MemoryRouter>
          <FirstRun gitRepo={false} />
        </MemoryRouter>
      </ProjectScopeContext.Provider>
    </QueryClientProvider>,
  )

const page = () => document.querySelector('[data-slot="first-run"]')?.getAttribute('data-first-run')
const WAIT = { timeout: 5_000 }

describe('the first-run agent step', () => {
  it('with an agent signed in, skips the step altogether', async () => {
    statuses = { claude: 'connected' }
    renderStep()
    await waitFor(() => expect(page()).toBe('pick-project'))
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/providers/setup'))).toBe(false)
  })

  it('with nothing installed, offers the list with the command each button runs', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    expect(await screen.findByRole('heading', { name: 'Pick your agent' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(2)
    expect(screen.getByText('npm install -g claude')).toBeTruthy()
    expect(started).toEqual([])
  })

  it('an install that exits 0 goes straight on to the sign-in, in cezar', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByTestId('terminal')
    expect(started).toEqual([{ provider: 'claude', action: 'install' }])
    statuses = { claude: 'disconnected', codex: 'not-installed' }
    finish(0)
    await waitFor(() => expect(started).toEqual([{ provider: 'claude', action: 'install' }, { provider: 'claude', action: 'login' }]), WAIT)
    expect(await screen.findByText('Sign in to Claude Code. Click the terminal to answer its questions.')).toBeTruthy()
  })

  it('a login that lands moves the page on by itself', async () => {
    statuses = { claude: 'disconnected', codex: 'not-installed' }
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('terminal')
    statuses = { claude: 'connected', codex: 'not-installed' }
    finish(0)
    await waitFor(() => expect(page()).toBe('pick-project'), WAIT)
  })

  it('a failed install stops with a sentence and Try again, keeping the screen', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByTestId('terminal')
    finish(1)
    expect((await screen.findByRole('alert', {}, WAIT)).textContent).toContain('Claude Code did not install')
    expect(screen.getByTestId('terminal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(started).toHaveLength(2))
    expect(started[1]).toEqual({ provider: 'claude', action: 'install' })
  })

  it('an install cezar then cannot find says so instead of waiting', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByTestId('terminal')
    finish(0)
    expect((await screen.findByRole('alert', {}, WAIT)).textContent).toContain('cannot find it')
    expect(started).toHaveLength(1)
  })

  it('a login that exits without signing in stops, and does not start itself again', async () => {
    statuses = { claude: 'disconnected', codex: 'not-installed' }
    renderStep()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await screen.findByTestId('terminal')
    finish(1)
    expect((await screen.findByRole('alert', {}, WAIT)).textContent).toContain('did not finish')
    expect(started).toHaveLength(1)
  })

  it('a terminal that disappears mid-run does not spin forever', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByText('Installing Claude Code…')
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/providers/setup')).length).toBeGreaterThan(1), WAIT)
    session = null
    expect((await screen.findByRole('alert', {}, WAIT)).textContent).toContain('closed before it finished')
    expect(screen.queryByText('Installing Claude Code…')).toBeNull()
  })

  it('an install that ended unseen still goes on to the sign-in', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByText('Installing Claude Code…')
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/providers/setup')).length).toBeGreaterThan(1), WAIT)
    statuses = { claude: 'disconnected', codex: 'not-installed' }
    session = null
    await waitFor(() => expect(started[1]).toEqual({ provider: 'claude', action: 'login' }), WAIT)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refused start keeps the command in reach', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    startError = 'Too many running services (24). Stop one and retry.'
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByRole('alert')
    expect(screen.getByText('npm install -g claude')).toBeTruthy()
  })

  it('a session that arrives clears an earlier refusal, and Close then leaves it running', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    startError = 'Another agent is being set up. Finish or cancel it first.'
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(stoppedIds).toEqual([])
  })

  it('Cancel stops the process and goes back to the list', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    await screen.findByTestId('terminal')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(stoppedIds).toEqual(['s1']))
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(2)
  })

  it('reattaches to a session already running after a reload, and starts nothing', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    session = {
      id: 'old', runId: 'agent-setup', cwd: '/home/me', shell: '/bin/sh', cols: 80, rows: 24, startedAt: 'now', exitCode: null,
      label: 'x', busy: false, topic: 'terminal:old', provider: 'codex', action: 'install', command: 'npm install -g codex',
    }
    renderStep()
    expect((await screen.findByTestId('terminal')).getAttribute('data-session')).toBe('old')
    expect(started).toEqual([])
  })

  it('tells a refused start in the row', async () => {
    statuses = { claude: 'not-installed', codex: 'not-installed' }
    startError = 'Another agent is being set up. Finish or cancel it first.'
    renderStep()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Install' }))[0]!)
    expect((await screen.findByRole('alert')).textContent).toContain('Another agent')
  })

  it('where no terminal can open, falls back to the commands to run elsewhere', async () => {
    available = false
    statuses = { claude: 'not-installed', codex: 'disconnected' }
    renderStep()
    expect(await screen.findByRole('heading', { name: 'Sign in to an agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByText('Opens the login in Terminal.')).toBeTruthy()
    expect(screen.getByText('npm i -g @anthropic-ai/claude-code')).toBeTruthy()
  })
})
