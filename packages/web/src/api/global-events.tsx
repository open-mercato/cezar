import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

import {
  applyProviderStatusRow,
  parseProviderStatusEventRow,
  type ProviderStatusEventRow,
} from '@/lib/provider-status'
import {
  applyRunDeleted,
  applyRunEvent,
  createUsageStore,
  EMPTY_USAGE,
  mergeRun,
  parseWorkspaceEvent,
  type GlobalEvent,
  type UsageStore,
} from './events'
import { apiPath, getApiScope, queryScope } from '@open-mercato/cezar-api-client'
import { queryKeys, useHealthSubscription, workspaceQueryKeys } from './queries'
import { RUN_EVENT_BATCH_MS } from './run-events'
import type {
  ApiRun,
  HealthResponse,
  ProcessUsage,
  ProviderStatusResponse,
} from '@open-mercato/cezar-api-client'

/**
 * The app's one connection to `GET /api/workspace/events`, and the two halves of the sync
 * doctrine (spec, "Architecture"): the stream is for immediacy, the REST endpoints are
 * authoritative, and on reconnect or a tab-visibility flip we refetch and reconcile.
 *
 * Immediacy is cache patching, not refetching: a live run emits a `run` event per step transition
 * and per token update, and invalidating the list on each would turn one agent into a request
 * flood against a server sharing this laptop's CPU with it. So events are folded into the cache
 * in place (events.ts), and the authoritative refetch happens exactly when we know we may have
 * missed something: at reconnect, and when a tab (or a phone that slept through an hour of the
 * run) comes back.
 *
 * Multi-project (spec, step 3.1): the one stream carries EVERY project's events, each stamped
 * with its owner. This layer unwraps the envelope (events.ts) and applies only the active
 * project's events — the mounted scope's, or the boot project's when unscoped — so the caches
 * (which are keyed by that same scope, queries.ts) never see another project's data. One
 * connection for the whole workspace, not one per project: same per-origin socket-budget
 * argument as ever, and a project switch changes the filter, not the socket.
 *
 * Provider authentication is host-wide rather than project-owned. Its dedicated unstamped event
 * bypasses that project filter and patches only an already-fetched workspace cache.
 */

// Route-relative: `apiPath` adds the version (and would add the project scope, though this
// stream is workspace-level and never scoped).
const SSE_URL = apiPath('/workspace/events')

/** `EventSource.CLOSED`. Spelled as the literal so nothing here depends on the global's statics —
 *  the same reason the constructor is read off `globalThis` below. */
const CLOSED = 2

/** How long to wait before rebuilding a stream the browser gave up on. Long enough that a server
 *  restart isn't hammered while it boots, short enough that the cockpit is live again before the
 *  reader notices. Only reached in the permanent-failure case: an ordinary drop is EventSource's
 *  own retry, which we neither can nor should replace. */
const REOPEN_DELAY_MS = 3_000

/** Everything the stream is allowed to say. An unknown name never reaches `parseGlobalEvent`,
 *  because SSE only delivers named events to a matching listener in the first place. */
const EVENT_NAMES = ['run', 'run-deleted', 'todos', 'usage', 'ping'] as const

/**
 * The workspace-only names (server: `WorkspaceEventName`). Unlike the list above these are not
 * project-stamped and never patch a run cache — they are registry news, so they invalidate the
 * projects query (the sidebar grows/loses a group without a reload) and fan out to whoever
 * subscribed via `onWorkspaceEvent`.
 */
const WORKSPACE_EVENT_NAMES = ['project-added', 'project-removed', 'checkout-progress', 'automation-change'] as const

type WorkspaceEventName = (typeof WORKSPACE_EVENT_NAMES)[number]

const workspaceListeners = new Set<(name: WorkspaceEventName, payload: unknown) => void>()

