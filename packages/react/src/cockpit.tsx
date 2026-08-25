import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, MemoryRouter, useLocation, useNavigate } from 'react-router'

import {
  setApiBaseUrl,
  type ApiError,
  type CezarClient,
} from '@open-mercato/cezar-api-client'

import { CezarCockpitImplementation } from '#cezar-web-cockpit'

import { CezarErrorBoundary } from './core/error-boundary.js'
import { createCezarQueryClient } from './core/query-client.js'
import type { CezarRuntimeClient } from './core/runtime.js'

export type CezarCockpitRouting =
  | { mode: 'browser' }
  | {
      mode: 'memory'
      initialPath?: string
      path?: string
      onPathChange?: (path: string) => void
    }

export interface CezarCockpitProps<TClient extends CezarRuntimeClient = CezarClient> {
  client: TClient
  queryClient?: QueryClient
  routing?: CezarCockpitRouting
  onAuthRequired?: (error: ApiError) => void | Promise<void>
  onError?: (error: ApiError) => void
  className?: string
}

let activeLegacyTransportOwner: symbol | null = null

/**
 * The retained web composition still resolves its HTTP and workspace-SSE URLs through the
 * api-client's legacy module-level base. Install the public client's authority synchronously so
 * private render-time URL resolution sees it, then release only this mount's lease. The deferred
 * generation check keeps React StrictMode's effect replay from clearing a live remount.
 */
function useLegacyTransportBaseUrl(baseUrl: string): void {
  const owner = useRef<symbol | null>(null)
  if (owner.current === null) owner.current = Symbol('cezar-cockpit-legacy-transport')
  const mountGeneration = useRef(0)

  activeLegacyTransportOwner = owner.current
  setApiBaseUrl(baseUrl)

  useEffect(() => {
    const generation = ++mountGeneration.current
    activeLegacyTransportOwner = owner.current
    setApiBaseUrl(baseUrl)
    return () => {
      queueMicrotask(() => {
        if (
          mountGeneration.current !== generation
          || activeLegacyTransportOwner !== owner.current
        ) return
        activeLegacyTransportOwner = null
        setApiBaseUrl('')
      })
    }
  }, [baseUrl])
}

function locationPath({ pathname, search, hash }: ReturnType<typeof useLocation>): string {
  return `${pathname}${search}${hash}`
}

function MemoryPathBridge({ routing }: { routing: Extract<CezarCockpitRouting, { mode: 'memory' }> }) {
  const location = useLocation()
  const navigate = useNavigate()
  const path = locationPath(location)
  const previousPath = useRef(path)
  const previousControlledPath = useRef(routing.path)
  const hostDrivenPath = useRef<string | null>(null)

  useEffect(() => {
    if (previousControlledPath.current === routing.path) return
    previousControlledPath.current = routing.path
    if (routing.path === undefined || routing.path === path) return
    hostDrivenPath.current = routing.path
    navigate(routing.path, { replace: true })
  }, [navigate, path, routing.path])

  useEffect(() => {
    if (hostDrivenPath.current === path) {
      hostDrivenPath.current = null
      previousPath.current = path
      return
    }
    if (previousPath.current === path) return
    previousPath.current = path
    routing.onPathChange?.(path)
  }, [path, routing.onPathChange])

  return null
}

/** The complete Cezar cockpit for standalone browser or host-owned memory routing. */
export function CezarCockpit<TClient extends CezarRuntimeClient = CezarClient>({
  client,
  queryClient: suppliedQueryClient,
  routing = { mode: 'memory' },
  onAuthRequired,
  onError,
  className,
}: CezarCockpitProps<TClient>): React.JSX.Element {
  useLegacyTransportBaseUrl(client.baseUrl)

  const ownedQueryClient = useRef<QueryClient | null>(null)
  if (suppliedQueryClient === undefined && ownedQueryClient.current === null) {
    ownedQueryClient.current = createCezarQueryClient()
  }
  const queryClient = suppliedQueryClient ?? ownedQueryClient.current
  if (queryClient === null) throw new Error('cezar: query client construction failed')

  const queryClientMountGeneration = useRef(0)
  useEffect(() => {
    const generation = ++queryClientMountGeneration.current
    return () => {
      if (ownedQueryClient.current === null) return
      queueMicrotask(() => {
        if (queryClientMountGeneration.current === generation) {
          ownedQueryClient.current?.clear()
        }
      })
    }
  }, [])

  const [rootElement, setRootElement] = useState<HTMLDivElement | null>(null)
  const content = rootElement ? (
    <CezarErrorBoundary
      fallback={({ reset }) => (
        <div role="alert">
          <p>Could not display Cezar.</p>
          <button type="button" onClick={reset}>Try again</button>
        </div>
      )}
    >
      <CezarCockpitImplementation
        client={client}
        queryClient={queryClient}
        rootElement={rootElement}
        onAuthRequired={onAuthRequired}
        onError={onError}
        className={className}
      />
    </CezarErrorBoundary>
  ) : null

  return (
    <div
      ref={setRootElement}
      data-cezar-routing={routing.mode}
      className="size-full min-h-0 min-w-0"
    >
      {routing.mode === 'browser'
        ? <BrowserRouter>{content}</BrowserRouter>
        : <MemoryRouter initialEntries={[routing.path ?? routing.initialPath ?? '/']}>
            <MemoryPathBridge routing={routing} />
            {content}
          </MemoryRouter>}
    </div>
  )
}
