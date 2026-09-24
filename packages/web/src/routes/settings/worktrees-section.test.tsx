import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

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
    defaultModels: {},
    modelsLocked: false,
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
      if (url === '/api/v1/config' && method === 'GET') return json(state)
      if (url === '/api/v1/config' && method === 'PUT') {
        if (body?.worktreeRetention !== undefined) {
          state.worktreeRetention = body.worktreeRetention as number
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
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const retentionInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-worktree-retention"]')
const saveButton = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-retention"]')
const puts = () =>
  requests.filter(
    (r) => r.method === 'PUT' && r.url === '/api/v1/config' && (r.body as { worktreeRetention?: unknown })?.worktreeRetention !== undefined,
  )

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Project settings → Worktrees: keep-last-N-worktrees (#483)', () => {
  it('renders the configured value and disables Save until it changes', async () => {
    serve({ worktreeRetention: 7 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())
    expect(retentionInput()!.value).toBe('7')
    expect(saveButton()!.disabled).toBe(true)
  })

  it('saves the entered count through PUT /api/v1/config', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    fireEvent.change(retentionInput()!, { target: { value: '3' } })
    expect(saveButton()!.disabled).toBe(false)
    fireEvent.click(saveButton()!)

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 3 })
  })

  it('saves 0 as a real value (unlimited), not as a clear', async () => {
    serve({ worktreeRetention: 5 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    fireEvent.change(retentionInput()!, { target: { value: '0' } })
    fireEvent.click(saveButton()!)

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ worktreeRetention: 0 })
  })

  it('rejects a negative, over-limit, or non-integer count (Save stays disabled, no PUT)', async () => {
    serve({ worktreeRetention: 10 })
    renderAt('/settings/worktrees')
    await waitFor(() => expect(retentionInput()).not.toBeNull())

    for (const bad of ['-1', '1001', '2.5', '']) {
      fireEvent.change(retentionInput()!, { target: { value: bad } })
      expect(saveButton()!.disabled).toBe(true)
      expect(document.querySelector('[data-slot="resources-retention-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })
})
