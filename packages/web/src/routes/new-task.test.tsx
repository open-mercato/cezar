import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type {
  AgentProfilesResponse,
  ConfigResponse,
  HealthResponse,
  ProviderStatusResponse,
  RepoResponse,
  Skill,
  WorkspaceConfigResponse,
  WorkflowsResponse,
} from '@open-mercato/cezar-api-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'

import { readDraft, resetDraft, writeDraft } from './new-task-draft'
import { NewTaskRoute } from './new-task'

/**
 * The /new screen against a mocked API: picker data flows (runner hidden on single-backend
 * hosts, model presets switching per runner, variants gated on git), the EXACT submit bodies
 * (workflow vs skill vs variants — the wire contract with POST /api/v1/runs), lastTask
 * persistence, draft survival across unmounts, ?skill/?ref prefill, and the suggested chips.
 */

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  resetDraft()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  defaultRunner: 'claude',
  checks: [
    { name: 'claude', available: true, version: '2.0.44' },
    { name: 'git', available: true, version: '2.43.0' },
  ],
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false },
}

const HEALTH_MULTI: HealthResponse = {
  ...HEALTH,
  checks: [
    { name: 'claude', available: true },
    { name: 'codex', available: true },
    { name: 'git', available: true },
  ],
}

const HEALTH_ALL: HealthResponse = {
  ...HEALTH,
  checks: [
    { name: 'claude', available: true },
    { name: 'codex', available: true },
    { name: 'opencode', available: true },
    { name: 'git', available: true },
  ],
}

const HEALTH_NO_GIT: HealthResponse = {
  ...HEALTH,
  repo: null,
  checks: [{ name: 'claude', available: true }],
}

const PROVIDERS_CONNECTED: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

const PROVIDERS_MULTI: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
}

const PROVIDERS_NONE: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
  ],
}

const SKILLS: Skill[] = [
  { name: 'om-fix', description: 'Fix an issue end to end', body: '', path: '/p/om-fix.md', source: 'ai' },
  { name: 'deploy', description: 'Deploy from anywhere', body: '', path: '/g/deploy.md', source: 'global' },
]

const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    { name: 'quick-task', description: 'Single step, no gates', source: 'built-in', steps: [] },
    { name: 'fix-and-verify', source: 'built-in', steps: [] },
  ],
  issues: [],
}

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main' },
  status: [],
  log: [],
  branches: ['main', 'develop'],
  baseBranch: null,
}

const REPO_NO_GIT: RepoResponse = { info: null, status: [], log: [], branches: [], baseBranch: null }

const CONFIG: ConfigResponse = {
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
  defaultModels: {},
  modelsLocked: false,
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
}

const WORKSPACE_CONFIG: WorkspaceConfigResponse = {
  agentDefaults: {},
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
    memoryLimitMb: null,
    worktreeRetentionDefault: 10,
  },
}

/** The shape `POST /api/v1/plan` answers (spec 008) — three steps so reorder/remove are provable. */
const PLAN = {
  steps: [
    { id: 'implement', name: 'Implement', prompt: '{{task}}' },
    { id: 'verify', name: 'Verify', command: 'npm test' },
    { id: 'review', name: 'Review', skill: 'om-fix', prompt: 'Review the changes for {{task}}' },
  ],
  rationale: 'Implement, verify with tests, then review.',
  fallback: false,
}

const FALLBACK_PLAN = {
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  rationale: 'planner unavailable — single-step plan',
  fallback: true,
}

// ---- harness ---------------------------------------------------------------------------------

type Recorded = { method: string; url: string; body?: unknown }
let requests: Recorded[]

function deferredJson<T>() {
  let resolve!: (response: Response) => void
  return {
    fetch: () => new Promise<Response>((done) => { resolve = done }),
    release: (payload: T) =>
      resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  }
}

