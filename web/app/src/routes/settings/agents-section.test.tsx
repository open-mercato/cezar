import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse, ProviderStatusResponse, RepoResponse, Runner } from '@/api/types'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Settings → Agents (R6 Step 1.5): the form round-trip against a stateful `/api/config` stub
 * that mimics the server's merge semantics (null clears, `defaultModels` merges per runner),
 * client-side validation of the system-prompt cap, and error surfacing — a PUT refusal (409)
 * shows the server's own words. The API contract itself is pinned server-side in
 * src/server/config-api.test.ts; this file asserts the SURFACE honors it.
 */

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main' },
  status: [],
  log: [],
  branches: ['main', 'develop'],
  baseBranch: null,
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve({
  config = {},
  putStatus = 200,
  putError = 'nope',
  providerStatus = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'connected', enabled: true },
      { provider: 'opencode', status: 'connected', enabled: true },
    ],
  },
  providerStatusCode = 200,
  providerStatusPending = false,
  providerStatusAfterFirstError,
}: {
  config?: Partial<ConfigResponse>
  putStatus?: number
  putError?: string
  providerStatus?: unknown
  providerStatusCode?: number
  providerStatusPending?: boolean
  providerStatusAfterFirstError?: string
} = {}) {
  requests = []
  let providerStatusReads = 0
  const state: ConfigResponse = {
    baseBranch: null,
    defaultRunner: 'claude',
    systemPrompt: null,
    defaultModels: {},
    maxParallel: 2,
    memoryLimitMb: null,
    worktreeRetention: 10,
    liveTitleUpdates: null,
    reviewGate: null,
    ...config,
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/config' && method === 'GET') return json(state)
      if (url === '/api/providers/status' && method === 'GET') {
        if (providerStatusPending) return new Promise<never>(() => {})
        if (providerStatusReads++ > 0 && providerStatusAfterFirstError) {
          return json({ error: providerStatusAfterFirstError }, 500)
        }
        return json(providerStatus, providerStatusCode)
      }
      if (url === '/api/providers/status?refresh=1' && method === 'GET') {
        return json(providerStatus, providerStatusCode)
      }
      if (url === '/api/config' && method === 'PUT') {
        if (putStatus !== 200) return json({ error: putError }, putStatus)
        // The server's merge semantics, mimicked: null clears, defaultModels merges per runner.
        if (body?.defaultRunner !== undefined) state.defaultRunner = body.defaultRunner as Runner
        if (body?.baseBranch !== undefined) state.baseBranch = (body.baseBranch as string | null) || null
        if (body?.systemPrompt !== undefined) {
          state.systemPrompt = (body.systemPrompt as string | null) || null
        }
        if (body?.liveTitleUpdates !== undefined) {
          state.liveTitleUpdates = body.liveTitleUpdates as boolean | null
        }
        if (body?.reviewGate !== undefined) {
          state.reviewGate = body.reviewGate as boolean | null
        }
        if (body?.defaultModels !== undefined) {
          for (const [runner, model] of Object.entries(body.defaultModels as Record<string, string | null>)) {
            if (model === null || model === '') delete state.defaultModels[runner as Runner]
            else state.defaultModels[runner as Runner] = model
          }
        }
        return json(state)
      }
      if (url === '/api/repo' && method === 'GET') return json(REPO)
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retry: false },
  })
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string) {
  const client = gateSeededClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/config')
const form = () => document.querySelector('[data-slot="agents-section"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the agents form', () => {
  it('puts the anchored Providers section first', async () => {
    serve()
    renderAt('/settings/agents')

    await waitFor(() => expect(form()).not.toBeNull())
    const providers = document.querySelector<HTMLElement>('[data-slot="provider-settings"]')!
    expect(providers.id).toBe('providers')
    expect(providers.className).toContain('scroll-mt-20')
    expect(providers.className).not.toContain('scroll-mt-6')
    expect(form()?.firstElementChild).toBe(providers)
  })

  it('keeps a saved disconnected runner selected while disabling its runner and model controls', async () => {
    serve({
      config: { defaultRunner: 'codex', defaultModels: { codex: 'gpt-5-codex' } },
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'disconnected', enabled: true },
          { provider: 'opencode', status: 'connected', enabled: true },
        ],
      },
    })
    renderAt('/settings/agents')

    const codex = await screen.findByRole('radio', { name: 'codex' })
    expect(codex.getAttribute('aria-checked')).toBe('true')
    expect((codex as HTMLButtonElement).disabled).toBe(true)
    const model = screen.getByLabelText<HTMLSelectElement>('Default model for codex')
    expect(model.value).toBe('gpt-5-codex')
    expect(model.disabled).toBe(true)

    expect((screen.getByRole('radio', { name: 'claude' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for claude').disabled).toBe(false)
  })

  it('keeps a saved disabled runner selected and explains how to recover', async () => {
    serve({
      config: { defaultRunner: 'codex', defaultModels: { codex: 'gpt-5-codex' } },
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: false },
          { provider: 'opencode', status: 'connected', enabled: true },
        ],
      },
    })
    renderAt('/settings/agents')

    const codex = await screen.findByRole('radio', { name: 'codex' })
    expect(codex.getAttribute('aria-checked')).toBe('true')
    expect((codex as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for codex').disabled).toBe(true)
    expect(
      screen.getByText('This provider is disabled. Enable it above or choose another provider.'),
    ).toBeTruthy()
  })

  it('disables only provider-specific controls while provider status is pending', async () => {
    serve({ providerStatusPending: true })
    renderAt('/settings/agents')

    const claude = await screen.findByRole('radio', { name: 'claude' })
    expect((claude as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for claude').disabled).toBe(true)
    expect((screen.getByLabelText<HTMLTextAreaElement>('System prompt')).disabled).toBe(false)
    expect((screen.getByLabelText<HTMLButtonElement>('Live title updates')).disabled).toBe(false)
  })

  it('keeps unrelated settings usable when provider status errors', async () => {
    serve({ providerStatus: { error: 'probe failed' }, providerStatusCode: 500 })
    renderAt('/settings/agents')

    expect(await screen.findByText('Provider status could not be loaded')).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'claude' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for claude').disabled).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>('System prompt').disabled).toBe(false)
    expect(screen.getByLabelText<HTMLButtonElement>('Review changes before finishing').disabled).toBe(false)
  })

  it('keeps unrelated settings usable and provider controls disabled for malformed status data', async () => {
    const secret = 'unexpected-provider-payload'
    serve({
      providerStatus: { providers: [null, { provider: 'future', status: secret }] },
    })
    renderAt('/settings/agents')

    expect(await screen.findByText('Provider status could not be loaded')).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'claude' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for claude').disabled).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>('System prompt').disabled).toBe(false)
    expect(screen.queryByText(secret)).toBeNull()
  })

  it('disables provider controls when a failed refresh leaves connected data cached', async () => {
    serve({ providerStatusAfterFirstError: 'refresh probe failed' })
    const client = renderAt('/settings/agents')

    const claude = await screen.findByRole('radio', { name: 'claude' })
    expect((claude as HTMLButtonElement).disabled).toBe(false)
    await act(() => client.refetchQueries({ queryKey: workspaceQueryKeys.providerStatus }))

    expect(await screen.findByText('Provider status could not be loaded')).toBeTruthy()
    expect((claude as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>('System prompt').disabled).toBe(false)
  })

  it('renders every knob from GET /api/config', async () => {
    serve({
      config: {
        baseBranch: 'develop',
        defaultRunner: 'codex',
        systemPrompt: 'Be brief.',
        defaultModels: { claude: 'opus' },
      },
    })
    renderAt('/settings/agents')

    await waitFor(() => expect(form()).not.toBeNull())
    expect(screen.getByRole('radio', { name: 'codex' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'claude' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for claude').value).toBe('opus')
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for codex').value).toBe('')
    expect(screen.getByLabelText<HTMLTextAreaElement>('System prompt').value).toBe('Be brief.')
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Base branch').value).toBe('develop'),
    )
  })


  it('live title updates: the switch defaults ON and PUTs the toggle', async () => {
    serve()
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    const toggle = screen.getByLabelText('Live title updates')
    expect(toggle.getAttribute('aria-checked') ?? toggle.getAttribute('data-state')).toBeTruthy()
    fireEvent.click(toggle)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ liveTitleUpdates: false })
    await waitFor(() => expect(screen.getByText('Off')).toBeTruthy())
  })

  it('review gate: the switch defaults OFF and PUTs the toggle (#489)', async () => {
    serve()
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    const toggle = screen.getByLabelText('Review changes before finishing')
    // Default off — the mirror image of live-title-updates.
    expect(toggle.getAttribute('aria-checked') ?? toggle.getAttribute('data-state')).toMatch(/false|unchecked/)
    fireEvent.click(toggle)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ reviewGate: true })
  })

  it('default runner round-trips: click PUTs the patch and the control follows the answer', async () => {
    serve()
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    fireEvent.click(screen.getByRole('radio', { name: 'codex' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ defaultRunner: 'codex' })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'codex' }).getAttribute('aria-checked')).toBe('true'),
    )
  })

  it('model presets round-trip per runner — auto sends null to clear the key', async () => {
    serve({ config: { defaultModels: { codex: 'gpt-5-codex' } } })
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    const claude = screen.getByLabelText<HTMLSelectElement>('Default model for claude')
    fireEvent.change(claude, { target: { value: 'opus' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ defaultModels: { claude: 'opus' } })
    // The readback is the server's merged truth: codex's preset survived claude's write.
    await waitFor(() => expect(claude.value).toBe('opus'))
    expect(screen.getByLabelText<HTMLSelectElement>('Default model for codex').value).toBe('gpt-5-codex')

    fireEvent.change(claude, { target: { value: '' } })
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ defaultModels: { claude: null } })
    await waitFor(() => expect(claude.value).toBe(''))
  })

  it('system prompt saves trimmed on the explicit button, and an emptied box clears with null', async () => {
    serve({ config: { systemPrompt: 'Be brief.' } })
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    const box = screen.getByLabelText<HTMLTextAreaElement>('System prompt')
    const saveButton = () => document.querySelector<HTMLButtonElement>('[data-action="agents-save-prompt"]')!
    // Unchanged draft: nothing to save.
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(box, { target: { value: '  Answer in Polish.  ' } })
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(saveButton())
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ systemPrompt: 'Answer in Polish.' })
    // Saved: the button falls back to disabled once the answer lands.
    await waitFor(() => expect(saveButton().disabled).toBe(true))

    fireEvent.change(box, { target: { value: '' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ systemPrompt: null })
  })

  it('an over-limit prompt disables Save with the reason — no request leaves', async () => {
    serve()
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'x'.repeat(20_001) } })
    const save = document.querySelector<HTMLButtonElement>('[data-action="agents-save-prompt"]')!
    expect(save.disabled).toBe(true)
    expect(document.querySelector('[data-slot="agents-prompt-limit"]')?.textContent).toContain('20,000')
    fireEvent.click(save)
    expect(puts()).toHaveLength(0)
  })

  it('base branch round-trips through the same PUT — "" means follow the checked-out branch', async () => {
    serve({ config: { baseBranch: 'develop' } })
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())
    const picker = await waitFor(() => screen.getByLabelText<HTMLSelectElement>('Base branch'))
    expect(picker.value).toBe('develop')

    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ baseBranch: null })
  })

  it('a PUT refusal surfaces the server\'s own words (409 → danger toast)', async () => {
    serve({ putStatus: 409, putError: 'config.json is locked by another cockpit' })
    renderAt('/settings/agents')
    await waitFor(() => expect(form()).not.toBeNull())

    fireEvent.click(screen.getByRole('radio', { name: 'opencode' }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'config.json is locked by another cockpit',
      ),
    )
    // The control did not lie: the runner stayed where the server left it.
    expect(screen.getByRole('radio', { name: 'claude' }).getAttribute('aria-checked')).toBe('true')
  })
})
