import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { queryKeys, useWorkspaceUiState } from '@/api/queries'
import type { ApiRun, RunStatus } from '@/api/types'
import {
  diffRunTransitions,
  normalizeNotifications,
  notificationSupport,
  shouldNotify,
  describeRunNotification,
} from '@/lib/notifications'

/**
 * The notification trigger (R6 Step 1.7, spec §"Cross-cutting"): browser `Notification` when a
 * run ENTERS `waiting`/`review`/failed while the tab is hidden.
 *
 * It watches the cached run list rather than opening its own listener on `/api/events`: the
 * global stream (api/global-events.tsx) already folds every `run` event into
 * `queryKeys.runs.list()`, and the reconnect/visibility reconciliation refetches it — so one
 * cache subscription sees BOTH deliveries of the same truth. That second path is not a bonus,
 * it is the point: a hidden tab is exactly when the stream is most likely to have been frozen
 * (mobile background freeze, laptop lid), and the run that flipped to `waiting` while the socket
 * was dead arrives via the reconciling refetch, not via an event.
 *
 * Statuses are tracked UNCONDITIONALLY — before the enabled/hidden/permission gate — so flipping
 * the toggle on later, or refocusing the tab, never replays transitions that already happened:
 * the gate decides whether a transition becomes a notification, never whether it was observed.
 *
 * Renders nothing. Mounted once in app.tsx, beside the providers, for the app's whole life.
 */
export function RunNotifications() {
  const queryClient = useQueryClient()
  // The toggle, straight from the GLOBAL ui-state (step 3.5 moved the section there — the
  // notifying browser is one browser whichever project is open). Read through the same query
  // AppearanceProvider keeps warm — no extra fetch, and a PUT from Settings updates this cache
  // entry, so the gate flips without any coupling between the two components.
  const uiState = useWorkspaceUiState()
  const enabled = normalizeNotifications(uiState.data?.notifications).enabled

  // A ref, not an effect dependency: re-running the effect on toggle flips would rebuild the
  // cache subscription and lose the status map — the whole "never replay" guarantee.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const statusesRef = useRef<ReadonlyMap<string, RunStatus>>(new Map())

  useEffect(() => {
    const listHash = hashKey(queryKeys.runs.list())

    const observe = (runs: readonly ApiRun[] | undefined): void => {
      const { entering, statuses } = diffRunTransitions(statusesRef.current, runs)
      statusesRef.current = statuses
      if (entering.length === 0) return
      const gate = {
        enabled: enabledRef.current,
        hidden: document.visibilityState === 'hidden',
        permission: notificationSupport(),
      }
      if (!shouldNotify(gate)) return
      for (const run of entering) fireRunNotification(run)
    }

    // Seed from whatever the cache already holds: with an empty previous map nothing can
    // "enter", so a mount mid-session records the current statuses and stays silent.
    observe(queryClient.getQueryData<ApiRun[]>(queryKeys.runs.list()))

    return queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== listHash || event.type !== 'updated') return
      observe(event.query.state.data as ApiRun[] | undefined)
    })
  }, [queryClient])

  return null
}

/** The impure sliver: construct the `Notification`. Guarded and try/caught because both failure
 *  modes are real — no constructor at all (tests, old WebViews), and a constructor that THROWS
 *  on page-context construction (Chrome on Android insists on a ServiceWorker). A notification
 *  is a courtesy; it must never take the message loop down with it. */
function fireRunNotification(run: ApiRun): void {
  const N = globalThis.Notification
  if (typeof N !== 'function') return
  const content = describeRunNotification(run)
  try {
    new N(content.title, { body: content.body, tag: content.tag })
  } catch {
    // Degrade silently — the dot in the quick-list still tells the truth.
  }
}
