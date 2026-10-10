import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  // Radix Select (the Dispatch limits) asks for pointer capture, which jsdom does not implement.
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
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
  capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false, dispatch: false },
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
    { provider: 'cursor', status: 'not-installed', enabled: true },
  ],
}

/** Two usable runners (claude + codex). Cursor stays not-installed so multi-backend
 *  scenarios stay a 2-choice pill unless a test opts Cursor in explicitly. */
const PROVIDERS_MULTI: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
    { provider: 'cursor', status: 'not-installed', enabled: true },
  ],
}

const PROVIDERS_NONE: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true },
    { provider: 'cursor', status: 'disconnected', enabled: true },
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
  branding: { name: 'cezar', logoUrl: null },
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
    idleTimeoutMinutes: 15,
    monitoringWakeIntervalMinutes: null,
    autoResumeOnUsageLimit: true,
    memoryLimitMb: null,
    worktreeRetentionDefault: 10,
  },
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
    ...overrides,
  }
  requests = []
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
      // One catalog per discovering runner — the composer reads the selected runner's, so a
      // single shared answer would let a codex-only fixture stand in for claude's picker.
      if (url === '/api/v1/models?runner=codex') return json({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (url === '/api/v1/models?runner=claude') return json({ runner: 'claude', models: [{ id: 'opus', label: 'opus', description: 'Opus 5' }, { id: 'sonnet', label: 'sonnet', description: 'Sonnet 5' }], source: 'live', stale: false })
      if (url === '/api/v1/models?runner=cursor') return json({ runner: 'cursor', models: [{ id: 'composer-2.5', label: 'Composer 2.5', description: '' }], source: 'live', stale: false })
      if (url === '/api/v1/skills') return json(data.skills)
      if (url === '/api/v1/workflows' && method === 'GET') return json(data.workflows)
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

const pngFile = (name = 'shot.png', bytes: number[] = [1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' })

const paste = (target: HTMLTextAreaElement, files: File[]) =>
  fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    },
  })

const attachmentChips = () => screen.queryAllByLabelText(/^Remove /)
// Workflows are chosen apart from skills: one pill each over the SAME source (a task runs a
// workflow or a skill, never both), so either pill's `data-source-kind` is the whole source's.
const workflowPill = () => screen.getByRole('button', { name: 'Choose a workflow' })
const skillPill = () => screen.getByRole('button', { name: 'Choose a skill' })
const sourceLabels = () => `${workflowPill().textContent} | ${skillPill().textContent}`
const location = () => screen.getByTestId('location').textContent

/** Seed the composer draft with a picked source — the ONLY thing that preselects one now.
 *  The persisted `lastTask` deliberately no longer does (see `resolveSource`), which is what
 *  keeps a skill from following the user into every task after the one they picked it for. */
const draftSource = (source: { source: 'skill' | 'workflow'; ref: string }) =>
  writeDraft({ ...readDraft(), source })

/** The pickers resolve once workflows+skills+ui-state answered — wait for the real label, on
 *  whichever of the two pills holds it. The default is the EMPTY source: `/new` opens with no
 *  skill picked ("Add skill") and the workflow pill naming the plain `quick-task` it will run. */
async function pillReady(label = 'Add skill') {
  await waitFor(() => {
    expect(sourceLabels()).toContain(label)
    expect(textarea().disabled).toBe(false)
  })
}

const sourceOption = (kind: string, ref?: string) =>
  document.querySelector<HTMLElement>(
    ref === undefined
      ? `[data-slot="source-option"][data-source-kind="${kind}"]`
      : `[data-slot="source-option"][data-source-kind="${kind}"][data-source-ref="${ref}"]`,
  )
const sourceOptions = () => [...document.querySelectorAll('[data-slot="source-option"]')]
const SKILL_SEARCH = 'search skills…'
const WORKFLOW_SEARCH = 'search workflows…'
const openSkillMenu = async () => {
  fireEvent.click(skillPill())
  return await screen.findByPlaceholderText(SKILL_SEARCH)
}
const openWorkflowMenu = async () => {
  fireEvent.click(workflowPill())
  return await screen.findByPlaceholderText(WORKFLOW_SEARCH)
}
const pickSkill = async (ref: string) => {
  await openSkillMenu()
  fireEvent.click(sourceOption('skill', ref)!)
}
const pickWorkflow = async (ref: string) => {
  await openWorkflowMenu()
  fireEvent.click(sourceOption('workflow', ref)!)
}

/** Variants, worktree, autonomy, follow-ups, dispatch and the base branch live one click away,
 *  in the composer's "Options" popover — nothing in there exists in the DOM until it is open. */
async function openRunOptions() {
  if (document.querySelector('[data-slot="run-options"]')) return
  fireEvent.click(screen.getByRole('button', { name: 'Run options' }))
  await waitFor(() => expect(document.querySelector('[data-slot="run-options"]')).not.toBeNull())
}

const startTask = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/runs')).toBe(true))
}

const postedBody = () => requests.find((r) => r.method === 'POST' && r.url === '/api/v1/runs')?.body

// ---- the hero surface -------------------------------------------------------------------------

