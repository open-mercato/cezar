import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CezarClient, CezarProjectClient, HealthResponse } from '@open-mercato/cezar-api-client'

const { privateRender } = vi.hoisted(() => ({ privateRender: { throws: false } }))

vi.mock('#cezar-web-cockpit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#cezar-web-cockpit')>()
  return {
    CezarCockpitImplementation: (props: import('#cezar-web-cockpit').CezarCockpitImplementationProps) => {
      if (privateRender.throws) throw new Error('private render failed')
      return <actual.CezarCockpitImplementation {...props} />
    },
  }
})

import { CezarCockpit, type CezarCockpitRouting } from './cockpit'

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

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function createQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(['default', 'health'], HEALTH)
  queryClient.setQueryData(['workspace', 'projects'], {
    projects: [],
    bootProject: 'project-a',
    projectsDir: '/projects',
  })
  return queryClient
}

beforeEach(() => {
  privateRender.throws = false
  FakeEventSource.instances = []
  window.history.replaceState({}, '', '/host/sandbox')
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
  vi.unstubAllGlobals()
})

describe('CezarCockpit', () => {
  it('keeps a memory-routed new-task cockpit inside the host URL and root', async () => {
    const routing = {
      mode: 'memory',
      initialPath: '/p/project-a/new',
    } satisfies CezarCockpitRouting

    render(<CezarCockpit client={fakeCezarClient()} queryClient={createQueryClient()} routing={routing} />)

    await waitFor(() => expect(document.querySelector('[data-route="new"]')).not.toBeNull())
    expect(window.location.pathname).toBe('/host/sandbox')
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelectorAll('.cezar-root')).toHaveLength(1)
    expect(document.querySelectorAll('[data-cezar-portal]')).toHaveLength(1)
    const root = document.querySelector('[data-cezar-routing="memory"]')
    expect(root?.classList.contains('size-full')).toBe(true)
    expect(root?.classList.contains('min-h-0')).toBe(true)
    expect(root?.classList.contains('min-w-0')).toBe(true)
  })

  it('replaces a controlled memory path without changing the host URL', async () => {
    const queryClient = createQueryClient()
    const onPathChange = vi.fn()
    const { rerender } = render(
      <CezarCockpit
        client={fakeCezarClient()}
        queryClient={queryClient}
        routing={{ mode: 'memory', path: '/p/project-a/new', onPathChange }}
      />,
    )

    await waitFor(() => expect(document.querySelector('[data-route="new"]')).not.toBeNull())
    rerender(
      <CezarCockpit
        client={fakeCezarClient()}
        queryClient={queryClient}
        routing={{ mode: 'memory', path: '/tasks', onPathChange }}
      />,
    )

    await waitFor(() => expect(document.querySelector('[data-route="global-tasks"]')).not.toBeNull())
    expect(window.location.pathname).toBe('/host/sandbox')
    expect(onPathChange).not.toHaveBeenCalled()
  })

  it('reports an internal memory navigation as pathname, search, and hash', async () => {
    const onPathChange = vi.fn()
    render(
      <CezarCockpit
        client={fakeCezarClient()}
        queryClient={createQueryClient()}
        routing={{ mode: 'memory', initialPath: '/p/project-a/new', onPathChange }}
      />,
    )

    await waitFor(() => expect(document.querySelector('[data-route="new"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }))

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith('/p/project-a/'))
    expect(window.location.pathname).toBe('/host/sandbox')
  })

  it('preserves search and hash when the route tree redirects in memory', async () => {
    const onPathChange = vi.fn()
    render(
      <CezarCockpit
        client={fakeCezarClient()}
        queryClient={createQueryClient()}
        routing={{
          mode: 'memory',
          initialPath: '/p/project-a/settings/skills?skill=alpha#details',
          onPathChange,
        }}
      />,
    )

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith('/p/project-a/skills?skill=alpha#details'))
    expect(window.location.pathname).toBe('/host/sandbox')
  })

  it('uses memory routing by default', async () => {
    render(<CezarCockpit client={fakeCezarClient()} queryClient={createQueryClient()} />)

    await screen.findByRole('heading', { name: 'Tasks' })
    expect(document.querySelector('[data-cezar-routing="memory"]')).not.toBeNull()
    expect(window.location.pathname).toBe('/host/sandbox')
  })

  it('contains a private render failure with the package retry fallback', async () => {
    privateRender.throws = true
    render(<CezarCockpit client={fakeCezarClient()} queryClient={createQueryClient()} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not display Cezar.')
    privateRender.throws = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { name: 'Tasks' })
  })
})
