import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * Project settings → Worktrees: the "Keep last N worktrees" field (#483). Renders the
 * current value, saves the entered number (0 = unlimited, sent as a number so it
 * is never mistaken for "clear"), and rejects out-of-range / non-integer input.
 * The API contract itself is pinned server-side in src/server/config-api.test.ts.
 *
 * The field moved out of Resources into its own PROJECT section in step 3.5 (retention sizes
 * one repo's worktree pool). Its store did not move: every save below is a PUT to the
 * project-scoped `/api/v1/config`, which is exactly the half of the split this pins.
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
    worktreeRetention: 10, worktreeIdleDays: 7, worktreeIdleDaysOwn: false, archivedTaskDeleteDays: 90, archivedTaskDeleteDaysOwn: false,
    liveTitleUpdates: null,
    reviewGate: null,
    profile: null, taskWorkspace: null, landing: null, landingBlocked: null, requiredChecks: [], defaultSkill: null, askSkill: null, teamSkills: true, bypassPermissions: false, bypassPermissionsBlocked: null,
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
        if (body?.worktreeRetention !== undefined) {
          state.worktreeRetention = body.worktreeRetention as number
        }
        if (body?.worktreeIdleDays !== undefined) {
          // null clears back to the workspace default (7 in this stub).
          state.worktreeIdleDaysOwn = body.worktreeIdleDays !== null
          state.worktreeIdleDays = (body.worktreeIdleDays as number | null) ?? 7
        }
        if (body?.archivedTaskDeleteDays !== undefined) {
          // null clears back to the workspace default (90 in this stub).
          state.archivedTaskDeleteDaysOwn = body.archivedTaskDeleteDays !== null
          state.archivedTaskDeleteDays = (body.archivedTaskDeleteDays as number | null) ?? 90
        }
        return json(state)
      }
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

const retentionInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-worktree-retention"]')
const puts = () =>
  requests.filter(
    (r) => r.method === 'PUT' && r.url === '/api/v1/config' && (r.body as { worktreeRetention?: unknown })?.worktreeRetention !== undefined,
  )

/** The stepper commits a typed value on blur (or Enter) — the one text-field save model. */
const type = (value: string) => {
  fireEvent.change(retentionInput()!, { target: { value } })
  fireEvent.blur(retentionInput()!)
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Project settings → Worktrees: keep-last-N-worktrees (#483)', () => {
  it('renders the configured value in an IntegerStepper — no native number input, no Save button', async () => {
    serve({ worktreeRetention: 7 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())
    expect(retentionInput()!.value).toBe('7')
    expect(retentionInput()!.getAttribute('role')).toBe('spinbutton')
    expect(document.querySelector('input[type="number"]')).toBeNull()
    expect(document.querySelector('[data-action="resources-save-retention"]')).toBeNull()
    expect(retentionInput()!.closest('[data-slot="form-row"]')).not.toBeNull()
    expect(retentionInput()!.closest('[data-slot="settings-card"]')).not.toBeNull()
  })

  it('saves the committed count through PUT /api/v1/config and says Saved inline', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    type('3')

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 3 })
    await waitFor(() => expect(retentionInput()!.closest('[data-slot="form-row"]')!.getAttribute('data-saved')).toBe(''))
  })

  it('saves 0 as a real value (unlimited), not as a clear', async () => {
    serve({ worktreeRetention: 5 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    type('0')

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 0 })
  })

  it('rejects a negative, over-limit, or non-integer count (inline error, no PUT)', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    for (const bad of ['-1', '1001', '2.5', '']) {
      type(bad)
      expect(document.querySelector('[data-slot="stepper-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })
})

describe('Project settings → Worktrees: idle age (spec 2026-11-19-worktree-disk-usage)', () => {
  const mode = () => document.querySelector<HTMLButtonElement>('[data-slot="worktrees-idle-days-mode"]')
  const days = () => document.querySelector<HTMLInputElement>('[data-slot="worktrees-idle-days"]')
  const idlePuts = () => requests.filter((r) => r.method === 'PUT' && (r.body as { worktreeIdleDays?: unknown })?.worktreeIdleDays !== undefined)
  async function pick(trigger: HTMLElement, option: string) {
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: option }))
  }

  it('shows the inherited workspace value and no own field while inheriting', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ worktreeIdleDays: 7, worktreeIdleDaysOwn: false })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(mode()).not.toBeNull())
    expect(mode()!.getAttribute('data-value')).toBe('inherit')
    expect(days()).toBeNull()
    expect(screen.getByText(/Inherited from Settings → Behaviour: 7 days/)).not.toBeNull()
  })

  it('switching to "This project" saves the inherited value as its own; editing saves the new one', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ worktreeIdleDays: 7, worktreeIdleDaysOwn: false })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(mode()).not.toBeNull())
    await pick(mode()!, 'This project')
    await waitFor(() => expect(idlePuts()).toHaveLength(1))
    expect(idlePuts()[0]?.body).toEqual({ worktreeIdleDays: 7 })
    await waitFor(() => expect(days()).not.toBeNull())
    fireEvent.change(days()!, { target: { value: '0' } })
    fireEvent.blur(days()!)
    await waitFor(() => expect(idlePuts()).toHaveLength(2))
    expect(idlePuts()[1]?.body).toEqual({ worktreeIdleDays: 0 })
  })

  it('"Workspace default" clears the repo key with null', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ worktreeIdleDays: 3, worktreeIdleDaysOwn: true })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(days()).not.toBeNull())
    expect(days()!.value).toBe('3')
    await pick(mode()!, 'Workspace default')
    await waitFor(() => expect(idlePuts()).toHaveLength(1))
    expect(idlePuts()[0]?.body).toEqual({ worktreeIdleDays: null })
    await waitFor(() => expect(days()).toBeNull())
  })
})