function serve(overrides: {
  health?: HealthResponse | (() => Promise<Response>)
  /** Active project's scoped config; health may describe a different boot project. */
  config?: Partial<ConfigResponse> | (() => Promise<Response>)
  workspaceConfig?: WorkspaceConfigResponse
  /** Host authentication state, or a delayed answer for pending/refresh tests. */
  providerStatus?: ProviderStatusResponse | (() => Promise<Response>)
  providerStatusStatus?: number
  skills?: Skill[]
  workflows?: WorkflowsResponse
  repo?: RepoResponse
  uiState?: Record<string, unknown>
  /** Non-2xx `GET /api/v1/ui-state` answers (the query-errored path: `data` stays undefined). */
  uiStateStatus?: number
  createRun?: unknown
  /** Non-2xx `POST /api/v1/runs` answers (the auto-start failure path). */
  createRunStatus?: number
  /** What `GET /api/v1/launch-key` answers — the bookmarklet auto-start secret. */
  launchKey?: string
  /** `POST /api/v1/plan` — a payload, or a handler for delayed/failing answers. */
  plan?: unknown | (() => Promise<Response>)
  /** `POST /api/v1/workflows` — answers in call order (409-then-201 for the overwrite flow). */
  saveWorkflow?: Array<{ status: number; body: unknown }>
  /** Agent accounts (spec 2026-07-29-agent-profiles). Omitted answers a 404, which is how every
   *  pre-existing test here keeps a composer with no account pill at all. */
  agentProfiles?: AgentProfilesResponse
} = {}) {
  const data = {
    health: HEALTH,
    config: CONFIG,
    workspaceConfig: WORKSPACE_CONFIG,
    providerStatus: PROVIDERS_CONNECTED,
    providerStatusStatus: 200,
    skills: SKILLS,
    workflows: WORKFLOWS,
    repo: REPO,
    uiState: {},
    uiStateStatus: 200,
    createRun: { id: 'r1' },
    createRunStatus: 201,
    launchKey: 'k-real',
    plan: PLAN,
    saveWorkflow: [{ status: 201, body: { path: '.ai/cezar/workflows/my-chain.yaml', name: 'my chain' } }],
    ...overrides,
  }
  requests = []
  let saves = 0
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/health') {
        return typeof data.health === 'function' ? data.health() : json(data.health)
      }
      if (url === '/api/v1/providers/status') {
        return typeof data.providerStatus === 'function'
          ? data.providerStatus()
          : json(data.providerStatus, data.providerStatusStatus)
      }
      if (url === '/api/v1/models?runner=codex') return json({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (url === '/api/v1/skills') return json(data.skills)
      if (url === '/api/v1/workflows' && method === 'GET') return json(data.workflows)
      if (url === '/api/v1/workflows' && method === 'POST') {
        const answer = data.saveWorkflow[Math.min(saves, data.saveWorkflow.length - 1)]!
        saves += 1
        return json(answer.body, answer.status)
      }
      if (url === '/api/v1/plan' && method === 'POST') {
        return typeof data.plan === 'function' ? (data.plan as () => Promise<Response>)() : json(data.plan)
      }
      if (url === '/api/v1/repo') return json(data.repo)
      if (url === '/api/v1/launch-key') return json({ key: data.launchKey })
      if (url === '/api/v1/ui-state' && method === 'GET') return json(data.uiState, data.uiStateStatus)
      if (url === '/api/v1/ui-state' && method === 'PUT') return json(body ?? {})
      if (url === '/api/v1/runs' && method === 'POST') return json(data.createRun, data.createRunStatus)
      if (url === '/api/v1/config' && method === 'GET')
        return typeof data.config === 'function'
          ? data.config()
          : json({ ...CONFIG, ...data.config })
      if (url === '/api/v1/config' && method === 'PUT')
        return json({ baseBranch: (body as { baseBranch: string | null }).baseBranch, defaultRunner: 'claude' })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(data.workspaceConfig)
      if (url === '/api/v1/workspace/agent-profiles' && method === 'GET' && data.agentProfiles) {
        return json(data.agentProfiles)
      }
      return json({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function renderNewTask(entry = '/new') {
  const client = createQueryClient()
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/new" element={<NewTaskRoute />} />
          <Route path="/p/:projectId/new" element={<NewTaskRoute />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
        <LocationProbe />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...rendered, client }
}

const textarea = () => screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement
const sourcePill = () => screen.getByRole('button', { name: 'Choose a skill or workflow' })
const location = () => screen.getByTestId('location').textContent

/** The pickers resolve once workflows+skills+ui-state answered — wait for the real label. */
async function pillReady(label = 'quick-task') {
  await waitFor(() => {
    expect(sourcePill().textContent).toContain(label)
    expect(textarea().disabled).toBe(false)
  })
}

const startTask = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/runs')).toBe(true))
}

const postedBody = () => requests.find((r) => r.method === 'POST' && r.url === '/api/v1/runs')?.body

// ---- the hero surface -------------------------------------------------------------------------

describe('the hero surface', () => {
  it('renders the mockup hero: title, subtitle, twinkles, and focus lands in the textarea', async () => {
    serve()
    renderNewTask()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What should the agent work on?')
    expect(screen.getByText('Runs in an isolated worktree — review everything before it lands.')).toBeTruthy()
    expect(document.querySelector('[data-route="new"] [data-slot="twinkle-backdrop"]')).not.toBeNull()
    await pillReady()
    // ⌘N drops you here to type — after the provider check enables the composer, the caret
    // must land in the box without the user clicking it.
    await waitFor(() => expect(document.activeElement).toBe(textarea()))
  })

  it('suggested chips fill the textarea (and only fill — no fetch, no navigation)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const chips = document.querySelectorAll('[data-slot="suggested-chip"]')
    expect(chips.length).toBe(3)
    fireEvent.click(chips[0] as HTMLElement)
    expect(textarea().value).toContain('failing or flaky test')
    expect(requests.some((r) => r.method === 'POST')).toBe(false)
    expect(location()).toBe('/new')
  })
})

// ---- picker data flows ------------------------------------------------------------------------

describe('picker data flows', () => {
  it('hides the runner pill on a single-backend host (legacy rule)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull()
  })

  it('shows the runner pill with >1 backend, and switching runner swaps the model presets', async () => {
    serve({ health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()

    const runnerPill = () => document.querySelector('[data-slot="runner-pill"]') as HTMLElement
    await waitFor(() => expect(runnerPill()).not.toBeNull())
    expect(runnerPill().textContent).toContain('claude')

    // claude's presets first…
    fireEvent.pointerDown(document.querySelector('[data-slot="model-pill"]') as HTMLElement)
    let options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('opus'), expect.stringContaining('sonnet')]),
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0))

    // …pick codex…
    fireEvent.pointerDown(runnerPill())
    options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('codex')) as HTMLElement)
    await waitFor(() => expect(runnerPill().textContent).toContain('codex'))
    // …the model reset to auto and the presets are codex's now.
    expect((document.querySelector('[data-slot="model-pill"]') as HTMLElement).textContent).toContain('auto')
    fireEvent.pointerDown(document.querySelector('[data-slot="model-pill"]') as HTMLElement)
    options = await screen.findAllByRole('menuitemradio')
    const labels = options.map((o) => o.textContent ?? '')
    expect(labels.some((l) => l.includes('gpt-future'))).toBe(true)
    expect(labels.some((l) => l.includes('opus'))).toBe(false)
  })

  it('excludes disconnected providers from the runner choices even when health detects them', async () => {
    serve({ health: HEALTH_ALL, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()

    const runnerPill = document.querySelector('[data-slot="runner-pill"]') as HTMLElement
    fireEvent.pointerDown(runnerPill)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('claude'),
      expect.stringContaining('codex'),
    ])
    expect(options.some((option) => option.textContent?.includes('opencode'))).toBe(false)
  })

  it('excludes connected but disabled providers while retaining an enabled runner choice', async () => {
    serve({
      health: HEALTH_ALL,
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'connected', enabled: false },
        ],
      },
    })
    renderNewTask()
    await pillReady()

    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    expect(textarea().disabled).toBe(false)
  })

  it('drops a persisted model preset that belongs to another runner', async () => {
    writeDraft({
      text: '', source: null, runner: 'codex', agentProfile: null, model: 'claude-opus-4-8', variants: 1,
      planFirst: false, worktree: null, autonomous: null, generateFollowups: null,
    })
    serve({ health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()

    const modelPill = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    await waitFor(() => expect(modelPill.textContent).toContain('auto'))
    fireEvent.pointerDown(modelPill)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.some((option) => option.textContent?.includes('claude-opus-4-8'))).toBe(false)
  })

  it('gates variants on git: no repo → pill disabled with the honest reason, base pill gone', async () => {
    serve({ health: HEALTH_NO_GIT, repo: REPO_NO_GIT })
    renderNewTask()
    await pillReady()
    const pill = document.querySelector('[data-slot="variants-pill"]') as HTMLButtonElement
    expect(pill.disabled).toBe(true)
    expect(pill.title).toContain('need a git repository')
    expect(document.querySelector('[data-slot="base-pill"]')).toBeNull()
  })

  it('base branch pill shows config default (falling back to the checkout) and PUTs /api/v1/config', async () => {
    serve({ repo: { ...REPO, baseBranch: 'develop' } })
    renderNewTask()
    await pillReady()
    const basePill = () => document.querySelector('[data-slot="base-pill"]') as HTMLElement
    await waitFor(() => expect(basePill()).not.toBeNull())
    expect(basePill().textContent).toContain('base: develop')

    fireEvent.pointerDown(basePill())
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('follow checked-out branch (main)'),
      expect.stringContaining('main'),
      expect.stringContaining('develop'),
    ])
    fireEvent.click(options[0] as HTMLElement)
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/config')).toBe(true),
    )
    // find the PUT specifically — the composer also GETs /api/v1/config for the model presets.
    expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/config')?.body).toEqual({
      baseBranch: null,
    })
  })

  it('preselects the persisted lastTask when it still exists', async () => {
    serve({ uiState: { lastTask: { source: 'workflow', ref: 'fix-and-verify' } } })
    renderNewTask()
    await pillReady('fix-and-verify')
  })

  it('falls back to quick-task when lastTask names something gone', async () => {
    serve({ uiState: { lastTask: { source: 'skill', ref: 'deleted-skill' } } })
    renderNewTask()
    await pillReady('quick-task')
  })

  it('the source menu groups: Project skills (bold), Workflows, Global last', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')

    const options = [...document.querySelectorAll('[data-slot="source-option"]')]
    expect(options.map((o) => o.getAttribute('data-source-ref'))).toEqual([
      'om-fix', 'quick-task', 'fix-and-verify', 'deploy',
    ])
    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(headings).toEqual(['Project skills', 'Workflows', 'Global'])
  })

  it('multi-keyword search: "fix issue" matches om-fix via hyphen-split keywords (#411)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')

    // "fix issue" should match "om-fix" because both "fix" and "issue" appear in the
    // combined value+keywords text (name splits: "om","fix" + description "Fix an issue end to end").
    fireEvent.change(input, { target: { value: 'fix issue' } })
    await waitFor(() => {
      const visible = [...document.querySelectorAll('[data-slot="source-option"]')]
      expect(visible.some((o) => o.getAttribute('data-source-ref') === 'om-fix')).toBe(true)
    })
  })

  it('multi-keyword search hides items that do not match all words (#411)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.click(sourcePill())
    const input = await screen.findByPlaceholderText('search skills & workflows…')

    fireEvent.change(input, { target: { value: 'deploy fix' } })
    await waitFor(() => {
      // "deploy" does not have "fix" in its name/description, and "om-fix" does not have "deploy"
      const visible = [...document.querySelectorAll('[data-slot="source-option"]')]
      expect(visible).toHaveLength(0)
    })
  })
})

