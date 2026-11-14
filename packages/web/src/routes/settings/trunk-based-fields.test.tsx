import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * Project settings → Tasks, trunk-based fields (spec 2026-10-20-trunk-based-projects): the
 * trunk-based preset is one write, every key stays adjustable, and every save is a PUT to the
 * project-scoped `/api/v1/config`.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(config: Partial<ConfigResponse> = {}) {
  requests = []
  const state: ConfigResponse = {
    baseBranch: null,
    defaultRunner: 'claude',
    systemPrompt: null,
    branchNaming: null,
    defaultModels: {},
    modelsLocked: false,
    maxParallel: 2,
    memoryLimitMb: null,
    worktreeRetention: 10,
    liveTitleUpdates: null,
    reviewGate: null,
    profile: null, taskWorkspace: null, landing: null, landingBlocked: null, requiredChecks: [], defaultSkill: null, askSkill: null, teamSkills: true,
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
      if (url === '/api/v1/config' && method === 'GET') return json(state)
      if (url === '/api/v1/config' && method === 'PUT') {
        Object.assign(state, body)
        return json(state)
      }
      if (url === '/api/v1/skills') return json([{ name: 'ingest' }, { name: 'ask' }])
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
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

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppRoutes />
          <Toaster />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const slot = <T extends Element>(name: string) => document.querySelector<T>(`[data-slot="${name}"]`)
const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/config').map((r) => r.body)

/** Radix Select in jsdom: open from the keyboard, pick with a click on the option. */
async function pick(trigger: Element, option: string | RegExp) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Project settings → Tasks: trunk-based projects', () => {
  it('shows the branch-per-task defaults when nothing is configured', async () => {
    serve()
    renderAt('/settings/tasks')
    await waitFor(() => expect(slot('tasks-profile')).not.toBeNull())
    expect(slot('tasks-profile')!.getAttribute('data-value')).toBe('branches')
    expect(slot('tasks-workspace')!.getAttribute('data-value')).toBe('')
    expect(slot<HTMLButtonElement>('tasks-landing')!.getAttribute('aria-checked')).toBe('false')
  })

  it('applies the trunk-based preset in one write, and clears it again', async () => {
    serve()
    renderAt('/settings/tasks')
    await waitFor(() => expect(slot('tasks-profile')).not.toBeNull())
    await pick(slot('tasks-profile')!, 'Trunk-based')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]).toEqual({ profile: 'trunk', taskWorkspace: 'in-place', landing: 'auto', reviewGate: false })
    await waitFor(() => expect(slot<HTMLButtonElement>('tasks-landing')!.getAttribute('aria-checked')).toBe('true'))
    await pick(slot('tasks-profile')!, 'Branch per task')
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]).toMatchObject({ profile: null, taskWorkspace: null, landing: null })
  })

  it('saves required checks one per line, and shows why auto-land is not honored', async () => {
    serve({ landing: 'auto', landingBlocked: 'config.json is tracked by git' })
    renderAt('/settings/tasks')
    await waitFor(() => expect(slot('tasks-required-checks')).not.toBeNull())
    expect(slot('tasks-landing-blocked')?.textContent).toContain('tracked by git')
    const area = slot<HTMLTextAreaElement>('tasks-required-checks')!
    fireEvent.change(area, { target: { value: 'node scripts/kb.ts validate\n\n  npm test  ' } })
    fireEvent.blur(area)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]).toEqual({ requiredChecks: ['node scripts/kb.ts validate', 'npm test'] })
  })

  it('turns team skill repositories off', async () => {
    serve()
    renderAt('/settings/tasks')
    await waitFor(() => expect(slot('tasks-team-skills')).not.toBeNull())
    fireEvent.click(slot('tasks-team-skills')!)
    await waitFor(() => expect(puts()).toEqual([{ teamSkills: false }]))
  })

  it('renders every control as a FormRow with Radix selects — no native select on the page (UI strategy)', async () => {
    serve()
    renderAt('/settings/tasks')
    await waitFor(() => expect(slot('tasks-profile')).not.toBeNull())
    expect(document.querySelector('select')).toBeNull()
    expect(document.querySelector('input[type="number"]')).toBeNull()
    expect(slot('tasks-profile')!.getAttribute('role')).toBe('combobox')
    const rows = document.querySelectorAll('[data-slot="form-row"]')
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(document.querySelectorAll('[data-slot="settings-card"]').length).toBeGreaterThanOrEqual(3)
    // No per-field Save or Reset button: controls save on change.
    expect(screen.queryByRole('button', { name: /^(save|reset)/i })).toBeNull()
  })

  it('says "Saved" inline on the row that changed', async () => {
    serve()
    renderAt('/settings/tasks')
    await waitFor(() => expect(slot('tasks-team-skills')).not.toBeNull())
    fireEvent.click(slot('tasks-team-skills')!)
    await waitFor(() => expect(puts()).toEqual([{ teamSkills: false }]))
    const row = slot('tasks-team-skills')!.closest('[data-slot="form-row"]')!
    await waitFor(() => expect(row.getAttribute('data-saved')).toBe(''))
    expect(document.querySelectorAll('[data-slot="form-row"][data-saved]')).toHaveLength(1)
  })
})
