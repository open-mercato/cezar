import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { AgentFallbackPolicy, AgentProfilesResponse, ProjectListEntry } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * Settings → Agents → Automatic fallback (spec 2026-10-20-agent-usage-limit-fallback), against a
 * stateful compare-and-swap stub of `/api/v1/workspace/agent-profiles/fallback-policy`.
 */

const PROJECT: ProjectListEntry = { id: 'boot', name: 'repo', root: '/repo', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' }

const PROFILES: AgentProfilesResponse = {
  defaults: {},
  editable: true,
  profileCapableProviders: ['claude', 'codex'],
  selections: {},
  profiles: [
    { id: 'default', provider: 'claude', label: 'Default', configDir: '~/.claude', path: '/h/.claude', exists: true, looksValid: true, isDefault: true, files: [] },
    { id: 'default', provider: 'codex', label: 'Default', configDir: '~/.codex', path: '/h/.codex', exists: true, looksValid: true, isDefault: true, files: [] },
    { id: 'work', provider: 'codex', label: 'Work', configDir: '~/.codex-work', path: '/h/.codex-work', exists: true, looksValid: true, isDefault: false, files: [] },
  ],
}

let puts: Array<Record<string, unknown>> = []

function serve({ policy, getStatus = 200, getError = 'agent fallback is local-only', conflictOnce = false, modelsLocked = false, profiles = PROFILES, defaultRunner = "claude" }: { policy?: Partial<AgentFallbackPolicy>; getStatus?: number; getError?: string; conflictOnce?: boolean; modelsLocked?: boolean; profiles?: AgentProfilesResponse; defaultRunner?: string } = {}) {
  puts = []
  let conflict = conflictOnce
  const state: AgentFallbackPolicy = { enabled: false, candidates: [], revision: 0, incarnation: null, revocation: null, ...policy }
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    if (url.startsWith('/api/v1/workspace/agent-profiles/fallback-policy')) {
      if (method === 'GET') return getStatus === 200 ? json(state) : json({ error: getError }, getStatus)
      puts.push(body ?? {})
      if (conflict) {
        conflict = false
        state.revision += 1
        return json({ error: 'fallback policy changed; reload and try again' }, 409)
      }
      if (body?.expectedRevision !== state.revision) return json({ error: 'fallback policy changed; reload and try again' }, 409)
      Object.assign(state, { enabled: body.enabled, candidates: body.candidates, revision: state.revision + 1, incarnation: state.incarnation ?? 'i1' })
      return json(state)
    }
    if (url === '/api/v1/config' && method === 'GET') {
      return json({ baseBranch: null, defaultRunner, systemPrompt: null, branchNaming: null, defaultModels: {}, modelsLocked, maxParallel: 2, memoryLimitMb: null, worktreeRetention: 10, liveTitleUpdates: null, reviewGate: null })
    }
    if (url === '/api/v1/providers/status') {
      return json({ providers: ['claude', 'codex', 'opencode', 'cursor', 'pi'].map((provider) => ({ provider, status: 'connected', enabled: true })) })
    }
    if (url === '/api/v1/workspace/agent-profiles') return json(profiles)
    if (url === '/api/v1/projects') return json({ projects: [PROJECT], bootProject: 'boot', projectsDir: '~/p' })
    if (url.startsWith('/api/v1/models?runner=')) return json({ runner: url.split('=')[1], models: [], source: 'live', stale: false })
    if (url === '/api/v1/repo') return json({ info: { root: '/repo', branch: 'main' }, status: [], log: [], branches: ['main'], checkedOutElsewhere: {}, baseBranch: null })
    return new Promise<never>(() => {})
  }))
  return state
}

function renderAgents() {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, { projects: [PROJECT], bootProject: 'boot', projectsDir: '~/p' })
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/settings/agents']}>
          <AppRoutes />
          <Toaster />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const section = () => document.querySelector<HTMLElement>('[data-slot="fallback-section"]')