/**
 * Subscribe to the workspace-level events on the one stream. Returns an unsubscribe.
 *
 * A module-level registry rather than a React context because the subscriber (the clone dialog,
 * step 4.3) is mounted far from the provider and cares about exactly one event id — a context
 * carrying every payload would re-render the whole tree on each `git clone` progress line.
 * Payloads are handed over RAW (parsed JSON, unvalidated): each listener knows the shape of the
 * event it asked for, and inventing a second parser here would only duplicate events.ts.
 */
export function onWorkspaceEvent(
  listener: (name: WorkspaceEventName, payload: unknown) => void,
): () => void {
  workspaceListeners.add(listener)
  return () => {
    workspaceListeners.delete(listener)
  }
}

/**
 * The cross-project index behind the global Tasks page, refreshed from ANY project's run news.
 *
 * Invalidated rather than patched, and debounced. Patching would mean synthesizing a
 * `RunIndexEntry` from a `RunRecord` — a slim row from a fat one, including the `usage` the server
 * attaches per poll — and inventing a row is exactly what the reducers in `events.ts` refuse to
 * do. Invalidation asks the authoritative endpoint instead, and costs nothing at all unless the
 * page is actually mounted: `invalidateQueries` refetches what is rendered and only marks the rest
 * stale.
 *
 * The debounce is what keeps that honest. One run emits many events (started, step, usage,
 * finished), and a workspace of forty projects emits them from everywhere at once; without it a
 * busy minute would be a refetch per event. One request per quiet moment is the whole point.
 */
const RUNS_INDEX_REFRESH_DEBOUNCE_MS = 400
const RECONCILE_TIMEOUT_MS = 15_000

/** Built per mount, not module-level: a pending timer holds the `queryClient` it will write to,
 *  and one that outlives its provider would invalidate a cache nobody is reading. `cancel` runs
 *  in the effect cleanup. */
function createRunsIndexRefresher(queryClient: QueryClient): {
  onEvent: (event: GlobalEvent) => void
  cancel: () => void
} {
  let pending: ReturnType<typeof setTimeout> | undefined
  return {
    onEvent(event) {
      if (event.type !== 'run' && event.type !== 'run-deleted') return
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      }, RUNS_INDEX_REFRESH_DEBOUNCE_MS)
    },
    cancel() {
      clearTimeout(pending)
      pending = undefined
    },
  }
}

function projectCacheScopes(queryClient: QueryClient, project: string): string[] {
  let bootProject: string | undefined
  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.queryKey[1] !== 'health') continue
    const candidate = (query.state.data as HealthResponse | undefined)?.bootProject
    if (typeof candidate === 'string') {
      bootProject = candidate
      break
    }
  }
  const scopes = new Set([project])
  if (bootProject === project) scopes.add('default')
  return [...scopes]
}

function historyQueryKeys(scope: string): readonly (readonly unknown[])[] {
  return [
    ['run-history', scope],
    ['run-history-context', scope],
    ['run-history-tail', scope],
  ]
}

function eventQueryKeys(scope: string): readonly (readonly unknown[])[] {
  return [
    [scope, 'runs'],
    [scope, 'todos'],
    [scope, 'worktrees'],
    ...historyQueryKeys(scope),
  ]
}

/** Extract the scope from a cached project key, including the two transcript keys that have a
 *  semantic prefix before their scope. Workspace keys are deliberately excluded. */
function projectQueryScope(queryKey: readonly unknown[]): string | undefined {
  if (queryKey[0] === 'workspace') return undefined
  if (
    queryKey[0] === 'run-history'
    || queryKey[0] === 'run-history-context'
    || queryKey[0] === 'run-history-tail'
  ) {
    return typeof queryKey[1] === 'string' ? queryKey[1] : undefined
  }
  return typeof queryKey[0] === 'string' ? queryKey[0] : undefined
}

function cachedProjectScopes(queryClient: QueryClient): string[] {
  return [...new Set(queryClient.getQueryCache().getAll()
    .map(({ queryKey }) => projectQueryScope(queryKey))
    .filter((scope): scope is string => scope !== undefined))]
}

