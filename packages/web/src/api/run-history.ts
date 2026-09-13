import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { RunEvent, RunHistoryPage } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { getRunHistory, getRunHistoryContext } from './client'
import { liveItemKey, useRunEvents, type RunEventCompaction } from './run-events'

const MAX_HISTORY_PAGES = 5
const COMPACT_LIVE_AT_EVENTS = 200
const LIVE_COMPACTION_SIZE_TRIGGER = 5_000
const COMPACTION_TIMEOUT_MS = 15_000
const EMPTY_RUN_EVENTS: RunEvent[] = []

function orderedUnique(...groups: readonly (readonly RunEvent[])[]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>()
  for (const group of groups) {
    for (const event of group) bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function isStrictlyIncreasing(events: readonly RunEvent[]): boolean {
  let previous = -Infinity
  for (const event of events) {
    if (event.seq <= previous) return false
    previous = event.seq
  }
  return true
}

function newestCursorlessPage(pages: readonly RunHistoryPage[]): RunHistoryPage | undefined {
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (pages[index]!.newerCursor === undefined) return pages[index]
  }
  return undefined
}

/** Merge the normal ordered streams without rebuilding a map and sorting their full contents. */
function mergeOrderedUnique(...groups: readonly (readonly RunEvent[])[]): RunEvent[] {
  if (!groups.every(isStrictlyIncreasing)) return orderedUnique(...groups)
  const indexes = groups.map(() => 0)
  const merged: RunEvent[] = []
  for (;;) {
    let nextSeq = Infinity
    for (let index = 0; index < groups.length; index += 1) {
      const event = groups[index]![indexes[index]!]
      if (event !== undefined && event.seq < nextSeq) nextSeq = event.seq
    }
    if (nextSeq === Infinity) return merged
    let selected: RunEvent | undefined
    for (let index = 0; index < groups.length; index += 1) {
      const event = groups[index]![indexes[index]!]
      if (event?.seq === nextSeq) {
        selected = event
        indexes[index] = indexes[index]! + 1
      }
    }
    if (selected !== undefined) merged.push(selected)
  }
}

/**
 * `asOfSeq` is a file high-water mark, not a contiguous live watermark: ephemeral deltas create
 * sequence gaps. Only remove a live sequence when it is present in durable history, or when a
 * durable full item snapshot after that delta repairs the same item.
 */
export function coveredLiveEventSeqs(
  liveEvents: readonly RunEvent[],
  persistedEvents: readonly RunEvent[],
  durableThroughSeq = -Infinity,
): RunEventCompaction {
  const durableSeqs = new Set(persistedEvents.map(({ seq }) => seq))
  const snapshotSeqs = new Map<string, number>()
  for (const event of persistedEvents) {
    if (event.type !== 'item.updated' && event.type !== 'item.completed') continue
    const key = liveItemKey(event)
    if (key !== undefined) snapshotSeqs.set(key, Math.max(snapshotSeqs.get(key) ?? -Infinity, event.seq))
  }
  return liveEvents
    .filter((event) => {
      if (durableSeqs.has(event.seq)) return true
      // Every non-delta/non-streaming snapshot event is persisted by the server. The page only
      // carries its newest 100 lines, so the file high-water mark also covers durable lines that
      // have already paged out of the in-memory window.
      if (event.seq <= durableThroughSeq && event.type !== 'item.delta' && event.type !== 'item.updated') {
        return true
      }
      if (event.type !== 'item.delta' && event.type !== 'item.updated') return false
      const snapshotSeq = snapshotSeqs.get(liveItemKey(event) ?? '')
      return snapshotSeq !== undefined && snapshotSeq > event.seq
    })
    .map(({ seq }) => seq)
}

/**
 * The optimized stream is append-only between history compactions. Keep that hot path linear and
 * preserve the old dedup/sort fallback for reconnects or a page replacement that overlaps it.
 */
export function mergeRunHistoryEvents(
  base: readonly RunEvent[],
  live: readonly RunEvent[],
): RunEvent[] {
  if (live.length === 0) return base.slice()
  const lastSeq = base.at(-1)?.seq ?? -Infinity
  let previous = -Infinity
  for (const event of live) {
    if (event.seq <= previous) return orderedUnique(base, live)
    previous = event.seq
  }
  if (base.length === 0 || live[0]!.seq > lastSeq) return [...base, ...live]

  // Compaction can replace the persisted page while the live buffer still contains frames from
  // the old cursor. Both lists are ordered, so merge them without a map/sort and keep every live
  // frame that the persisted page does not contain.
  return mergeOrderedUnique(base, live)
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
  const tailKey = ['run-history-tail', scope, runId] as const

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

  const initialHistoryError = history.isError
    && history.data === undefined
    && !history.isFetchPreviousPageError
    && !history.isFetchNextPageError
    && !history.isRefetchError
  const initialContextError = context.isError && context.data === undefined && !context.isRefetchError
  const pages = history.data?.pages ?? []
  const newestPageRef = useRef<RunHistoryPage | undefined>(undefined)
  const ownerKey = `${scope}\0${runId ?? ''}`
  const ownerRef = useRef({ key: ownerKey, fallbackLatched: false })
  const historyMutationRef = useRef(Promise.resolve())
  const historyGenerationRef = useRef(0)
  if (ownerRef.current.key !== ownerKey) {
    ownerRef.current = { key: ownerKey, fallbackLatched: false }
    historyMutationRef.current = Promise.resolve()
    historyGenerationRef.current += 1
    newestPageRef.current = undefined
  }
  if (initialHistoryError || initialContextError) ownerRef.current.fallbackLatched = true
  const fallback = ownerRef.current.fallbackLatched
  const enqueueHistoryMutation = useCallback(<T,>(mutation: () => Promise<T>): Promise<T> => {
    const previous = historyMutationRef.current
    let release!: () => void
    historyMutationRef.current = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(mutation).finally(release)
  }, [])
  const cachedNewestPage = newestCursorlessPage(pages)
  const cachedTail = pages.length > 0
    ? queryClient.getQueryData<RunHistoryPage>(tailKey)
    : undefined
  if (cachedNewestPage && (!newestPageRef.current || cachedNewestPage.asOfSeq >= newestPageRef.current.asOfSeq)) {
    newestPageRef.current = cachedNewestPage
  } else if (cachedTail && (!newestPageRef.current || cachedTail.asOfSeq >= newestPageRef.current.asOfSeq)) {
    newestPageRef.current = cachedTail
  }
  // With maxPages, TanStack may evict the cursorless newest page while older pages remain. The
  // tail is kept outside that window so the live cursor never starts after an evicted segment.
  // The last retained page is only a final recovery for pre-existing cache shapes.
  const newestPage = newestPageRef.current
    ?? cachedNewestPage
    ?? cachedTail
    ?? (pages.length > 0 ? pages.at(-1) : undefined)
  const compactingOwnerRef = useRef<string | undefined>(undefined)
  const compactLive = useCallback(async (liveEvents: readonly RunEvent[]): Promise<RunEventCompaction | false> => {
    if (runId === undefined || compactingOwnerRef.current === ownerKey) return false
    compactingOwnerRef.current = ownerKey
    const generation = historyGenerationRef.current
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const latestPage = await Promise.race<RunHistoryPage>([
        getRunHistory(runId, undefined, { signal: controller.signal }),
        new Promise<RunHistoryPage>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error('history compaction timed out'))
          }, COMPACTION_TIMEOUT_MS)
        }),
      ])
      if (ownerRef.current.key !== ownerKey || historyGenerationRef.current !== generation) return false
      const current = queryClient.getQueryData<InfiniteData<RunHistoryPage, string | undefined>>(historyKey)
      // Only the cursorless page is the current tail. Older pages can carry the same file
      // high-water mark and must not reject a newer tail snapshot.
      const currentTail = newestCursorlessPage(current?.pages ?? [])
      const cachedTail = queryClient.getQueryData<RunHistoryPage>(tailKey)
      const latestKnownAsOfSeq = Math.max(
        currentTail?.asOfSeq ?? -Infinity,
        cachedTail?.asOfSeq ?? -Infinity,
        newestPageRef.current?.asOfSeq ?? -Infinity,
      )
      // Decide and install against the same snapshot. Computing coverage before an updater can
      // reject a stale page would remove live frames even though that page never became cache.
      if (latestKnownAsOfSeq >= latestPage.asOfSeq) return false
      const next: InfiniteData<RunHistoryPage, string | undefined> = current
        ? (() => {
          const pages = [...current.pages]
          const pageParams = [...current.pageParams]
          const latestIndex = currentTail ? pages.indexOf(currentTail) : -1
          if (latestIndex >= 0) {
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
        })()
        : { pages: [latestPage], pageParams: [undefined] }
      queryClient.setQueryData(historyKey, next)
      queryClient.setQueryData(tailKey, latestPage)
      newestPageRef.current = latestPage
      return coveredLiveEventSeqs(
        liveEvents,
        next.pages.flatMap((page) => page.events as RunEvent[]),
        latestPage.asOfSeq,
      )
    } catch {
      // Compaction is an optimization, not a load. The live buffer remains the source of truth,
      // and the stream re-arms its request latch so a later batch can retry.
      return false
    } finally {
      clearTimeout(timeout)
      controller.abort()
      if (compactingOwnerRef.current === ownerKey) compactingOwnerRef.current = undefined
    }
  }, [historyKey, ownerKey, queryClient, runId, tailKey])
  const liveEvents = useRunEvents(newestPage && !fallback ? runId : undefined, newestPage ? {
    cursor: newestPage.liveCursor,
    afterSeq: newestPage.asOfSeq,
    compactWhenOver: LIVE_COMPACTION_SIZE_TRIGGER,
    compactAt: COMPACT_LIVE_AT_EVENTS,
    onCompact: compactLive,
  } : {})
  const fallbackEvents = useRunEvents(fallback ? runId : undefined)
  const fallbackTailRef = useRef<{ runId: string | undefined; scope: string; events: RunEvent[] }>({
    runId: undefined,
    scope,
    events: [],
  })
  if (fallbackTailRef.current.runId !== runId || fallbackTailRef.current.scope !== scope) {
    fallbackTailRef.current = { runId, scope, events: [] }
  }
  if (!fallback) fallbackTailRef.current.events = liveEvents
  const fallbackTail = fallback ? fallbackTailRef.current.events : EMPTY_RUN_EVENTS

  const pagedEvents = useMemo(
    () => {
      const groups = pages.map((page) => page.events as RunEvent[])
      if (newestPage !== undefined && !pages.includes(newestPage)) groups.push(newestPage.events as RunEvent[])
      return orderedUnique(...groups)
    },
    [newestPage, pages],
  )
  useEffect(() => {
    const page = newestCursorlessPage(pages)
    if (!page) return
    queryClient.setQueryData(tailKey, page)
  }, [pages, queryClient, runId, scope])
  const visibleEvents = useMemo(
    () => fallback
      ? mergeOrderedUnique(pagedEvents, fallbackTail, fallbackEvents)
      : mergeRunHistoryEvents(pagedEvents, liveEvents),
    [fallback, fallbackEvents, fallbackTail, liveEvents, pagedEvents],
  )
  const currentEvents = useMemo(() => {
    if (fallback) return visibleEvents
    const contextEvents = (context.data?.contextEvents ?? []) as RunEvent[]
    const contextHighWater = context.data?.asOfSeq ?? 0
    return mergeOrderedUnique(
      contextEvents,
      visibleEvents.filter(({ seq }) => seq > contextHighWater),
      liveEvents.filter(({ seq }) => seq <= contextHighWater),
    )
  }, [context.data, fallback, liveEvents, visibleEvents])

  const loadOlder = useCallback(async () => {
    const requestOwnerKey = ownerKey
    const requestGeneration = historyGenerationRef.current
    const current = queryClient.getQueryData<InfiniteData<RunHistoryPage, string | undefined>>(historyKey)
    const tail = newestCursorlessPage(current?.pages ?? [])
    if (tail) queryClient.setQueryData(tailKey, tail)
    try {
      await enqueueHistoryMutation(() => history.fetchPreviousPage())
    } finally {
      if (ownerRef.current.key !== requestOwnerKey || historyGenerationRef.current !== requestGeneration) return
      const latestTail = newestPageRef.current
      if (!latestTail) return
      queryClient.setQueryData<InfiniteData<RunHistoryPage, string | undefined> | undefined>(historyKey, (current) => {
        if (!current) return current
        const currentTail = newestCursorlessPage(current.pages)
        const tailIndex = currentTail ? current.pages.indexOf(currentTail) : -1
        if (tailIndex < 0 || current.pages[tailIndex]!.asOfSeq >= latestTail.asOfSeq) return current
        const pages = [...current.pages]
        pages[tailIndex] = latestTail
        return { ...current, pages }
      })
    }
  }, [enqueueHistoryMutation, history.fetchPreviousPage, historyKey, queryClient, tailKey])

  const jumpToLatest = useCallback(async () => {
    historyGenerationRef.current += 1
    historyMutationRef.current = Promise.resolve()
    newestPageRef.current = undefined
    queryClient.removeQueries({ queryKey: tailKey, exact: true })
    // resetQueries cancels the in-flight older-page request, clears its data immediately, and
    // refetches the active cursorless page. Do not await the refetch: the scroller must jump now.
    void queryClient.resetQueries({ queryKey: historyKey, exact: true })
  }, [historyKey, queryClient, tailKey])

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
