import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { FirstRun, WelcomeBack } from '@/components/first-run'

/**
 * Which first-run page shows (spec 2026-10-26-first-run-onboarding). The rule this pins down is
 * "nothing until known": a page that flips to another one a moment later is worse than a short
 * blank, for the agent answer and for the git answer alike.
 */

vi.mock('@/api/global-events', () => ({ onWorkspaceEvent: () => () => undefined }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

const fetchMock = vi.fn<typeof fetch>()
let singleProject = false
let agentsOff = false
let uiState: Record<string, unknown> = { onboarding: { agentCheckSkipped: true } }
const puts: Array<Record<string, unknown>> = []

const project = (id: string, root: string) => ({
  id,
  name: id,
  root,
  addedAt: '2026-10-01T00:00:00.000Z',
  lastOpenedAt: '2026-10-01T00:00:00.000Z',
  source: 'local',
  status: 'not-git',
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/workspace/ui-state' && init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>
      puts.push(patch)
      uiState = { ...uiState, ...patch }
    }
    const body =
      url.pathname === '/api/v1/providers/status'
        ? {
            providers: agentsOff
              ? [
                  { provider: 'claude', status: 'disconnected', enabled: false },
                  { provider: 'codex', status: 'not-installed', enabled: false },
                ]
              : [{ provider: 'claude', status: 'connected', enabled: true }],
          }
        : url.pathname === '/api/v1/workspace/ui-state'
          ? uiState
          : url.pathname === '/api/v1/projects'
            ? { projects: [project('boot', '/work/plans'), project('second', '/tmp/qa-demo')], bootProject: 'boot', projectsDir: '~/cezar/projects' }
          : url.pathname === '/api/v1/fs/repos'
            ? { repos: [], truncated: false }
            : url.pathname === '/api/v1/projects/github-owners'
              ? { available: false, reason: 'gh is not authenticated' }
              : url.pathname === '/api/v1/health'
                ? { repoRoot: '/work/plans', bootProject: 'boot', capabilities: { singleProject, designMode: true, automations: true } }
                : { error: 'not stubbed' }
    return new Response(JSON.stringify(body), { status: 'error' in body ? 404 : 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  singleProject = false
  agentsOff = false
  uiState = { onboarding: { agentCheckSkipped: true } }
  puts.length = 0
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function renderFirstRun(gitRepo: boolean | undefined, projectId: string | null = null) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectScopeContext.Provider value={{ projectId, apiBase: '/api/v1' }}>
        <MemoryRouter>
          <FirstRun gitRepo={gitRepo} />
        </MemoryRouter>
      </ProjectScopeContext.Provider>
    </QueryClientProvider>,
  )
}

const page = () => document.querySelector('[data-slot="first-run"]')?.getAttribute('data-first-run')

describe('FirstRun', () => {
  it('shows nothing while the git answer is unknown, even past the agent step', async () => {
    renderFirstRun(undefined)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 50))
    expect(page()).toBeUndefined()
  })

  it('a plain folder gets the pick-a-project step', async () => {
    renderFirstRun(false)
    await waitFor(() => expect(page()).toBe('pick-project'))
    expect(screen.getByRole('button', { name: 'Initialize git here' })).toBeTruthy()
  })

  it('offers no git init in a single-project workspace, where the server refuses it', async () => {
    singleProject = true
    renderFirstRun(false)
    await waitFor(() => expect(page()).toBe('pick-project'))
    await waitFor(() => expect(screen.getByText('isn’t a git repository.', { exact: false })).toBeTruthy())
    await new Promise((resolveSoon) => setTimeout(resolveSoon, 50))
    expect(screen.queryByRole('button', { name: 'Initialize git here' })).toBeNull()
  })

  it('names the folder of the project on screen, not the one cezar booted in (#1725 QA)', async () => {
    renderFirstRun(false, 'second')
    await waitFor(() => expect(screen.getByText('isn’t a git repository.', { exact: false }).textContent).toMatch(/^qa-demo isn’t a git repository\./))
    fireEvent.click(screen.getByRole('button', { name: 'Initialize git here' }))
    expect(await screen.findByRole('heading', { name: 'Initialize git in qa-demo' })).toBeTruthy()
  })

  it('says every agent is off, and where to turn one on, instead of an empty sign-in step', async () => {
    agentsOff = true
    uiState = {}
    renderFirstRun(true)
    await waitFor(() => expect(page()).toBe('sign-in'))
    expect(screen.getByText('All agents are turned off.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Turn one on' }).getAttribute('href')).toBe('/settings/agents#providers')
  })
})

describe('WelcomeBack', () => {
  it('marks What\u2019s new as seen when it is opened from the card, so the sidebar dot clears', async () => {
    const now = Date.now()
    uiState = {
      onboarding: {
        firstVisitAt: '2026-08-01T00:00:00.000Z',
        returnedFrom: '2026-09-01T00:00:00.000Z',
        returnedAt: new Date(now - 60_000).toISOString(),
      },
    }
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <WelcomeBack runs={[]} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'See what\u2019s new' }))
    await waitFor(() => expect(puts.some((patch) => typeof (patch.onboarding as Record<string, unknown> | undefined)?.whatsNewSeenAt === 'string')).toBe(true))
  })
})