/** Mark inactive project caches stale in one quiet batch; never patch them with another scope's data. */
function createInactiveProjectRefresher(queryClient: QueryClient): {
  onEvent: (project: string) => void
  cancel: () => void
} {
  let pending: ReturnType<typeof setTimeout> | undefined
  let scopes = new Set<string>()
  return {
    onEvent(project) {
      if (pending !== undefined && scopes.has(project)) return
      for (const scope of projectCacheScopes(queryClient, project)) scopes.add(scope)
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        const queued = scopes
        scopes = new Set()
        const activeScope = queryScope()
        for (const scope of queued) {
          for (const queryKey of eventQueryKeys(scope)) {
            void queryClient.invalidateQueries({
              queryKey,
              refetchType: scope === activeScope ? 'active' : 'none',
            })
          }
        }
      }, RUNS_INDEX_REFRESH_DEBOUNCE_MS)
    },
    cancel() {
      clearTimeout(pending)
      pending = undefined
      scopes.clear()
    },
  }
}

/**
 * Coalesce global run summaries before touching the query cache. The sidebar needs live status,
 * but it does not need one React notification per token/usage update.
 */
function createRunEventBatcher(
  queryClient: QueryClient,
  usage: UsageStore,
  onDroppedProject: (project: string) => void,
): {
  onEvent: (event: Extract<GlobalEvent, { type: 'run' | 'run-deleted' }>, project: string) => void
  beginReconcile: () => void
  endReconcile: () => void
  cancel: () => void
} {
  let pending = new Map<string, {
    event: Extract<GlobalEvent, { type: 'run' | 'run-deleted' }>
    project: string
  }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reconciliationDepth = 0

  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (reconciliationDepth > 0) return
    const project = activeProject(queryClient)
    const events = pending
    pending = new Map()
    for (const queued of events.values()) {
      // The route can change while the 50 ms window is open. Never resolve the cache keys from
      // the new scope for an event that arrived under the old one.
      if (queued.project === project) applyGlobalEvent(queryClient, usage, queued.event)
      else onDroppedProject(queued.project)
    }
  }

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(flush, RUN_EVENT_BATCH_MS)
  }

  return {
    onEvent(event, project) {
      const id = event.type === 'run' ? event.run.id : event.id
      pending.set(`${project}:${id}`, { event, project })
      schedule()
    },
    beginReconcile() {
      // Flush the pre-reconcile snapshot, then hold later live events until the authoritative
      // invalidations finish. Otherwise an older response can overwrite a newer queued event.
      flush()
      reconciliationDepth += 1
    },
    endReconcile() {
      if (reconciliationDepth === 0) return
      reconciliationDepth -= 1
      if (reconciliationDepth === 0) flush()
    },
    cancel() {
      clearTimeout(timer)
      timer = undefined
      pending.clear()
      reconciliationDepth = 0
    },
  }
}

/**
 * Refetch the authoritative endpoints.
 *
 * These are the endpoints the stream can leave stale:
 * - runs: the summaries the stream patches (`invalidate(['runs'])` covers the list and every
 *   single-run query under it — that is what the hierarchical keys in queries.ts are for);
 * - todos: the inbox the `todos` event replaces;
 * - health: the repo/branch chip. Health is not on the stream — nothing server-side watches for a
 *   branch switch — so this reconcile alone only catches a switch across a reconnect or a tab
 *   coming back; a checkout in a foreground, connected tab is covered by `useHealth`'s own poll
 *   instead (#369). Invalidating it here too costs nothing extra and keeps this list a complete
 *   "everything the stream can leave stale" note;
 * - worktrees: run terminal transitions and reclaim operations change the resources panel;
 * - provider status: runtime authentication failures patch this workspace-wide cache live.
 *
 * `invalidateQueries` and not `refetchQueries`: it refetches what is actually rendered and marks
 * the rest stale for whenever it next mounts. A background tab with fifty cached runs should not
 * fetch fifty runs to come back.
 */