// ---- provider authentication gate -------------------------------------------------------------

describe('provider authentication gate', () => {
  it('keeps a pending status honest without claiming that providers are missing', async () => {
    let release!: (response: Response) => void
    serve({
      providerStatus: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    renderNewTask()

    await waitFor(() => expect(sourcePill().textContent).toContain('quick-task'))
    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toBe('Checking agent providers…')
    expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
    expect(document.body.textContent).not.toContain('Connect an agent provider')

    release(
      new Response(JSON.stringify(PROVIDERS_CONNECTED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })

  it('disables Start and Plan and links to project-aware provider settings when none connect', async () => {
    serve({ providerStatus: PROVIDERS_NONE })
    renderNewTask('/p/acme/new')

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Plan first' }))
    expect((screen.getByRole('button', { name: 'Plan task' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/p/acme/settings/agents#providers',
    )
  })

  it('disables submission with verification-failed copy and setup guidance on a status error', async () => {
    serve({ providerStatus: { providers: [] }, providerStatusStatus: 404 })
    renderNewTask()

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Provider authentication could not be verified.'),
    )
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
  })

  it('one connected provider suppresses the runner pill but leaves submission enabled', async () => {
    serve({
      health: { ...HEALTH_MULTI, defaultRunner: 'codex' },
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()

    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Use the only connected provider' } })
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('can safely omit the runner while boot health is pending because project config is authoritative', async () => {
    const delayedHealth = deferredJson<HealthResponse>()
    serve({ health: delayedHealth.fetch })
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'Start before health resolves' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
    delayedHealth.release(HEALTH)
  })

  it('posts an explicit connected fallback when the configured default is disconnected', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Fall back safely' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).runner).toBe('codex')
  })

  it('stays enabled when one provider is connected and another status is unknown', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'unknown', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Known-good provider wins' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).runner).toBe('codex')
  })

  it('a status refresh enables an already-open form without a reload', async () => {
    let current = PROVIDERS_NONE
    serve({
      providerStatus: () =>
        Promise.resolve(
          new Response(JSON.stringify(current), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    })
    const { client } = renderNewTask()
    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )

    current = PROVIDERS_CONNECTED
    await client.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
    await waitFor(() => expect(textarea().disabled).toBe(false))
  })
})

// ---- submit bodies (the wire contract) ---------------------------------------------------------

describe('submit', () => {
  it('a SKILL source posts the one-step inline chain and persists lastTask, then navigates', async () => {
    serve({
      createRun: { id: 'run-9' },
      uiState: { lastTask: { source: 'skill', ref: 'om-fix' } },
    })
    renderNewTask()
    await pillReady('om-fix')
    fireEvent.change(textarea(), { target: { value: 'Fix the flaky worktree test' } })
    await startTask()

    expect(postedBody()).toEqual({
      task: 'Fix the flaky worktree test',
      steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
      // Skills default to autonomous (#autonomous).
      autonomous: true,
    })
    await waitFor(() => expect(location()).toBe('/tasks/run-9'))
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body).toEqual({
        lastTask: { source: 'skill', ref: 'om-fix' },
        // The run also lands at the head of the recency list (picker sort)...
        recentSources: [{ source: 'skill', ref: 'om-fix' }],
        lastGenerateFollowups: true,
        // ...and bumps its usage count for the #408 frequency sort (a workflow source would
        // NOT carry a skillUsage key at all — see the WORKFLOW test below).
        skillUsage: { 'om-fix': 1 },
      }),
    )
  })

  it('a SKILL run with ui-state unavailable omits skillUsage rather than wiping the map', async () => {
    // `sourcesReady` only rules out `isPending`, so an ERRORED ui-state query still lets the
    // form submit with `uiState.data === undefined`. The PUT merge is shallow, so bumping off
    // that would send a one-entry map and replace every stored count.
    // 404, not a 5xx: the query client never retries a 4xx (query-client.ts), so the query
    // lands in its errored state immediately and the test stays deterministic.
    writeDraft({
      text: '', source: { source: 'skill', ref: 'om-fix' }, runner: null, agentProfile: null, model: null,
      variants: 1, planFirst: false, worktree: null, autonomous: null, generateFollowups: null,
    })
    serve({ createRun: { id: 'run-9' }, uiStateStatus: 404 })
    renderNewTask()
    await pillReady('om-fix')
    fireEvent.change(textarea(), { target: { value: 'Fix the flaky worktree test' } })
    await startTask()

    await waitFor(() => expect(location()).toBe('/tasks/run-9'))
    const put = requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')
    // The other prefs still persist — only the unknowable map is left alone.
    expect(put?.body).not.toHaveProperty('skillUsage')
  })

  it('a WORKFLOW source posts { workflow, task }', async () => {
    serve({ uiState: { lastTask: { source: 'workflow', ref: 'quick-task' } } })
    renderNewTask()
    await pillReady('quick-task')
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()

    expect(postedBody()).toEqual({ task: 'Ship it', workflow: 'quick-task' })
  })

  it('posts worktree:false after opt-out for every single-step source shape', async () => {
    const cases: Array<{
      label: string
      overrides: NonNullable<Parameters<typeof serve>[0]>
      expected: Record<string, unknown>
    }> = [
      {
        label: 'quick-task',
        overrides: {},
        expected: { workflow: 'quick-task' },
      },
      {
        label: 'om-fix',
        overrides: { uiState: { lastTask: { source: 'skill', ref: 'om-fix' } } },
        expected: { steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }] },
      },
      {
        label: 'one-step',
        overrides: {
          workflows: {
            workflows: [
              ...WORKFLOWS.workflows,
              { name: 'one-step', source: 'file', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] },
            ],
            issues: [],
          },
          uiState: { lastTask: { source: 'workflow', ref: 'one-step' } },
        },
        expected: { workflow: 'one-step' },
      },
    ]

    for (const testCase of cases) {
      cleanup()
      resetDraft()
      serve(testCase.overrides)
      renderNewTask()
      await pillReady(testCase.label)
      const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
      fireEvent.click(worktree)
      expect(worktree.getAttribute('aria-checked')).toBe('false')
      fireEvent.change(textarea(), { target: { value: `Run ${testCase.label} in place` } })
      await startTask()
      expect(postedBody()).toMatchObject({ ...testCase.expected, worktree: false })
    }
  })

  it('carries an inherited Worktree-off policy into the submitted payload', async () => {
    serve({
      workspaceConfig: {
        ...WORKSPACE_CONFIG,
        composerDefaults: {
          ...WORKSPACE_CONFIG.composerDefaults!,
          inheritedWorktree: false,
        },
      },
    })
    renderNewTask()
    await pillReady()
    const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
    expect(worktree.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(textarea(), { target: { value: 'Use the environment seed' } })
    await startTask()
    expect(postedBody()).toMatchObject({ workflow: 'quick-task', worktree: false })
  })

  it('picking a model and ×2 variants rides along; {runs} answer navigates to the FIRST variant', async () => {
    serve({ createRun: { runs: [{ id: 'v-a' }, { id: 'v-b' }] } })
    renderNewTask()
    await pillReady()

    fireEvent.pointerDown(document.querySelector('[data-slot="model-pill"]') as HTMLElement)
    let options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('sonnet')) as HTMLElement)
    await waitFor(() => expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0))

    fireEvent.pointerDown(document.querySelector('[data-slot="variants-pill"]') as HTMLElement)
    options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('×2')) as HTMLElement)
    await waitFor(() =>
      expect((document.querySelector('[data-slot="variants-pill"]') as HTMLElement).textContent).toContain('×2'),
    )

    fireEvent.change(textarea(), { target: { value: 'Race two attempts' } })
    await startTask()

    expect(postedBody()).toEqual({
      task: 'Race two attempts',
      workflow: 'quick-task',
      model: 'sonnet',
      variants: 2,
    })
    await waitFor(() => expect(location()).toBe('/tasks/v-a'))
  })

  it('shows a locked native default but omits it from the direct run request', async () => {
    writeDraft({ ...readDraft(), model: 'opus' })
    serve({
      providerStatus: PROVIDERS_MULTI,
      config: {
        defaultModels: { claude: 'native-sonnet', codex: 'gpt-5.6-codex' },
        modelsLocked: true,
      },
    })
    renderNewTask()
    await pillReady()

    const modelPill = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    expect(modelPill.textContent).toContain('native-sonnet')
    expect(modelPill.textContent).not.toContain('opus')
    expect(modelPill.tagName).toBe('SPAN')
    expect(modelPill.querySelector('svg')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
    const runnerOptions = await screen.findAllByRole('menuitemradio')
    fireEvent.click(runnerOptions.find((option) => option.textContent?.includes('Codex')) as HTMLElement)
    await waitFor(() => expect(modelPill.textContent).toContain('gpt-5.6-codex'))

    fireEvent.change(textarea(), { target: { value: 'Use native settings' } })
    await startTask()
    expect(postedBody()).toEqual({
      task: 'Use native settings',
      workflow: 'quick-task',
      runner: 'codex',
    })
  })

  it('single-backend hosts omit `runner` when it matches the server default', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'no runner key' } })
    await startTask()
    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
  })

  it('uses the active project default rather than the boot project health default', async () => {
    serve({ health: { ...HEALTH, defaultRunner: 'codex' }, config: { defaultRunner: 'claude' } })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'follow the project default' } })
    await startTask()
    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
  })

  it('sends an explicit runner pick when boot health claims that runner is the default', async () => {
    serve({
      health: { ...HEALTH_MULTI, defaultRunner: 'codex' },
      config: { defaultRunner: 'claude' },
      providerStatus: PROVIDERS_MULTI,
    })
    renderNewTask()
    await pillReady()
    fireEvent.pointerDown(document.querySelector('[data-slot="runner-pill"]') as HTMLElement)
    const options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((option) => option.textContent?.includes('codex')) as HTMLElement)
    fireEvent.change(textarea(), { target: { value: 'pin codex' } })
    await startTask()
    expect(postedBody()).toMatchObject({ runner: 'codex' })
  })

  it('defaults follow-up generation on, but posts and remembers an explicit opt-out', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const toggle = document.querySelector(
      '[data-slot="generate-followups-toggle"]',
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(textarea(), { target: { value: 'No follow-up inbox items' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).generateFollowups).toBe(false)
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body).toMatchObject({
        lastGenerateFollowups: false,
      }),
    )
  })

  it('uses the remembered follow-up preference when the draft has no choice', async () => {
    serve({ uiState: { lastGenerateFollowups: false } })
    renderNewTask()
    await pillReady()
    expect(
      document
        .querySelector('[data-slot="generate-followups-toggle"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false')
  })

  it('applies an interactive skill hint to untouched controls while keeping both overridable', async () => {
    // The cold default is now quick-task, so an interactive skill only drives the recommendation
    // once it is the selected source — here via the persisted lastTask.
    serve({
      skills: [{ ...SKILLS[0]!, interactive: true }, SKILLS[1]!],
      uiState: { lastTask: { source: 'skill', ref: 'om-fix' } },
    })
    renderNewTask()
    await pillReady('om-fix')

    const autonomous = document.querySelector(
      '[data-slot="autonomous-toggle"]',
    ) as HTMLButtonElement
    const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
    expect(autonomous.getAttribute('aria-checked')).toBe('false')
    expect(worktree.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/recommends an interactive run in the current checkout/i)).toBeTruthy()

    fireEvent.click(autonomous)
    fireEvent.click(worktree)
    expect(autonomous.getAttribute('aria-checked')).toBe('true')
    expect(worktree.getAttribute('aria-checked')).toBe('true')
  })

  it('lets a multi-step workflow opt out and submits worktree:false', async () => {
    serve({
      workflows: {
        workflows: [
          WORKFLOWS.workflows[0]!,
          {
            name: 'fix-and-verify',
            source: 'file',
            steps: [
              { id: 'fix', name: 'Fix', prompt: '{{task}}' },
              { id: 'verify', name: 'Verify', command: 'npm test' },
            ],
          },
        ],
        issues: [],
      },
      uiState: { lastTask: { source: 'workflow', ref: 'fix-and-verify' } },
    })
    renderNewTask()
    await pillReady('fix-and-verify')

    const worktree = document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
    expect(worktree.disabled).toBe(false)
    fireEvent.click(worktree)
    expect(worktree.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(textarea(), { target: { value: 'Run the whole workflow in place' } })
    await startTask()
    expect(postedBody()).toMatchObject({ workflow: 'fix-and-verify', worktree: false })
  })

  // #471 — the composer must not offer a switch the server overrides anyway.
  const inboxOffHealth: HealthResponse = {
    ...HEALTH,
    capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false },
  }
  const followupsToggle = () =>
    document.querySelector('[data-slot="generate-followups-toggle"]')

  it('hides the follow-up toggle when the server has the inbox off', async () => {
    serve({ health: inboxOffHealth })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(followupsToggle()).toBeNull())
    // The neighbouring toggles are untouched — the gate owns exactly one control.
    expect(document.querySelector('[data-slot="autonomous-toggle"]')).not.toBeNull()
  })

  it('posts generateFollowups:false from an inbox-less server', async () => {
    serve({ health: inboxOffHealth })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(followupsToggle()).toBeNull())

    fireEvent.change(textarea(), { target: { value: 'No inbox on this server' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).generateFollowups).toBe(false)
  })

  it('does not overwrite the remembered preference it never offered', async () => {
    // The user last chose "on". With the inbox off there is no toggle, so persisting the
    // forced `false` would silently flip their choice for when CEZ_FOLLOWUPS comes back.
    serve({ health: inboxOffHealth, uiState: { lastGenerateFollowups: true } })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(followupsToggle()).toBeNull())

    fireEvent.change(textarea(), { target: { value: 'Leave my preference alone' } })
    await startTask()

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')).toBe(true),
    )
    const persisted = requests
      .filter((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')
      .map((r) => r.body as Record<string, unknown>)
    for (const body of persisted) expect(body).not.toHaveProperty('lastGenerateFollowups')
  })

})

