import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useCallback, useMemo, useRef } from 'react'

import type { RunEvent, RunHistoryPage } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { getRunHistory, getRunHistoryContext } from './client'
import { useRunEvents } from './run-events'

const MAX_HISTORY_PAGES = 5
const COMPACT_LIVE_AT_EVENTS = 200
const MAX_LIVE_EVENTS = 5_000

function orderedUnique(...groups: readonly RunEvent[][]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>()
  for (const group of groups) {
    for (const event of group) bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export interface RunHistoryState {
  visibleEvents: RunEvent[]
  currentEvents: RunEvent[]
  isPending: boolean
  contextPending: boolean
  fallback: boolean
  hasOlder: boolean
  isFetchingOlder: boolean
  olderError: string | undefined
  loadOlder: () => Promise<void>
  jumpToLatest: () => Promise<void>
  retainedPages: number
}

/**
 * Bounded transcript hydration: newest page and compact current-state context load in parallel,
 * then one cursor-resumed SSE carries live frames. Any optimized-path failure switches once to
 * the protected full-replay hook so a missing optimization never makes a session unreadable.
 */
export function useRunHistory(runId: string | undefined): RunHistoryState {
  const scope = queryScope()
  const queryClient = useQueryClient()
  const historyKey = ['run-history', scope, runId] as const
  const contextKey = ['run-history-context', scope, runId] as const

  const history = useInfiniteQuery({
    queryKey: historyKey,
    enabled: runId !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => getRunHistory(runId!, pageParam, { signal }),
    getPreviousPageParam: (firstPage) => firstPage.olderCursor,
    getNextPageParam: (lastPage) => lastPage.newerCursor,
    maxPages: MAX_HISTORY_PAGES,
    retry: 1,
  })
  const context = useQuery({
    queryKey: contextKey,
    enabled: runId !== undefined,
    queryFn: ({ signal }) => getRunHistoryContext(runId!, { signal }),
    retry: 1,
  })

  const fallback = history.isError || context.isError
  const fallbackEvents = useRunEvents(fallback ? runId : undefined)
  const pages = history.data?.pages ?? []
  const newestPage = pages.reduce<RunHistoryPage | undefined>(
    (latest, page) =>
      page.newerCursor === undefined
        ? page
        : latest ?? page,
    undefined,
  )
  const compactingLive = useRef(false)
  const compactLive = useCallback(() => {
    if (runId === undefined || compactingLive.current) return
    compactingLive.current = true
    void getRunHistory(runId, undefined)
      .then((latestPage) => {
        queryClient.setQueryData<InfiniteData<RunHistoryPage, string | undefined>>(
          ['run-history', scope, runId],
          (current) => {
            if (!current) return { pages: [latestPage], pageParams: [undefined] }
            const pages = [...current.pages]
            const pageParams = [...current.pageParams]
            let latestIndex = -1
            for (let index = 0; index < pages.length; index += 1) {
              if (latestIndex === -1 || pages[index]!.asOfSeq > pages[latestIndex]!.asOfSeq) latestIndex = index
            }
            if (latestIndex >= 0 && pages[latestIndex]!.newerCursor === undefined) {
              pages[latestIndex] = latestPage
              pageParams[latestIndex] = undefined
            } else {
              pages.push(latestPage)
              pageParams.push(undefined)
            }
            while (pages.length > MAX_HISTORY_PAGES) {
              pages.shift()
              pageParams.shift()
            }
            return { pages, pageParams }
          },
        )
      })
      // Compaction is an optimization, not a load: this call is fire-and-forget (`void`), so a
      // rejection here has no query to reject and would surface as an unhandled rejection. The
      // live buffer still holds every event, and the next `onCompact` retries — so swallowing is
      // the graceful outcome. Reachable via a transport error, and now also via a malformed page
      // body, which the client validates rather than casts (#827).
      .catch(() => {})
      .finally(() => {
        compactingLive.current = false
      })
  }, [queryClient, runId, scope])
  const liveEvents = useRunEvents(!fallback && newestPage ? runId : undefined, {
    cursor: newestPage?.liveCursor,
    afterSeq: newestPage?.asOfSeq,
    maxEvents: MAX_LIVE_EVENTS,
    compactAt: COMPACT_LIVE_AT_EVENTS,
    onCompact: compactLive,
  })

  const pagedEvents = useMemo(
    () => orderedUnique(...pages.map((page) => page.events as RunEvent[])),
    [pages],
  )
  const visibleEvents = useMemo(
    () => fallback ? fallbackEvents : orderedUnique(pagedEvents, liveEvents),
    [fallback, fallbackEvents, pagedEvents, liveEvents],
  )
  const currentEvents = useMemo(() => {
    if (fallback) return fallbackEvents
    const contextEvents = (context.data?.contextEvents ?? []) as RunEvent[]
    const contextHighWater = context.data?.asOfSeq ?? 0
    return orderedUnique(contextEvents, visibleEvents.filter(({ seq }) => seq > contextHighWater))
  }, [context.data, fallback, fallbackEvents, visibleEvents])

  const loadOlder = useCallback(async () => {
    await history.fetchPreviousPage()
  }, [history.fetchPreviousPage])

  const jumpToLatest = useCallback(async () => {
    await queryClient.resetQueries({ queryKey: historyKey, exact: true })
  }, [historyKey, queryClient])

  return {
    visibleEvents,
    currentEvents,
    isPending: !fallback && history.isPending,
    contextPending: !fallback && context.isPending,
    fallback,
    hasOlder: !fallback && Boolean(history.hasPreviousPage),
    isFetchingOlder: history.isFetchingPreviousPage,
    olderError: history.isFetchPreviousPageError
      ? history.error instanceof Error ? history.error.message : 'Could not load earlier items'
      : undefined,
    loadOlder,
    jumpToLatest,
    retainedPages: pages.length,
  }
}
