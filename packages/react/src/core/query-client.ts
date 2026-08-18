import { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@open-mercato/cezar-api-client'

const FIVE_MINUTES = 5 * 60_000
const THIRTY_MINUTES = 30 * 60_000

/** Create an isolated cache with Cezar's stream-first fetching defaults. */
export function createCezarQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: FIVE_MINUTES,
        gcTime: THIRTY_MINUTES,
        refetchInterval: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: (failureCount, error) => {
          if (failureCount >= 1 || !(error instanceof ApiError)) return false
          return error.status === 0 || error.status >= 500
        },
      },
      mutations: {
        retry: false,
      },
    },
  })
}
