import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSetupEntry, AgentSetupProvider } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import { useAgentSetup } from '@/api/queries'
import { AgentSetupFlow } from '@/components/agent-setup-sheet'
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
let statuses: Record<string, string> = {}
let session: Record<string, unknown> | null = null
let posted: Array<Record<string, unknown>> = []
/** How long a start takes to answer: long enough, and the sheet re-renders while it is in flight. */
let postDelayMs = 0

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const entry = (provider: AgentSetupProvider, over: Partial<AgentSetupEntry> = {}): AgentSetupEntry => ({
  provider,
  installCommand: null,
  installHint: '',
  loginCommand: `${provider} login`,
  install: { command: null, runnable: false, method: null, sudo: false },
  update: null,
  docsUrl: `https://docs.example/${provider}`,
  copyOnlyReason: null,
  installed: false,
  version: null,
  method: null,
  minVersion: null,
  latestVersion: null,
  versionState: 'unknown',
  autoUpdates: null,
  activeRuns: 0,
  ...over,
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/v1/providers/status') {
      return json({ providers: Object.entries(statuses).map(([provider, status]) => ({ provider, status, enabled: true })) })
    }
    if (url.pathname === '/api/v1/providers/setup') return json({ available: true, interactive, session, agents })
    if (url.pathname === '/api/v1/providers/setup/sessions' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posted.push(body)
      if (postDelayMs) await new Promise((resolve) => setTimeout(resolve, postDelayMs))
      session = {
        id: `s${posted.length}`, runId: 'agent-setup', cwd: '/home/me', shell: '/bin/sh', cols: 80, rows: 24, startedAt: 'now', exitCode: null,
        label: 'x', busy: false, topic: 't', provider: body.provider, action: body.action, command: `run ${String(body.action)}`,
      }
      return json(session, 201)
    }
    if (url.pathname === '/api/v1/health') return json({ repoRoot: '/work', bootProject: 'boot', capabilities: {} })
    return json({ error: 'not stubbed' }, 404)
  })
})

afterEach(() => {
  agents = []
  interactive = true
  statuses = {}
  session = null
  posted = []
  postDelayMs = 0
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const renderFlow = (provider: AgentSetupProvider, action: 'install' | 'update' | 'sign-in') =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AgentSetupFlow provider={provider} action={action} onClose={() => {}} />
    </QueryClientProvider>,
  )

const phase = () => document.querySelector('[data-slot="agent-setup-flow"]')?.getAttribute('data-phase')
const WAIT = { timeout: 5_000 }

describe('AgentSetupFlow', () => {
  it('confirms the exact command, installs, then moves on to the sign-in', async () => {
    statuses = { codex: 'not-installed' }
    agents = [entry('codex', { installCommand: 'npm install -g @openai/codex', install: { command: 'npm install -g @openai/codex', runnable: true, method: 'npm', sudo: false } })]
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
      install: { command: 'brew install can1357/tap/omp', runnable: false, method: 'brew', sudo: false },
      copyOnlyReason: 'OMP installs from a third-party Homebrew tap, so cezar shows the command instead of running it.',
    })]
    renderFlow('omp', 'install')
    expect(await screen.findByText('brew install can1357/tap/omp')).toBeTruthy()
    expect(screen.getByText(/third-party Homebrew tap/)).toBeTruthy()
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
    agents = [entry('codex', { install: { command: 'sudo npm install -g @openai/codex', runnable: true, method: 'npm', sudo: true } })]
    renderFlow('codex', 'install')
    expect(await screen.findByText(/needs your computer password/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('holds an update while tasks run, unless told to update now', async () => {
    statuses = { claude: 'connected' }
    agents = [entry('claude', {
      installed: true, version: '2.0.14', latestVersion: '2.1.3', versionState: 'update-available', method: 'native', activeRuns: 2,
      update: { command: "'claude' update", runnable: true, method: 'native', sudo: false },
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
    const current = { installed: true, method: 'native' as const, update: { command: "'claude' update", runnable: true, method: 'native' as const, sudo: false } }
    agents = [entry('claude', { ...current, version: '2.0.14', latestVersion: '2.1.3', versionState: 'update-available' })]
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
    agents = [entry('claude', { ...current, version: '2.1.3', latestVersion: '2.1.3', versionState: 'current' })]
    session = { ...session, exitCode: 0 }
    await waitFor(() => expect(phase()).toBe('done'), WAIT)
    await waitFor(() => expect(screen.getByTestId('settings-version').textContent).toBe('2.1.3'), WAIT)
  })
})

describe('AgentSetupFlow: an update that waits for tasks', () => {
  afterEach(() => vi.useRealTimers())

  it('starts the update exactly once when the tasks finish, then reads the new version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    postDelayMs = 2_000
    statuses = { claude: 'connected' }
    const claude = (over: Partial<AgentSetupEntry>) => entry('claude', {
      installed: true, version: '2.0.14', versionState: 'update-available', method: 'native', activeRuns: 1,
      update: { command: "'claude' update", runnable: true, method: 'native', sudo: false },
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
    agents = [claude({ activeRuns: 0, version: '2.1.3', versionState: 'current' })]
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
      entry('claude', { installed: true, version: '2.0.14', latestVersion: '2.1.3', versionState: 'update-available', update: { command: "'claude' update", runnable: true, method: 'native', sudo: false } }),
      entry('gemini', { install: { command: 'npm install -g @google/gemini-cli', runnable: false, method: 'npm', sudo: false } }),
      entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, method: 'npm', sudo: false } }),
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
