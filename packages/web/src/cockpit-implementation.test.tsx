import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CezarClient, CezarProjectClient, HealthResponse } from '@open-mercato/cezar-api-client'
import { setApiBaseUrl } from '@open-mercato/cezar-api-client'

import { ApiError } from './api/client'
import { createQueryClient } from './api/query-client'
import { CezarCockpitImplementation } from './cockpit-implementation'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly readyState = 0
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function fakeCezarClient(identity = 'cockpit'): CezarClient {
  const project = (projectId: string | null): CezarProjectClient => ({
    projectId,
    runs: {} as CezarProjectClient['runs'],
    events: {} as CezarProjectClient['events'],
    resolveUrl: (url) => url,
  })
  return {
    identity,
    baseUrl: '',
    rpc: {} as CezarClient['rpc'],
    events: { forProject: (projectId = null) => project(projectId).events },
    forProject: (projectId = null) => project(projectId),
  } as CezarClient
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'project-a',
  repoRoot: '/projects/project-a',
  repo: { root: '/projects/project-a', branch: 'main', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: {
    localHandoff: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: false,
    singleProject: true,
    automations: false,
  },
}

function seedRouteGate(queryClient: ReturnType<typeof createQueryClient>): void {
  queryClient.setQueryData(['default', 'health'], HEALTH)
  queryClient.setQueryData(['workspace', 'projects'], {
    projects: [],
    bootProject: 'project-a',
    projectsDir: '/projects',
  })
}

function renderCockpit(entry = '/p/project-a/new') {
  const rootElement = document.createElement('div')
  document.body.append(rootElement)
  const queryClient = createQueryClient()
  seedRouteGate(queryClient)
  render(
    <MemoryRouter initialEntries={[entry]}>
      <CezarCockpitImplementation
        client={fakeCezarClient()}
        queryClient={queryClient}
        rootElement={rootElement}
      />
    </MemoryRouter>,
    { container: rootElement },
  )
  return { queryClient, rootElement }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/skills')) return response([])
    if (url.includes('/workflows')) return response({ workflows: [] })
    if (url.includes('/runs')) return response([])
    if (url.includes('/todos')) return response([])
    if (url.includes('/providers/status')) return response({ providers: [] })
    if (url.includes('/workspace/ui-state')) return response({})
    if (url.includes('/workspace/projects')) {
      return response({ projects: [], bootProject: 'project-a', projectsDir: '/projects' })
    }
    return response(HEALTH)
  }))
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setApiBaseUrl('')
  vi.unstubAllGlobals()
})

describe('CezarCockpitImplementation', () => {
  it('mounts the complete existing cockpit in the adopted root with one stream and no iframe', async () => {
    const { rootElement } = renderCockpit()

    await waitFor(() => expect(rootElement.querySelector('[data-route="new"]')).not.toBeNull())
    expect(document.querySelector('iframe')).toBeNull()
    expect(rootElement.querySelectorAll('.cezar-root')).toHaveLength(0)
    expect(rootElement.classList).toContain('cezar-root')
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('keeps the workspace stream open across router navigation', async () => {
    renderCockpit()
    await waitFor(() => expect(document.querySelector('[data-route="new"]')).not.toBeNull())

    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }))

    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('normalizes one private query failure for the host callbacks', async () => {
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const queryClient = createQueryClient()
    seedRouteGate(queryClient)
    const onAuthRequired = vi.fn()
    const onError = vi.fn()
    render(
      <MemoryRouter initialEntries={['/p/project-a/new']}>
        <CezarCockpitImplementation
          client={fakeCezarClient()}
          queryClient={queryClient}
          rootElement={rootElement}
          onAuthRequired={onAuthRequired}
          onError={onError}
        />
      </MemoryRouter>,
      { container: rootElement },
    )

    await queryClient.fetchQuery({
      queryKey: ['private', 'auth'],
      queryFn: () => Promise.reject(new ApiError(401, 'sign in first')),
      retry: false,
    }).catch(() => undefined)

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      status: 401,
      path: 'cockpit',
      message: 'sign in first',
    })
  })
})
