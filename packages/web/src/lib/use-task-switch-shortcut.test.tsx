import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import * as telemetry from './telemetry'
import { SWITCH_TASK_EVENT, TaskSwitchShortcut } from './use-task-switch-shortcut'

vi.mock('@/lib/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telemetry')>()
  return { ...actual, trackTaskSwitched: vi.fn() }
})

function run(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: id,
    status: 'done',
    createdAt: '2026-10-21T08:00:00Z',
    finishedAt: '2026-10-21T08:05:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }
}

// Sidebar order: waiting (needs you), then review, then the two finished ones.
const RUNS = [
  run('old', { finishedAt: '2026-10-21T07:00:00Z' }),
  run('waiting', { status: 'waiting' }),
  run('new'),
  run('review', { status: 'review' }),
]

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/api/v1/runs') return json(RUNS)
    if (path === '/api/v1/projects') return json({ projects: [], bootProject: 'default', projectsDir: '/repos' })
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  })
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.mocked(telemetry.trackTaskSwitched).mockClear()
})

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

async function mount(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <TaskSwitchShortcut />
        <LocationProbe />
        <textarea data-testid="composer" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // The ring is the run list; wait for it so the first press has somewhere to go.
  await waitFor(() => expect(client.getQueryData(['default', 'runs', 'list'])).toBeDefined())
  await act(async () => {})
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element | Window = window) =>
  act(() => {
    fireEvent.keyDown(target, { key, altKey: true, ...init })
  })
const location = () => screen.getByTestId('location').textContent

describe('⌥↑ / ⌥↓', () => {
  it('walk the sidebar order from the task on screen and wrap', async () => {
    await mount('/tasks/waiting')
    await press('ArrowDown')
    await waitFor(() => expect(location()).toBe('/tasks/review'))
    await press('ArrowUp')
    await waitFor(() => expect(location()).toBe('/tasks/waiting'))
    await press('ArrowUp')
    await waitFor(() => expect(location()).toBe('/tasks/old'))
    expect(telemetry.trackTaskSwitched).toHaveBeenCalledWith('arrow')
  })

  it('start at the top from a page that is not a task', async () => {
    await mount('/tasks')
    await press('ArrowDown')
    await waitFor(() => expect(location()).toBe('/tasks/waiting'))
  })

  it('with ⇧ visit only the tasks that need you', async () => {
    await mount('/tasks/new')
    await press('ArrowDown', { shiftKey: true })
    await waitFor(() => expect(location()).toBe('/tasks/waiting'))
    await press('ArrowDown', { shiftKey: true })
    await waitFor(() => expect(location()).toBe('/tasks/review'))
    await press('ArrowDown', { shiftKey: true })
    await waitFor(() => expect(location()).toBe('/tasks/waiting'))
  })

  it('fire from a text field, like Slack, but not with ⌘ held', async () => {
    await mount('/tasks/waiting')
    await press('ArrowDown', {}, screen.getByTestId('composer'))
    await waitFor(() => expect(location()).toBe('/tasks/review'))
    await press('ArrowDown', { metaKey: true })
    await act(async () => {})
    expect(location()).toBe('/tasks/review')
  })

  it('the desktop shell’s global chord arrives as an event and walks the Needs-you ring', async () => {
    await mount('/tasks/new')
    const send = (detail: unknown) =>
      act(() => {
        window.dispatchEvent(new CustomEvent(SWITCH_TASK_EVENT, { detail }))
      })
    await send('next')
    await waitFor(() => expect(location()).toBe('/tasks/waiting'))
    await send('previous')
    await waitFor(() => expect(location()).toBe('/tasks/review'))
    await send('sideways')
    await act(async () => {})
    expect(location()).toBe('/tasks/review')
    expect(telemetry.trackTaskSwitched).toHaveBeenCalledWith('arrow')
  })

  it('stay quiet under a dialog', async () => {
    await mount('/tasks/waiting')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await press('ArrowDown')
    await act(async () => {})
    expect(location()).toBe('/tasks/waiting')
    dialog.remove()
  })
})