async function reconcile(queryClient: QueryClient): Promise<void> {
  const activeScope = queryScope()
  const keys = [
    queryKeys.runs.all,
    // Events happened while we were disconnected, and the index is cross-project — nothing else
    // here covers it.
    workspaceQueryKeys.runsIndex,
    queryKeys.todos,
    queryKeys.health,
    // The worktree panel's list/total (#483) — a run finishing or a reclaim changes it.
    queryKeys.worktrees,
    workspaceQueryKeys.providerStatus,
    ['run-history', activeScope] as const,
    ['run-history-context', activeScope] as const,
  ] as const
  const invalidations = Promise.allSettled(
    [
      ...cachedProjectScopes(queryClient)
        .filter((scope) => scope !== activeScope)
        .flatMap((scope) => eventQueryKeys(scope).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey, refetchType: 'none' }))),
      ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ],
  )
  let completed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      invalidations.then(() => { completed = true }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, RECONCILE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  if (completed) return
  // A broken request must not hold the live-event queue forever. Cancelling marks the queries
  // stale without allowing a late fetch result to win over the events released below.
  await Promise.allSettled(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })))
}

/**
 * The project whose events this cockpit currently applies: the mounted scope, or — unscoped —
 * the boot project `GET /api/health` names (`bootProject`, additive field). Undefined only in
 * the unscoped moments before health's first answer; stamped events are dropped then, which is
 * harmless by the doctrine — the authoritative queries are fetching right at that moment, and
 * the reducers refuse to invent caches from stream messages anyway.
 */
function activeProject(queryClient: QueryClient): string | undefined {
  return getApiScope() ?? (queryClient.getQueryData(queryKeys.health) as HealthResponse | undefined)?.bootProject
}

/** Fold one stream message into the cache. The reducers it calls are pure and table-tested in
 *  events.ts; this is only the wiring from an event to the cache it belongs in. */
function applyGlobalEvent(queryClient: QueryClient, usage: UsageStore, event: GlobalEvent): void {
  switch (event.type) {
    case 'run': {
      queryClient.setQueryData<ApiRun[]>(queryKeys.runs.list(), (list) => applyRunEvent(list, event.run))
      // Only a detail cache that exists: `setQueryData` would happily create one, leaving an entry
      // for a run nobody opened — and, worse, one built from a summary rather than from
      // `GET /api/runs/:id`, which the next reader would then be served as if it were fetched.
      const key = queryKeys.runs.detail(event.run.id)
      if (queryClient.getQueryData(key) !== undefined) {
        queryClient.setQueryData<ApiRun>(key, (previous) => mergeRun(previous, event.run))
      }
      // The Changes tab stops polling once a run leaves the active set (queries.ts:
      // refetchInterval only lives while active), so end-of-run writes would otherwise wait
      // for the next SSE reconnect's reconcile(). Invalidate the changes cache on the run event
      // itself — but only when one already exists, so a background tab that never opened the
      // Changes view doesn't fetch a diff nobody is looking at (same stance as the detail guard).
      const changesKey = queryKeys.runs.changes(event.run.id)
      if (queryClient.getQueryData(changesKey) !== undefined) {
        void queryClient.invalidateQueries({ queryKey: changesKey })
      }
      // A terminal transition can reclaim (or re-materialize) a worktree (#483); keep the
      // panel live. invalidateQueries only refetches while the panel is actually mounted.
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
      return
    }
    case 'run-deleted': {
      queryClient.setQueryData<ApiRun[]>(queryKeys.runs.list(), (list) => applyRunDeleted(list, event.id))
      // Removed, not set to undefined: the run is gone server-side, so its detail and diff caches
      // are garbage. Anything still mounted on them refetches and gets the server's 404 — the
      // truth — instead of rendering a record that no longer exists.
      queryClient.removeQueries({ queryKey: queryKeys.runs.detail(event.id) })
      queryClient.removeQueries({ queryKey: queryKeys.runs.diff(event.id) })
      // Its worktree goes with it — refresh the panel (#483).
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
      return
    }
    case 'todos':
      // A complete array every time (the server re-reads the file), so it replaces outright and
      // may seed a cache no one fetched yet — unlike `run`, this payload *is* the whole answer.
      queryClient.setQueryData(queryKeys.todos, event.items)
      return
    case 'usage':
      usage.set(event.usage)
      return
    case 'ping':
      // A keep-alive. It says the socket is open, which we already know by receiving it.
      return
  }
}