// ---- drafts & prefill ---------------------------------------------------------------------------

describe('drafts and prefill', () => {
  it('text and picker choices survive an unmount/remount (navigation away and back)', async () => {
    serve()
    const first = renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'half-written thought' } })
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.click(document.querySelector('[data-source-ref="fix-and-verify"]') as HTMLElement)
    await pillReady('fix-and-verify')
    first.unmount()

    renderNewTask()
    await pillReady('fix-and-verify')
    expect(textarea().value).toBe('half-written thought')
  })

  it('?skill=&ref= prefill: ref becomes the text, the skill is selected — beating the draft', async () => {
    serve()
    const first = renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'stale draft' } })
    first.unmount()

    renderNewTask('/new?skill=deploy&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fissues%2F5&auto=1&key=whatever')
    // auto=1 with the WRONG key resolves to the blocked/prefill path — never a run.
    await pillReady('deploy')
    expect(textarea().value).toBe('https://github.com/o/r/issues/5')
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/runs')).toBe(false)
  })

  // #374: the composer is the middle of the inbox round trip — the Run link carries `todo=`,
  // and the started run must carry it back so the entry is marked started and leaves the inbox.
  it('?todo= prefill: the entry id rides along to POST /api/v1/runs so the inbox entry is marked', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=ship%20it&todo=t1')
    await pillReady('deploy')
    await startTask()

    expect((postedBody() as Record<string, unknown>).todoId).toBe('t1')
  })

  it('a plain launch (no ?todo=) sends no todoId — the inbox is left alone', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'unrelated task' } })
    await startTask()

    expect((postedBody() as Record<string, unknown>).todoId).toBeUndefined()
  })

  // The two are orthogonal concerns (#374 vs #444): turning follow-up generation OFF for the
  // NEW task must never stop the entry it was launched FROM being marked started.
  it('carries todoId even when follow-up generation is switched off', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=ship%20it&todo=t1')
    await pillReady('deploy')
    fireEvent.click(
      document.querySelector('[data-slot="generate-followups-toggle"]') as HTMLElement,
    )
    await startTask()

    const body = postedBody() as Record<string, unknown>
    expect(body.todoId).toBe('t1')
    expect(body.generateFollowups).toBe(false)
  })

  it('submit spends the draft text', async () => {
    serve()
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'send me' } })
    await startTask()
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())

    renderNewTask()
    expect(textarea().value).toBe('')
  })
})

