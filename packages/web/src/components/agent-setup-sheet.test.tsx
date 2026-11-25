import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSetupEntry, AgentSetupProvider } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import type { QueryClient } from '@tanstack/react-query'
import { useAgentSetup } from '@/api/queries'
import { AgentSetupFlow } from '@/components/agent-setup-sheet'
import { toast } from '@/components/ui/toaster'
import { DefaultAgentPicker, agentPickerRows } from '@/components/default-agent-picker'

/**
 * The setup sheet (spec 2026-11-25-agent-cli-install-and-update): confirm the exact command, run
 * it, then sign in; a command cezar does not run is only shown; a phone cannot type or sudo.
 */

vi.mock('@/api/global-events', () => ({ onWorkspaceEvent: () => () => undefined }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
vi.mock('@/routes/task-workspace/terminal-pane', () => ({
  TerminalPane: ({ session }: { session: { id: string } }) => <div data-testid="terminal" data-session={session.id} />,
}))
vi.mock('@/components/reconnect/reconnect-card', () => ({
  ReconnectCard: ({ provider }: { provider: string }) => <div data-testid="reconnect-card" data-provider={provider} />,
}))

const fetchMock = vi.fn<typeof fetch>()
let agents: AgentSetupEntry[] = []
let interactive = true
/** The server's refusal (hosted cockpit, terminal off): null when setup is available. */
let refusedWith: string | null = null
let statuses: Record<string, string> = {}
let session: Record<string, unknown> | null = null
let posted: Array<Record<string, unknown>> = []
/** When set, POST /providers/setup/sessions refuses with 409 `{ error }`. */
let startError: string | null = null
/** Optional hook fired when `GET /api/v1/providers/status?refresh=1` runs. */
let onStatusRefresh: (() => void | Promise<void>) | null = null
/** How long a start takes to answer: long enough, and the sheet re-renders while it is in flight. */
let postDelayMs = 0
let cancelled: string[] = []
/** When true, DELETE /providers/setup/sessions/:id answers 500 and the session keeps running. */
let cancelFails = false
/** When set, a DELETE waits for it before answering (the server still lists the session meanwhile). */
let cancelGate: Promise<void> | null = null
/** When true, GET /providers/setup answers 500. */
let listFails = false
/** When true, a POST answers as the server's join of the running session, with its header. */
let joinNext = false
/** When true, `GET /api/v1/providers/status?refresh=1` answers 500. */
let refreshFails = false

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const entry = (provider: AgentSetupProvider, over: Partial<AgentSetupEntry> = {}): AgentSetupEntry => ({
  provider,
  loginCommand: `${provider} login`,
  install: { command: null, runnable: false, sudo: false },
  update: null,
  docsUrl: `https://docs.example/${provider}`,
  installed: false,
  version: null,
  method: null,
  minVersion: null,
  latestVersion: null,
  activeRuns: 0,
  ...over,
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/v1/providers/status') {
      if (url.searchParams.get('refresh') === '1' && onStatusRefresh) await onStatusRefresh()
      if (url.searchParams.get('refresh') === '1' && refreshFails) return json({ error: 'down' }, 500)
      return json({ providers: Object.entries(statuses).map(([provider, status]) => ({ provider, status, enabled: true })) })
    }
    if (url.pathname === '/api/v1/providers/setup' && listFails) return json({ error: 'down' }, 500)
    if (url.pathname === '/api/v1/providers/setup') return json({ available: refusedWith === null, reason: refusedWith, interactive, session, agents })
    if (url.pathname === '/api/v1/providers/setup/sessions' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      // `force` rides a header (the typed API is at its size limit): record it with the body.
      posted.push(new Headers(init?.headers).get('x-cezar-force') === '1' ? { ...body, force: true } : body)
      if (postDelayMs) await new Promise((resolve) => setTimeout(resolve, postDelayMs))
      if (startError) return json({ error: startError }, 409)
      if (joinNext && session) {
        return new Response(JSON.stringify(session), { status: 201, headers: { 'content-type': 'application/json', 'x-cezar-joined': '1' } })
      }
      session = {
        id: `s${posted.length}`, runId: 'agent-setup', cwd: '/home/me', shell: '/bin/sh', cols: 80, rows: 24, startedAt: 'now', exitCode: null,
        label: 'x', busy: false, topic: 't', provider: body.provider, action: body.action, command: `run ${String(body.action)}`,
      }
      return json(session, 201)
    }
    const cancelMatch = /^\/api\/v1\/providers\/setup\/sessions\/([^/]+)$/.exec(url.pathname)
    if (cancelMatch && method === 'DELETE') {
      cancelled.push(cancelMatch[1]!)
      if (cancelGate) await cancelGate
      if (cancelFails) return json({ error: 'boom' }, 500)
      // The server kills and forgets the terminal (terminal/sessions.ts): the listing drops it.
      if (session && session.id === cancelMatch[1]) session = null
      return json({ ok: true })
    }
    if (url.pathname === '/api/v1/health') return json({ repoRoot: '/work', bootProject: 'boot', capabilities: {} })
    return json({ error: 'not stubbed' }, 404)
  })
})

