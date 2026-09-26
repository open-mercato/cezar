import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { AutomationEditor } from './editor'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const health = (dispatch = true) => ({
  version: '0.0.0-test',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  forge: null,
  capabilities: { localHandoff: true, followups: true, singleProject: false, automations: true, dispatch, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true },
  defaultRunner: 'claude',
  checks: [{ name: 'claude', available: true }],
  projects: [],
  bootProject: 'p1',
})

const PROVIDERS = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

const WORKFLOWS = {
  workflows: [
    { name: 'quick-task', description: 'Single step', source: 'built-in', steps: [] },
    { name: 'fix-and-verify', source: 'built-in', steps: [] },
  ],
  issues: [],
}

const SKILLS = [
  { name: 'om-review', description: 'Review a pull request', path: '/repo/.claude/skills/om-review/SKILL.md', source: 'project' },
]

const REPO = { info: { root: '/repo', branch: 'main' }, status: [], log: [], branches: ['main', 'develop'], baseBranch: 'develop' }

const DATA: AutomationsResponse = {
  available: true,
  scheduler: { state: 'idle' },
  timeZone: 'Europe/Warsaw',
  stats: { runs: 0, failed: 0, agentSeconds: 0 },
  automations: [],
}

const EXISTING: AutomationListEntry = {
  id: 'a1',
  revision: 4,
  name: 'Nightly dependency bump',
  enabled: true,
  kind: 'schedule',
  schedule: { type: 'daily', hour: 4, minute: 0 },
  task: { prompt: 'Run npm outdated and bump.', workflow: 'fix-and-verify', autonomous: true, dispatch: { maxSubtasks: 4, reviewChild: true } },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
  counts: { matches: 0, launched: 3, duplicates: 0, errors: 0 },
  runs7d: 3,
  costUsd7d: 1.02,
  lastRun: { runId: 'r9', status: 'done', ts: '2026-09-14T04:00:00.000Z', costUsd: 0.33 },
}

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(
  overrides: Record<string, () => Response | Promise<Response>> = {},
  opts: { dispatch?: boolean } = {},
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    sent.push({ path, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
    const override = overrides[`${method} ${path}`]
    if (override) return override()
    if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(opts.dispatch ?? true))
    if (method === 'GET' && path === '/api/v1/providers/status') return jsonResponse(PROVIDERS)
    if (method === 'GET' && path === '/api/v1/config') return jsonResponse({ defaultRunner: 'claude', defaultModels: {}, modelsLocked: false })
    if (method === 'GET' && path === '/api/v1/models?runner=claude') return jsonResponse({ runner: 'claude', models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }], source: 'live', stale: false })
    if (method === 'GET' && path === '/api/v1/workflows') return jsonResponse(WORKFLOWS)
    if (method === 'GET' && path.startsWith('/api/v1/skills')) return jsonResponse(SKILLS)
    if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(REPO)
    if (method === 'GET' && path === '/api/v1/ui-state') return jsonResponse({})
    if (method === 'GET' && path === '/api/v1/workspace/automation-templates') return jsonResponse({ templates: [] })
    if (method === 'POST' && path === '/api/v1/automations') return jsonResponse({ automation: { ...EXISTING, id: 'new', revision: 1 } }, 201)
    if (method === 'PUT' && path === '/api/v1/automations/a1') return jsonResponse({ automation: { ...EXISTING, revision: 5 } })
    return jsonResponse({ error: `unmocked ${method} ${path}` }, 404)
  }))
  return sent
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderEditor(props: Partial<Parameters<typeof AutomationEditor>[0]> = {}) {
  const onBack = vi.fn()
  const onSaved = vi.fn()
  const onLog = vi.fn()
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/automations/new']}>
        <Routes>
          <Route path="*" element={<><AutomationEditor data={DATA} onBack={onBack} onSaved={onSaved} onLog={onLog} {...props} /><LocationProbe /><Toaster /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onBack, onSaved, onLog, client }
}

const sourcePill = () => screen.getByRole('button', { name: 'Choose a skill or workflow' })
const saveButton = () => screen.getByRole('button', { name: /^Save/ })
const fillRequired = (name = 'Nightly bump', prompt = 'Bump the deps.') => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: prompt } })
}

// ---- new ------------------------------------------------------------------------------------