// ---- bookmarklet auto-start (spec 011, Step 1.3 — legacy handleDeepLink parity) -----------------

describe('bookmarklet auto-start', () => {
  const runsPosted = () => requests.filter((r) => r.method === 'POST' && r.url === '/api/v1/runs')
  const keyFetched = () => requests.some((r) => r.method === 'GET' && r.url === '/api/v1/launch-key')

  it('waits for provider status before a valid signed bookmarklet starts', async () => {
    let release!: (response: Response) => void
    serve({
      providerStatus: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() =>
      expect(requests.some((request) => request.url === '/api/v1/providers/status')).toBe(true),
    )
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)

    release(
      new Response(JSON.stringify(PROVIDERS_CONNECTED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted()).toHaveLength(1)
  })

  it('waits for project config, then keeps an untouched project-default runner implicit', async () => {
    const delayedConfig = deferredJson<ConfigResponse>()
    const delayedProviders = deferredJson<ProviderStatusResponse>()
    serve({
      health: { ...HEALTH, defaultRunner: 'codex' },
      config: delayedConfig.fetch,
      providerStatus: delayedProviders.fetch,
    })
    const { client } = renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() => {
      expect(requests.some((request) => request.url === '/api/v1/config')).toBe(true)
      expect(requests.some((request) => request.url === '/api/v1/providers/status')).toBe(true)
    })
    await act(async () => {
      delayedProviders.release(PROVIDERS_CONNECTED)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('success'),
    )
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)

    delayedConfig.release(CONFIG)
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((request) => request.body)).toEqual([
      {
        task: 'hello',
        steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }],
      },
    ])
  })

  it('waits for project config and sends a connected fallback when that default is unavailable', async () => {
    const delayedConfig = deferredJson<ConfigResponse>()
    const delayedProviders = deferredJson<ProviderStatusResponse>()
    serve({ config: delayedConfig.fetch, providerStatus: delayedProviders.fetch })
    const { client } = renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() => {
      expect(requests.some((request) => request.url === '/api/v1/config')).toBe(true)
      expect(requests.some((request) => request.url === '/api/v1/providers/status')).toBe(true)
    })
    await act(async () => {
      delayedProviders.release(PROVIDERS_CONNECTED)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('success'),
    )
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)

    delayedConfig.release({ ...CONFIG, defaultRunner: 'codex' })
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((request) => request.body)).toEqual([
      {
        task: 'hello',
        steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }],
        runner: 'claude',
      },
    ])
  })

  it('valid key + auto=1 + skill/ref → starts unattended with the exact legacy body, then the thread', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())

    expect(keyFetched()).toBe(true)
    // The body pin: Step 1.1's skill-source shape, nothing else on the wire — no model, no
    // runner, no variants (legacy's bookmarklet start never sent them either).
    expect(runsPosted().map((r) => r.body)).toEqual([
      { task: 'hello', steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }] },
    ])
    expect(location()).toBe('/tasks/r1')
    // Unattended starts do not rewrite the sticky lastTask (legacy parity).
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')).toBe(false)
  })

  it('uses an explicit connected fallback when the saved server default is disconnected', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())

    expect(runsPosted().map((request) => request.body)).toEqual([
      {
        task: 'hello',
        steps: [{ id: 'task', name: 'deploy', skill: 'deploy', prompt: '{{task}}' }],
        runner: 'codex',
      },
    ])
  })

  it('keeps the prefilled composer disabled and does not POST when none are connected', async () => {
    serve({ providerStatus: PROVIDERS_NONE })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )
    expect(textarea().value).toBe('hello')
    expect(runsPosted()).toHaveLength(0)
    expect(screen.getByRole('link', { name: 'Configure providers' })).toBeTruthy()
  })

  it('ref only (no skill) + valid key → quick-task, exactly like legacy', async () => {
    serve()
    renderNewTask('/new?ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((r) => r.body)).toEqual([{ task: 'hello', workflow: 'quick-task' }])
  })

  it('the legacy `task` alias for ref still auto-starts', async () => {
    serve()
    renderNewTask('/new?task=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((r) => r.body)).toEqual([{ task: 'hello', workflow: 'quick-task' }])
  })

  it('an unknown skill with a valid key STILL starts (legacy never validated it client-side)', async () => {
    // The server notes `skill "…" not found — running with the plain prompt` and runs anyway
    // (src/workflows/run.ts); blocking here would break saved bookmarklets legacy honored.
    serve()
    renderNewTask('/new?skill=ghost&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(screen.queryByTestId('elsewhere')).not.toBeNull())
    expect(runsPosted().map((r) => r.body)).toEqual([
      { task: 'hello', steps: [{ id: 'task', name: 'ghost', skill: 'ghost', prompt: '{{task}}' }] },
    ])
  })

  it('wrong key + auto=1 → blocked: prefill, a toast, focus on Start, no run, key never rendered', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=wrong')
    await pillReady('deploy')
    await screen.findByText('Auto-start blocked (bad key) — review and press Start')

    expect(keyFetched()).toBe(true)
    expect(runsPosted()).toHaveLength(0)
    expect(textarea().value).toBe('hello')
    expect(document.body.textContent).not.toContain('k-real')
    // Legacy focused the Run button so a bare Enter submits the reviewed form.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start task' })),
    )
  })

  it('missing key + auto=1 → the same blocked path', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1')
    await pillReady('deploy')
    await screen.findByText('Auto-start blocked (bad key) — review and press Start')
    expect(runsPosted()).toHaveLength(0)
    expect(textarea().value).toBe('hello')
  })

  it('valid key WITHOUT auto=1 → prefill + toast, the key is not even fetched', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&key=k-real')
    await pillReady('deploy')
    await screen.findByText('Prefilled from link — review and press Start')
    expect(keyFetched()).toBe(false)
    expect(runsPosted()).toHaveLength(0)
    expect(textarea().value).toBe('hello')
    expect(document.body.textContent).not.toContain('k-real')
  })

  it('the generic launcher link (auto=0&key=&ref=, no skill) prefills — never starts', async () => {
    // Exactly what legacy `bookmarkletUrl('', false, key)` emits: auto=0 still carries the key.
    serve()
    renderNewTask('/new?auto=0&key=k-real&ref=hello')
    await pillReady()
    await screen.findByText('Prefilled from link — review and press Start')
    expect(textarea().value).toBe('hello')
    expect(runsPosted()).toHaveLength(0)
    expect(keyFetched()).toBe(false)
  })

  it('an unknown skill on the prefill path → honest toast + the legacy quick-task embedding', async () => {
    serve()
    renderNewTask('/new?skill=ghost&ref=hello')
    await screen.findByText('Unknown skill "ghost" — prefilled for quick-task; review and press Start')
    // Legacy initFromQuery verbatim: the intent goes into the text, quick-task resolves it.
    expect(textarea().value).toBe('Use the "ghost" skill on: hello')
    await pillReady('quick-task')
    expect(runsPosted()).toHaveLength(0)
  })

  it('a failed unattended POST falls back to the prefilled composer with the reason', async () => {
    serve({ createRun: { error: 'boom' }, createRunStatus: 500 })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await screen.findByText('Auto-start failed: boom — review and press Start')
    expect(runsPosted()).toHaveLength(1)
    expect(textarea().value).toBe('hello')
    expect(location()).toBe('/new')
  })

  it('cleans the sensitive params from the URL immediately (legacy history.replaceState)', async () => {
    serve()
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=wrong')
    await waitFor(() => expect(location()).toBe('/new'))
  })

  it('cleans the URL on plain prefill links too', async () => {
    serve()
    renderNewTask('/new?ref=hello')
    await waitFor(() => expect(location()).toBe('/new'))
  })
})

