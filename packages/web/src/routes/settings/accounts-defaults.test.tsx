import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type {
  AgentProfilesResponse,
  AgentProvidersResponse,
  WorkspaceConfigResponse,
} from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * Global settings → Agent accounts, "Defaults for new projects" (spec 2026-07-29-agent-profiles):
 * the agent, account and models a project uses when it has chosen none, so a second login is set up
 * once rather than per repo. It lives on the accounts page because it is the same subject — a
 * separate page would mean adding an account here and going elsewhere to say "use it".
 *
 * What this pins is the STORES. One click answers one question but writes two files — the runner and
 * the models to `~/.cezar/config.json`, the account to `~/.cezar/agent-accounts.json` — and neither
 * may ever reach the per-repo `/api/v1/config`, which is committable. A regression there would
 * publish which login someone works under.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const ACCOUNTS: AgentProfilesResponse = {
  editable: true,
  profileCapableProviders: ['claude', 'codex'],
  selections: {},
  defaults: {},
  profiles: [
    {
      id: 'default',
      provider: 'claude',
      label: 'Default',
      configDir: '/home/u/.claude',
      path: '/home/u/.claude',
      exists: true,
      looksValid: true,
      isDefault: true,
      files: [],
    },
    {
      id: 'klaudiusz',
      provider: 'claude',
      label: 'Klaudiusz',
      configDir: '~/.claude-klaudiusz',
      path: '/home/u/.claude-klaudiusz',
      exists: true,
      looksValid: true,
      isDefault: false,
      files: [],
    },
  ],
}

const PROVIDERS = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'connected', enabled: true },
    { provider: 'cursor', status: 'connected', enabled: true },
    { provider: 'pi', status: 'connected', enabled: true },
    { provider: 'junie', status: 'connected', enabled: true },
  ],
}

function serve({
  agentDefaults = {},
  accounts = ACCOUNTS,
  checks = [],
  methods = { editable: true, agents: [] },
}: {
  agentDefaults?: WorkspaceConfigResponse['agentDefaults']
  accounts?: AgentProfilesResponse
  methods?: AgentProvidersResponse
  checks?: Array<{ name: string; available: boolean }>
} = {}) {
  requests = []
  const state: WorkspaceConfigResponse = {
    branding: { name: 'cezar', logoUrl: null },
    computerName: 'Test Mac',
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    orgSkillsRepos: [],
    systemPrompt: null,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: true,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      idleTimeoutMinutes: 15,
      monitoringWakeIntervalMinutes: null,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10, worktreeIdleDaysDefault: 7, archivedTaskDeleteDaysDefault: 90, diskGuard: { minFreePercent: 10, minFreeGb: 5, maxWorktreesGb: 20 },
    },
    agentDefaults,
  }
  let accountState = accounts
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/agent-providers' && methods) return json(methods)
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        const patch = (body?.agentDefaults ?? {}) as { runner?: string; models?: Record<string, string | null> }
        if (patch.runner !== undefined) state.agentDefaults.runner = patch.runner as never
        if (patch.models) {
          state.agentDefaults.models = { ...state.agentDefaults.models, ...patch.models } as never
        }
        return json(state)
      }
      if (url === '/api/v1/workspace/agent-profiles' && method === 'GET') return json(accountState)
      if (url === '/api/v1/workspace/agent-profiles/selection' && method === 'PUT') {
        const { provider, profileId } = body as { provider: string; profileId: string | null }
        const defaults = { ...accountState.defaults }
        if (profileId === null) delete defaults[provider as 'claude']
        else defaults[provider as 'claude'] = profileId
        accountState = { ...accountState, defaults }
        return json({ selections: accountState.selections, defaults })
      }
      if (url === '/api/v1/providers/status' && method === 'GET') return json(PROVIDERS)
      // The accounts page also paints per-agent facts from health; an empty answer is a real state
      // (it renders "Checking…") and keeps this file about the defaults block.
      if (url === '/api/v1/health' && method === 'GET') return json({ checks, bootProject: 'boot' })
      if (url.startsWith('/api/v1/open-targets')) return json({ targets: [] })
      if (url.startsWith('/api/v1/models?runner=')) {
        const runner = url.includes('cursor') ? 'cursor' : 'codex'
        return json({ runner, models: [], source: 'unavailable', stale: false })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderAccounts(checks?: Array<{ name: string; available: boolean }>) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot', ...(checks ? { checks } : {}) })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/settings/global/agents']}>
          <AppRoutes />
          <Toaster />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const accountMenu = async () => {
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Account for Claude Code' }), { key: 'ArrowDown' })
  await screen.findByRole('menuitemradio', { name: 'Default' })
}

