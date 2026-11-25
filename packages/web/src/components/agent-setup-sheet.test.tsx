import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSetupEntry, AgentSetupProvider } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
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

  it('offers Antigravity’s docs when its installer is not known yet', async () => {
    statuses = { antigravity: 'not-installed' }
    agents = [entry('antigravity')]
    renderFlow('antigravity', 'install')
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
})

describe('DefaultAgentPicker actions', () => {
  it('puts Install, Sign in and Update on the rows that need them, and a version chip beside', async () => {
    const onAgentAction = vi.fn()
    const setup = [
      entry('claude', { installed: true, version: '2.0.14', latestVersion: '2.1.3', versionState: 'update-available', update: { command: "'claude' update", runnable: true, method: 'native', sudo: false } }),
      entry('gemini', { install: { command: 'npm install -g @google/gemini-cli', runnable: false, method: 'npm', sudo: false } }),
      entry('codex', { install: { command: 'npm install -g @openai/codex', runnable: true, method: 'npm', sudo: false } }),
      entry('copilot', { installed: true }),
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
          ] },
        }}
        setup={setup}
        onAgentAction={onAgentAction}
        onPick={() => {}}
      />,
    )
    const action = (runner: string) => document.querySelector(`[data-slot="agents-runner-action"][data-runner="${runner}"]`)
    expect(action('claude')?.textContent).toBe('Update')
    expect(action('gemini')?.textContent).toBe('How to install')
    expect(action('codex')?.textContent).toBe('Install')
    expect(action('copilot')?.textContent).toBe('Sign in')
    expect(document.querySelector('[data-slot="agents-version-chip"][data-runner="claude"]')?.textContent).toBe('2.1.3 available')
    // The row itself stays unselectable until the agent is connected.
    expect((screen.getByRole('radio', { name: /codex/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => fireEvent.click(action('codex')!))
    expect(onAgentAction).toHaveBeenCalledWith('codex', 'install')
  })
})