// ---- plan mode (#383 + spec 008) ----------------------------------------------------------------

const planToggle = () => screen.getByRole('radio', { name: /Plan first|Planning…/ })
const startToggle = () => screen.getByRole('radio', { name: 'Start' })
const stepIds = () =>
  [...document.querySelectorAll('[data-slot="plan-step"]')].map((el) =>
    el.getAttribute('data-step-id'),
  )

/** Toggle plan mode, type, submit — resolves once the review overlay is up. */
async function planTask(text = 'Tighten the flaky suite') {
  await pillReady()
  fireEvent.click(planToggle())
  fireEvent.change(textarea(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Plan task' }))
  await screen.findByText('Proposed chain')
}

describe('the Start | Plan first toggle', () => {
  it('flips the selected state (#383): aria-checked moves, the submit becomes "Plan task"', async () => {
    serve()
    renderNewTask()
    await pillReady()

    expect(startToggle().getAttribute('aria-checked')).toBe('true')
    expect(planToggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Start task' })).not.toBeNull()

    fireEvent.click(planToggle())
    expect(planToggle().getAttribute('aria-checked')).toBe('true')
    expect(startToggle().getAttribute('aria-checked')).toBe('false')
    // The selected plan segment takes the contrast fill — the unmistakable state.
    expect(planToggle().className).toContain('bg-contrast')
    expect(screen.queryByRole('button', { name: 'Plan task' })).not.toBeNull()

    fireEvent.click(startToggle())
    expect(planToggle().getAttribute('aria-checked')).toBe('false')
    expect(startToggle().getAttribute('aria-checked')).toBe('true')
  })

  it('disables the Autonomous toggle in plan mode (planning is interactive)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const autonomous = () =>
      document.querySelector('[data-slot="autonomous-toggle"]') as HTMLButtonElement

    // Off plan mode the toggle is interactive.
    expect(autonomous().disabled).toBe(false)
    fireEvent.click(planToggle())
    expect(autonomous().disabled).toBe(true)
    expect(autonomous().getAttribute('aria-checked')).toBe('false')
  })

  it('persists in the draft store across unmount/remount', async () => {
    serve()
    const first = renderNewTask()
    await pillReady()
    fireEvent.click(planToggle())
    first.unmount()

    renderNewTask()
    await pillReady()
    expect(planToggle().getAttribute('aria-checked')).toBe('true')
  })
})

describe('the plan flow', () => {
  it('submit in plan mode POSTs /api/v1/plan (never /api/v1/runs) and opens the review overlay', async () => {
    serve()
    renderNewTask()
    await planTask('Tighten the flaky suite')

    expect(requests.find((r) => r.url === '/api/v1/plan')?.body).toEqual({
      task: 'Tighten the flaky suite',
    })
    expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(false)

    // Task line, rationale, numbered cards with skill/check badges and hints.
    expect(document.querySelector('[data-slot="plan-task"]')?.textContent).toBe(
      'Tighten the flaky suite',
    )
    expect(screen.getByText('Implement, verify with tests, then review.')).toBeTruthy()
    expect(stepIds()).toEqual(['implement', 'verify', 'review'])
    expect(document.querySelector('[data-slot="plan-badge-check"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="plan-badge-skill"]')?.textContent).toBe('om-fix')
    expect(screen.getByText('npm test')).toBeTruthy()
  })

  it('a degraded answer shows the fallback note instead of a rationale', async () => {
    serve({ plan: FALLBACK_PLAN })
    renderNewTask()
    await planTask()
    expect(document.querySelector('[data-slot="plan-fallback"]')?.textContent).toBe(
      'planner unavailable — single-step plan',
    )
    expect(document.querySelector('[data-slot="plan-rationale"]')).toBeNull()
    expect(stepIds()).toEqual(['task'])
  })

  it('shows the busy state while planning: "Planning…" on the segment, submit disabled', async () => {
    let release!: () => void
    serve({
      plan: () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify(PLAN), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
        }),
    })
    renderNewTask()
    await pillReady()
    fireEvent.click(planToggle())
    fireEvent.change(textarea(), { target: { value: 'slow plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan task' }))

    await screen.findByText('Planning…')
    expect((screen.getByRole('button', { name: 'Plan task' }) as HTMLButtonElement).disabled).toBe(true)

    release()
    await screen.findByText('Proposed chain')
    expect(screen.queryByText('Planning…')).toBeNull()
  })

  it('✕ removes a step and ↑/↓ reorder (the touch-honest path)', async () => {
    serve()
    renderNewTask()
    await planTask()

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }))
    expect(stepIds()).toEqual(['implement', 'review'])

    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
    expect(stepIds()).toEqual(['review', 'implement'])

    // Edges are disabled — the first card cannot move up, the last cannot move down.
    expect((screen.getByRole('button', { name: 'Move step 1 up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move step 2 down' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('removing everything leaves the honest empty line and disables Start + Save', async () => {
    serve({ plan: FALLBACK_PLAN })
    renderNewTask()
    await planTask()
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 1' }))

    expect(screen.getByText('(no steps left — discard and plan again)')).toBeTruthy()
    expect((document.querySelector('[data-slot="plan-start"]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('[data-slot="plan-save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('▶ Start posts the EDITED steps inline — the exact wire payload — and navigates', async () => {
    serve({ createRun: { id: 'planned-1' } })
    renderNewTask()
    await planTask('Tighten the flaky suite')

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)

    await waitFor(() =>
      expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(true),
    )
    expect(postedBody()).toEqual({
      task: 'Tighten the flaky suite',
      steps: [
        { id: 'review', name: 'Review', skill: 'om-fix', prompt: 'Review the changes for {{task}}' },
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      ],
    })
    await waitFor(() => expect(location()).toBe('/tasks/planned-1'))
  })

  it('▶ Start omits a locked native default from the planned run request', async () => {
    serve({
      config: { defaultModels: { claude: 'native-sonnet' }, modelsLocked: true },
      createRun: { id: 'planned-native' },
    })
    renderNewTask()
    await planTask('Plan with native settings')
    expect((document.querySelector('[data-slot="model-pill"]') as HTMLElement).textContent).toContain(
      'native-sonnet',
    )

    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)
    await waitFor(() => expect(postedBody()).toBeDefined())
    expect(postedBody()).toEqual({
      task: 'Plan with native settings',
      steps: PLAN.steps,
    })
  })

  it('▶ Start uses project config while boot health is still pending', async () => {
    const delayedHealth = deferredJson<HealthResponse>()
    serve({ health: delayedHealth.fetch, createRun: { id: 'planned-before-health' } })
    renderNewTask()
    await planTask('Plan before health resolves')

    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)
    await waitFor(() => expect(postedBody()).toBeDefined())

    expect((postedBody() as Record<string, unknown>).runner).toBeUndefined()
    delayedHealth.release(HEALTH)
  })

  it('does not start a reviewed plan after provider status loses every connection', async () => {
    let current = PROVIDERS_CONNECTED
    serve({
      providerStatus: () =>
        Promise.resolve(
          new Response(JSON.stringify(current), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    })
    const { client } = renderNewTask()
    await planTask('Wait for a connected provider')

    current = PROVIDERS_NONE
    await client.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus })
    await waitFor(() => expect(textarea().disabled).toBe(true))
    const start = document.querySelector<HTMLButtonElement>('[data-slot="plan-start"]')!
    expect(start.disabled).toBe(true)
    expect(screen.getByText('Connect an agent provider before starting a task.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
    start.removeAttribute('disabled')
    fireEvent.click(start)

    expect(requests.some((request) => request.url === '/api/v1/runs')).toBe(false)
  })

  it('▶ Start carries the follow-up opt-out from the composer and remembers it', async () => {
    serve({ createRun: { id: 'planned-no-followups' } })
    renderNewTask()
    await pillReady()
    fireEvent.click(
      document.querySelector('[data-slot="generate-followups-toggle"]') as HTMLElement,
    )
    await planTask('Plan without follow-ups')
    fireEvent.click(document.querySelector('[data-slot="plan-start"]') as HTMLElement)

    await waitFor(() => expect((postedBody() as Record<string, unknown>).generateFollowups).toBe(false))
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body).toEqual({
        lastGenerateFollowups: false,
      }),
    )
  })

  it('Discard closes the overlay and hands back the draft untouched', async () => {
    serve()
    renderNewTask()
    await planTask('keep this text')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByText('Proposed chain')).toBeNull())
    expect(textarea().value).toBe('keep this text')
    expect(requests.some((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toBe(false)
  })
})

describe('save as chain', () => {
  it('asks for the name in a dialog and posts { name, steps } — no overwrite key uninvited', async () => {
    serve()
    renderNewTask()
    await planTask()

    fireEvent.click(document.querySelector('[data-slot="plan-save"]') as HTMLElement)
    const nameInput = await screen.findByLabelText('Chain name')
    fireEvent.change(nameInput, { target: { value: '  my chain  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(requests.some((r) => r.url === '/api/v1/workflows' && r.method === 'POST')).toBe(true),
    )
    expect(requests.find((r) => r.url === '/api/v1/workflows' && r.method === 'POST')?.body).toEqual({
      name: 'my chain',
      steps: PLAN.steps,
    })
    // Dialog closes on success; the review itself stays open (start is a separate decision).
    await waitFor(() => expect(screen.queryByLabelText('Chain name')).toBeNull())
    expect(screen.getByText('Proposed chain')).toBeTruthy()
    await screen.findByText('Saved — my-chain.yaml')
  })

  it('a 409 opens the overwrite confirm; Yes retries with overwrite: true', async () => {
    serve({
      saveWorkflow: [
        { status: 409, body: { error: 'workflow file already exists: x.yaml', exists: true } },
        { status: 201, body: { path: '.ai/cezar/workflows/my-chain.yaml', name: 'my chain' } },
      ],
    })
    renderNewTask()
    await planTask()

    fireEvent.click(document.querySelector('[data-slot="plan-save"]') as HTMLElement)
    fireEvent.change(await screen.findByLabelText('Chain name'), { target: { value: 'my chain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Overwrite “my chain”?')
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))

    await waitFor(() => {
      const saves = requests.filter((r) => r.url === '/api/v1/workflows' && r.method === 'POST')
      expect(saves).toHaveLength(2)
      expect(saves[1]?.body).toEqual({ name: 'my chain', steps: PLAN.steps, overwrite: true })
    })
    await waitFor(() => expect(screen.queryByLabelText('Chain name')).toBeNull())
  })

  it('a non-409 failure surfaces the server message and keeps the dialog open', async () => {
    serve({ saveWorkflow: [{ status: 400, body: { error: 'step 2: needs prompt or command' } }] })
    renderNewTask()
    await planTask()

    fireEvent.click(document.querySelector('[data-slot="plan-save"]') as HTMLElement)
    fireEvent.change(await screen.findByLabelText('Chain name'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('step 2: needs prompt or command')
    expect(screen.getByLabelText('Chain name')).toBeTruthy()
  })
})

// ---- prompt templates on /new (#413 follow-up) ---------------------------------------------------

describe('prompt templates on the new-task composer', () => {
  const ASSIGNED = [
    { id: 'assigned', label: 'Fix rules', text: 'Follow the fix rules.', skills: ['om-fix'] },
    { id: 'manual', label: 'Manual', text: 'Never auto.' },
  ]

  const templateTrigger = () => screen.getByRole('button', { name: 'Insert a prompt template' })
  const option = (id: string) =>
    document.querySelector<HTMLElement>(`[data-slot="prompt-template-option"][data-template="${id}"]`)

  const pickSource = async (ref: string) => {
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.click(document.querySelector(`[data-slot="source-option"][data-source-ref="${ref}"]`)!)
  }

  it('the trigger is icon-only here — the footer pill row is already full', async () => {
    serve()
    renderNewTask()
    await pillReady()

    // No "templates" word next to the icon, unlike the roomier GitHub/Inbox composers.
    expect(templateTrigger().textContent).toBe('')
    expect(templateTrigger().querySelector('svg')).not.toBeNull()
  })

  it('inserts a template into the composer draft at the caret', async () => {
    serve()
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    fireEvent.click(templateTrigger())
    await waitFor(() => expect(option('add-tests')).not.toBeNull())
    fireEvent.click(option('add-tests')!)

    await waitFor(() =>
      expect(textarea().value).toBe('Ship it\n\nAlso add or update tests covering this change.'),
    )
  })

  it('picking a skill auto-applies the templates assigned to it into an empty composer', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))
  })

  it('switching to a skill with nothing assigned takes the auto-applied text back out', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))

    await pickSource('deploy')
    await waitFor(() => expect(textarea().value).toBe(''))
  })

  it('NEVER overwrites a draft the user already typed', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'my own words' } })
    await pickSource('om-fix')

    await waitFor(() => expect(sourcePill().textContent).toContain('om-fix'))
    expect(textarea().value).toBe('my own words')
  })

  it('a workflow never auto-applies — assignment is a skill concept', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('quick-task')
    await waitFor(() => expect(sourcePill().textContent).toContain('quick-task'))
    expect(textarea().value).toBe('')
  })

  it('the auto-applied text is what actually gets submitted', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSource('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))

    await startTask()
    // The auto-applied text is the real task text on the wire, not just something on screen.
    expect(postedBody()).toMatchObject({
      task: 'Follow the fix rules.',
      steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
    })
  })
})

