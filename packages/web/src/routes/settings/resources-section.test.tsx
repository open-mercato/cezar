import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { ThemeProvider } from '@/components/theme-provider'

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
      maxSubagents: null,
      maxReviewers: null,
      autoScale: false,
      effective: { maxParallel: 2, maxSubagents: null, maxReviewers: null },
      agentCpuPriority: 'normal',
      hostReserve: { memoryMb: null, cpuPct: null },
      totalAgentMemoryMb: null,
      worktreeRetentionDefault: 10,
      ...resources,
    },
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
      <ThemeProvider>
        <MemoryRouter initialEntries={['/settings/global/resources']}>
          <AppRoutes />
          <Toaster />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const parallelSelect = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-max-parallel"]')
const memoryInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-memory-limit"]')
const saveMemory = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-memory"]')
const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')
const monitoringSelect = () => document.querySelector<HTMLInputElement>('[data-slot="resources-max-monitoring"]')
const idleTimeout = () => document.querySelector<HTMLInputElement>('[data-slot="resources-idle-timeout"]')
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

  it('the responsiveness preset writes low priority plus a host reserve in one PUT', async () => {
    serve({})
    renderResources()
    await waitFor(() => expect(document.querySelector('[data-slot="resources-responsive-preset"]')).not.toBeNull())

    fireEvent.change(document.querySelector('[data-slot="resources-responsive-preset"]')!, { target: { value: 'on' } })

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      resources: { agentCpuPriority: 'low', hostReserve: { memoryMb: 2048, cpuPct: 90 } },
    })
  })

  it('the preset keeps a custom reserve and priority already set', async () => {
    serve({ agentCpuPriority: 'idle', hostReserve: { memoryMb: 4096, cpuPct: null } })
    renderResources()
    await waitFor(() => expect(document.querySelector('[data-slot="resources-responsive-preset"]')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="resources-responsive-preset"]')!, { target: { value: 'on' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      resources: { agentCpuPriority: 'idle', hostReserve: { memoryMb: 4096, cpuPct: 90 } },
    })
  })

  it('saves the host headroom fields and rejects a value below the floor', async () => {
    serve({})
    renderResources()
    const mem = () => document.querySelector<HTMLInputElement>('[data-slot="resources-reserve-memory"]')!
    const save = () => document.querySelector<HTMLButtonElement>('[data-action="resources-save-host-headroom"]')!
    await waitFor(() => expect(document.querySelector('[data-slot="resources-reserve-memory"]')).not.toBeNull())

    fireEvent.change(mem(), { target: { value: '12' } })
    expect(save().disabled).toBe(true)
    expect(document.querySelector('[data-slot="resources-host-invalid"]')).not.toBeNull()

    fireEvent.change(mem(), { target: { value: '3072' } })
    fireEvent.change(document.querySelector('[data-slot="resources-total-agent-memory"]')!, { target: { value: '8192' } })
    fireEvent.click(save())
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      resources: { hostReserve: { memoryMb: 3072, cpuPct: null }, totalAgentMemoryMb: 8192 },
    })
  })

  it('saves a separate sub-agent pool and an empty field returns it to sharing', async () => {
    serve({ maxSubagents: 6 })
    renderResources()
    const pool = () => document.querySelector<HTMLInputElement>('[data-slot="resources-max-subagents"]')
    await waitFor(() => expect(pool()).not.toBeNull())
    expect(pool()!.value).toBe('6')

    fireEvent.change(pool()!, { target: { value: '40' } })
    fireEvent.keyDown(pool()!, { key: 'Enter' })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxSubagents: 40 } })

    fireEvent.change(pool()!, { target: { value: '' } })
    fireEvent.keyDown(pool()!, { key: 'Enter' })
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ resources: { maxSubagents: null } })
  })

  it('accepts up to 128 parallel tasks', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    fireEvent.change(parallelSelect()!, { target: { value: '100' } })
    fireEvent.keyDown(parallelSelect()!, { key: 'Enter' })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxParallel: 100 } })
  })

  it('shows "effective X of Y" while autoScale has lowered a limit', async () => {
    serve({
      maxParallel: 8,
      autoScale: true,
      maxReviewers: 4,
      effective: { maxParallel: 3, maxSubagents: null, maxReviewers: 4 },
    })
    renderResources()
    await waitFor(() => expect(document.querySelector('[data-slot="resources-effective"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="resources-effective"]')!.textContent).toBe(
      'Right now: tasks effective 3 of 8, reviewers 4.',
    )
    fireEvent.change(document.querySelector('[data-slot="resources-auto-scale"]')!, { target: { value: 'off' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { autoScale: false } })
  })

  it('saves maxParallel to the WORKSPACE config, never the per-repo one', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())

    fireEvent.change(parallelSelect()!, { target: { value: '6' } })
    fireEvent.keyDown(parallelSelect()!, { key: 'Enter' })

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
    fireEvent.blur(monitoringSelect()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxMonitoringSessions: 3 } })
  })

  it('saves the waiting-session idle timeout and allows disabling it', async () => {
    serve({ idleTimeoutMinutes: 15 })
    renderResources()
    await waitFor(() => expect(idleTimeout()).not.toBeNull())
    expect(idleTimeout()!.value).toBe('15')
    fireEvent.change(idleTimeout()!, { target: { value: '0' } })
    fireEvent.blur(idleTimeout()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { idleTimeoutMinutes: 0 } })
  })

  it('is a typed integer field with arrows, not a dropdown — stepping saves once', async () => {
    serve({ maxParallel: 2, maxMonitoringSessions: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    expect(parallelSelect()!.tagName).toBe('INPUT')
    expect(monitoringSelect()!.tagName).toBe('INPUT')

    const increase = screen.getByRole('button', { name: 'Increase Max parallel tasks' })
    fireEvent.click(increase)
    fireEvent.click(increase)
    expect(parallelSelect()!.value).toBe('4')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxParallel: 4 } })
  })

  it('refuses a limit outside the range the server accepts', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    fireEvent.change(parallelSelect()!, { target: { value: '129' } })
    fireEvent.blur(parallelSelect()!)
    expect(screen.getByText('Enter a whole number from 1 to 128.')).not.toBeNull()
    expect(puts()).toHaveLength(0)
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

  it('shows auto-resume on by default and saves the opt-out', async () => {
    serve()
    renderResources()
    const select = (await screen.findByLabelText('Auto-resume after a usage limit')) as HTMLSelectElement
    // The shipped default (spec 2026-08-03-auto-resume-after-usage-limit) — a user who never
    // opens this pane still gets their limited tasks finished.
    expect(select.value).toBe('on')

    fireEvent.change(select, { target: { value: 'off' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { autoResumeOnUsageLimit: false } })
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
