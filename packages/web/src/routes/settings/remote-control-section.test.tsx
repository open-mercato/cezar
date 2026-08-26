import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { RemoteControlStatus } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Project settings → Remote Control (spec 2026-08-26-remote-control): status, the
 * claude.ai link when running, Start/Stop through the bodyless POSTs, the CLI's own
 * refusal shown verbatim, and the hosted-mode degradation. The API contract itself is
 * pinned server-side in src/server/remote-control-api.test.ts.
 */

let requests: Array<{ method: string; url: string }> = []

function serve(initial: RemoteControlStatus, onStart?: () => RemoteControlStatus) {
  requests = []
  let state = initial
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url })
      if (url === '/api/v1/remote-control' && method === 'GET') return json(state)
      if (url === '/api/v1/remote-control/start' && method === 'POST') {
        state = onStart?.() ?? {
          available: true,
          state: 'running',
          url: 'https://claude.ai/code?environment=env_test',
          startedAt: '2026-08-26T12:00:00.000Z',
        }
        return json(state)
      }
      if (url === '/api/v1/remote-control/stop' && method === 'POST') {
        state = { available: true, state: 'stopped' }
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

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

function renderSection() {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <MemoryRouter initialEntries={['/settings/remote-control']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const startButton = () =>
  document.querySelector<HTMLButtonElement>('[data-slot="remote-control-start"]')
const stopButton = () =>
  document.querySelector<HTMLButtonElement>('[data-slot="remote-control-stop"]')
const link = () =>
  document.querySelector<HTMLAnchorElement>('[data-slot="remote-control-link"] a')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Project settings → Remote Control', () => {
  it('stopped: explains the feature and offers Start, no link', async () => {
    serve({ available: true, state: 'stopped' })
    renderSection()
    await waitFor(() => expect(startButton()).not.toBeNull())
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(link()).toBeNull()
    expect(stopButton()).toBeNull()
  })

  it('Start POSTs and renders the claude.ai link from the final answer — no polling', async () => {
    serve({ available: true, state: 'stopped' })
    renderSection()
    await waitFor(() => expect(startButton()).not.toBeNull())

    fireEvent.click(startButton()!)
    await waitFor(() => expect(link()).not.toBeNull())
    expect(link()!.href).toBe('https://claude.ai/code?environment=env_test')
    expect(requests.filter((r) => r.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/v1/remote-control/start' },
    ])
    // The final state came from the mutation's answer; nothing scheduled a refetch loop.
    expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/remote-control')).toHaveLength(1)
    expect(stopButton()).not.toBeNull()
  })

  it("a refusal (workspace trust) is shown in the CLI's own words, with Try again", async () => {
    serve({ available: true, state: 'stopped' }, () => ({
      available: true,
      state: 'error',
      error: 'Error: Workspace not trusted. Please run `claude` in /repo first. (exited with code 0)',
    }))
    renderSection()
    await waitFor(() => expect(startButton()).not.toBeNull())

    fireEvent.click(startButton()!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="remote-control-error"]')?.textContent).toContain(
        'Workspace not trusted',
      ),
    )
    expect(startButton()!.textContent).toBe('Try again')
  })

  it('running: Stop POSTs and the section returns to Not connected', async () => {
    serve({
      available: true,
      state: 'running',
      url: 'https://claude.ai/code?environment=env_test',
    })
    renderSection()
    await waitFor(() => expect(stopButton()).not.toBeNull())
    expect(link()).not.toBeNull()

    fireEvent.click(stopButton()!)
    await waitFor(() => expect(startButton()).not.toBeNull())
    expect(requests.filter((r) => r.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/v1/remote-control/stop' },
    ])
    expect(link()).toBeNull()
  })

  it('hosted mode: available:false renders the reason and no buttons', async () => {
    serve({
      available: false,
      reason: 'Remote Control is started from the machine that owns the checkout (this cockpit runs in hosted mode)',
      state: 'stopped',
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('Remote Control is unavailable here')).toBeTruthy())
    expect(startButton()).toBeNull()
    expect(stopButton()).toBeNull()
  })
})
