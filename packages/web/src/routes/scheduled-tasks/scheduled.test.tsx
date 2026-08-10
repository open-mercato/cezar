import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  HealthResponse,
  ScheduledTaskPreviewResponse,
  ScheduledTasksResponse,
} from '@open-mercato/cezar-api-client'

import { ScheduledRoute } from './scheduled'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, scheduledTasks: true },
}

const HEALTH_OFF: HealthResponse = {
  ...HEALTH,
  capabilities: { ...HEALTH.capabilities, scheduledTasks: false },
}

const LIST: ScheduledTasksResponse = {
  scheduler: { state: 'scheduled', nextDue: '2026-08-10T18:00:00.000Z' },
  writable: true,
  scheduledTasks: [
    {
      id: 'st-1',
      revision: 1,
      name: 'Nightly summary',
      description: 'Summarize the day',
      enabled: true,
      timing: { kind: 'once', at: '2026-08-10T18:00:00.000Z', timezone: 'America/New_York' },
      task: { prompt: 'Summarize today', workflow: 'quick-task' },
      createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:00:00.000Z',
      displayStatus: 'pending',
      latestOccurrence: {
        seq: 1,
        occurrenceId: 'occ-1',
        occurrenceKey: 'st-1@2026-08-10T18:00:00.000Z',
        scheduledTaskId: 'st-1',
        revision: 1,
        scheduledFor: '2026-08-10T18:00:00.000Z',
        observedAt: '2026-08-10T18:00:01.000Z',
        trigger: 'scheduled',
        status: 'launched',
        runId: 'run-9',
        updatedAt: '2026-08-10T18:00:01.000Z',
      },
    },
  ],
}