describe('Project settings → Worktrees: archived-task lifetime (spec 2026-11-19-worktree-disk-usage)', () => {
  const mode = () => document.querySelector<HTMLButtonElement>('[data-slot="worktrees-archived-delete-days-mode"]')
  const days = () => document.querySelector<HTMLInputElement>('[data-slot="worktrees-archived-delete-days"]')
  const deletePuts = () =>
    requests.filter((r) => r.method === 'PUT' && (r.body as { archivedTaskDeleteDays?: unknown })?.archivedTaskDeleteDays !== undefined)
  async function pick(trigger: HTMLElement, option: string) {
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: option }))
  }

  it('shows the inherited workspace value and no own field while inheriting', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ archivedTaskDeleteDays: 90, archivedTaskDeleteDaysOwn: false })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(mode()).not.toBeNull())
    expect(mode()!.getAttribute('data-value')).toBe('inherit')
    expect(days()).toBeNull()
    expect(screen.getByText(/Inherited from Settings → Behaviour: after 90 days/)).not.toBeNull()
  })

  it('switching to "This project" saves the inherited value as its own; 0 saves "never"', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ archivedTaskDeleteDays: 90, archivedTaskDeleteDaysOwn: false })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(mode()).not.toBeNull())
    await pick(mode()!, 'This project')
    await waitFor(() => expect(deletePuts()).toHaveLength(1))
    expect(deletePuts()[0]?.body).toEqual({ archivedTaskDeleteDays: 90 })
    await waitFor(() => expect(days()).not.toBeNull())
    fireEvent.change(days()!, { target: { value: '0' } })
    fireEvent.blur(days()!)
    await waitFor(() => expect(deletePuts()).toHaveLength(2))
    expect(deletePuts()[1]?.body).toEqual({ archivedTaskDeleteDays: 0 })
    await waitFor(() => expect(screen.getByText(/This project: never\./)).not.toBeNull())
  })

  it('"Workspace default" clears the repo key with null', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    serve({ archivedTaskDeleteDays: 30, archivedTaskDeleteDaysOwn: true })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(days()).not.toBeNull())
    expect(days()!.value).toBe('30')
    await pick(mode()!, 'Workspace default')
    await waitFor(() => expect(deletePuts()).toHaveLength(1))
    expect(deletePuts()[0]?.body).toEqual({ archivedTaskDeleteDays: null })
    await waitFor(() => expect(days()).toBeNull())
  })
})