// ---- agent accounts (spec 2026-07-29-agent-profiles) ------------------------------------------

/** One extra Claude login beside the discovered defaults. */
const ACCOUNTS: AgentProfilesResponse = {
  defaults: {},
  editable: true,
  profileCapableProviders: ['claude', 'codex'],
  selections: {},
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
      status: { provider: 'claude', status: 'connected' },
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
      status: { provider: 'claude', status: 'connected', profileId: 'work' },
      files: [],
    },
  ],
}

/** The one pill that now carries both: which agent, and which of that agent's logins. */
const runnerPill = () => document.querySelector('[data-slot="runner-pill"]') as HTMLElement | null

/** Open a PickerPill and click the option whose label contains `match`. */
const pickFrom = async (pill: HTMLElement, match: string) => {
  fireEvent.pointerDown(pill)
  const options = await screen.findAllByRole('menuitemradio')
  fireEvent.click(options.find((o) => o.textContent?.includes(match)) as HTMLElement)
}

/**
 * The account lives INSIDE the runner pill (spec 2026-07-29-agent-profiles): "which agent" and
 * "which of my logins for that agent" are one decision, and the composer row already carries six
 * pills. The account defaults to whatever the repo is set to and is overridable per task.
 */
describe('the composer runner pill carries the account', () => {
  it('adds nothing when no second login exists — the zero-config composer is unchanged', async () => {
    serve({
      agentProfiles: { ...ACCOUNTS, profiles: ACCOUNTS.profiles.filter((p: (typeof ACCOUNTS)['profiles'][number]) => p.isDefault) },
    })
    renderNewTask()
    await pillReady()
    // Settled: the model pill (rendered unconditionally beside it) is up, so this is not a race.
    await waitFor(() => expect(document.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    // One runner and no accounts leaves nothing to choose, so the pill stays away entirely.
    expect(runnerPill()).toBeNull()
    expect(document.querySelector('[data-slot="account-pill"]')).toBeNull()
  })

  it('lists every agent-and-login as ONE flat row, on a single-runner host too', async () => {
    // Two regressions in one: folding the account into the runner pill must not hide it on a
    // claude-only machine (where the pill never used to render), and the list must be flat —
    // one row per thing that can run the task, not a runner choice with an account choice nested
    // under it.
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    fireEvent.pointerDown(runnerPill()!)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent?.replace(/\s+/g, ' '))).toEqual([
      'claude · Default/home/u/.claude'.replace(/\s+/g, ' '),
      'claude · Klaudiusz~/.claude-klaudiusz'.replace(/\s+/g, ' '),
    ])
    // Each row names its folder: the labels are cezar's invention, the folder is the account.
    expect(options[1]?.textContent).toContain('~/.claude-klaudiusz')
  })

  it('starts on the account the repo is set to, without the user picking anything', async () => {
    serve({
      agentProfiles: { ...ACCOUNTS, selections: { '/repo': { claude: 'klaudiusz' } } },
    })
    renderNewTask()
    await pillReady()
    // The repo's choice IS the initial selection — no "repo default" abstraction to decode.
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))

    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // …and an untouched pill still sends nothing, so the repo stays in charge.
    expect(postedBody()).not.toHaveProperty('agentProfile')
  })

  it('sends `default` explicitly when the repo points elsewhere — not an absent key', async () => {
    // The one case where "follow the repo" and "the discovered account" differ. An absent key would
    // run the task on Klaudiusz, which is the opposite of what picking `claude · Default` says.
    serve({
      agentProfiles: { ...ACCOUNTS, selections: { '/repo': { claude: 'klaudiusz' } } },
    })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))

    await pickFrom(runnerPill()!, 'Default')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Default'))
    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()

    expect(postedBody()).toMatchObject({ agentProfile: 'default' })
  })

  it('sends the picked account on the wire', async () => {
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    await pickFrom(runnerPill()!, 'Klaudiusz')
    // The pill says which login the task will really use, not just which agent.
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))
    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()

    expect(postedBody()).toMatchObject({ agentProfile: 'klaudiusz' })
  })

  it('sends NOTHING when the repo default is left alone', async () => {
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // An absent key means "follow the repo", which is what an untouched control means.
    expect(postedBody()).not.toHaveProperty('agentProfile')
  })

  it('switches back to the discovered account after picking another', async () => {
    serve({ agentProfiles: ACCOUNTS })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    await pickFrom(runnerPill()!, 'Klaudiusz')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Klaudiusz'))
    await pickFrom(runnerPill()!, 'Default')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('claude · Default'))

    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // This repo has no selection of its own, so `default` and "follow the repo" agree — but the
    // pick was explicit, and saying so keeps it true if the repo setting changes before it starts.
    expect(postedBody()).toMatchObject({ agentProfile: 'default' })
  })

  it('drops an account belonging to another runner when the runner switches', async () => {
    // A Claude account must not ride along into a codex run: the id means nothing there, and
    // sending it would assert a choice the user never made for that engine.
    serve({ agentProfiles: ACCOUNTS, health: HEALTH_MULTI, providerStatus: PROVIDERS_MULTI })
    renderNewTask()
    await pillReady()
    await waitFor(() => expect(runnerPill()).not.toBeNull())

    await pickFrom(runnerPill()!, 'Klaudiusz')
    await waitFor(() => expect(runnerPill()?.textContent).toContain('Klaudiusz'))

    await pickFrom(runnerPill()!, 'codex')

    // Codex has no second login, so the account group goes away and the pill is a runner again…
    await waitFor(() => expect(runnerPill()?.textContent?.trim()).toBe('codex'))
    fireEvent.change(textarea(), { target: { value: 'do the thing' } })
    await startTask()
    // …and nothing account-shaped reaches the wire.
    expect(postedBody()).not.toHaveProperty('agentProfile')
  })
})