describe('the hero surface', () => {
  it('offers one Start action without a plan-mode switcher', async () => {
    serve()
    renderNewTask()
    await pillReady()

    expect(screen.getByRole('button', { name: 'Start task' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Run mode' })).toBeNull()
  })

  it('renders the hero: title, subtitle, the glow, and focus lands in the textarea', async () => {
    serve()
    renderNewTask()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What should the agent work on?')
    expect(screen.getByText('Runs in an isolated worktree — review everything before it lands.')).toBeTruthy()
    // The hero's only decoration is the soft wash from the top edge — the twinkle scatter is gone.
    expect(document.querySelector('[data-route="new"] [data-slot="hero-glow"]')).not.toBeNull()
    expect(document.querySelector('[data-route="new"] [data-slot="twinkle-backdrop"]')).toBeNull()
    // Asserted here for the DEFAULT run mode only. #793: this line used to be printed
    // unconditionally, so it also claimed isolation for runs that had opted out of it — the
    // per-state cases live in "the run-mode note" below.
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
    // codex's catalog is fetched for the runner now SELECTED (#794), so it lands after the switch.
    await waitFor(() => {
      const labels = screen.getAllByRole('menuitemradio').map((o) => o.textContent ?? '')
      expect(labels.some((l) => l.includes('gpt-future'))).toBe(true)
      expect(labels.some((l) => l.includes('opus'))).toBe(false)
    })
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
          { provider: 'cursor', status: 'connected', enabled: false },
        ],
      },
    })
    renderNewTask()
    await pillReady()

    expect(document.querySelector('[data-slot="runner-pill"]')).toBeNull()
    expect(textarea().disabled).toBe(false)
  })

  it('offers Cursor in the runner pill when the provider is connected and enabled', async () => {
    serve({
      health: {
        ...HEALTH,
        checks: [
          { name: 'claude', available: true },
          { name: 'codex', available: true },
          { name: 'cursor', available: true },
          { name: 'git', available: true },
        ],
      },
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'disconnected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'connected', enabled: true },
        ],
      },
    })
    renderNewTask()
    await pillReady()

    const runnerPill = document.querySelector('[data-slot="runner-pill"]') as HTMLElement
    await waitFor(() => expect(runnerPill).not.toBeNull())
    fireEvent.pointerDown(runnerPill)
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('claude'),
      expect.stringContaining('cursor'),
    ])
  })

  it('drops a persisted model preset that belongs to another runner', async () => {
    writeDraft({
      text: '', source: null, runner: 'codex', agentProfile: null, model: 'claude-opus-4-8', variants: 1,
      worktree: null, autonomous: null, generateFollowups: null, dispatch: null,
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

  describe('the run-mode note (#793)', () => {
    const note = () => document.querySelector('[data-slot="run-mode-note"]')?.textContent

    it('promises isolation only while the run will actually get a worktree', async () => {
      serve()
      renderNewTask()
      await pillReady()
      expect(note()).toBe('Runs in an isolated worktree — review everything before it lands.')

      // Switching it off changes where the work lands, so it has to change what the header
      // says. This is the regression: the line was printed unconditionally, so it kept promising
      // isolation for a run that was about to edit the user's checkout directly.
      await openRunOptions()
      fireEvent.click(document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement)
      await waitFor(() => expect(note())
        .toBe('Runs in the repo working tree — your checkout is modified directly.'))
    })

    it('explains a non-git folder rather than warning about a checkout', async () => {
      // There is no worktree to opt into here, so "your checkout is modified directly" would be
      // the wrong half of the truth — the user needs to know WHY there is no isolation on offer.
      serve({ health: HEALTH_NO_GIT, repo: REPO_NO_GIT })
      renderNewTask()
      await pillReady()
      expect(note())
        .toBe('Runs in place — no git repository detected, so there is no worktree to isolate in.')
    })

    it('follows the workspace Worktree-off policy, not just an explicit click', async () => {
      // The resolved mode, not the draft: a run can land in the checkout because policy said so,
      // and the header has to be honest about that too.
      serve({
        workspaceConfig: {
          ...WORKSPACE_CONFIG,
          composerDefaults: { ...WORKSPACE_CONFIG.composerDefaults!, inheritedWorktree: false },
        },
      })
      renderNewTask()
      await pillReady()
      await waitFor(() => expect(note())
        .toBe('Runs in the repo working tree — your checkout is modified directly.'))
    })
  })

  const variantChoices = () =>
    within(document.querySelector('[data-slot="variants-pill"]') as HTMLElement).getAllByRole('radio') as HTMLButtonElement[]

  it('gates variants on git: no repo → choices disabled with the honest reason, base pill gone', async () => {
    serve({ health: HEALTH_NO_GIT, repo: REPO_NO_GIT })
    renderNewTask()
    await pillReady()
    await openRunOptions()
    expect(variantChoices().map((choice) => choice.disabled)).toEqual([true, true, true])
    expect(document.querySelector('[data-slot="variants-option"]')?.textContent)
      .toContain('Needs a git repository — each variant runs in its own worktree.')
    expect(document.querySelector('[data-slot="base-pill"]')).toBeNull()
    // No worktree to opt into either — the switch is not offered.
    expect(document.querySelector('[data-slot="worktree-toggle"]')).toBeNull()
    // The rows that need no git are still there, so the absences above are the gate's doing.
    expect(document.querySelector('[data-slot="autonomous-toggle"]')).not.toBeNull()
  })

  // #791: health is bound to the boot folder, so a cezar booted outside a git repo answered
  // `repo: null` for EVERY project. Reading git state from the project-scoped `/repo` instead is
  // what keeps the worktree controls alive for a git project under a non-git boot root.
  it('gates variants on the project repo, not the boot folder: boot without git still offers worktrees', async () => {
    serve({ health: HEALTH_NO_GIT, repo: REPO })
    renderNewTask()
    await pillReady()
    await openRunOptions()
    expect(variantChoices().map((choice) => choice.disabled)).toEqual([false, false, false])
    expect(document.querySelector('[data-slot="variants-option"]')?.textContent)
      .toContain('Run it several times in parallel and keep the diff you like.')
    expect(document.querySelector('[data-slot="worktree-toggle"]')).not.toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Fix the composer git detection' } })
    await startTask()
    // `worktree` is sent only when explicitly OFF (new-task-form.ts): an absent key IS the
    // isolated-worktree default, so absence — not `worktree: false` — is what the fix restores.
    expect(postedBody()).not.toHaveProperty('worktree')
  })

  it('base branch pill shows config default (falling back to the checkout) and PUTs /api/v1/config', async () => {
    serve({ repo: { ...REPO, baseBranch: 'develop' } })
    renderNewTask()
    await pillReady()
    await openRunOptions()
    const basePill = () => document.querySelector('[data-slot="base-pill"]') as HTMLElement
    await waitFor(() => expect(basePill()).not.toBeNull())
    // The row's own title says "Base branch"; the pill is just the branch.
    expect(basePill().textContent).toBe('develop')
    expect(basePill().getAttribute('aria-label')).toBe('Base branch')

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

  it('filters base branches by name', async () => {
    serve({ repo: { ...REPO, branches: ['main', 'develop', 'feature/searchable-base'] } })
    renderNewTask()
    await pillReady()
    await openRunOptions()

    fireEvent.pointerDown(document.querySelector('[data-slot="base-pill"]') as HTMLElement)
    const search = await screen.findByRole('searchbox', { name: 'Search branches…' })
    fireEvent.change(search, { target: { value: 'searchable' } })

    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual([
      expect.stringContaining('feature/searchable-base'),
    ])
    expect(screen.queryByText('develop')).toBeNull()

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByText('No branches found.')).not.toBeNull()

    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('searchbox', { name: 'Search branches…' })).toBeNull())
    fireEvent.pointerDown(document.querySelector('[data-slot="base-pill"]') as HTMLElement)
    const reopenedSearch = await screen.findByRole('searchbox', { name: 'Search branches…' })
    expect((reopenedSearch as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
  })

  it('opens with NOTHING picked, whatever the last run used', async () => {
    // The report this fixes: a skill picked once sat in the pill for every task afterwards,
    // and the composer offered no way to take it out. `lastTask` is still recorded — it just
    // no longer decides what the next task runs.
    serve({ uiState: { lastTask: { source: 'skill', ref: 'om-fix' } } })
    renderNewTask()
    await pillReady()
    expect(skillPill().getAttribute('data-source-kind')).toBe('none')
    expect(skillPill().textContent).not.toContain('om-fix')
  })

  it('preselects the draft pick, and drops it when the catalog no longer has it', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')

    cleanup()
    resetDraft()
    draftSource({ source: 'skill', ref: 'deleted-skill' })
    serve()
    renderNewTask()
    await pillReady()
    expect(skillPill().getAttribute('data-source-kind')).toBe('none')
  })

  it('the skill menu groups: No skill first, Project skills (bold), Global last — and no workflows', async () => {
    serve()
    renderNewTask()
    await pillReady()
    await openSkillMenu()

    const options = sourceOptions()
    // "No skill" leads, heading-less. Workflows are chosen apart, in their own picker.
    expect(options.map((o) => o.getAttribute('data-source-kind'))).toEqual(['none', 'skill', 'skill'])
    expect(options.map((o) => o.getAttribute('data-source-ref'))).toEqual([null, 'om-fix', 'deploy'])
    expect(options[0]!.textContent).toContain('No skill')
    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(headings).toEqual(['Project skills', 'Global'])
    // Project skills read bold, global ones plain.
    expect(sourceOption('skill', 'om-fix')!.querySelector('span')?.className).toContain('font-semibold')
    expect(sourceOption('skill', 'deploy')!.querySelector('span')?.className).not.toContain('font-semibold')
  })

  it('the workflow menu lists every workflow, the default quick-task leading — and no skills', async () => {
    serve()
    renderNewTask()
    await pillReady()
    // Never empty: with nothing picked the task runs the plain built-in, and the pill says so.
    expect(workflowPill().textContent).toContain('quick-task')
    await openWorkflowMenu()

    const options = sourceOptions()
    expect(options.map((o) => o.getAttribute('data-source-kind'))).toEqual(['workflow', 'workflow'])
    expect(options.map((o) => o.getAttribute('data-source-ref'))).toEqual(['quick-task', 'fix-and-verify'])
    expect(options[0]!.textContent).toContain('default')
    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(headings).toEqual(['Workflows'])
  })

  it('a task runs a workflow OR a skill: picking in one pill replaces the pick in the other', async () => {
    serve()
    renderNewTask()
    await pillReady()

    await pickWorkflow('fix-and-verify')
    await waitFor(() => expect(workflowPill().textContent).toContain('fix-and-verify'))
    expect(skillPill().textContent).toContain('Add skill')
    expect(readDraft().source).toEqual({ source: 'workflow', ref: 'fix-and-verify' })

    await pickSkill('om-fix')
    await waitFor(() => expect(skillPill().textContent).toContain('om-fix'))
    // The skill runs on its own — the workflow pill names none, not even the default.
    expect(workflowPill().textContent).not.toContain('fix-and-verify')
    expect(workflowPill().textContent).not.toContain('quick-task')
    expect(readDraft().source).toEqual({ source: 'skill', ref: 'om-fix' })

    await pickWorkflow('fix-and-verify')
    await waitFor(() => expect(skillPill().textContent).toContain('Add skill'))
    expect(readDraft().source).toEqual({ source: 'workflow', ref: 'fix-and-verify' })
  })

  it('multi-keyword search: "fix issue" matches om-fix via hyphen-split keywords (#411)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const input = await openSkillMenu()

    // "fix issue" should match "om-fix" because both "fix" and "issue" appear in the
    // combined value+keywords text (name splits: "om","fix" + description "Fix an issue end to end").
    fireEvent.change(input, { target: { value: 'fix issue' } })
    await waitFor(() => {
      expect(sourceOptions().map((o) => o.getAttribute('data-source-ref'))).toEqual(['om-fix'])
    })
  })

  it('multi-keyword search hides items that do not match all words (#411)', async () => {
    serve()
    renderNewTask()
    await pillReady()
    const input = await openSkillMenu()

    fireEvent.change(input, { target: { value: 'deploy fix' } })
    await waitFor(() => {
      // "deploy" does not have "fix" in its name/description, and "om-fix" does not have "deploy"
      expect(sourceOptions()).toHaveLength(0)
    })
    expect(screen.getByText('Nothing matches.')).toBeTruthy()
  })
})

// ---- clearing the source (the reported bug: no way to deselect a skill) -----------------------

describe('clearing the picked skill or workflow', () => {
  const clearButton = () => document.querySelector<HTMLButtonElement>('[data-slot="source-pill-clear"]')

  it('the ✕ clears in one click, without opening the menu', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    expect(clearButton()?.getAttribute('aria-label')).toBe('Clear the skill om-fix')
    fireEvent.click(clearButton()!)

    await waitFor(() => expect(skillPill().getAttribute('data-source-kind')).toBe('none'))
    // No menu was ever opened — the whole point of the affordance.
    expect(screen.queryByPlaceholderText(SKILL_SEARCH)).toBeNull()
    expect(screen.queryByPlaceholderText(WORKFLOW_SEARCH)).toBeNull()
    expect(clearButton()).toBeNull()
    // And the run really does go out as the plain built-in.
    fireEvent.change(textarea(), { target: { value: 'Ship it plain' } })
    await startTask()
    expect(postedBody()).toEqual({ task: 'Ship it plain', workflow: 'quick-task' })
  })

  it('offers no ✕ while nothing is picked — there is nothing to clear', async () => {
    serve()
    renderNewTask()
    await pillReady()
    expect(clearButton()).toBeNull()
  })

  it('Backspace on the focused pill clears it, like a token in a tag field', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')

    fireEvent.keyDown(workflowPill(), { key: 'Backspace' })
    await waitFor(() => expect(workflowPill().getAttribute('data-source-kind')).toBe('none'))
    // Back to the plain built-in, which is what an empty source runs.
    expect(workflowPill().textContent).toContain('quick-task')
  })

  it('leaves the pill alone on ⌘/Ctrl+Backspace — that is a text gesture, not a picker one', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    fireEvent.keyDown(skillPill(), { key: 'Backspace', metaKey: true })
    expect(skillPill().getAttribute('data-source-kind')).toBe('skill')
  })

  it('picking the SELECTED row again clears it — for a skill and for a workflow', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    await pickSkill('om-fix')
    await waitFor(() => expect(skillPill().getAttribute('data-source-kind')).toBe('none'))

    await pickWorkflow('fix-and-verify')
    await waitFor(() => expect(workflowPill().textContent).toContain('fix-and-verify'))
    await pickWorkflow('fix-and-verify')
    await waitFor(() => expect(workflowPill().getAttribute('data-source-kind')).toBe('none'))
    expect(workflowPill().textContent).toContain('quick-task')
  })

  it('the "No skill" row clears the picker, and answers to a search for quick-task', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve()
    renderNewTask()
    await pillReady('om-fix')

    const input = await openSkillMenu()
    // The built-in has no row among the skills — typing its name finds the row that runs it.
    fireEvent.change(input, { target: { value: 'quick' } })
    await waitFor(() => {
      expect(sourceOptions().map((o) => o.getAttribute('data-source-kind'))).toEqual(['none'])
    })

    fireEvent.click(sourceOption('none')!)
    await waitFor(() => expect(skillPill().getAttribute('data-source-kind')).toBe('none'))
  })

  it('in its own picker quick-task IS a row, and picking it over another workflow goes back to plain', async () => {
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')
    expect(clearButton()?.getAttribute('aria-label')).toBe('Clear the workflow fix-and-verify')

    const input = await openWorkflowMenu()
    fireEvent.change(input, { target: { value: 'quick' } })
    await waitFor(() => {
      expect(sourceOptions().map((o) => o.getAttribute('data-source-ref'))).toEqual(['quick-task'])
    })
    fireEvent.click(sourceOption('workflow', 'quick-task')!)
    await waitFor(() => expect(workflowPill().getAttribute('data-source-kind')).toBe('none'))
    expect(workflowPill().textContent).toContain('quick-task')
    expect(readDraft().source).toBeNull()
  })

  it('a cleared pill stays cleared for the NEXT task, and the started one is not remembered', async () => {
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve({ createRun: { id: 'run-2' } })
    renderNewTask()
    await pillReady('om-fix')
    fireEvent.change(textarea(), { target: { value: 'Fix it with the skill' } })
    await startTask()
    await waitFor(() => expect(location()).toBe('/tasks/run-2'))

    // Same browser, same project, next visit: the skill went with the task it ran.
    cleanup()
    serve()
    renderNewTask()
    await pillReady()
    expect(skillPill().getAttribute('data-source-kind')).toBe('none')
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

    await waitFor(() => expect(skillPill().textContent).toContain('Add skill'))
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

  it('disables Start and links to project-aware provider settings when none connect', async () => {
    serve({ providerStatus: PROVIDERS_NONE })
    renderNewTask('/p/acme/new')

    await waitFor(() =>
      expect(textarea().placeholder).toBe('Connect an agent provider before starting a task.'),
    )
    expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true)
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
          { provider: 'cursor', status: 'not-installed', enabled: true },
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
          { provider: 'cursor', status: 'not-installed', enabled: true },
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
          { provider: 'cursor', status: 'not-installed', enabled: true },
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
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve({ createRun: { id: 'run-9' } })
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
      variants: 1, worktree: null, autonomous: null, generateFollowups: null, dispatch: null,
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
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
    serve()
    renderNewTask()
    await pillReady('fix-and-verify')
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()

    expect(postedBody()).toEqual({ task: 'Ship it', workflow: 'fix-and-verify' })
  })

  it('NO source posts the plain quick-task, records lastTask:null and no recency entry', async () => {
    serve({ createRun: { id: 'run-plain' } })
    renderNewTask()
    await pillReady()
    fireEvent.change(textarea(), { target: { value: 'Ship it' } })
    await startTask()

    expect(postedBody()).toEqual({ task: 'Ship it', workflow: 'quick-task' })
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body).toEqual({
        // An honest record of a run that picked nothing — and the value that stops an older
        // cockpit restoring a stale skill from this same file.
        lastTask: null,
        // Nothing was picked, so nothing joins the recency list or the frequency map.
        lastGenerateFollowups: true,
      }),
    )
  })

  it('posts worktree:false after opt-out for every single-step source shape', async () => {
    const cases: Array<{
      label: string
      source?: { source: 'skill' | 'workflow'; ref: string }
      overrides: NonNullable<Parameters<typeof serve>[0]>
      expected: Record<string, unknown>
    }> = [
      {
        label: 'Add skill',
        overrides: {},
        expected: { workflow: 'quick-task' },
      },
      {
        label: 'om-fix',
        source: { source: 'skill', ref: 'om-fix' },
        overrides: {},
        expected: { steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }] },
      },
      {
        label: 'one-step',
        source: { source: 'workflow', ref: 'one-step' },
        overrides: {
          workflows: {
            workflows: [
              ...WORKFLOWS.workflows,
              { name: 'one-step', source: 'file', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] },
            ],
            issues: [],
          },
        },
        expected: { workflow: 'one-step' },
      },
    ]

    for (const testCase of cases) {
      cleanup()
      resetDraft()
      if (testCase.source) draftSource(testCase.source)
      serve(testCase.overrides)
      renderNewTask()
      await pillReady(testCase.label)
      await openRunOptions()
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
    await openRunOptions()
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
    const options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('sonnet')) as HTMLElement)
    await waitFor(() => expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0))

    await openRunOptions()
    const variants = within(document.querySelector('[data-slot="variants-pill"]') as HTMLElement)
    expect(variants.getByRole('radio', { name: 'One run' }).getAttribute('aria-checked')).toBe('true')
    // Nothing on the closed Options button until a choice in there changes what the run costs.
    const optionsButton = screen.getByRole('button', { name: 'Run options' })
    expect(optionsButton.querySelector('.bg-primary')).toBeNull()
    const two = variants.getByRole('radio', { name: '2 competing runs' })
    expect(two.textContent).toBe('×2')
    fireEvent.click(two)
    await waitFor(() => expect(two.getAttribute('aria-checked')).toBe('true'))
    expect(optionsButton.querySelector('.bg-primary')).not.toBeNull()

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
    // Not a selector: no chevron — the one a pill that CAN be changed carries.
    expect(modelPill.querySelector('.lucide-chevron-down')).toBeNull()
    expect(screen.getByRole('button', { name: 'Runner' }).querySelector('.lucide-chevron-down')).not.toBeNull()
    expect(modelPill.title).toBe('Model selection is locked to native coding-agent settings.')
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
    await openRunOptions()
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
    await openRunOptions()
    expect(
      document
        .querySelector('[data-slot="generate-followups-toggle"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false')
  })

  it('applies an interactive skill hint to untouched controls while keeping both overridable', async () => {
    // The composer opens on no source, so an interactive skill only drives the recommendation
    // once it is the selected one — here from the draft.
    draftSource({ source: 'skill', ref: 'om-fix' })
    serve({ skills: [{ ...SKILLS[0]!, interactive: true }, SKILLS[1]!] })
    renderNewTask()
    await pillReady('om-fix')
    await openRunOptions()

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
    draftSource({ source: 'workflow', ref: 'fix-and-verify' })
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
    })
    renderNewTask()
    await pillReady('fix-and-verify')
    await openRunOptions()

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
    capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
  }
  const followupsToggle = () =>
    document.querySelector('[data-slot="generate-followups-toggle"]')

  it('hides the follow-up toggle when the server has the inbox off', async () => {
    serve({ health: inboxOffHealth })
    renderNewTask()
    await pillReady()
    await openRunOptions()
    await waitFor(() => expect(followupsToggle()).toBeNull())
    // The neighbouring toggles are untouched — the gate owns exactly one control.
    expect(document.querySelector('[data-slot="autonomous-toggle"]')).not.toBeNull()
  })

  it('posts generateFollowups:false from an inbox-less server', async () => {
    serve({ health: inboxOffHealth })
    renderNewTask()
    await pillReady()
    await openRunOptions()
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
    await openRunOptions()
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
    await pickWorkflow('fix-and-verify')
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
    await openRunOptions()
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

  it('waits for project config and keeps the form when that default is unavailable', async () => {
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
    await waitFor(() => expect(textarea().value).toBe('hello'))
    expect(runsPosted()).toHaveLength(0)
    expect(screen.queryByTestId('elsewhere')).toBeNull()
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

  it('keeps the prefilled composer when the saved server default is disconnected', async () => {
    serve({
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(textarea().value).toBe('hello'))

    expect(runsPosted()).toHaveLength(0)
    expect(screen.queryByTestId('elsewhere')).toBeNull()
  })

  it('keeps the prefilled composer when the saved server default is disabled', async () => {
    serve({
      config: { defaultRunner: 'claude' },
      providerStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'cursor', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderNewTask('/new?skill=deploy&ref=hello&auto=1&key=k-real')
    await waitFor(() => expect(textarea().value).toBe('hello'))

    expect(runsPosted()).toHaveLength(0)
    expect(screen.queryByTestId('elsewhere')).toBeNull()
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
    // "quick-task" IS the empty picker now — the prefill lands on it by picking nothing.
    await pillReady()
    expect(skillPill().getAttribute('data-source-kind')).toBe('none')
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

 // ---- prompt templates on /new (#413 follow-up) ---------------------------------------------------

describe('prompt templates on the new-task composer', () => {
  const ASSIGNED = [
    { id: 'assigned', label: 'Fix rules', text: 'Follow the fix rules.', skills: ['om-fix'] },
    { id: 'manual', label: 'Manual', text: 'Never auto.' },
  ]

  const templateTrigger = () => screen.getByRole('button', { name: 'Insert a prompt template' })
  const option = (id: string) =>
    document.querySelector<HTMLElement>(`[data-slot="prompt-template-option"][data-template="${id}"]`)

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

    await pickSkill('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))
  })

  it('switching to a skill with nothing assigned takes the auto-applied text back out', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSkill('om-fix')
    await waitFor(() => expect(textarea().value).toBe('Follow the fix rules.'))

    await pickSkill('deploy')
    await waitFor(() => expect(textarea().value).toBe(''))
  })

  it('NEVER overwrites a draft the user already typed', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    fireEvent.change(textarea(), { target: { value: 'my own words' } })
    await pickSkill('om-fix')

    await waitFor(() => expect(skillPill().textContent).toContain('om-fix'))
    expect(textarea().value).toBe('my own words')
  })

  it('a workflow never auto-applies — assignment is a skill concept', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickWorkflow('fix-and-verify')
    await waitFor(() => expect(workflowPill().textContent).toContain('fix-and-verify'))
    expect(textarea().value).toBe('')
  })

  it('the auto-applied text is what actually gets submitted', async () => {
    serve({ uiState: { promptTemplates: ASSIGNED } })
    renderNewTask()
    await pillReady()

    await pickSkill('om-fix')
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

// ---- the Dispatch toggle (spec 2026-09-10-dispatch) --------------------------------------------

describe('the Dispatch toggle', () => {
  const HEALTH_DISPATCH: HealthResponse = {
    ...HEALTH,
    capabilities: { ...HEALTH.capabilities, dispatch: true },
  }
  const dispatchToggle = () =>
    document.querySelector('[data-slot="dispatch-toggle"]') as HTMLButtonElement | null
  const worktreeToggle = () =>
    document.querySelector('[data-slot="worktree-toggle"]') as HTMLButtonElement
  const autonomousToggle = () =>
    document.querySelector('[data-slot="autonomous-toggle"]') as HTMLButtonElement
  const note = () => document.querySelector('[data-slot="run-mode-note"]')?.textContent
  const hint = () => document.querySelector('[data-slot="dispatch-hint"]')
  const settings = () => document.querySelector('[data-slot="dispatch-settings"]')
  /** The row's "Limits" button — the way into the settings, on every screen size. */
  const settingsTrigger = () =>
    document.querySelector('[data-slot="dispatch-settings-trigger"]') as HTMLButtonElement | null
  /** The explanation each Options row prints under its title. */
  const rowText = (control: HTMLElement) => control.closest('[data-slot="run-option"]')?.textContent

  /** Render with dispatch on the server, open Options and wait for the switch to be there. */
  async function readyWithDispatch(overrides: Parameters<typeof serve>[0] = {}) {
    serve({ health: HEALTH_DISPATCH, ...overrides })
    renderNewTask()
    await pillReady()
    await openRunOptions()
    await waitFor(() => expect(dispatchToggle()).not.toBeNull())
    return dispatchToggle()!
  }

  /** The limits are Radix Selects. jsdom has no real pointer, so open by keyboard. */
  const limit = (label: string) => screen.getByRole('combobox', { name: label })
  async function openLimit(label: string): Promise<HTMLElement[]> {
    fireEvent.keyDown(limit(label), { key: 'ArrowDown' })
    return await screen.findAllByRole('option')
  }
  async function chooseLimit(label: string, option: string) {
    const options = await openLimit(label)
    fireEvent.click(options.find((item) => item.textContent === option)!)
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  }
  /** What a limit offers, in order. Closes by re-picking the current choice, which changes nothing. */
  async function limitChoices(label: string): Promise<(string | null)[]> {
    const options = await openLimit(label)
    const texts = options.map((item) => item.textContent)
    fireEvent.click(options.find((item) => item.getAttribute('data-state') === 'checked')!)
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    return texts
  }

  it('is hidden while the server has dispatch off, and sends nothing', async () => {
    serve()
    renderNewTask()
    await pillReady()
    await openRunOptions()
    expect(dispatchToggle()).toBeNull()
    expect(settingsTrigger()).toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Plain run' } })
    await startTask()
    expect(postedBody()).not.toHaveProperty('dispatch')
  })

  it('renders off by default when the capability is on; off sends no dispatch key', async () => {
    const toggle = await readyWithDispatch()
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Dispatch')
    expect(hint()).toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Still a plain run' } })
    await startTask()
    expect(postedBody()).not.toHaveProperty('dispatch')
  })

  it('a tap turns it on: hint, forced worktree, autonomous by default, and the bare `{}` on the wire', async () => {
    const toggle = await readyWithDispatch()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    // The hint line under the composer, and the header's one-liner, both say what changed.
    expect(hint()?.textContent).toContain('Dispatch is on.')
    expect(hint()?.textContent).toContain('Set limits under Options.')
    expect(note()).toBe('Runs on its own and fans work out to subtasks — it will not pause for you.')

    // Subtasks fork off this task's commits, so the worktree is no longer the user's call.
    expect(worktreeToggle().disabled).toBe(true)
    expect(worktreeToggle().getAttribute('aria-checked')).toBe('true')
    expect(rowText(worktreeToggle())).toContain("Dispatch forks this task's commits — subtasks need a worktree.")
    expect(autonomousToggle().getAttribute('aria-checked')).toBe('true')

    fireEvent.change(textarea(), { target: { value: 'Review every open PR' } })
    await startTask()
    const body = postedBody() as Record<string, unknown>
    expect(body.dispatch).toEqual({})
    expect(body).not.toHaveProperty('worktree')
    expect(body.autonomous).toBe(true)
  })

  it('an explicit Autonomous off survives dispatch, and the note says so', async () => {
    const toggle = await readyWithDispatch()
    fireEvent.click(toggle)
    fireEvent.click(autonomousToggle())
    expect(autonomousToggle().getAttribute('aria-checked')).toBe('false')
    expect(note()).toBe('Fans work out to subtasks in isolated worktrees.')

    // Off again: the ordinary note and an enabled worktree switch come back.
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(hint()).toBeNull()
    expect(worktreeToggle().disabled).toBe(false)
    expect(rowText(worktreeToggle())).toContain('Works on its own branch, in its own folder.')
    expect(note()).toBe('Runs in an isolated worktree — review everything before it lands.')
  })

  it('the Limits button opens the settings without toggling; limits set there turn it on and ride the body', async () => {
    const toggle = await readyWithDispatch()
    expect(settingsTrigger()?.textContent).toBe('Limits')
    expect(settingsTrigger()?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(settingsTrigger()!)
    await waitFor(() => expect(settings()).not.toBeNull())
    expect(settingsTrigger()?.getAttribute('aria-expanded')).toBe('true')
    // The button is the secondary action — it did not flip the switch.
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await chooseLimit('Max subtasks', '10')
    await chooseLimit('In flight at once', '2')
    // A limit is a statement about a dispatch that will happen: setting one turns it on.
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(hint()).not.toBeNull()
    expect(readDraft().dispatch).toEqual({ maxSubtasks: 10, inFlight: 2 })

    fireEvent.change(textarea(), { target: { value: 'Fan out the review' } })
    await startTask()
    expect((postedBody() as Record<string, unknown>).dispatch).toEqual({ maxSubtasks: 10, inFlight: 2 })
  })

  it('the settings offer the host runners and the model catalog of the chosen subtask runner', async () => {
    const toggle = await readyWithDispatch({ health: { ...HEALTH_DISPATCH, checks: HEALTH_MULTI.checks }, providerStatus: PROVIDERS_MULTI })
    fireEvent.click(settingsTrigger()!)
    await waitFor(() => expect(settings()).not.toBeNull())

    expect(await limitChoices('Subtask runner')).toEqual(['same as parent', 'claude', 'codex'])
    // "same as parent" resolves against the parent's (claude) catalog — the live one.
    await waitFor(async () => expect(await limitChoices('Subtask model')).toEqual(['same as parent', 'opus', 'sonnet']))

    // Picking a model, then another runner: the model pin is dropped with it (presets are
    // per-runner), and the list becomes CODEX's — its own discovered catalog, not the parent's
    // and not the `auto`-only static presets discovery replaced (#784/#794).
    await chooseLimit('Subtask model', 'sonnet')
    expect(readDraft().dispatch).toEqual({ model: 'sonnet' })
    await chooseLimit('Subtask runner', 'codex')
    expect(readDraft().dispatch).toEqual({ runner: 'codex' })
    await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/models?runner=codex')).toBe(true))
    await waitFor(async () => expect(await limitChoices('Subtask model')).toEqual(['same as parent', 'gpt-future']))
    await chooseLimit('Subtask model', 'gpt-future')
    expect(readDraft().dispatch).toEqual({ runner: 'codex', model: 'gpt-future' })
    fireEvent.change(screen.getByLabelText('Budget per subtask'), { target: { value: '2.5' } })
    expect(readDraft().dispatch).toEqual({ runner: 'codex', model: 'gpt-future', budgetUsd: 2.5 })

    // Back to the parent's runner: the pin is dropped again and the parent's catalog returns.
    await chooseLimit('Subtask runner', 'same as parent')
    expect(readDraft().dispatch).toEqual({ budgetUsd: 2.5 })
    expect(await limitChoices('Subtask model')).toEqual(['same as parent', 'opus', 'sonnet'])

    // The header switch is the same on/off as the row's.
    fireEvent.click(document.querySelector('[data-slot="dispatch-settings-switch"]')!)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(readDraft().dispatch).toBeNull()
  })

  it("a Codex subtask under a Claude parent can pin a Codex model, and it rides the body", async () => {
    await readyWithDispatch({ health: { ...HEALTH_DISPATCH, checks: HEALTH_MULTI.checks }, providerStatus: PROVIDERS_MULTI })
    fireEvent.click(settingsTrigger()!)
    await waitFor(() => expect(settings()).not.toBeNull())

    // The composer itself stays on claude — only the SUBTASKS run as codex.
    await chooseLimit('Subtask runner', 'codex')
    await waitFor(async () => expect(await limitChoices('Subtask model')).toEqual(['same as parent', 'gpt-future']))
    await chooseLimit('Subtask model', 'gpt-future')

    fireEvent.change(textarea(), { target: { value: 'Fan this out to codex' } })
    await startTask()
    const body = postedBody() as Record<string, unknown>
    expect(body.dispatch).toEqual({ runner: 'codex', model: 'gpt-future' })
    // The parent's own engine is untouched by the subtask pick.
    expect(body).not.toHaveProperty('model')
  })

  it('on a phone the settings are a bottom sheet, not a popover', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query !== '(min-width: 768px)',
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })),
    )
    const toggle = await readyWithDispatch()
    // The same Limits button as on desktop — it opens a sheet here instead.
    fireEvent.click(settingsTrigger()!)
    await waitFor(() => expect(settings()).not.toBeNull())
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(settings()?.getAttribute('data-slot')).toBe('dispatch-settings')
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull()
    expect(settings()?.closest('[data-slot="popover-content"]')).toBeNull()
    expect(settings()?.getAttribute('role')).toBe('dialog')

    // The sheet's close button is absolutely positioned over the top-right corner, which is where
    // the settings header keeps its on/off switch — without the reserved strip the X swallows it.
    expect(settings()?.className).toContain('pt-16')
  })

  it('survives a remount through the draft, and is dropped when the server no longer offers it', async () => {
    const first = await readyWithDispatch()
    fireEvent.click(first)
    expect(readDraft().dispatch).toEqual({})
    cleanup()

    // Same draft, dispatch turned off server-side: no switch, and the stored intent is not sent.
    serve()
    renderNewTask()
    await pillReady()
    await openRunOptions()
    expect(dispatchToggle()).toBeNull()
    expect(worktreeToggle().disabled).toBe(false)
    fireEvent.change(textarea(), { target: { value: 'Server says no' } })
    await startTask()
    expect(postedBody()).not.toHaveProperty('dispatch')
  })
})
