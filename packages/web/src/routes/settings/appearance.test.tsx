import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppearanceSection } from './appearance'

/**
 * Settings → Appearance's project-order reset (#952). The order itself is set by dragging the
 * drawer; this section owns the undo, and the rule worth pinning is that the undo is ABSENT
 * whenever it could only do nothing — a reset button for state the user has never created is a
 * dead control, and the sidebar's own emptiness is not something Settings should announce.
 */

const RESET = '[data-slot="appearance-project-order-reset"]'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(uiState: Record<string, unknown> = {}) {
  requests = []
  let workspaceConfig = {
    branding: { name: 'cezar', logoUrl: null as string | null, primaryColor: null as string | null },
    browseRoot: '~/', projectsDir: '~/cezar/projects', skillsAutoUpdate: null, effectiveSkillsAutoUpdate: true,
    composerDefaults: { autonomous: null, worktree: null, inheritedAutonomous: 'source-dependent', inheritedWorktree: true },
    resources: { maxParallel: 2, maxMonitoringSessions: 2, idleTimeoutMinutes: 15, monitoringWakeIntervalMinutes: 5, autoResumeOnUsageLimit: true, memoryLimitMb: null, worktreeRetentionDefault: 10 },
    agentDefaults: {},
  }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(workspaceConfig)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        const patch = body as { branding?: Partial<typeof workspaceConfig.branding> }
        workspaceConfig = { ...workspaceConfig, branding: { ...workspaceConfig.branding, ...patch.branding } }
        return json(workspaceConfig)
      }
      if (url === '/api/v1/workspace/branding-logo' && method === 'POST') return json({ logoUrl: '/api/v1/workspace/branding-logo?v=abc123' })
      if (url === '/api/v1/workspace/branding-logo' && method === 'DELETE') return json({ logoUrl: null })
      return new Promise<never>(() => {})
    }),
  )
}

/** The registry is seeded rather than fetched: this section only asks it "more than one?". */
function seedProjects(client: QueryClient, ids: string[]) {
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: ids.map((id) => ({
      id,
      name: id,
      root: `/home/me/${id}`,
      addedAt: '2026-07-01T00:00:00.000Z',
      lastOpenedAt: '2026-07-20T00:00:00.000Z',
      source: 'local',
      status: 'ok',
    })),
    bootProject: ids[0] ?? 'cezar',
    projectsDir: '~/cezar/projects',
  })
}

function renderSection(projectIds: string[]) {
  const client = createQueryClient()
  seedProjects(client, projectIds)
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AppearanceProvider>
          <AppearanceSection />
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Settings → Appearance: project order', () => {
  it('previews a selected logo and uploads only after Save logo', async () => {
    serve()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:logo-preview', revokeObjectURL: vi.fn() }))
    renderSection(['cezar'])
    const file = new File(['sample-image'], 'brand.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [file] } })
    expect(await screen.findByAltText('Logo preview')).toBeTruthy()
    expect(requests.some((request) => request.url === '/api/v1/workspace/branding-logo' && request.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save logo' }))
    await waitFor(() => expect(requests.some((request) => request.url === '/api/v1/workspace/branding-logo' && request.method === 'POST')).toBe(true))
  })

  it('offers the reset once an order has been stored', async () => {
    serve({ sidebar: { collapsed: { cezar: true }, projectOrder: ['shop', 'cezar'] } })
    renderSection(['cezar', 'shop'])

    await waitFor(() => expect(document.querySelector(RESET)).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Reset order' }))

    // Forgetting the order is the key going away — not an empty list, which would read as "the
    // user placed nothing on purpose" — and the legacy collapse map rides along untouched.
    await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1))
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
      sidebar: { collapsed: { cezar: true } },
    })
  })

  it('stays absent when nothing has been reordered', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderSection(['cezar', 'shop'])

    await waitFor(() => expect(screen.getByText('Reading width')).not.toBeNull())
    expect(document.querySelector(RESET)).toBeNull()
  })

  it('stays absent in a single-project workspace, order or no order', async () => {
    // The grouped sidebar does not render below two projects, so there is no order to undo.
    serve({ sidebar: { projectOrder: ['cezar'] } })
    renderSection(['cezar'])

    await waitFor(() => expect(screen.getByText('Reading width')).not.toBeNull())
    expect(document.querySelector(RESET)).toBeNull()
  })
})
