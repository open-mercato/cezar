import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { SkillsUpdateState, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { AppRoutes } from '@/routes'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(
  overrides: Partial<WorkspaceConfigResponse> = {},
  updateOverrides: Partial<SkillsUpdateState> = {},
) {
  requests = []
  const config: WorkspaceConfigResponse = {
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: false,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
    },
    agentDefaults: {},
    ...overrides,
  }
  const update: SkillsUpdateState = {
    status: 'current',
    available: false,
    autoUpdateEnabled: true,
    inherited: true,
    checkedAt: null,
    updatedAt: null,
    needsUpgradeNotes: false,
    scopes: [
      {
        scope: 'project',
        status: 'current',
        available: false,
        skills: [],
        checkedAt: null,
        updatedAt: null,
        reason: 'Open Mercato installation is not tracked',
      },
      {
        scope: 'global',
        status: 'current',
        available: false,
        skills: [],
        checkedAt: null,
        updatedAt: null,
        reason: 'Open Mercato installation is not tracked',
      },
    ],
    ...updateOverrides,
  }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        if (body && 'skillsAutoUpdate' in body) {
          config.skillsAutoUpdate = body.skillsAutoUpdate as boolean | null
          config.effectiveSkillsAutoUpdate = config.skillsAutoUpdate ?? true
        }
        return json(config)
      }
      if (url === '/api/v1/workspace/skills-update?projectId=boot') return json(update)
      return new Promise<never>(() => {})
    }),
  )
}

function renderSkills() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/skills']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const puts = () => requests.filter((request) => request.method === 'PUT')

describe('Global settings → Skills', () => {
  it('renders the inherited default and quiet no-installation state', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update Open Mercato skills automatically',
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('On (default)')).toBeTruthy()
    expect(screen.getByText(/CEZ_SKILLS_AUTO_UPDATE supplies/)).toBeTruthy()
    expect(await screen.findByText('No tracked Open Mercato installation found.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use default' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('writes an explicit boolean, then can clear it back to the inherited default', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update Open Mercato skills automatically',
    })
    fireEvent.click(toggle)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: false }))
    const reset = screen.getByRole('button', { name: 'Use default' })
    await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(reset)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: null }))
  })

  it('degrades to an unavailable status without disabling the preference', async () => {
    serve(
      {},
      {
        status: 'unavailable',
        scopes: [
          {
            scope: 'project',
            status: 'unavailable',
            available: false,
            skills: [],
            checkedAt: null,
            updatedAt: null,
            reason: 'npx is unavailable',
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('npx is unavailable')).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })
})
