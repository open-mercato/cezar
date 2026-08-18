import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, type CezarClient, type CezarProjectClient } from '@open-mercato/cezar-api-client'

import { CezarErrorBoundary } from './error-boundary'
import { CezarLink, type CezarLocation, type CezarNavigationAdapter } from './navigation'
import { createCezarQueryClient } from './query-client'
import {
  CezarProvider,
  cezarQueryKey,
  useCezarRuntime,
  type CezarRuntime,
} from './provider'
import { useCezarPortal } from './portal'
import { createCezarMemoryStorage } from './storage'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('class')
  document.documentElement.removeAttribute('style')
  for (const attribute of [...document.documentElement.attributes]) {
    if (attribute.name.startsWith('data-cezar-')) {
      document.documentElement.removeAttribute(attribute.name)
    }
  }
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fakeCezarClient(identity: string): CezarClient {
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

function RuntimeProbe({ capture }: { capture?: (runtime: CezarRuntime) => void }) {
  const runtime = useCezarRuntime()
  capture?.(runtime)
  return (
    <output data-testid="runtime">
      {cezarQueryKey(runtime.client, runtime.projectId, 'runs').slice(1).join('|')}
    </output>
  )
}

function PortalProbe() {
  const portal = useCezarPortal()
  return portal === null ? null : createPortal(<span data-testid="portal-content">portal</span>, portal)
}

function hostContainer(): HTMLDivElement {
  const container = document.createElement('div')
  container.dataset.host = 'true'
  document.body.append(container)
  return container
}

describe('CezarProvider roots and runtime', () => {
  it('creates one scoped root, cache, and descendant portal without touching the host document', async () => {
    const container = hostContainer()
    const before = document.documentElement.outerHTML
    const client = fakeCezarClient('client-a')
    let runtime: CezarRuntime | undefined

    const view = render(
      <CezarProvider client={client} projectId="project-a" theme="dark" accent="lime">
        <RuntimeProbe capture={(value) => { runtime = value }} />
        <PortalProbe />
      </CezarProvider>,
      { container },
    )

    const root = screen.getByTestId('cezar-root')
    expect(root.classList.contains('cezar-root')).toBe(true)
    expect(root.getAttribute('data-cezar-theme')).toBe('dark')
    expect(root.getAttribute('data-cezar-accent')).toBe('lime')
    expect(root.getAttribute('data-cezar-density')).toBe('comfortable')
    expect(root.getAttribute('data-cezar-width')).toBe('narrow')
    expect(root.style.colorScheme).toBe('dark')
    expect(within(root).getByTestId('cezar-portal')).not.toBeNull()
    await screen.findByTestId('portal-content')
    expect(screen.getByTestId('runtime').textContent).toBe('client-a|project-a|runs')
    expect(runtime?.projectClient.projectId).toBe('project-a')
    expect(runtime?.queryClient).toBeInstanceOf(QueryClient)

    view.unmount()
    expect(document.documentElement.outerHTML).toBe(before)
  })

  it('keeps generated provider caches and appearance isolated', () => {
    const clients: QueryClient[] = []
    render(
      <>
        <CezarProvider client={fakeCezarClient('a')} projectId="one" theme="light" accent="violet">
          <RuntimeProbe capture={(runtime) => { clients[0] = runtime.queryClient }} />
        </CezarProvider>
        <CezarProvider client={fakeCezarClient('b')} projectId="two" theme="dark" density="compact">
          <RuntimeProbe capture={(runtime) => { clients[1] = runtime.queryClient }} />
        </CezarProvider>
      </>,
    )

    const roots = screen.getAllByTestId('cezar-root')
    expect(roots).toHaveLength(2)
    expect(roots[0]?.getAttribute('data-cezar-theme')).toBe('light')
    expect(roots[0]?.getAttribute('data-cezar-accent')).toBe('violet')
    expect(roots[1]?.getAttribute('data-cezar-theme')).toBe('dark')
    expect(roots[1]?.getAttribute('data-cezar-density')).toBe('compact')
    expect(clients[0]).not.toBe(clients[1])
  })

  it('adopts a supplied root and restores only provider-owned values during cleanup', () => {
    const rootElement = document.createElement('section')
    rootElement.className = 'cezar-root host-class'
    rootElement.setAttribute('data-cezar-theme', 'light')
    rootElement.setAttribute('data-host-value', 'preserved')
    rootElement.style.setProperty('color-scheme', 'light', 'important')
    document.body.append(rootElement)

    const view = render(
      <CezarProvider
        client={fakeCezarClient('a')}
        rootElement={rootElement}
        className="host-class provider-class"
        theme="dark"
      >
        <RuntimeProbe />
      </CezarProvider>,
      { container: rootElement },
    )

    expect(rootElement.querySelectorAll('.cezar-root')).toHaveLength(0)
    expect(rootElement.classList.contains('provider-class')).toBe(true)
    expect(rootElement.getAttribute('data-cezar-theme')).toBe('dark')
    expect(rootElement.style.colorScheme).toBe('dark')

    view.unmount()
    expect(rootElement.className).toBe('cezar-root host-class')
    expect(rootElement.getAttribute('data-cezar-theme')).toBe('light')
    expect(rootElement.getAttribute('data-host-value')).toBe('preserved')
    expect(rootElement.style.getPropertyValue('color-scheme')).toBe('light')
    expect(rootElement.style.getPropertyPriority('color-scheme')).toBe('important')
  })

  it('removes a root class it added to an adopted host without disturbing host classes', () => {
    const rootElement = document.createElement('main')
    rootElement.className = 'host-class'
    document.body.append(rootElement)
    const view = render(
      <CezarProvider client={fakeCezarClient('a')} rootElement={rootElement}>
        child
      </CezarProvider>,
      { container: rootElement },
    )

    expect(rootElement.className).toContain('cezar-root')
    view.unmount()
    expect(rootElement.className).toBe('host-class')
    expect(rootElement.hasAttribute('data-cezar-theme')).toBe(false)
    expect(rootElement.style.colorScheme).toBe('')
  })

  it('resolves system theme on the adopted root and releases exactly its media listener', async () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    const addEventListener = vi.fn((_type: string, next: (event: MediaQueryListEvent) => void) => {
      listener = next
    })
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener,
      removeEventListener,
    })))
    const rootElement = hostContainer()
    const documentBefore = document.documentElement.outerHTML

    const view = render(
      <CezarProvider client={fakeCezarClient('a')} rootElement={rootElement} theme="system">
        child
      </CezarProvider>,
      { container: rootElement },
    )

    await waitFor(() => expect(rootElement.getAttribute('data-cezar-theme')).toBe('light'))
    act(() => listener?.({ matches: false } as MediaQueryListEvent))
    expect(rootElement.getAttribute('data-cezar-theme')).toBe('dark')
    view.unmount()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith('change', listener)
    expect(document.documentElement.outerHTML).toBe(documentBefore)
  })
})