afterEach(async () => {
  // Unmount first and let the deferred close-cancel run, while fetch is still the stub.
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 20))
  agents = []
  interactive = true
  refusedWith = null
  statuses = {}
  session = null
  posted = []
  startError = null
  onStatusRefresh = null
  postDelayMs = 0
  cancelled = []
  cancelFails = false
  cancelGate = null
  listFails = false
  joinNext = false
  refreshFails = false
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const renderFlow = (
  provider: AgentSetupProvider,
  action: 'install' | 'update' | 'sign-in',
  options: { strict?: boolean; client?: QueryClient } = {},
) => {
  const tree = (
    <QueryClientProvider client={options.client ?? createQueryClient()}>
      <AgentSetupFlow provider={provider} action={action} onClose={() => {}} />
    </QueryClientProvider>
  )
  return render(options.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const phase = () => document.querySelector('[data-slot="agent-setup-flow"]')?.getAttribute('data-phase')
const WAIT = { timeout: 5_000 }

describe('AgentSetupFlow', () => {
  it('confirms the exact command, installs, then moves on to the sign-in', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    expect(await screen.findByText('npm install -g @openai/codex')).toBeTruthy()
    expect(posted).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    expect(posted).toEqual([{ provider: 'codex', action: 'install' }])
    statuses = { codex: 'disconnected' }
    session = { ...session, exitCode: 0 }
    await waitFor(() => expect(phase()).toBe('sign-in'), WAIT)
    expect(screen.getByTestId('reconnect-card').getAttribute('data-provider')).toBe('codex')
  })

  it('shows OMP’s third-party tap to copy, and never offers to run it', async () => {
    statuses = { omp: 'not-installed' }
    agents = [entry('omp', {
      install: { command: 'brew install can1357/tap/omp', runnable: false, sudo: false },
    })]
    renderFlow('omp', 'install')
    expect(await screen.findByText('brew install can1357/tap/omp')).toBeTruthy()
    expect(screen.getByText(/third-party installer/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByRole('link', { name: /Official docs/ }).getAttribute('href')).toBe('https://docs.example/omp')
  })

  it('offers the docs when an installer is not known yet (Kimi)', async () => {
    statuses = { kimi: 'not-installed' }
    agents = [entry('kimi')]
    renderFlow('kimi', 'install')
    expect(await screen.findByText(/does not know this installer yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('signs in to Antigravity in a terminal here on the computer', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await waitFor(() => expect(posted).toEqual([{ provider: 'antigravity', action: 'login' }]))
    expect(await screen.findByTestId('terminal')).toBeTruthy()
  })

  it('on a phone, sends Antigravity’s sign-in to the computer', async () => {
    interactive = false
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    expect(await screen.findByText('Finish on my computer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open terminal here' })).toBeNull()
  })

  it('on a phone, will not start what needs the computer password', async () => {
    interactive = false
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'sudo npm install -g @openai/codex', runnable: true, sudo: true } })]
    renderFlow('codex', 'install')
    expect(await screen.findByText(/needs your computer password/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('holds an update while tasks run, unless told to update now', async () => {
    statuses = { claude: 'connected' }
    agents = [entry('claude', {
      installed: true, version: '2.0.14', latestVersion: '2.1.3', method: 'native', activeRuns: 2,
      update: { command: "'claude' update", runnable: true, sudo: false },
    })]
    renderFlow('claude', 'update')
    expect(await screen.findByText(/2 tasks are running/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update when they finish' }))
    await waitFor(() => expect(phase()).toBe('waiting'))
    expect(posted).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    await waitFor(() => expect(posted).toEqual([{ provider: 'claude', action: 'update', force: true }]))
  })

  it('Settings’ own listing reads the new version once an update ends', async () => {
    statuses = { claude: 'connected' }
    const current = { installed: true, method: 'native' as const, update: { command: "'claude' update", runnable: true, sudo: false } }
    agents = [entry('claude', { ...current, version: '2.0.14', latestVersion: '2.1.3' })]
    // Settings → Agents reads the `latest` listing, a query of its own beside the sheet's.
    function SettingsVersion() {
      const version = useAgentSetup({ latest: true }).data?.agents.find((agent) => agent.provider === 'claude')?.version
      return <span data-testid="settings-version">{version ?? ''}</span>
    }
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SettingsVersion />
        <AgentSetupFlow provider="claude" action="update" onClose={() => {}} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('settings-version').textContent).toBe('2.0.14'))
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await waitFor(() => expect(phase()).toBe('running'))
    agents = [entry('claude', { ...current, version: '2.1.3', latestVersion: '2.1.3' })]
    session = { ...session, exitCode: 0 }
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    await waitFor(() => expect(screen.getByTestId('settings-version').textContent).toBe('2.1.3'), WAIT)
  })
})

describe('AgentSetupFlow: review follow-ups (#2474)', () => {
  it('words an update with no known command as an update, not an install', async () => {
    statuses = { codex: 'connected' }
    agents = [entry('codex', { installed: true, version: '0.170.0', method: null, update: null })]
    renderFlow('codex', 'update')
    expect(await screen.findByText(/cannot tell how this copy of Codex was installed/)).toBeTruthy()
    expect(screen.getByText(/Update Codex on the computer running cezar/)).toBeTruthy()
    expect(screen.queryByText(/does not know this installer/)).toBeNull()
  })

  it("on a hosted cockpit, an update gives the server's reason, not an unknown install method", async () => {
    refusedWith = 'Set up agents on the machine hosting cezar.'
    statuses = { claude: 'connected' }
    // A refused listing blanks the update line: it would name the host's binary.
    agents = [entry('claude', { installed: true, version: '2.0.14', method: 'native', update: { command: null, runnable: false, sudo: false } })]
    renderFlow('claude', 'update')
    expect(await screen.findByText('Set up agents on the machine hosting cezar.')).toBeTruthy()
    expect(screen.queryByText(/cannot tell how this copy/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('says to keep the sheet open while it waits, and that closing it cancels the update', async () => {
    statuses = { claude: 'connected' }
    agents = [entry('claude', {
      installed: true, version: '2.0.14', method: 'native', activeRuns: 1,
      update: { command: "'claude' update", runnable: true, sudo: false },
    })]
    const view = renderFlow('claude', 'update')
    fireEvent.click(await screen.findByRole('button', { name: 'Update when they finish' }))
    expect(await screen.findByText(/Keep this open/)).toBeTruthy()
    vi.mocked(toast).mockClear()
    view.unmount()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('was not updated'))
    expect(posted).toEqual([])
  })

  it('on a hosted cockpit, labels step 2 "Install yourself" instead of "Install"', async () => {
    refusedWith = 'Set up agents on the machine hosting cezar.'
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: false, sudo: false } })]
    renderFlow('codex', 'install')
    expect(await screen.findByText('Install yourself')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('invalidates Settings’ latest listing after post-install status refresh so installed/method/latest update', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    onStatusRefresh = () => {
      statuses = { codex: 'disconnected' }
      agents = [entry('codex', {
        installed: true,
        method: 'npm',
        version: '0.170.0',
        latestVersion: '0.180.0',
        install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false },
        update: { command: 'npm install -g @openai/codex@latest', runnable: true, sudo: false },
      })]
    }
    function SettingsSnapshot() {
      const codex = useAgentSetup({ latest: true }).data?.agents.find((agent) => agent.provider === 'codex')
      return <span data-testid="settings-codex">{codex ? `${codex.installed}:${codex.method}:${codex.latestVersion}` : ''}</span>
    }
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SettingsSnapshot />
        <AgentSetupFlow provider="codex" action="install" onClose={() => {}} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('settings-codex').textContent).toBe('false:null:null'))
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    session = { ...session, exitCode: 0 }
    await waitFor(() => expect(phase()).toBe('sign-in'), WAIT)
    await waitFor(() => expect(screen.getByTestId('settings-codex').textContent).toBe('true:npm:0.180.0'), WAIT)
  })

  it('shows failure on non-zero install exit and resets to confirm on Try again', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    session = { ...session, exitCode: 1 }
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
    expect(screen.getByRole('alert').textContent).toContain('Codex did not install. The terminal says why.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(phase()).toBe('confirm'))
  })

  it('shows failure on non-zero update exit', async () => {
    statuses = { claude: 'connected' }
    agents = [entry('claude', { installed: true, version: '2.0.14', method: 'native', update: { command: "'claude' update", runnable: true, sudo: false } })]
    renderFlow('claude', 'update')
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await waitFor(() => expect(phase()).toBe('running'))
    session = { ...session, exitCode: 2 }
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
    expect(screen.getByRole('alert').textContent).toContain('Claude Code did not update. The terminal says why.')
  })

  it('moves to failed when POST /providers/setup/sessions refuses with 409, and recovers on Try again', async () => {
    startError = 'Another agent is being set up. Finish or cancel it first.'
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('failed'))
    expect(screen.getByRole('alert').textContent).toContain('Another agent is being set up.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(phase()).toBe('confirm'))
  })

  it('reports "cannot find it" when install exits 0 but status remains not-installed', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    session = { ...session, exitCode: 0 }
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
    expect(screen.getByRole('alert').textContent).toContain('Codex installed, but cezar cannot find it.')
  })

  it('skips sign-in and goes straight to done when install exits 0 and agent is already connected', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    statuses = { codex: 'connected' }
    session = { ...session, exitCode: 0 }
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    expect(screen.getByText('Codex is ready.')).toBeTruthy()
  })

  it('rejoins an already-running setup session on mount without starting another', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    session = {
      id: 'existing-1', runId: 'agent-setup', cwd: '/home/me', shell: '/bin/sh', cols: 80, rows: 24, startedAt: 'now', exitCode: null,
      label: 'codex install', busy: false, topic: 't', provider: 'codex', action: 'install', command: 'npm install -g @openai/codex',
    }
    renderFlow('codex', 'install')
    await waitFor(() => expect(phase()).toBe('running'))
    expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('existing-1')
    expect(posted).toEqual([])
  })

  it('advances sign-in polling to done once the provider reports connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      statuses = { codex: 'disconnected' }
      agents = [entry('codex', { installed: true })]
      renderFlow('codex', 'sign-in')
      await waitFor(() => expect(phase()).toBe('sign-in'))
      statuses = { codex: 'connected' }
      await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
      await waitFor(() => expect(phase()).toBe('done'), WAIT)
      expect(screen.getByText('Codex is ready.')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

const live = (over: Record<string, unknown>) => ({
  id: 'live-1', runId: 'agent-setup', cwd: '/home/me', shell: '/bin/sh', cols: 80, rows: 24, startedAt: 'now', exitCode: null,
  label: 'x', busy: false, topic: 't', command: 'run', ...over,
})

describe('AgentSetupFlow: terminal sign-in and lost sessions (#2474 re-review)', () => {
  it('cancels a terminal sign-in when the sheet closes, so it does not hold the setup slot', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    const view = renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    view.unmount()
    await waitFor(() => expect(cancelled).toEqual(['s1']))
  })

  it('cancels the sign-in terminal once the sign-in lands', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    statuses = { antigravity: 'connected' }
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    // Closing afterwards does not send a second DELETE for the login it already ended.
    cleanup()
    await pause(20)
    expect(cancelled).toEqual(['s1'])
  })

  it('offers Cancel while a sign-in terminal is open, and does not rejoin what it cancelled', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    expect(await screen.findByRole('button', { name: 'Open terminal here' })).toBeTruthy()
    expect(screen.queryByTestId('terminal')).toBeNull()
  })

  it('opened as a sign-in, rejoins a sign-in terminal already running', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    session = live({ provider: 'antigravity', action: 'login' })
    renderFlow('antigravity', 'sign-in')
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('live-1'))
    expect(posted).toEqual([])
  })

  it('offers the terminal again when the sign-in terminal ends before signing in', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    session = { ...session, exitCode: 1 }
    expect((await screen.findByRole('alert', {}, WAIT)).textContent).toContain('The sign-in terminal closed before Antigravity signed in.')
    expect(screen.getByRole('button', { name: 'Open terminal here' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('an update sheet never rejoins a sign-in, so it cannot report an update that never ran', async () => {
    statuses = { claude: 'disconnected' }
    agents = [entry('claude', { installed: true, version: '2.0.14', method: 'native', update: { command: "'claude' update", runnable: true, sudo: false } })]
    session = live({ provider: 'claude', action: 'login' })
    renderFlow('claude', 'update')
    expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(phase()).toBe('confirm')
    expect(screen.queryByTestId('terminal')).toBeNull()
  })

  it('settles an install whose session vanished from the server against the status', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    statuses = { codex: 'disconnected' }
    session = null
    await waitFor(() => expect(phase()).toBe('sign-in'), WAIT)
  })

  it('settles an update whose session vanished from the server against the version', async () => {
    statuses = { claude: 'connected' }
    agents = [entry('claude', { installed: true, version: '2.0.14', method: 'native', update: { command: "'claude' update", runnable: true, sudo: false } })]
    renderFlow('claude', 'update')
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await waitFor(() => expect(phase()).toBe('running'))
    session = null
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
    expect(screen.getByRole('alert').textContent).toContain('The terminal closed before cezar saw it finish.')
  })

  it('reports an update as done when its session vanished and the version really changed', async () => {
    statuses = { claude: 'connected' }
    agents = [entry('claude', { installed: true, version: '2.0.14', method: 'native', update: { command: "'claude' update", runnable: true, sudo: false } })]
    renderFlow('claude', 'update')
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await waitFor(() => expect(phase()).toBe('running'))
    // The server re-probed at the exit: the listing that drops the session already has the new version.
    agents = [entry('claude', { installed: true, version: '2.1.3', method: 'native', update: { command: "'claude' update", runnable: true, sudo: false } })]
    session = null
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    expect(screen.getByText('Claude Code is updated. It reports 2.1.3 now.')).toBeTruthy()
  })

  it('settles when the listing shows another session instead of the one it tracks', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    statuses = { codex: 'disconnected' }
    // Another tab started one after a restart: s1 is gone, but the listing is not empty.
    session = live({ id: 'other-tab', provider: 'claude', action: 'install' })
    await waitFor(() => expect(phase()).toBe('sign-in'), WAIT)
  })

  it('never cancels a sign-in it rejoined from another tab when it closes (StrictMode)', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    session = live({ provider: 'antigravity', action: 'login' })
    const view = renderFlow('antigravity', 'sign-in', { strict: true })
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('live-1'))
    await pause(20)
    expect(cancelled).toEqual([])
    view.unmount()
    await pause(20)
    expect(cancelled).toEqual([])
  })

  it('under StrictMode, cancels the sign-in it started exactly once when it closes', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    const view = renderFlow('antigravity', 'sign-in', { strict: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    view.unmount()
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    // waitFor passes on the first DELETE: give a second one time to arrive, then count exactly.
    await pause(50)
    expect(cancelled).toEqual(['s1'])
  })

  it('a sheet reopened right after closing does not rejoin the sign-in the close cancelled', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    const client = createQueryClient()
    // The page behind the sheet keeps reading the listing, so its cache outlives the sheet.
    function Page({ sheet }: { sheet: boolean }) {
      useAgentSetup()
      return sheet ? <AgentSetupFlow provider="antigravity" action="sign-in" onClose={() => {}} /> : null
    }
    const view = render(<QueryClientProvider client={client}><Page sheet /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    // Reopened while the close's DELETE is still in flight: the server still lists the login.
    let release!: () => void
    cancelGate = new Promise<void>((resolve) => { release = resolve })
    view.rerender(<QueryClientProvider client={client}><Page sheet={false} /></QueryClientProvider>)
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    view.rerender(<QueryClientProvider client={client}><Page sheet /></QueryClientProvider>)
    await pause(50)
    expect(screen.queryByTestId('terminal')).toBeNull()
    release()
    await pause(300)
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open terminal here' })).toBeTruthy()
  })

  it('cancels a rejoined sign-in once it lands, so it does not hold the setup slot', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    session = live({ provider: 'antigravity', action: 'login' })
    renderFlow('antigravity', 'sign-in')
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('live-1'))
    statuses = { antigravity: 'connected' }
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    await waitFor(() => expect(cancelled).toEqual(['live-1']))
    cleanup()
    await pause(50)
    expect(cancelled).toEqual(['live-1'])
  })

  it('after the user cancels, no "terminal closed" alert follows, and a listing still showing it is not rejoined', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    const client = createQueryClient()
    renderFlow('antigravity', 'sign-in', { client })
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    let release!: () => void
    cancelGate = new Promise<void>((resolve) => { release = resolve })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    // A read while the DELETE is in flight still lists the login as running.
    await act(async () => { await client.refetchQueries({ queryKey: ['workspace', 'providers', 'setup'] }) })
    await pause(50)
    expect(screen.queryByTestId('terminal')).toBeNull()
    release()
    await pause(300)
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open terminal here' })).toBeTruthy()
  })

  it('does not cancel on close a sign-in its own start only joined (another tab started it)', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    const client = createQueryClient()
    renderFlow('antigravity', 'sign-in', { client })
    await screen.findByRole('button', { name: 'Open terminal here' })
    // Another tab starts the login after this sheet's last listing; this sheet's start joins it.
    session = live({ provider: 'antigravity', action: 'login' })
    joinNext = true
    // The read after the start fails, so the cache keeps exactly what the start wrote into it.
    listFails = true
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal here' }))
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('live-1'))
    // `joined` is the client's note on the response, never written into the contract-typed cache.
    expect(client.getQueryData<{ session: Record<string, unknown> }>(['workspace', 'providers', 'setup'])?.session).not.toHaveProperty('joined')
    cleanup()
    await pause(50)
    expect(cancelled).toEqual([])
  })
  it('without a page holding the listing, a sheet reopened during the close’s DELETE does not rejoin it', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    // The real openers watch only the `latest` listing: the main one is dropped when the sheet closes.
    const client = createQueryClient()
    const first = renderFlow('antigravity', 'sign-in', { client })
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    let release!: () => void
    cancelGate = new Promise<void>((resolve) => { release = resolve })
    first.unmount()
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    renderFlow('antigravity', 'sign-in', { client })
    await screen.findByRole('button', { name: 'Open terminal here' })
    await pause(100)
    expect(screen.queryByTestId('terminal')).toBeNull()
    release()
    await pause(300)
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps Open terminal here disabled until the Cancel settles', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    let release!: () => void
    cancelGate = new Promise<void>((resolve) => { release = resolve })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const open = await screen.findByRole('button', { name: 'Open terminal here' })
    expect((open as HTMLButtonElement).disabled).toBe(true)
    release()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open terminal here' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal here' }))
    await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('s2'))
  })

  it('does not show a login its start joined while another sheet is still cancelling it', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    const closing = renderFlow('antigravity', 'sign-in')
    fireEvent.click(await within(closing.container).findByRole('button', { name: 'Open terminal here' }))
    await within(closing.container).findByTestId('terminal')
    let release!: () => void
    cancelGate = new Promise<void>((resolve) => { release = resolve })
    closing.unmount()
    await waitFor(() => expect(cancelled).toEqual(['s1']))
    // A second sheet's start reaches the server before the kill: the server joins the dying login.
    joinNext = true
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The last sign-in terminal is still stopping.')
    expect(screen.queryByTestId('terminal')).toBeNull()
    release()
  })

  it('says so when the terminal of a landed sign-in cannot be closed, and closes it on retry', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    cancelFails = true
    statuses = { antigravity: 'connected' }
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    expect((await screen.findByRole('alert')).textContent).toContain('could not close the sign-in terminal')
    cancelFails = false
    fireEvent.click(screen.getByRole('button', { name: 'Close it' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(cancelled).toEqual(['s1', 's1'])
  })

  it('does not settle on a stale listing without the session while the server still runs it', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    const client = createQueryClient()
    renderFlow('codex', 'install', { client })
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    // A read that began before the start lands now, without the session.
    act(() => { client.setQueryData(['workspace', 'providers', 'setup'], (state: Record<string, unknown>) => ({ ...state, session: null })) })
    await pause(300)
    expect(phase()).toBe('running')
    expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('s1')
  })

  it('does not settle when the re-read itself fails', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    const client = createQueryClient()
    renderFlow('codex', 'install', { client })
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    listFails = true
    act(() => { client.setQueryData(['workspace', 'providers', 'setup'], (state: Record<string, unknown>) => ({ ...state, session: null })) })
    await pause(300)
    expect(phase()).toBe('running')
    // Once the listing answers again and the session is really gone, it settles.
    listFails = false
    session = null
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
  })

  it('keeps the sign-in terminal and its Cancel when the cancel fails', async () => {
    cancelFails = true
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((await screen.findByRole('alert')).textContent).toContain('could not stop the sign-in terminal')
    expect(screen.getByTestId('terminal')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it.each([
    { sheet: 'install' as const, running: 'login', rejoins: true },
    { sheet: 'install' as const, running: 'update', rejoins: false },
    { sheet: 'sign-in' as const, running: 'install', rejoins: false },
    { sheet: 'sign-in' as const, running: 'update', rejoins: false },
  ])('a $sheet sheet $running session: rejoins=$rejoins', async ({ sheet, running, rejoins }) => {
    statuses = { antigravity: sheet === 'install' ? 'not-installed' : 'disconnected' }
    agents = [entry('antigravity', { installed: sheet !== 'install', loginCommand: "'agy'", install: { command: 'curl -fsSL https://x | bash', runnable: true, sudo: false } })]
    session = live({ provider: 'antigravity', action: running })
    renderFlow('antigravity', sheet)
    if (rejoins) {
      await waitFor(() => expect(screen.getByTestId('terminal').getAttribute('data-session')).toBe('live-1'))
    } else {
      await waitFor(() => expect(phase()).toBeTruthy())
      await pause(50)
      expect(screen.queryByTestId('terminal')).toBeNull()
    }
    expect(posted).toEqual([])
  })

  it('offers the terminal again when a sign-in session vanishes', async () => {
    statuses = { antigravity: 'disconnected' }
    agents = [entry('antigravity', { installed: true, loginCommand: "'agy'" })]
    renderFlow('antigravity', 'sign-in')
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal here' }))
    await screen.findByTestId('terminal')
    session = null
    expect((await screen.findByRole('alert', {}, WAIT)).textContent).toContain('The terminal closed before cezar saw it finish. Open it again')
    expect(screen.getByRole('button', { name: 'Open terminal here' })).toBeTruthy()
    expect(screen.queryByTestId('terminal')).toBeNull()
  })

  it('fails an install that vanished while the agent is still not installed', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    session = null
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
    expect(screen.getByRole('alert').textContent).toContain('Codex is not installed. Try again.')
  })

  it('fails with a retry when the status cannot be read after an install vanished', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } })]
    renderFlow('codex', 'install')
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(phase()).toBe('running'))
    refreshFails = true
    session = null
    await waitFor(() => expect(phase()).toBe('failed'), WAIT)
    expect(screen.getByRole('alert').textContent).toContain('cezar could not check the agent. Try again.')
  })
})