const configPuts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')
const selections = () =>
  requests.filter((r) => r.url === '/api/v1/workspace/agent-profiles/selection')
const repoConfigWrites = () => requests.filter((r) => r.url === '/api/v1/config')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Agent accounts → Defaults for new projects', () => {
  it('moves the workspace default star without changing either account or project defaults', async () => {
    serve({ methods: { editable: true, agents: ['claude', 'codex'].map(id => ({
      runner: id as 'claude' | 'codex', mode: 'one', active: 'subscription',
      methods: [{ id: 'subscription', kind: 'subscription', label: 'Subscription', state: 'connected' }],
    })) } })
    renderAccounts()
    const star = await screen.findByRole('button', { name: 'Start new projects with Codex' })
    await waitFor(() => expect(star.hasAttribute('disabled')).toBe(false))
    fireEvent.click(star)
    await waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByRole('button', { name: 'Start new projects with Claude Code' }).getAttribute('aria-pressed')).toBe('false')
    expect(configPuts().map(r => r.body)).toEqual([{ agentDefaults: { runner: 'codex' } }])
    expect(selections()).toHaveLength(0)
    expect(repoConfigWrites()).toHaveLength(0)
  })

  it('survives a server that has never heard of agent defaults', async () => {
    // Version skew, and it crashed this page for real: Vite serves this bundle while `dist/` or
    // another process serves the API, so an older server answers `/workspace/config` with no
    // `agentDefaults` at all and the block read `.runner` off undefined. Fixed at the client
    // boundary — one place a missing key becomes the empty answer it means — so this guards the
    // whole class rather than the one line that happened to blow up.
    serve()
    const older = { ...ACCOUNTS }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        requests.push({ method: init?.method ?? 'GET', url })
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
        if (url === '/api/v1/workspace/config') {
          return json({
            browseRoot: '~/',
            projectsDir: '~/cezar/projects',
            skillsAutoUpdate: null,
            effectiveSkillsAutoUpdate: true,
            composerDefaults: {
              autonomous: null,
              worktree: null,
              inheritedAutonomous: 'source-dependent',
              inheritedWorktree: true,
            },
            resources: {
              maxParallel: 2,
              maxMonitoringSessions: 2,
              monitoringWakeIntervalMinutes: null,
              autoResumeOnUsageLimit: true,
              memoryLimitMb: null,
              worktreeRetentionDefault: 10, worktreeIdleDaysDefault: 7, archivedTaskDeleteDaysDefault: 90, diskGuard: { minFreePercent: 10, minFreeGb: 5, maxWorktreesGb: 20 },
            },
            // …and no `agentDefaults`.
          })
        }
        if (url === '/api/v1/workspace/agent-profiles') return json(older)
        if (url === '/api/v1/providers/status') return json(PROVIDERS)
        if (url === '/api/v1/health') return json({ checks: [], bootProject: 'boot' })
        if (url.startsWith('/api/v1/open-targets')) return json({ targets: [] })
        return new Promise<never>(() => {})
      }),
    )
    renderAccounts()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Start new projects with Claude Code' }).getAttribute('aria-pressed')).toBe('true'))
  })

  it('changing the default runner preserves the named account for the previous runner', async () => {
    serve({ accounts: { ...ACCOUNTS, defaults: { claude: 'klaudiusz' } } })
    renderAccounts()
    const star = await screen.findByRole('button', { name: 'Start new projects with Codex' })
    await waitFor(() => expect(star.hasAttribute('disabled')).toBe(false))
    fireEvent.click(star)
    await waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'))
    expect(configPuts().map((r) => r.body)).toEqual([{ agentDefaults: { runner: 'codex' } }])
    expect(selections()).toHaveLength(0)
  })

  it('writes the account to the accounts store with projectId null — the machine default', async () => {
    serve()
    renderAccounts()

    await accountMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Klaudiusz' }))

    await waitFor(() => expect(selections()).toHaveLength(1))
    // `null` is what makes this the machine-wide default rather than one repo's selection.
    expect(selections()[0]?.body).toEqual({
      projectId: null,
      provider: 'claude',
      profileId: 'klaudiusz',
    })
    // claude was already the effective runner, so the workspace config needed no write…
    expect(configPuts()).toHaveLength(0)
    // …and the repo config is not touched from this pane at all.
    expect(repoConfigWrites()).toHaveLength(0)
  })

  it('starts on the account the machine default already names', async () => {
    serve({ accounts: { ...ACCOUNTS, defaults: { claude: 'klaudiusz' } } })
    renderAccounts()

    await accountMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Klaudiusz' }).getAttribute('aria-checked')).toBe('true')
  })

  it('clears an account back to the discovered one with null, never the reserved id', async () => {
    serve({ accounts: { ...ACCOUNTS, defaults: { claude: 'klaudiusz' } } })
    renderAccounts()

    await accountMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }))

    await waitFor(() => expect(selections()).toHaveLength(1))
    expect(selections()[0]?.body).toEqual({
      projectId: null,
      provider: 'claude',
      profileId: null,
    })
  })

  it('saves a default model to the workspace config, and clears it with null', async () => {
    // Radix Select in jsdom: no scrollIntoView, no ResizeObserver.
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ agentDefaults: { models: { claude: 'opus' } } })
    renderAccounts()

    const trigger = () =>
      document.querySelector<HTMLButtonElement>('[data-slot="accounts-default-model"][data-runner="claude"]')
    await waitFor(() => expect(trigger()).not.toBeNull())
    expect(trigger()!.getAttribute('data-value')).toBe('opus')
    expect(trigger()!.textContent).toContain('opus')

    await waitFor(() => expect(trigger()?.disabled).toBe(false))
    fireEvent.keyDown(trigger()!, { key: 'ArrowDown' })
    const auto = await screen.findByRole('option', { name: 'auto' })
    fireEvent.click(auto)
    await waitFor(() => expect(configPuts()).toHaveLength(1))
    // …and the row says so inline, instead of a toast.
    await waitFor(() => expect(trigger()!.parentElement?.querySelector('[data-slot="saved-indicator"]')?.textContent).toBe('Saved'))
    // `null`, not an absent key: a partial patch cannot say "forget this" by omission, and a stale
    // value would keep seeding every unconfigured repo.
    expect(configPuts()[0]?.body).toEqual({ agentDefaults: { models: { claude: null } } })
    expect(repoConfigWrites()).toHaveLength(0)
  })

  it('shows a stale default model for an agent that is NOT installed, so it can be cleared', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const checks = [
      { name: 'claude', available: true },
      { name: 'codex', available: false },
    ]
    serve({ agentDefaults: { models: { codex: 'gpt-5-codex' } }, checks })
    renderAccounts(checks)

    const trigger = () =>
      document.querySelector<HTMLButtonElement>('[data-slot="accounts-default-model"][data-runner="codex"]')
    // The not-installed fold opens on its own: the stale value still seeds every new project.
    await waitFor(() => expect(trigger()).not.toBeNull())
    expect(trigger()!.getAttribute('data-value')).toBe('gpt-5-codex')
    await waitFor(() => expect(trigger()?.disabled).toBe(false))
    fireEvent.keyDown(trigger()!, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'auto' }))
    await waitFor(() => expect(configPuts()).toHaveLength(1))
    expect(configPuts()[0]?.body).toEqual({ agentDefaults: { models: { codex: null } } })
  })

})
