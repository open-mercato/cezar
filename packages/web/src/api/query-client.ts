import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './client'

/**
 * Defaults for a cockpit talking to a server on localhost.
 *
 * The doctrine (spec, "Architecture"): SSE streams are for immediacy, `GET /api/runs` and
 * `GET /api/runs/:id` are authoritative. So freshness comes from the stream invalidating these
 * queries (Step 3.2) — not from polling and not from a short staleTime. Both would re-fetch on
 * a schedule that has nothing to do with when the data actually changed, and would paper over a
 * broken stream with data that happens to be nearly right.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // No polling. The stream says when something changed.
        refetchInterval: false,
        // Long, not Infinity: a tab focus or a mount after five minutes of a dead stream should
        // still land on the truth. Step 3.2 replaces "eventually" with "on reconnect".
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        // The reconnect/refetch path is Step 3.2's, and it is explicit. These would fire it at
        // arbitrary moments instead.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // The server is a process on this machine: a request either answers or the server is
        // down, and three silent retries only delay saying so. A 4xx is never worth retrying —
        // it is the server's considered answer.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
          return failureCount < 1
        },
      },
      mutations: {
        // Mutations act (cancel, delete, start). Replaying one that may have landed is worse
        // than reporting the failure.
        retry: false,
      },
    },
  })
}