describe('AutomationEditor — new', () => {
  it('opens with the palette, a paused daily draft, and a save disabled until name and prompt', () => {
    stubFetch()
    renderEditor()
    expect(screen.getByRole('heading', { name: 'New automation' })).not.toBeNull()
    expect(document.querySelector('[data-slot="template-palette"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Hide templates' })).not.toBeNull()
    expect(saveButton().textContent).toContain('Save paused')
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-slot="editor-cron"]')?.textContent).toBe('0 4 * * *')
    expect(screen.getByText('Europe/Warsaw')).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="next-run"]')).toHaveLength(5)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly bump' } })
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Bump the deps.' } })
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    expect(saveButton().textContent).toContain('Save and enable')
  })

  it('posts a schedule body with enable per the switch and reports back', async () => {
    const sent = stubFetch()
    const { onSaved } = renderEditor()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fri' }))
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '16' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const post = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/automations')
    expect(post?.body).toEqual({
      name: 'Nightly bump',
      kind: 'schedule',
      schedule: { type: 'weekly', hour: 16, minute: 0, day: 5 },
      task: { prompt: 'Bump the deps.', workflow: 'quick-task', autonomous: true },
      enable: true,
    })
  })

  it('runs a picked skill as a one-step inline chain, as /new sends it', async () => {
    // cmdk's dropdown needs what jsdom lacks — the same stubs /new's picker tests use.
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const sent = stubFetch()
    const { onSaved } = renderEditor()
    fillRequired()
    await waitFor(() => expect((sourcePill() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    fireEvent.click(document.querySelector('[data-source-ref="om-review"]')!)
    expect(sourcePill().getAttribute('data-source-kind')).toBe('skill')
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const post = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/automations')
    expect((post?.body as { task: unknown }).task).toEqual({
      prompt: 'Bump the deps.',
      steps: [{ id: 'task', name: 'om-review', skill: 'om-review', prompt: '{{task}}' }],
      autonomous: true,
    })
  })

  it('posts a github body with the events, interval and filters', async () => {
    const sent = stubFetch()
    const { onSaved } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'When GitHub changes' }))
    expect(screen.getByText('How it polls')).not.toBeNull()
    expect(screen.getByText(/from a current-time baseline/)).not.toBeNull()
    fillRequired('Triage', 'Read {{github.url}}')
    fireEvent.click(screen.getByRole('button', { name: 'issue.labeled' }))
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    fireEvent.change(screen.getByLabelText('Changed labels (required)'), { target: { value: 'bug, needs-triage' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const post = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/automations')
    expect(post?.body).toEqual({
      name: 'Triage',
      kind: 'github',
      events: ['issue.opened', 'issue.labeled'],
      intervalSeconds: 300,
      filters: { changedLabels: ['bug', 'needs-triage'], lookbackDays: 7, maxRecords: 25 },
      task: { prompt: 'Read {{github.url}}', workflow: 'quick-task', autonomous: true },
      enable: false,
    })
  })

  it('"Use this" fills the form from a template and closes the palette', async () => {
    stubFetch()
    renderEditor()
    // The dispatch row appears once health has answered the capability.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Dispatch' })).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Use this: Flaky test hunt' }))
    expect(document.querySelector('[data-slot="template-palette"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Start from a template' })).not.toBeNull()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Flaky test hunt')
    expect((screen.getByLabelText('Prompt') as HTMLInputElement).value).toBe('Run the suite 5×, quarantine intermittent tests, open an issue per test.')
    expect(screen.getByRole('button', { name: 'Tue' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-slot="editor-cron"]')?.textContent).toBe('0 2 * * 2')
    expect(screen.getByRole('switch', { name: 'Dispatch' }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-slot="editor-dispatch-hint"]')?.textContent).toBe('≤ 9 agents')
    // Built-in templates name no workflow, so the cockpit default (no skill = quick-task) stays.
    expect(sourcePill().getAttribute('data-source-kind')).toBe('none')
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('inserts a prompt template at the caret and offers Manage… into Settings', async () => {
    stubFetch()
    renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tests' })).not.toBeNull())
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Bump deps.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add tests' }))
    expect((screen.getByLabelText('Prompt') as HTMLInputElement).value).toBe('Bump deps.\n\nAlso add or update tests covering this change.')
    fireEvent.click(screen.getByRole('button', { name: 'Manage…' }))
    expect(screen.getByTestId('location').textContent).toBe('/settings/prompt-templates')
  })

  it('hides the dispatch row when the cockpit has dispatch off', async () => {
    stubFetch({}, { dispatch: false })
    renderEditor()
    await waitFor(() => expect((sourcePill() as HTMLButtonElement).disabled).toBe(false))
    expect(document.querySelector('[data-slot="editor-dispatch"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review open PRs' })).toBeNull()
  })

  it('disables the GitHub segment with the reason when the forge is unavailable', () => {
    stubFetch()
    renderEditor({ data: { ...DATA, available: false, reason: 'no GitHub remote' } })
    const github = screen.getByRole('button', { name: 'When GitHub changes' })
    expect((github as HTMLButtonElement).disabled).toBe(true)
    expect(github.getAttribute('title')).toBe('no GitHub remote')
    expect((screen.getByRole('button', { name: 'On a schedule' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a 400 under the section it names and a generic failure at the top', async () => {
    stubFetch({ 'POST /api/v1/automations': () => jsonResponse({ error: 'schedule: hour must be at most 23' }, 400) })
    renderEditor()
    fillRequired()
    fireEvent.click(saveButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('schedule: hour must be at most 23')
    // Rendered inside the When section, right after the schedule fields.
    const section = alert.closest('[data-slot="editor-section"]')
    expect(section?.contains(document.querySelector('[data-slot="editor-schedule"]'))).toBe(true)
  })

  it('copies the CLI line and cancels back to the list', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    stubFetch()
    const { onBack } = renderEditor()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      'cez automation add --name "Nightly bump" --cron "0 4 * * *" --workflow "quick-task" --autonomous --prompt "Bump the deps."',
    ))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

// ---- edit -----------------------------------------------------------------------------------

describe('AutomationEditor — edit', () => {
  it('reads the definition, shows the state pill and the last run, and PUTs with expectedRevision', async () => {
    const sent = stubFetch()
    const runNow = vi.fn(async () => undefined)
    const { onSaved, onLog } = renderEditor({
      automation: EXISTING,
      actions: { preview: vi.fn(), runNow, toggleEnabled: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), copyCli: vi.fn(), busy: false },
    })
    expect(screen.getByRole('heading', { name: 'Edit automation' })).not.toBeNull()
    expect(screen.getByText('enabled').getAttribute('data-slot')).toBe('pill')
    expect(document.querySelector('[data-slot="template-palette"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /templates/ })).toBeNull()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Nightly dependency bump')
    await waitFor(() => expect(document.querySelector('[data-slot="editor-dispatch-hint"]')?.textContent).toBe('≤ 5 agents'))
    // The other kind is locked: a kind switch is a guaranteed 409.
    expect((screen.getByRole('button', { name: 'When GitHub changes' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(runNow).toHaveBeenCalledWith(EXISTING)
    fireEvent.click(screen.getByRole('button', { name: 'View log' }))
    expect(onLog).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly deps' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Dispatch' }))
    expect(saveButton().textContent).toContain('Save changes')
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const put = sent.find((request) => request.method === 'PUT')
    expect(put?.path).toBe('/api/v1/automations/a1')
    expect(put?.body).toEqual({
      name: 'Nightly deps',
      kind: 'schedule',
      schedule: { type: 'daily', hour: 4, minute: 0 },
      task: { prompt: 'Run npm outdated and bump.', workflow: 'fix-and-verify', autonomous: true },
      enabled: true,
      expectedRevision: 4,
    })
  })

  it('a stale revision shows the "edited elsewhere" alert with a Reload', async () => {
    stubFetch({ 'PUT /api/v1/automations/a1': () => jsonResponse({ error: 'revision mismatch' }, 409) })
    const { onSaved } = renderEditor({ automation: EXISTING })
    fireEvent.click(saveButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Edited elsewhere — reload to see the latest version')
    expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('tracker automation editor', () => {
  const association = { kind: 'jira', source: { id: 'cloud', webUrl: 'https://example.atlassian.net' }, externalId: '100', externalName: 'Team', connectionId: '11111111-1111-4111-8111-111111111111' }
  it('saves the selected historical event and status ID with the shared form', async () => {
    const sent = stubFetch({ 'GET /api/v1/tracker/automation-options': () => jsonResponse({ available: true, association, events: ['issue.opened', 'issue.status_changed'], statuses: [{ id: 'todo-id', name: 'To Do' }], labels: [], limitations: [] }) })
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'When Jira / Linear changes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Jira work' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Implement {{tracker.key}}' } })
    fireEvent.click(await screen.findByRole('button', { name: 'issue.status_changed' }))
    expect((screen.getByRole('button', { name: 'Save paused' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'To Do' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save paused' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
    await waitFor(() => expect(sent.find(request => request.method === 'POST' && request.path === '/api/v1/automations')?.body).toMatchObject({ kind: 'tracker', enable: false, intervalSeconds: 1800, trackerTrigger: { association, events: ['issue.status_changed'], targetStatusIds: ['todo-id'] } }))
  })
  it('does not offer unadvertised Linear history events', async () => {
    stubFetch({ 'GET /api/v1/tracker/automation-options': () => jsonResponse({ available: true, association: { ...association, kind: 'linear' }, events: ['issue.opened'], statuses: [], labels: [], limitations: ['Early changes are not fully recorded.'] }) })
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'When Jira / Linear changes' }))
    await screen.findByText('Early changes are not fully recorded.')
    expect(screen.queryByRole('button', { name: 'issue.status_changed' })).toBeNull()
  })
})

it('invalidates tracker event options on the existing tracker cache prefix', async () => {
  let connectionId = '11111111-1111-4111-8111-111111111111'
  stubFetch({ 'GET /api/v1/tracker/automation-options': () => jsonResponse({ available: true,
    association: { kind: 'jira', source: { id: 'cloud', webUrl: 'https://example.atlassian.net' }, externalId: '100', externalName: connectionId, connectionId },
    events: ['issue.opened'], statuses: [], labels: [], limitations: [] }) })
  const { client } = renderEditor()
  fireEvent.click(screen.getByRole('button', { name: 'When Jira / Linear changes' }))
  fireEvent.click(await screen.findByRole('button', { name: 'issue.opened' }))
  connectionId = '22222222-2222-4222-8222-222222222222'
  await act(async () => { await client.invalidateQueries({ queryKey: ['tracker'] }) })
  await screen.findByText('The tracker connection changed. Select an event again before saving.')
})
