import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Resources (step 3.5): `maxParallel` and `memoryLimitMb` moved out of the
 * per-repo config into `~/.cezar/config.json` (spec §"Resource governance" — they protect the
 * host, not a repo). What this pins is the store: every read and write goes to
 * `/api/v1/workspace/config`, and the per-repo `/api/v1/config` is never touched from here — a
 * regression there would silently re-introduce a value the engine no longer reads.
 *
 * The route contract itself (bounds, the semaphore refresh) is pinned server-side in
 * src/server/workspace-api.test.ts.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(resources: Partial<WorkspaceConfigResponse['resources']> = {}) {
  requests = []
  const state: WorkspaceConfigResponse = {
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
    resources: { maxParallel: 2, maxMonitoringSessions: 2, monitoringWakeIntervalMinutes: null, memoryLimitMb: null, worktreeRetentionDefault: 10, ...resources },
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
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        Object.assign(state.resources, (body?.resources ?? {}) as object)
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates so the shell renders immediately. The global settings area is
 *  unscoped, but the gates still answer for the chrome rendered around it. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderResources() {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <MemoryRouter initialEntries={['/settings/global/resources']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const parallelSelect = () =>
  document.querySelector<HTMLSelectElement>('[data-slot="resources-max-parallel"]')
const memoryInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-memory-limit"]')
const saveMemory = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-memory"]')
const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')
const monitoringSelect = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-max-monitoring"]')
const wakeMode = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-monitoring-wake-mode"]')
const wakeInterval = () => document.querySelector<HTMLInputElement>('[data-slot="resources-monitoring-wake-interval"]')
const saveWake = () => document.querySelector<HTMLButtonElement>('[data-action="resources-save-monitoring-wake"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Resources', () => {
  it('renders the workspace values, read from /api/v1/workspace/config', async () => {
    serve({ maxParallel: 5, memoryLimitMb: 4096 })
    renderResources()

    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    expect(parallelSelect()!.value).toBe('5')
    expect(memoryInput()!.value).toBe('4096')
    // The per-repo config is not even read by this pane.
    expect(requests.some((r) => r.url === '/api/v1/config')).toBe(false)
  })

  it('saves maxParallel to the WORKSPACE config, never the per-repo one', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())

    fireEvent.change(parallelSelect()!, { target: { value: '6' } })

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxParallel: 6 } })
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/config')).toBe(false)
  })

  it('links workspace limits to the per-project controls', async () => {
    serve()
    renderResources()

    const link = await screen.findByRole('link', { name: 'Configure per-project limits' })
    expect(link.getAttribute('href')).toBe('/settings/global/projects')
    expect(screen.getByText(/Need a different limit for one project/)).not.toBeNull()
  })

  it('saves the extra monitoring capacity and explains the two pools', async () => {
    serve({ maxParallel: 4, maxMonitoringSessions: 2 })
    renderResources()
    await waitFor(() => expect(monitoringSelect()).not.toBeNull())
    expect(screen.getByText(/Capacity: 4 active \+ 2 monitoring/)).not.toBeNull()
    fireEvent.change(monitoringSelect()!, { target: { value: '3' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxMonitoringSessions: 3 } })
  })

  it('keeps wake-ups parked by default and saves an explicit interval', async () => {
    serve({ monitoringWakeIntervalMinutes: null })
    renderResources()
    await waitFor(() => expect(wakeMode()).not.toBeNull())
    expect(wakeMode()!.value).toBe('park')
    expect(wakeInterval()).toBeNull()
    fireEvent.change(wakeMode()!, { target: { value: 'interval' } })
    expect(wakeInterval()!.value).toBe('5')
    fireEvent.click(saveWake()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { monitoringWakeIntervalMinutes: 5 } })
  })

  it('saves a memory limit, and an empty field clears it back to "no limit"', async () => {
    serve({ memoryLimitMb: null })
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())

    fireEvent.change(memoryInput()!, { target: { value: '2048' } })
    fireEvent.click(saveMemory()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { memoryLimitMb: 2048 } })

    fireEvent.change(memoryInput()!, { target: { value: '' } })
    fireEvent.click(saveMemory()!)
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ resources: { memoryLimitMb: null } })
  })

  it('rejects a memory limit below the floor — Save stays disabled and nothing is PUT', async () => {
    serve()
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())

    for (const bad of ['12', '1024.5', '-1']) {
      fireEvent.change(memoryInput()!, { target: { value: bad } })
      expect(saveMemory()!.disabled).toBe(true)
      expect(document.querySelector('[data-slot="resources-memory-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })

  it('worktree retention is NOT here — it stayed with the project', async () => {
    serve()
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    expect(document.querySelector('[data-slot="resources-worktree-retention"]')).toBeNull()
    expect(screen.queryByText('Keep last N worktrees')).toBeNull()
  })

  it('renders and saves New task On/Off/Inherit policy', async () => {
    serve()
    renderResources()
    const autonomous = await screen.findByLabelText('Autonomous by default')
    const worktree = screen.getByLabelText('Use a worktree by default')
    expect((autonomous as HTMLSelectElement).value).toBe('inherit')
    expect(screen.getByText(/Source-dependent — skills on, workflows off/)).toBeTruthy()

    fireEvent.change(autonomous, { target: { value: 'off' } })
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({
      composerDefaults: { autonomous: false },
    }))
    fireEvent.change(worktree, { target: { value: 'on' } })
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({
      composerDefaults: { worktree: true },
    }))
  })
})