/**
 * Hold one EventSource open for as long as this is mounted.
 *
 * Called once, by `GlobalEventsProvider`. One connection per app and not per component: browsers
 * cap concurrent connections per origin (6 on HTTP/1.1, which is what a local Hono server speaks),
 * and a handful of components each opening their own stream would spend that budget on duplicate
 * copies of the same messages and then stall every other request behind them.
 */
export function useGlobalEvents(usage: UsageStore, url: string = SSE_URL): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // jsdom has no EventSource, and neither would a prerender. Read it off `globalThis` so the
    // check and the construction see the same binding (`vi.stubGlobal` is what the tests install).
    const Source = globalThis.EventSource
    if (typeof Source !== 'function') return

    let source: EventSource | null = null
    const runsIndexRefresher = createRunsIndexRefresher(queryClient)
    const inactiveProjectRefresher = createInactiveProjectRefresher(queryClient)
    const runEventBatcher = createRunEventBatcher(
      queryClient,
      usage,
      inactiveProjectRefresher.onEvent,
    )
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let everOpened = false
    let disposed = false
    let providerStatusRefetching = false
    let providerStatusDirty = false
    let reconciliationDepth = 0
    let pendingTodos = new Set<string>()
    let pendingProviderRows: ProviderStatusEventRow[] = []

    const refetchUncachedProviderStatus = (): void => {
      providerStatusRefetching = true
      providerStatusDirty = false
      const key = workspaceQueryKeys.providerStatus
      void queryClient.cancelQueries({ queryKey: key, exact: true })
        .then(() => queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'active' }))
        .finally(() => {
          if (disposed || !providerStatusDirty) {
            providerStatusRefetching = false
            return
          }
          // Coalesce every valid event received during this replacement into one trailing fetch.
          // A further event during that fetch marks dirty again, so no status requests overlap.
          refetchUncachedProviderStatus()
        })
    }

    const applyProviderStatusEvent = (row: ProviderStatusEventRow): void => {
      const key = workspaceQueryKeys.providerStatus
      const response = queryClient.getQueryData<ProviderStatusResponse>(key)
      const updated = applyProviderStatusRow(response, row)
      if (updated !== undefined) {
        queryClient.setQueryData(key, updated)
        return
      }
      // An additive row cannot safely seed the complete provider cache. Discard an old
      // initial fetch and replace it after the server emitted this latch. Further valid rows
      // while that replacement is in flight coalesce into one trailing fetch.
      if (providerStatusRefetching) {
        providerStatusDirty = true
        return
      }
      refetchUncachedProviderStatus()
    }

    const reconcileNow = (): void => {
      reconciliationDepth += 1
      runEventBatcher.beginReconcile()
      void reconcile(queryClient).finally(() => {
        reconciliationDepth -= 1
        if (reconciliationDepth === 0) {
          if (disposed) {
            pendingTodos.clear()
            pendingProviderRows = []
          } else {
            flushDeferredEvents()
          }
        }
        runEventBatcher.endReconcile()
      })
    }

    const flushDeferredEvents = (): void => {
      const todosQueued = pendingTodos
      const providerRows = pendingProviderRows
      pendingTodos = new Set()
      pendingProviderRows = []
      // The payload has no version. The reconnect's REST response is authoritative; refetch once
      // more instead of allowing an older queued snapshot to overwrite it.
      const active = activeProject(queryClient)
      for (const project of todosQueued) {
        if (project === active) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.todos })
        } else {
          inactiveProjectRefresher.onEvent(project)
        }
      }
      for (const row of providerRows) applyProviderStatusEvent(row)
    }

    const reopenLater = (): void => {
      if (disposed || reopenTimer !== undefined) return
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined
        if (!disposed) connect()
      }, REOPEN_DELAY_MS)
    }

    const connect = (): void => {
      source?.close()
      // Remote cockpits commonly sit behind HTTP Basic Auth. EventSource supports an explicit
      // credentials mode (unlike WebSocket), so keep every automatic reconnect authenticated.
      const current = new Source(url, { withCredentials: true })
      source = current

      current.addEventListener('open', () => {
        if (disposed || source !== current) return
        // Not the first one: at boot the queries are fetching anyway, and invalidating them here
        // would only ask the same questions twice. Every later open is a *re*connect — we were
        // disconnected, events happened without us, and the cache is now a guess.
        if (everOpened) reconcileNow()
        everOpened = true
      })

      for (const name of EVENT_NAMES) {
        current.addEventListener(name, (event) => {
          if (disposed || source !== current) return
          const parsed = parseWorkspaceEvent(name, (event as MessageEvent<string>).data)
          if (!parsed) return
          // The cross-project index first, and BEFORE the scope filter below — it is the one
          // cache that spans every project, so another project's news is exactly what it is news
          // for. Dropping those events left the global Tasks page entirely poll-driven: a title
          // the namer had rewritten stayed stale until the next tick, and the tick does not run
          // in a background tab, so coming back to one showed yesterday's rows until a reload.
          runsIndexRefresher.onEvent(parsed.event)
          // Another project's news never patches the active scope. Its own cache is marked stale
          // in a debounced batch so a later project switch refetches truth without cross-project
          // bleed. `ping` (project null) always passes — liveness is not project-owned.
          if (parsed.project !== null && parsed.project !== activeProject(queryClient)) {
            inactiveProjectRefresher.onEvent(parsed.project)
            return
          }
          if (parsed.event.type === 'run' || parsed.event.type === 'run-deleted') {
            if (parsed.project !== null) runEventBatcher.onEvent(parsed.event, parsed.project)
          } else if (parsed.event.type === 'todos' && reconciliationDepth > 0) {
            if (parsed.project !== null) pendingTodos.add(parsed.project)
          } else {
            applyGlobalEvent(queryClient, usage, parsed.event)
          }
        })
      }

      for (const name of WORKSPACE_EVENT_NAMES) {
        current.addEventListener(name, (event) => {
          if (disposed || source !== current) return
          let payload: unknown
          try {
            payload = JSON.parse((event as MessageEvent<string>).data)
          } catch {
            return
          }
          // A registry mutation changes the sidebar for every open tab, not just the one that
          // clicked. `checkout-progress` is deliberately NOT in this branch: a clone emits a
          // line every few hundred ms, and re-listing the registry on each would turn one clone
          // into a request flood (the dialog's own success handler invalidates once, at the end).
          if (name !== 'checkout-progress' && name !== 'automation-change') {
            void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
          }
          for (const listener of [...workspaceListeners]) listener(name, payload)
        })
      }

      current.addEventListener('provider-status', (event) => {
        if (disposed || source !== current) return
        let payload: unknown
        try {
          payload = JSON.parse((event as MessageEvent<string>).data)
        } catch {
          return
        }
        const row = parseProviderStatusEventRow(payload)
        if (!row) return
        if (reconciliationDepth > 0) {
          pendingProviderRows.push(row)
          return
        }
        applyProviderStatusEvent(row)
      })

      current.addEventListener('error', () => {
        if (disposed || source !== current) return
        // An ordinary drop leaves the stream CONNECTING and the browser retries it on its own —
        // touching that would just race its backoff. CLOSED means it gave up for good, which is
        // what a restarting server produces (the request is answered with a non-2xx while it
        // boots). Nothing would ever reopen it, so the cockpit would sit there looking live and
        // showing yesterday's state.
        if (current.readyState === CLOSED) reopenLater()
      })
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      // The phone-in-a-pocket case: mobile browsers freeze background tabs, so the stream may have
      // been dead for an hour with no error handler ever running. Whatever is on screen right now
      // is what the reader is about to trust, so ask the server before they read it.
      reconcileNow()
      if (!source || source.readyState === CLOSED) {
        // Don't make them wait out a backoff that started while they were away.
        clearTimeout(reopenTimer)
        reopenTimer = undefined
        connect()
      }
    }

    const onPageHide = (): void => {
      // Full navigation away. React never unmounts for those — the document goes to the
      // back/forward cache still holding this socket, and six cached documents exhaust the
      // browser's per-origin connection pool: the *next* page load then hangs waiting for a
      // free socket. Close eagerly; pageshow reopens if the document ever comes back.
      clearTimeout(reopenTimer)
      reopenTimer = undefined
      const current = source
      source = null
      current?.close()
    }

    const onPageShow = (event: PageTransitionEvent): void => {
      // Only a bfcache restore (`persisted`) finds this document alive with its stream closed
      // by onPageHide; on a normal load this effect just ran and the stream is fresh.
      if (!event.persisted) return
      reconcileNow()
      connect()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    connect()

    return () => {
      disposed = true
      clearTimeout(reopenTimer)
      runsIndexRefresher.cancel()
      inactiveProjectRefresher.cancel()
      runEventBatcher.cancel()
      pendingTodos.clear()
      pendingProviderRows = []
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      // Explicit: an EventSource keeps its socket (and its retry loop) alive on its own, so a
      // dropped reference leaks a connection per remount, and StrictMode remounts every effect.
      const current = source
      source = null
      current?.close()
    }
  }, [queryClient, usage, url])
}