const PREVIEW: ScheduledTaskPreviewResponse = {
  at: '2026-08-10T22:00:00.000Z',
  timezone: 'America/New_York',
  localLabel: 'Aug 10, 2026, 6:00 PM',
  utcLabel: 'Aug 10, 2026, 22:00 UTC',
  warnings: [],
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (repo-git.test.tsx): records requests, serves the scheduled
 *  fixtures + the editor's catalog reads, and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/scheduled-tasks') return jsonResponse(LIST)
      if (method === 'GET' && path === '/api/v1/workflows') return jsonResponse({ workflows: [{ name: 'quick-task', source: 'built-in', steps: [] }] })
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse([])
      if (method === 'GET' && path === '/api/v1/config') return jsonResponse({})
      if (method === 'POST' && path === '/api/v1/scheduled-tasks/preview') return jsonResponse(PREVIEW)
      if (method === 'POST' && path === '/api/v1/scheduled-tasks') return jsonResponse({ scheduledTask: { ...LIST.scheduledTasks[0], id: 'st-new' } }, 201)
      // A single-definition GET (detail/edit) — the save flow navigates here afterwards.
      if (method === 'GET' && /^\/api\/v1\/scheduled-tasks\/[^/?]+$/.test(path)) {
        const entry = LIST.scheduledTasks[0]!
        return jsonResponse({ scheduledTask: entry, displayStatus: entry.displayStatus, latestOccurrence: entry.latestOccurrence })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

/** Cold-load the scheduled surface at a URL, with the same route map routes.tsx registers. */
function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/scheduled" element={<ScheduledRoute />} />
          <Route path="/scheduled/new" element={<ScheduledRoute mode="new" />} />
          <Route path="/scheduled/:scheduledTaskId" element={<ScheduledRoute mode="detail" />} />
          <Route path="/scheduled/:scheduledTaskId/edit" element={<ScheduledRoute mode="edit" />} />
          <Route path="/scheduled/:scheduledTaskId/history" element={<ScheduledRoute mode="history" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

// ---- list ------------------------------------------------------------------------------------

describe('the scheduled list', () => {
  it('renders a row with its status as TEXT, the due instant, and the linked run', async () => {
    stubFetch()
    renderAt('/scheduled')

    await screen.findByText('Nightly summary')
    // The header carries the exact spec sentence about closed-cezar behaviour.
    expect(screen.getByText(/Postponed tasks run while cezar is open/)).toBeTruthy()

    const row = document.querySelector('[data-slot="scheduled-row"]') as HTMLElement
    // Status is text, not just colour.
    expect(within(row).getByText('Pending')).toBeTruthy()
    // The authoritative instant is a machine-readable <time>.
    const time = row.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe('2026-08-10T18:00:00.000Z')
    // The timezone the author chose is shown beside the local reading.
    expect(row.textContent).toContain('America/New_York')
    // The latest occurrence links to its run thread.
    expect(within(row).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/run-9')
  })

  it('shows the off explainer when the capability is absent', async () => {
    stubFetch({ 'GET /api/v1/health': () => jsonResponse(HEALTH_OFF) })
    renderAt('/scheduled')
    await screen.findByText('Scheduled tasks are off')
  })

  it('shows the friendly empty state with no scheduled tasks', async () => {
    stubFetch({ 'GET /api/v1/scheduled-tasks': () => jsonResponse({ scheduler: { state: 'idle' }, writable: true, scheduledTasks: [] }) })
    renderAt('/scheduled')
    await screen.findByText(/No scheduled tasks yet/)
  })

  it('notes read-only and disables Run now when the project is not writable', async () => {
    stubFetch({ 'GET /api/v1/scheduled-tasks': () => jsonResponse({ ...LIST, writable: false }) })
    renderAt('/scheduled')
    await screen.findByText('Nightly summary')
    expect(screen.getByText(/This project is read-only/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

// ---- editor ----------------------------------------------------------------------------------

describe('the scheduled editor', () => {
  it('computes and shows the authoritative preview from POST /scheduled-tasks/preview', async () => {
    const sent = stubFetch()
    renderAt('/scheduled/new')

    await screen.findByLabelText('Name')
    // The uploads-disabled explanation is present (attachments are unavailable for scheduled tasks).
    expect(screen.getByText(/Uploads are disabled for scheduled tasks/)).toBeTruthy()

    // The default date/time seed a preview request; its authoritative local label lands in the
    // aria-live region.
    await waitFor(() => expect(screen.getByText('Aug 10, 2026, 6:00 PM')).toBeTruthy())
    expect(sent.some((request) => request.method === 'POST' && request.path === '/api/v1/scheduled-tasks/preview')).toBe(true)
  })

  it('POSTs a CreateScheduledTaskInput and navigates to the new detail on save', async () => {
    const sent = stubFetch()
    renderAt('/scheduled/new')

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Release notes' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Draft the notes' } })
    // Wait for the source catalog + preview to settle so the built body carries the workflow.
    await waitFor(() => expect(screen.getByText('Aug 10, 2026, 6:00 PM')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Schedule task' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/scheduled/st-new'))
    const post = sent.find((request) => request.method === 'POST' && request.path === '/api/v1/scheduled-tasks')
    expect(post).toBeTruthy()
    const body = post!.body as { name: string; enabled: boolean; timing: { kind: string; localAt: string; timezone: string }; task: { prompt: string; workflow?: string } }
    expect(body.name).toBe('Release notes')
    expect(body.timing.kind).toBe('once')
    expect(typeof body.timing.localAt).toBe('string')
    expect(body.timing.timezone.length).toBeGreaterThan(0)
    expect(body.task.prompt).toBe('Draft the notes')
    expect(body.task.workflow).toBe('quick-task')
    // The one-shot transport keys never ride a stored template.
    expect('images' in body.task).toBe(false)
    expect('todoId' in body.task).toBe(false)
  })

  it('surfaces a 409 as an inline changed-elsewhere message', async () => {
    stubFetch({ 'POST /api/v1/scheduled-tasks': () => jsonResponse({ error: 'revision conflict' }, 409) })
    renderAt('/scheduled/new')

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Release notes' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Draft the notes' } })
    await waitFor(() => expect(screen.getByText('Aug 10, 2026, 6:00 PM')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Schedule task' }))
    await screen.findByText(/changed elsewhere/)
  })
})

// ---- history ---------------------------------------------------------------------------------

describe('the occurrence history', () => {
  it('lists occurrences newest-first with status, times and the run link', async () => {
    stubFetch({
      'GET /api/v1/scheduled-task-occurrences?scheduledTaskId=st-1': () =>
        jsonResponse({ occurrences: [LIST.scheduledTasks[0]!.latestOccurrence] }),
    })
    renderAt('/scheduled/st-1/history')

    await screen.findByText('Occurrence history')
    const item = document.querySelector('[data-slot="occurrence"]') as HTMLElement
    expect(within(item).getByText('launched')).toBeTruthy()
    expect(item.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-10T18:00:00.000Z')
    expect(within(item).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/run-9')
  })
})
