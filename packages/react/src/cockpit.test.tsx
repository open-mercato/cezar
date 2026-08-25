import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCezarClient,
  getApiBaseUrl,
  setApiBaseUrl,
  type CezarClient,
  type CezarProjectClient,
  type HealthResponse,
} from '@open-mercato/cezar-api-client'

const { privateRender } = vi.hoisted(() => ({
  privateRender: {
    throws: false,
    seedQueryClient: false,
    queryClient: null as QueryClient | null,
  },
}))

vi.mock('#cezar-web-cockpit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#cezar-web-cockpit')>()
  const router = await import('react-router')
  function NavigationTypeProbe() {
    return <output data-testid="memory-navigation-type">{router.useNavigationType()}</output>
  }
  return {
    CezarCockpitImplementation: (props: import('#cezar-web-cockpit').CezarCockpitImplementationProps) => {
      if (privateRender.throws) throw new Error('private render failed')
      privateRender.queryClient = props.queryClient
      if (privateRender.seedQueryClient) {
        props.queryClient.setQueryData(['facade-owned-lifecycle'], 'retained')
      }
      return (
        <>
          <actual.CezarCockpitImplementation {...props} />
          <NavigationTypeProbe />
        </>
      )
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
  privateRender.seedQueryClient = false
  privateRender.queryClient = null
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
  setApiBaseUrl('')
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

  it('reports controlled internal navigation, accepts the host echo, then replaces a later host path', async () => {
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
    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }))

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith('/p/project-a/'))
    expect(document.querySelector('[data-route="tasks"]')).not.toBeNull()

    rerender(
      <CezarCockpit
        client={fakeCezarClient()}
        queryClient={queryClient}
        routing={{ mode: 'memory', path: '/p/project-a/', onPathChange }}
      />,
    )

    expect(document.querySelector('[data-route="tasks"]')).not.toBeNull()
    expect(onPathChange).toHaveBeenCalledTimes(1)

    rerender(
      <CezarCockpit
        client={fakeCezarClient()}
        queryClient={queryClient}
        routing={{ mode: 'memory', path: '/tasks', onPathChange }}
      />,
    )

    await waitFor(() => expect(document.querySelector('[data-route="global-tasks"]')).not.toBeNull())
    expect(screen.getByTestId('memory-navigation-type').textContent).toBe('REPLACE')
    expect(window.location.pathname).toBe('/host/sandbox')
    expect(onPathChange).toHaveBeenCalledTimes(1)
    expect(onPathChange).toHaveBeenLastCalledWith('/p/project-a/')
  })

  it('bridges the public client base URL into private fetch and workspace event transports', async () => {
    const authority = 'https://cezar-api.example.test/root'
    const client = createCezarClient({ baseUrl: `${authority}/`, credentials: 'include' })
    const view = render(
      <CezarCockpit
        client={client}
        queryClient={createQueryClient()}
        routing={{ mode: 'memory', initialPath: '/p/project-a/new' }}
      />,
    )

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([input]) =>
        String(input).startsWith(`${authority}/api/v1/`),
      )).toBe(true)
    })
    const privateRequest = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input).startsWith(`${authority}/api/v1/`),
    )
    expect(privateRequest?.[1]).toMatchObject({ credentials: 'include' })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe(`${authority}/api/v1/workspace/events`)

    view.unmount()
    await waitFor(() => expect(getApiBaseUrl()).toBe(''))
  })

  it('clears its owned query client after ordinary unmount', async () => {
    privateRender.seedQueryClient = true
    const view = render(<CezarCockpit client={fakeCezarClient()} />)
    await screen.findByRole('heading', { name: 'Tasks' })
    const ownedQueryClient = privateRender.queryClient
    expect(ownedQueryClient?.getQueryData(['facade-owned-lifecycle'])).toBe('retained')

    view.unmount()

    await waitFor(() => {
      expect(ownedQueryClient?.getQueryData(['facade-owned-lifecycle'])).toBeUndefined()
    })
  })

  it('does not clear a supplied query client after unmount', async () => {
    const suppliedQueryClient = createQueryClient()
    suppliedQueryClient.setQueryData(['host-owned-lifecycle'], 'retained')
    const view = render(
      <CezarCockpit client={fakeCezarClient()} queryClient={suppliedQueryClient} />,
    )
    await screen.findByRole('heading', { name: 'Tasks' })

    view.unmount()
    await Promise.resolve()

    expect(suppliedQueryClient.getQueryData(['host-owned-lifecycle'])).toBe('retained')
  })

  it('retains its owned cache through the StrictMode effect replay and clears the final unmount', async () => {
    privateRender.seedQueryClient = true
    const view = render(
      <StrictMode>
        <CezarCockpit client={fakeCezarClient()} />
      </StrictMode>,
    )
    await screen.findByRole('heading', { name: 'Tasks' })
    const ownedQueryClient = privateRender.queryClient
    await Promise.resolve()

    expect(ownedQueryClient?.getQueryData(['facade-owned-lifecycle'])).toBe('retained')

    view.unmount()
    await waitFor(() => {
      expect(ownedQueryClient?.getQueryData(['facade-owned-lifecycle'])).toBeUndefined()
    })
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