const rows = () => Array.from(document.querySelectorAll('[data-slot="fallback-row"]')).map((row) => row.textContent ?? '')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('automatic fallback settings', () => {
  it('starts empty with the switch disabled and explains scope, cost and the stop condition', async () => {
    serve()
    renderAgents()
    await screen.findByText('No fallback agents yet. Add the agent that should take over first.')
    expect(screen.getByRole('switch', { name: 'Automatic fallback' }).hasAttribute('disabled')).toBe(true)
    const describedBy = screen.getByRole('switch', { name: 'Automatic fallback' }).getAttribute('aria-describedby')!
    for (const id of describedBy.split(' ')) expect(document.getElementById(id)).not.toBeNull()
    const terms = section()?.textContent ?? ''
    expect(terms).toContain('receives the task and its repository context')
    expect(terms).toContain('workflow graphs and earlier steps keep waiting')
    expect(terms).toContain('the task stops')
  })

  it('provides labelled keyboard drag handles without replacing arrow controls', async () => {
    serve({ policy: { candidates: [
      { provider: 'claude', profileId: 'default' },
      { provider: 'codex', profileId: 'work' },
    ] } })
    renderAgents()
    const handle = await screen.findByRole('button', { name: 'Reorder claude · Default, position 1 of 2' })
    expect(handle.hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Move claude · Default down' })).toBeTruthy()
    handle.focus()
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' })
    await waitFor(() => expect(handle.getAttribute('aria-pressed')).toBe('true'))
    expect(puts).toHaveLength(0)
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    await waitFor(() => expect(handle.getAttribute('aria-pressed')).not.toBe('true'))
    expect(puts).toHaveLength(0)
  })

  it('adds a specific account, never offers one already listed, and sends the current revision', async () => {
    serve()
    renderAgents()
    const agent = await screen.findByLabelText<HTMLSelectElement>('Agent to add')
    fireEvent.change(agent, { target: { value: 'codex:work' } })
    fireEvent.click(screen.getByRole('button', { name: /Add agent/ }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(puts[0]).toMatchObject({ expectedRevision: 0, enabled: false, candidates: [{ provider: 'codex', profileId: 'work' }] })
    expect(rows()[0]).toContain('codex · Work')
    expect(screen.queryByRole('button', { name: 'Turn on automatic fallback' })).toBeNull()
    expect(screen.getByText('Off — the list is saved but not used.')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic fallback' }))
    await waitFor(() => expect(puts[1]).toMatchObject({ enabled: true }))
    const options = Array.from(screen.getByLabelText<HTMLSelectElement>('Agent to add').options).map((o) => o.value)
    expect(options).not.toContain('codex:work')
  })

  it('reorders and removes rows with named buttons, keeping the policy on while rows remain', async () => {
    serve({ policy: { enabled: true, revision: 2, incarnation: 'i', candidates: [{ provider: 'codex', profileId: 'default' }, { provider: 'opencode', profileId: 'default' }] } })
    renderAgents()
    const move = await screen.findByRole('button', { name: 'Move opencode · Default up' })
    move.focus()
    fireEvent.click(move)
    await waitFor(() => expect(rows()[0]).toContain('opencode'))
    expect(puts[0]).toMatchObject({ expectedRevision: 2, enabled: true })
    expect(document.activeElement).toBe(move)
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('moved to position 1'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove codex · Default from fallback' }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(puts[1]).toMatchObject({ enabled: true, candidates: [{ provider: 'opencode', profileId: 'default' }] })
  })

  it('removing the last row switches fallback off', async () => {
    serve({ policy: { enabled: true, revision: 1, incarnation: 'i', candidates: [{ provider: 'codex', profileId: 'default' }] } })
    renderAgents()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove codex · Default from fallback' }))
    await waitFor(() => expect(puts[0]).toMatchObject({ enabled: false, candidates: [] }))
  })

  it('marks a removed account and still lets the user switch fallback off', async () => {
    serve({ policy: { enabled: true, revision: 1, incarnation: 'i', candidates: [{ provider: 'claude', profileId: 'gone' }] } })
    renderAgents()
    await screen.findByText('Account removed — will be skipped')
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic fallback' }))
    await waitFor(() => expect(puts[0]).toMatchObject({ enabled: false, candidates: [{ provider: 'claude', profileId: 'gone' }] }))
  })

  it('reloads after a conflict so the next edit is not stuck on a stale revision', async () => {
    serve({ policy: { candidates: [{ provider: 'codex', profileId: 'default' }] }, conflictOnce: true })
    renderAgents()
    const toggle = await screen.findByRole('switch', { name: 'Automatic fallback' })
    fireEvent.click(toggle)
    await screen.findByText('Fallback settings changed elsewhere — reloaded. Try again.')
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Automatic fallback' })).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic fallback' }))
    await waitFor(() => expect(puts[1]).toMatchObject({ expectedRevision: 1, enabled: true }))
  })

  it('uses native model settings when model selection is locked', async () => {
    serve({ modelsLocked: true, policy: { candidates: [{ provider: 'codex', profileId: 'work', model: 'old-pin' }] } })
    renderAgents()
    await screen.findByLabelText('Agent to add')
    expect(screen.queryByRole('combobox', { name: 'Model for the agent to add' })).toBeNull()
    expect(screen.getByLabelText('Model for the agent to add').textContent).toContain('Native agent settings')
    expect(screen.getByText('Model selection is locked — remove and add this agent again to use native settings.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add agent/ }))
    await waitFor(() => expect(puts[0]).toMatchObject({ candidates: [
      { provider: 'codex', profileId: 'work', model: 'old-pin' },
      { provider: 'claude', profileId: 'default' },
    ] }))
  })

  it.each(['project', 'machine'] as const)('marks the effective %s account as the starting agent', async (source) => {
    serve({ defaultRunner: 'codex', profiles: { ...PROFILES,
      defaults: { codex: source === 'machine' ? 'work' : 'default' },
      selections: source === 'project' ? { '/repo': { codex: 'work' } } : {},
    }, policy: { candidates: [{ provider: 'codex', profileId: 'default' }, { provider: 'codex', profileId: 'work' }] } })
    renderAgents()
    await waitFor(() => expect(rows()[1]).toContain('This is the default agent'))
    expect(rows()[0]).not.toContain('This is the default agent')
  })

  it('reports a missing project folder and retries when the folder returns', async () => {
    serve({ getStatus: 409, getError: 'project folder not found: boot' })
    renderAgents()
    await screen.findByText('Fallback settings did not load — project folder not found: boot')
    expect(screen.queryByText('Automatic fallback is available on a local cockpit only.')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Automatic fallback' })).toBeNull()
    expect(puts).toHaveLength(0)
    serve()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('switch', { name: 'Automatic fallback' })
  })

  it('degrades without editable controls when an older server has no fallback endpoint', async () => {
    serve({ getStatus: 404, getError: 'Not Found' })
    renderAgents()
    await screen.findByText('Fallback settings did not load — Not Found')
    expect(screen.queryByRole('switch', { name: 'Automatic fallback' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Default models' })).toBeTruthy()
    expect(puts).toHaveLength(0)
  })

  it('explains why the section is unavailable on a hosted cockpit', async () => {
    serve({ getStatus: 409 })
    renderAgents()
    await screen.findByText('Automatic fallback is available on a local cockpit only.')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