describe('query runtime boundaries', () => {
  it('uses the stable cache namespace and retries only explicit network and server failures once', () => {
    const client = fakeCezarClient('identity')
    expect(cezarQueryKey(client, null, 'runs', 'list')).toEqual([
      'cezar', 'identity', 'boot', 'runs', 'list',
    ])

    const queryClient = createCezarQueryClient()
    const queries = queryClient.getDefaultOptions().queries
    const mutations = queryClient.getDefaultOptions().mutations
    const retry = queries?.retry
    expect(queries?.staleTime).toBe(5 * 60_000)
    expect(queries?.gcTime).toBe(30 * 60_000)
    expect(queries?.refetchInterval).toBe(false)
    expect(queries?.refetchOnWindowFocus).toBe(false)
    expect(queries?.refetchOnReconnect).toBe(false)
    expect(mutations?.retry).toBe(false)
    expect(typeof retry).toBe('function')
    if (typeof retry === 'function') {
      expect(retry(0, new ApiError(0, '/runs', 'cannot reach server'))).toBe(true)
      expect(retry(1, new ApiError(0, '/runs', 'cannot reach server'))).toBe(false)
      expect(retry(0, new ApiError(200, '/runs', 'unexpected response body'))).toBe(false)
      expect(retry(0, new ApiError(302, '/runs', 'unexpected redirect'))).toBe(false)
      expect(retry(0, new ApiError(404, '/runs', 'not found'))).toBe(false)
      expect(retry(0, new ApiError(500, '/runs', 'failed'))).toBe(true)
      expect(retry(1, new ApiError(500, '/runs', 'failed'))).toBe(false)
      expect(retry(0, new DOMException('cancelled', 'AbortError'))).toBe(false)
      expect(retry(0, new TypeError('Cannot read properties of undefined'))).toBe(false)
      expect(retry(0, new Error('programming failure'))).toBe(false)
    }
  })

  it('reports only scoped ApiErrors after query state handles them', async () => {
    const queryClient = createCezarQueryClient()
    const client = fakeCezarClient('client-a')
    const onError = vi.fn()
    const onAuthRequired = vi.fn()
    render(
      <CezarProvider
        client={client}
        projectId="project-a"
        queryClient={queryClient}
        onError={onError}
        onAuthRequired={onAuthRequired}
      >
        child
      </CezarProvider>,
    )

    const authError = new ApiError(401, '/runs', 'sign in')
    await queryClient.fetchQuery({
      queryKey: cezarQueryKey(client, 'project-a', 'runs'),
      queryFn: () => Promise.reject(authError),
      retry: false,
    }).catch(() => undefined)
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(authError))
    expect(onError).toHaveBeenCalledWith(authError)

    await queryClient.fetchQuery({
      queryKey: ['host', 'query'],
      queryFn: () => Promise.reject(new ApiError(500, '/host', 'host failure')),
      retry: false,
    }).catch(() => undefined)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('never clears a supplied cache and clears an owned cache on unmount', async () => {
    const supplied = createCezarQueryClient()
    const suppliedClear = vi.spyOn(supplied, 'clear')
    const suppliedView = render(
      <CezarProvider client={fakeCezarClient('a')} queryClient={supplied}>child</CezarProvider>,
    )
    suppliedView.unmount()
    expect(suppliedClear).not.toHaveBeenCalled()

    let owned: QueryClient | undefined
    const ownedView = render(
      <CezarProvider client={fakeCezarClient('b')}>
        <RuntimeProbe capture={(runtime) => { owned = runtime.queryClient }} />
      </CezarProvider>,
    )
    if (!owned) throw new Error('owned query client was not captured')
    const ownedClear = vi.spyOn(owned, 'clear')
    ownedView.unmount()
    await waitFor(() => expect(ownedClear).toHaveBeenCalledTimes(1))
  })

  it('keeps one live owned cache and error subscription through StrictMode replay', async () => {
    const client = fakeCezarClient('strict')
    const onError = vi.fn()
    let runtime: CezarRuntime | undefined
    const view = render(
      <StrictMode>
        <CezarProvider client={client} projectId="project-a" onError={onError}>
          <RuntimeProbe capture={(value) => { runtime = value }} />
        </CezarProvider>
      </StrictMode>,
    )
    if (!runtime) throw new Error('runtime was not captured')

    runtime.queryClient.setQueryData(['live-after-replay'], 'preserved')
    await act(async () => Promise.resolve())
    expect(runtime.queryClient.getQueryData(['live-after-replay'])).toBe('preserved')

    const error = new ApiError(500, '/runs', 'failed')
    await runtime.queryClient.fetchQuery({
      queryKey: cezarQueryKey(client, 'project-a', 'runs'),
      queryFn: () => Promise.reject(error),
      retry: false,
    }).catch(() => undefined)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith(error)

    const clear = vi.spyOn(runtime.queryClient, 'clear')
    view.unmount()
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
  })
})

describe('adapters and boundaries', () => {
  it('namespaces lazy browser storage and exports isolated memory storage', () => {
    let runtime: CezarRuntime | undefined
    render(
      <CezarProvider client={fakeCezarClient('client-a')} projectId="project-a">
        <RuntimeProbe capture={(value) => { runtime = value }} />
      </CezarProvider>,
    )
    if (!runtime) throw new Error('runtime was not captured')
    runtime.storage.setItem('draft', 'one')
    expect(localStorage.getItem('cezar:client-a:project-a:draft')).toBe('one')
    expect(runtime.storage.getItem('draft')).toBe('one')
    runtime.storage.removeItem('draft')
    expect(localStorage.getItem('cezar:client-a:project-a:draft')).toBeNull()

    const first = createCezarMemoryStorage({ draft: 'first' })
    const second = createCezarMemoryStorage()
    expect(first.getItem('draft')).toBe('first')
    expect(second.getItem('draft')).toBeNull()
  })

  it('uses a no-op notification default without requesting permission', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { requestPermission })
    let runtime: CezarRuntime | undefined
    render(
      <CezarProvider client={fakeCezarClient('client-a')}>
        <RuntimeProbe capture={(value) => { runtime = value }} />
      </CezarProvider>,
    )
    await runtime?.notifications.notify({ title: 'Finished' })
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('renders an anchor when href is available and a semantic button otherwise', () => {
    const linkTarget: CezarLocation = { area: 'task', runId: 'run-a' }
    const linked: CezarNavigationAdapter = {
      href: () => '/p/project-a/tasks/run-a',
      navigate: vi.fn(),
    }
    const linkedView = render(
      <CezarProvider client={fakeCezarClient('a')} navigation={linked}>
        <CezarLink to={linkTarget} target="_blank">Open task</CezarLink>
      </CezarProvider>,
    )
    const anchor = screen.getByRole('link', { name: 'Open task' })
    expect(anchor.getAttribute('href')).toBe('/p/project-a/tasks/run-a')
    expect(anchor.getAttribute('target')).toBe('_blank')
    linkedView.unmount()

    const buttonNavigation: CezarNavigationAdapter = {
      href: () => undefined,
      navigate: vi.fn(),
    }
    render(
      <CezarProvider client={fakeCezarClient('b')} navigation={buttonNavigation}>
        <CezarLink to={linkTarget}>Open task</CezarLink>
      </CezarProvider>,
    )
    const button = screen.getByRole('button', { name: 'Open task' })
    fireEvent.click(button)
    expect(buttonNavigation.navigate).toHaveBeenCalledWith(linkTarget, undefined)
  })

  it('isolates an unexpected render failure with an accessible fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function Broken(): ReactNode {
      throw new Error('render failed')
    }
    render(
      <CezarErrorBoundary fallback={({ error }) => <p role="alert">{error.message}</p>}>
        <Broken />
      </CezarErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toBe('render failed')
  })
})