describe('AgentSetupFlow: an update that waits for tasks', () => {
  afterEach(() => vi.useRealTimers())

  it('starts the update exactly once when the tasks finish, then reads the new version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    postDelayMs = 2_000
    statuses = { claude: 'connected' }
    const claude = (over: Partial<AgentSetupEntry>) => entry('claude', {
      installed: true, version: '2.0.14', method: 'native', activeRuns: 1,
      update: { command: "'claude' update", runnable: true, sudo: false },
      ...over,
    })
    agents = [claude({})]
    renderFlow('claude', 'update')
    fireEvent.click(await screen.findByRole('button', { name: 'Update when they finish' }))
    await waitFor(() => expect(phase()).toBe('waiting'))
    expect(posted).toEqual([])

    // The task ends; the next poll sees no task on Claude Code.
    agents = [claude({ activeRuns: 0 })]
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    // The start is in flight for two seconds; the sheet keeps re-rendering meanwhile.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    await waitFor(() => expect(phase()).toBe('running'), WAIT)
    // Further polls and re-renders while the start is in flight must not start it again.
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(posted).toEqual([{ provider: 'claude', action: 'update' }])

    // It ends: the sheet re-reads the listing before it says done, and names the version.
    agents = [claude({ activeRuns: 0, version: '2.1.3' })]
    session = { ...session, exitCode: 0 }
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    expect(screen.getByText(/It reports 2\.1\.3 now/)).toBeTruthy()
    expect(posted).toHaveLength(1)
  })
})

