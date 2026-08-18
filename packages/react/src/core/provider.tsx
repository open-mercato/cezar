import {
  QueryClientProvider,
  type QueryCacheNotifyEvent,
  type QueryKey,
} from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { ApiError, type CezarClient } from '@open-mercato/cezar-api-client'

import {
  cezarRootClassName,
  useAdoptedCezarAppearance,
  useResolvedCezarTheme,
  type CezarAccent,
  type CezarDensity,
  type CezarTheme,
  type CezarWidth,
} from './appearance.js'
import {
  CezarNavigationContext,
  defaultCezarNavigation,
  type CezarNavigationAdapter,
} from './navigation.js'
import {
  createNoopCezarNotifications,
  type CezarNotifications,
} from './notifications.js'
import { CezarPortalContext } from './portal.js'
import { createCezarQueryClient } from './query-client.js'
import {
  CezarRuntimeContext,
  useCezarRuntime,
  type CezarRuntime,
  type CezarRuntimeClient,
} from './runtime.js'
import {
  createCezarBrowserStorage,
  type CezarStorage,
} from './storage.js'

export interface CezarProviderProps<
  TClient extends CezarRuntimeClient = CezarClient,
> {
  client: TClient
  projectId?: string | null
  queryClient?: import('@tanstack/react-query').QueryClient
  navigation?: CezarNavigationAdapter
  storage?: CezarStorage
  notifications?: CezarNotifications
  theme?: CezarTheme
  accent?: CezarAccent
  density?: CezarDensity
  width?: CezarWidth
  rootElement?: HTMLElement | null
  className?: string
  onError?: (error: ApiError) => void
  onAuthRequired?: (error: ApiError) => void
  children: ReactNode
}

export function cezarQueryKey(
  client: Pick<CezarClient, 'identity'>,
  projectId: string | null,
  domain: string,
  ...parts: readonly unknown[]
): readonly unknown[] {
  return ['cezar', client.identity, projectId ?? 'boot', domain, ...parts]
}

function hasPrefix(key: QueryKey | undefined, prefix: readonly unknown[]): boolean {
  return key !== undefined
    && key.length >= prefix.length
    && prefix.every((part, index) => Object.is(part, key[index]))
}

function queryEventError(event: QueryCacheNotifyEvent): unknown {
  return event.type === 'updated' && event.action.type === 'error'
    ? event.action.error
    : undefined
}

export function CezarProvider<TClient extends CezarRuntimeClient = CezarClient>({
  client,
  projectId: projectIdProp,
  queryClient: suppliedQueryClient,
  navigation = defaultCezarNavigation,
  storage: suppliedStorage,
  notifications: suppliedNotifications,
  theme = 'dark',
  accent = 'lime',
  density = 'comfortable',
  width = 'narrow',
  rootElement,
  className,
  onError,
  onAuthRequired,
  children,
}: CezarProviderProps<TClient>) {
  const projectId = projectIdProp ?? null
  const ownedQueryClient = useRef<import('@tanstack/react-query').QueryClient | null>(null)
  if (suppliedQueryClient === undefined && ownedQueryClient.current === null) {
    ownedQueryClient.current = createCezarQueryClient()
  }
  const queryClient = suppliedQueryClient ?? ownedQueryClient.current
  if (queryClient === null) throw new Error('cezar: query client construction failed')

  const mountGeneration = useRef(0)
  useEffect(() => {
    const generation = ++mountGeneration.current
    return () => {
      if (ownedQueryClient.current === null) return
      queueMicrotask(() => {
        if (mountGeneration.current === generation) ownedQueryClient.current?.clear()
      })
    }
  }, [])

  const projectClient = useMemo(() => client.forProject(projectId), [client, projectId])
  const defaultStorage = useMemo(
    () => createCezarBrowserStorage(client.identity, projectId),
    [client.identity, projectId],
  )
  const defaultNotifications = useMemo(createNoopCezarNotifications, [])
  const runtime = useMemo<CezarRuntime>(
    () => ({
      client,
      projectId,
      projectClient,
      queryClient,
      storage: suppliedStorage ?? defaultStorage,
      notifications: suppliedNotifications ?? defaultNotifications,
    }),
    [
      client,
      projectId,
      projectClient,
      queryClient,
      suppliedStorage,
      defaultStorage,
      suppliedNotifications,
      defaultNotifications,
    ],
  )

  const onErrorRef = useRef(onError)
  const onAuthRequiredRef = useRef(onAuthRequired)
  onErrorRef.current = onError
  onAuthRequiredRef.current = onAuthRequired
  const errorPrefix = useMemo(
    () => ['cezar', client.identity, projectId ?? 'boot'] as const,
    [client.identity, projectId],
  )
  useEffect(() => {
    const report = (error: unknown) => {
      if (!(error instanceof ApiError)) return
      if (error.status === 401) onAuthRequiredRef.current?.(error)
      onErrorRef.current?.(error)
    }
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (!hasPrefix(event.query.queryKey, errorPrefix)) return
      report(queryEventError(event))
    })
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated') return
      if (!hasPrefix(event.mutation.options.mutationKey, errorPrefix)) return
      report(event.action.type === 'error' ? event.action.error : undefined)
    })
    return () => {
      unsubscribeQueries()
      unsubscribeMutations()
    }
  }, [queryClient, errorPrefix])

  const resolvedTheme = useResolvedCezarTheme(theme)
  useAdoptedCezarAppearance(
    rootElement,
    resolvedTheme,
    accent,
    density,
    width,
    className,
  )

  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)
  const capturePortal = useCallback((element: HTMLDivElement | null) => {
    setPortalElement(element)
  }, [])
  const content = (
    <QueryClientProvider client={queryClient}>
      <CezarRuntimeContext.Provider value={runtime}>
        <CezarNavigationContext.Provider value={navigation}>
          <CezarPortalContext.Provider value={portalElement}>
            {children}
            <div ref={capturePortal} data-cezar-portal="" data-testid="cezar-portal" />
          </CezarPortalContext.Provider>
        </CezarNavigationContext.Provider>
      </CezarRuntimeContext.Provider>
    </QueryClientProvider>
  )

  if (rootElement) return content
  return (
    <div
      className={cezarRootClassName(className)}
      data-cezar-theme={resolvedTheme}
      data-cezar-accent={accent}
      data-cezar-density={density}
      data-cezar-width={width}
      data-testid="cezar-root"
      style={{ colorScheme: resolvedTheme }}
    >
      {content}
    </div>
  )
}

export { useCezarRuntime }
export type { CezarRuntime }