const UsageContext = createContext<UsageStore | null>(null)

/**
 * Mounts the global stream and publishes the live usage map.
 *
 * Must sit inside `QueryClientProvider` (it patches that cache) and be rendered exactly once.
 */
export function GlobalEventsProvider({ children }: { children: ReactNode }) {
  // One store per provider instance, created lazily: a module-level singleton would let one test's
  // ticks bleed into the next, and StrictMode's double-invoked render still yields exactly one.
  const [usage] = useState(createUsageStore)
  useGlobalEvents(usage)
  // The ONE session-long `health` topic subscription (queries.ts): here, at the root that is
  // mounted for the app's whole life, so health stays live continuously instead of flapping with
  // the lifecycles of the ~15 `useHealth` readers below.
  useHealthSubscription()
  return <UsageContext.Provider value={usage}>{children}</UsageContext.Provider>
}

/**
 * The live `{runId → usage}` map. Re-renders the caller on each ~2 s tick and nothing else.
 *
 * Empty outside a provider rather than a throw: "no samples yet" is a real, expected state (it is
 * what every idle cockpit reports), so a component rendered without the stream sees the same
 * nothing it would see before the first tick instead of crashing a tree over telemetry.
 */
export function useUsage(): Record<string, ProcessUsage> {
  const store = useContext(UsageContext)
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.get : getEmptyUsage,
    getEmptyUsage,
  )
}

/**
 * One run's live sample.
 *
 * Selected inside the store subscription rather than by reading the whole map, so a row only
 * re-renders when its own sample is replaced: a tick that carries nothing about this run (it
 * finished, it never had a process) leaves the selected value `undefined` — identical, so React
 * bails out — while `useUsage()` would hand it a new map object every tick.
 */
export function useRunUsage(runId: string | undefined): ProcessUsage | undefined {
  const store = useContext(UsageContext)
  const get = store ? store.get : getEmptyUsage
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (runId ? get()[runId] : undefined),
    () => undefined,
  )
}

const noopSubscribe = (): (() => void) => () => undefined
const getEmptyUsage = (): Record<string, ProcessUsage> => EMPTY_USAGE