describe('DefaultAgentPicker with the setup catalog', () => {
  it('keeps only pickable agents in the strip and groups the rest by their next step', async () => {
    const onAgentAction = vi.fn()
    const setup = [
      entry('claude', { installed: true, version: '2.0.14', latestVersion: '2.1.3', update: { command: "'claude' update", runnable: true, sudo: false } }),
      entry('gemini', { install: { command: 'npm install -g @google/gemini-cli', runnable: false, sudo: false } }),
      entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, sudo: false } }),
      entry('copilot', { installed: true, version: '1.0.88' }),
      entry('pi'),
    ]
    render(
      <DefaultAgentPicker
        rows={agentPickerRows([])}
        runner="claude"
        accountFor={() => null}
        providerStatus={{
          isPending: false,
          isError: false,
          data: { providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'gemini', status: 'not-installed', enabled: true },
            { provider: 'codex', status: 'not-installed', enabled: true },
            { provider: 'copilot', status: 'disconnected', enabled: true },
            { provider: 'pi', status: 'not-installed', enabled: false },
          ] },
        }}
        setup={setup}
        onAgentAction={onAgentAction}
        onPick={() => {}}
      />,
    )
    // The strip: what can be picked, and nothing else.
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('data-value'))).toEqual(['claude'])
    const group = (id: string) => [...document.querySelectorAll(`[data-group="${id}"] [data-slot="agents-setup-row"]`)].map((row) => row.getAttribute('data-runner'))
    expect(group('update')).toEqual(['claude'])
    expect(group('sign-in')).toEqual(['copilot'])
    expect(group('install')).toEqual(['codex', 'gemini'])
    expect(group('off')).toEqual(['pi'])
    const action = (runner: string) => document.querySelector(`[data-slot="agents-runner-action"][data-runner="${runner}"]`)
    expect(action('claude')?.textContent).toBe('Update')
    expect(action('gemini')?.textContent).toBe('How to install')
    expect(action('codex')?.textContent).toBe('Install')
    expect(action('copilot')?.textContent).toBe('Sign in')
    expect(action('pi')).toBeNull()
    expect(screen.getByText('2.0.14 → 2.1.3')).toBeTruthy()
    await act(async () => fireEvent.click(action('codex')!))
    expect(onAgentAction).toHaveBeenCalledWith('codex', 'install')
  })

  it('keeps the checked agent in the strip even when it is signed out', () => {
    render(
      <DefaultAgentPicker
        rows={agentPickerRows([])}
        runner="codex"
        accountFor={() => null}
        providerStatus={{ isPending: false, isError: false, data: { providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'disconnected', enabled: true },
        ] } }}
        setup={[entry('codex', { installed: true })]}
        onAgentAction={() => {}}
        onPick={() => {}}
      />,
    )
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('data-value'))).toEqual(['claude', 'codex'])
    expect((radios[1] as HTMLButtonElement).disabled).toBe(true)
  })

  it('without the catalog, is the strip it always was', () => {
    render(
      <DefaultAgentPicker
        rows={agentPickerRows([])}
        runner="claude"
        accountFor={() => null}
        providerStatus={{ isPending: false, isError: false, data: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] } }}
        onPick={() => {}}
      />,
    )
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(1)
    expect(document.querySelector('[data-slot="agents-setup-groups"]')).toBeNull()
  })
})
