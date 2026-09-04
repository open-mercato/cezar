import { QueryClientProvider, type QueryKey, type QueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { ApiError, type CezarClient } from '@open-mercato/cezar-api-client'
import type { CezarRuntimeClient } from '@open-mercato/cezar-react'

import { GlobalEventsProvider } from './api/global-events'
import { AppShellContainer } from './components/app-shell-container'
import { AppearanceProvider } from './components/appearance-provider'
import { LastLocationController } from './components/last-location-controller'
import { ReferenceStatusRegistry } from './components/reference-status'
import { ReferenceCezarProvider } from './components/reference-cezar-provider'
import { RunNotifications } from './components/run-notifications'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/toaster'
import { AppRoutes } from './routes'

export interface CezarCockpitImplementationProps<
  TClient extends CezarRuntimeClient = CezarClient,
> {
  client: TClient
  queryClient: QueryClient
  rootElement: HTMLElement
  onAuthRequired?: (error: ApiError) => void | Promise<void>
  onError?: (error: ApiError) => void
  className?: string
}

function isPublicCezarKey(key: QueryKey | undefined, client: Pick<CezarRuntimeClient, 'identity'>): boolean {
  return key !== undefined && key[0] === 'cezar' && key[1] === client.identity
}

function publicApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error
  if (!(error instanceof Error)) return null
  const candidate = error as Error & { status?: unknown }
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : 0
  return new ApiError(status, 'cockpit', error.message, undefined, { cause: error })
}

/** The complete existing cockpit composition, kept private until the public facade is ready. */
export function CezarCockpitImplementation<TClient extends CezarRuntimeClient>({
  client,
  queryClient,
  rootElement,
  onAuthRequired,
  onError,
  className,
}: CezarCockpitImplementationProps<TClient>): React.JSX.Element {
  const onAuthRequiredRef = useRef(onAuthRequired)
  const onErrorRef = useRef(onError)
  useLayoutEffect(() => {
    onAuthRequiredRef.current = onAuthRequired
    onErrorRef.current = onError
  }, [onAuthRequired, onError])

  useEffect(() => {
    const report = (error: unknown) => {
      const normalized = publicApiError(error)
      if (normalized === null) return
      if (normalized.status === 401) void onAuthRequiredRef.current?.(normalized)
      onErrorRef.current?.(normalized)
    }
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return
      if (isPublicCezarKey(event.query.queryKey, client)) return
      report(event.action.error)
    })
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return
      if (isPublicCezarKey(event.mutation.options.mutationKey, client)) return
      report(event.action.error)
    })
    return () => {
      unsubscribeQueries()
      unsubscribeMutations()
    }
  }, [client, queryClient])

  return (
    <QueryClientProvider client={queryClient}>
      <GlobalEventsProvider>
        <RunNotifications />
        <ThemeProvider rootElement={rootElement}>
          <AppearanceProvider rootElement={rootElement}>
            <ReferenceCezarProvider
              client={client}
              queryClient={queryClient}
              rootElement={rootElement}
              onAuthRequired={onAuthRequired}
              onError={onError}
              className={className}
            >
              <LastLocationController />
              <ReferenceStatusRegistry>
                <AppShellContainer>
                  <AppRoutes />
                </AppShellContainer>
              </ReferenceStatusRegistry>
              <Toaster />
            </ReferenceCezarProvider>
          </AppearanceProvider>
        </ThemeProvider>
      </GlobalEventsProvider>
    </QueryClientProvider>
  )
}
