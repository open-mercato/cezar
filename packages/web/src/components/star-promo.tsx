import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { queryKeys, useStarCount } from '@/api/queries'
import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'
import {
  CEZAR_REPO_URL,
  STAR_TOAST_ACTION_LABEL,
  STAR_TOAST_MESSAGE,
  STAR_TOAST_MS,
  diffSuccessTransition,
  hasSeenStarToast,
  markStarToastSeen,
} from '@/lib/star-promo'
import { toast } from '@/components/ui/toaster'

/**
 * The star ask's one-time toast: after the user's FIRST successful run, once per browser, ever.
 *
 * It watches the cached run list rather than opening its own listener, for the same reason
 * `RunNotifications` does — the global SSE stream folds every `run` event into
 * `queryKeys.runs.list()`, and the reconnect/visibility reconciliation refetches it, so one cache
 * subscription sees both deliveries of the same truth.
 *
 * Statuses are tracked UNCONDITIONALLY, before any gate. That is what keeps the ask honest about
 * "first": a run that was already `done` when this mounted is not a transition and can never fire
 * the toast, however many times the gates flip afterwards.
 *
 * Three gates, and each is a different question:
 *  - has this browser seen it? (`hasSeenStarToast`, which fails CLOSED — see the lib);
 *  - may cezar promote itself at all? (`CEZ_NO_BANNER=1` reaches the browser as the star-count
 *    route answering `available: false`, which is also what offline looks like — erring quiet);
 *  - did a run just finish well? (`diffSuccessTransition`).
 *
 * Renders nothing. Mounted once in app.tsx, beside `RunNotifications`, for the app's whole life.
 */
export function StarPromo() {
  const queryClient = useQueryClient()
  const starCount = useStarCount()
  const allowed = starCount.data?.available === true

  // A ref, not an effect dependency: re-running the effect when the count resolves would rebuild
  // the cache subscription and lose the status map — and with it the "never replay" guarantee
  // that makes this a first-run toast rather than an any-run one.
  const allowedRef = useRef(allowed)
  allowedRef.current = allowed
  const statusesRef = useRef<ReadonlyMap<string, RunStatus>>(new Map())

  useEffect(() => {
    const listHash = hashKey(queryKeys.runs.list())

    const observe = (runs: readonly ApiRun[] | undefined): void => {
      const { succeeded, statuses } = diffSuccessTransition(statusesRef.current, runs)
      statusesRef.current = statuses
      if (!succeeded || !allowedRef.current || hasSeenStarToast()) return
      // Marked BEFORE the toast is published. A throw between the two would cost one user the
      // ask; the other order would cost every user a toast that repeats forever.
      markStarToastSeen()
      toast(STAR_TOAST_MESSAGE, {
        action: { label: STAR_TOAST_ACTION_LABEL, href: CEZAR_REPO_URL },
        durationMs: STAR_TOAST_MS,
      })
    }

    // Seed from whatever the cache already holds: with an empty previous map nothing can be a
    // transition, so mounting mid-session records the current statuses and stays silent.
    observe(queryClient.getQueryData<ApiRun[]>(queryKeys.runs.list()))

    return queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== listHash || event.type !== 'updated') return
      observe(event.query.state.data as ApiRun[] | undefined)
    })
  }, [queryClient])

  return null
}
