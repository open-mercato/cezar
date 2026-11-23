import {
  questionMutationResponseSchema,
  questionsResponseSchema,
  questionsTopicFrameSchema,
  type HealthResponse,
  type ManagerListResponse,
  type QuestionCounts,
  type QuestionItem,
  type QuestionsResponse,
} from '@open-mercato/cezar-api-client'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { ApiError, cez, unwrap } from './client'
import { managerKeys } from './managers'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'
import { noteAttentionMaybeChanged } from './attention'

/**
 * The Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`): the workspace-level read,
 * its two writes, the `questions` topic and the client-side dismiss undo.
 */

export const questionKeys = {
  all: ['workspace', 'questions'] as const,
}

const questions = () => cez.api.v1.workspace.questions

// Checked against the contract: an older server, or one answering something else, must fail the query, not the page.
const checked = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, path: string, body: unknown): T => {
  const result = schema.safeParse(body)
  if (!result.success) throw new ApiError(200, `the cezar server answered ${path} with an unexpected body`)
  return result.data
}

export async function getQuestions(opts?: { signal?: AbortSignal }): Promise<QuestionsResponse> {
  const path = '/workspace/questions'
  return checked(questionsResponseSchema, path, await unwrap(await questions().$get({}, opts?.signal ? { init: { signal: opts.signal } } : undefined), path))
}

/** `reactivate`: the card's manager is inactive and the user confirmed waking it (spec 2026-11-19-manager-deactivate). */
export async function answerQuestion(key: string, text: string, opts?: { reactivate?: boolean }): Promise<QuestionItem> {
  const path = '/workspace/questions/:key/answer'
  const json = { text, ...(opts?.reactivate ? { reactivate: true as const } : {}) }
  return checked(questionMutationResponseSchema, path, await unwrap(await questions()[':key'].answer.$post({ param: { key: encodeURIComponent(key) }, json }), path)).item
}

export async function dismissQuestion(key: string): Promise<QuestionItem> {
  const path = '/workspace/questions/:key/dismiss'
  return checked(questionMutationResponseSchema, path, await unwrap(await questions()[':key'].dismiss.$post({ param: { key: encodeURIComponent(key) } }), path)).item
}

/** Every reader shares one cache: the sidebar badge keeps it observed, the topic keeps it fresh. */
export function useQuestions(enabled = true) {
  return useQuery({ queryKey: questionKeys.all, queryFn: ({ signal }) => getQuestions({ signal }), enabled })
}

/** Move a closed item out of the open list now; the refetch that follows confirms it. */
export function settleQuestion(queryClient: QueryClient, item: QuestionItem): void {
  queryClient.setQueryData<QuestionsResponse>(questionKeys.all, (data) => {
    if (!data) return data
    const was = data.open.find((row) => row.key === item.key)
    if (!item.closed) return data
    // Already off the list (the live counts took it): record why, the counts are already right.
    if (!was) return { ...data, closed: [item, ...data.closed.filter((row) => row.key !== item.key)] }
    const counts = {
      live: Math.max(0, data.counts.live - (was.older ? 0 : 1)),
      older: Math.max(0, data.counts.older - (was.older ? 1 : 0)),
    }
    return { ...data, open: data.open.filter((row) => row.key !== item.key), closed: [item, ...data.closed.filter((row) => row.key !== item.key)], counts }
  })
  void queryClient.invalidateQueries({ queryKey: questionKeys.all })
}

// ---- live updates --------------------------------------------------------------------------

/**
 * The ONE `questions` topic subscription, at the root like health's (spec § Counts): local mode
 * only, since a browser WebSocket cannot carry a remote proxy's credentials. A frame is the counts
 * and a revision of the open list; the list is re-read only while something shows it.
 */
export function useQuestionsSubscription(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    let release: (() => void) | undefined
    const sync = (): void => {
      const local = queryClient.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.localHandoff === true
      if (local && release === undefined) {
        let revision: string | undefined
        release = subscribeTopic('questions', (data) => {
          const frame = questionsTopicFrameSchema.safeParse(data)
          if (!frame.success) return
          const { revision: next, ...counts } = frame.data
          const listChanged = next !== undefined && revision !== undefined && next !== revision
          revision = next
          applyQuestionCounts(queryClient, counts, listChanged)
          noteAttentionMaybeChanged(queryClient)
        })
      } else if (!local && release !== undefined) {
        release()
        release = undefined
      }
    }
    sync()
    const releaseCache = queryClient.getQueryCache().subscribe(sync)
    return () => {
      releaseCache()
      release?.()
    }
  }, [queryClient])
}

/** `listChanged`: the frame's revision moved, so the list is re-read even at equal counts (a re-ask). */
export function applyQuestionCounts(queryClient: QueryClient, counts: QuestionCounts, listChanged = false): void {
  const before = queryClient.getQueryData<QuestionsResponse>(questionKeys.all)
  if (!listChanged && before && before.counts.live === counts.live && before.counts.older === counts.older) return
  // The server stopped counting cards the badge already subtracts and has been told about (an
  // answer in flight, a dismissal sent): they leave the list in the same write, or the badge
  // would subtract them twice for a frame (and settleQuestion again after).
  let dropped = Math.max(0, (before?.counts.live ?? 0) - counts.live)
  const gone = new Set((before?.open ?? []).filter((row) => !row.older && (answering.has(row.key) || isDismissalSent(row.key)) && dropped-- > 0).map((row) => row.key))
  // A drop left over while a card waits out its undo window could be that card (closed elsewhere,
  // already subtracted) or another one: the counts alone cannot say, so they wait for the list
  // re-read below, which brings both together and cancels that dismissal if it is the one.
  const ambiguous = dropped > 0 && (before?.open ?? []).some((row) => !row.older && isDismissalPending(row.key))
  if (!ambiguous) {
    queryClient.setQueryData<QuestionsResponse>(questionKeys.all, (data) => (
      data ? { ...data, counts, ...(gone.size > 0 ? { open: data.open.filter((row) => !gone.has(row.key)) } : {}) } : data
    ))
  }
  void queryClient.invalidateQueries({ queryKey: questionKeys.all })
}

const REMOTE_REFRESH_MS = 500
let remoteTimer: ReturnType<typeof setTimeout> | undefined

/** Remote mode has no topic: a run or manager frame may have opened or closed a question, so the
 *  list is re-read, batched. Local mode leaves it to the topic. */
export function noteQuestionsMaybeChanged(queryClient: QueryClient): void {
  if (queryClient.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.localHandoff !== false) return
  if (queryClient.getQueryData(questionKeys.all) === undefined || remoteTimer !== undefined) return
  remoteTimer = setTimeout(() => {
    remoteTimer = undefined
    void queryClient.invalidateQueries({ queryKey: questionKeys.all })
  }, REMOTE_REFRESH_MS)
}

// ---- dismiss with undo ---------------------------------------------------------------------

/** Nothing is sent until the undo window ends (design notes § B): undo is a cancelled timer. */
export const DISMISS_UNDO_MS = 6_000

export interface PendingDismissal {
  key: string
  /** What the toast names: the first header. */
  label: string
  /** Paused while focus is inside the toast (design notes § E). */
  paused: boolean
  error?: string
}

type Entry = PendingDismissal & {
  timer?: ReturnType<typeof setTimeout>
  remaining: number
  startedAt: number
  queryClient: QueryClient
  /** Runs where the close fails, mounted or not: Needs you un-hides its row (spec 2026-11-23-needs-you-triage). */
  onFailed?: (error: string) => void
}

const dismissals = new Map<string, Entry>()
let snapshot: readonly PendingDismissal[] = []
const listeners = new Set<() => void>()
/** Answers in flight from the Questions page: the badge drops on the click, not on the reply. */
const answering = new Set<string>()
let answeringSnapshot: ReadonlySet<string> = new Set()

function publish(): void {
  snapshot = [...dismissals.values()].map(({ key, label, paused, error }) => ({ key, label, paused, ...(error ? { error } : {}) }))
  for (const listener of [...listeners]) listener()
}

export function markAnswering(key: string, inFlight: boolean): void {
  if (answering.has(key) === inFlight) return
  if (inFlight) answering.add(key)
  else answering.delete(key)
  answeringSnapshot = new Set(answering)
  for (const listener of [...listeners]) listener()
}

function arm(entry: Entry): void {
  clearTimeout(entry.timer)
  entry.startedAt = Date.now()
  entry.timer = setTimeout(() => void commit(entry.key), entry.remaining)
}

async function commit(key: string): Promise<void> {
  const entry = dismissals.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.timer = undefined
  try {
    const item = await dismissQuestion(key)
    settleQuestion(entry.queryClient, item)
    // After the cache's batched notify: the Questions page swaps the undo note for "Dismissed"
    // when the card leaves the open list, and must not draw the open card for a frame in between.
    setTimeout(() => {
      if (dismissals.get(key) !== entry) return
      dismissals.delete(key)
      publish()
    }, 0)
  } catch (failure) {
    // 409: it closed meanwhile (answered, replaced, ended). Nothing to retry; the refetch shows why.
    if (failure instanceof ApiError && failure.status === 409) {
      dismissals.delete(key)
      publish()
      void entry.queryClient.invalidateQueries({ queryKey: questionKeys.all })
      return
    }
    // The card comes back with the reason: a dismissal that did not land must not look done.
    entry.error = failure instanceof Error ? failure.message : String(failure)
    try {
      entry.onFailed?.(entry.error)
    } catch {
      // the caller's recovery must not stop the card coming back
    }
    entry.paused = true
    publish()
    void entry.queryClient.invalidateQueries({ queryKey: questionKeys.all })
    // The page dropped its manager's "Waiting for N answers" on the click: put it back.
    void entry.queryClient.invalidateQueries({ queryKey: managerKeys.list })
  }
}

/** Past its undo window, request on its way: the server may already count it off. */
function isDismissalSent(key: string): boolean {
  const entry = dismissals.get(key)
  return entry !== undefined && !entry.error && !entry.paused && entry.timer === undefined
}

/** Inside its undo window (paused or not): nothing sent, the badge already counts it off. */
function isDismissalPending(key: string): boolean {
  const entry = dismissals.get(key)
  return entry !== undefined && !entry.error && !isDismissalSent(key)
}

const watched = new WeakSet<QueryClient>()

/**
 * The list says a card waiting out its undo window is no longer open (answered, replaced, expired,
 * its task ended): drop the dismissal in the same cache update that drops the card, so the badge
 * never subtracts it twice and nothing is sent for it.
 */
function watchClosedElsewhere(queryClient: QueryClient): void {
  if (watched.has(queryClient)) return
  watched.add(queryClient)
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || dismissals.size === 0) return
    const data = queryClient.getQueryData<QuestionsResponse>(questionKeys.all)
    if (!data || event.query.queryHash !== queryClient.getQueryCache().find({ queryKey: questionKeys.all, exact: true })?.queryHash) return
    let changed = false
    for (const entry of [...dismissals.values()]) {
      if (entry.queryClient !== queryClient || isDismissalSent(entry.key) || data.open.some((row) => row.key === entry.key)) continue
      clearTimeout(entry.timer)
      dismissals.delete(entry.key)
      changed = true
    }
    if (changed) publish()
  })
}

export function scheduleDismiss(queryClient: QueryClient, key: string, label: string, opts?: { onFailed?: (error: string) => void }): void {
  const existing = dismissals.get(key)
  if (existing && !existing.error) {
    // Already on its way (the Questions page, a card): this caller still hears a failure.
    const later = opts?.onFailed
    if (later) {
      const earlier = existing.onFailed
      existing.onFailed = earlier ? (error) => { earlier(error); later(error) } : later
    }
    return
  }
  clearTimeout(existing?.timer)
  const entry: Entry = { key, label, paused: false, remaining: DISMISS_UNDO_MS, startedAt: Date.now(), queryClient, ...(opts?.onFailed ? { onFailed: opts.onFailed } : {}) }
  watchClosedElsewhere(queryClient)
  dismissals.set(key, entry)
  arm(entry)
  publish()
}

/** `false` when it came too late: the close was already sent (or there was nothing to undo). */
export function undoDismiss(key: string): boolean {
  const entry = dismissals.get(key)
  if (!entry) return false
  if (entry.timer === undefined && !entry.paused && !entry.error) return false
  clearTimeout(entry.timer)
  dismissals.delete(key)
  publish()
  return true
}

export function pauseDismiss(key: string): void {
  const entry = dismissals.get(key)
  if (!entry || entry.paused || entry.timer === undefined) return
  clearTimeout(entry.timer)
  entry.timer = undefined
  entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt))
  entry.paused = true
  publish()
}

export function resumeDismiss(key: string): void {
  const entry = dismissals.get(key)
  if (!entry || !entry.paused || entry.error) return
  entry.paused = false
  arm(entry)
  publish()
}

/** The toasts unmounted (navigation) with focus inside: no blur will come, so restart their clocks. */
export function resumePausedDismissals(): void {
  for (const entry of [...dismissals.values()]) if (entry.paused && !entry.error) resumeDismiss(entry.key)
}

/** Test seam. */
export function resetDismissals(): void {
  for (const entry of dismissals.values()) clearTimeout(entry.timer)
  dismissals.clear()
  answering.clear()
  answeringSnapshot = new Set()
  publish()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePendingDismissals(): readonly PendingDismissal[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

export function useAnsweringQuestions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => answeringSnapshot, () => answeringSnapshot)
}

/** Open questions minus the ones waiting out their undo window: what every screen shows. */
export function visibleOpen(data: QuestionsResponse | undefined, pending: readonly PendingDismissal[]): QuestionItem[] {
  const hidden = new Set(pending.filter((entry) => !entry.error).map((entry) => entry.key))
  return (data?.open ?? []).filter((item) => !hidden.has(item.key))
}

const NO_MANAGERS: ReadonlySet<string> = new Set()
const NO_KEYS: ReadonlySet<string> = new Set()

const fromInactive = (item: QuestionItem, inactive: ReadonlySet<string>) => item.source.kind === 'manager' && inactive.has(item.source.managerId)

/** The badge: the server's live count, less a dismissal still inside its undo window and an answer
 *  in flight. Undefined until the first answer (or when the route is missing), so the badge says
 *  nothing rather than 0. The server leaves inactive managers' cards out of `live` (spec
 *  2026-11-19-manager-deactivate), so hiding one of them takes nothing off it. */
export function liveQuestionCount(data: QuestionsResponse | undefined, pending: readonly PendingDismissal[], inactive: ReadonlySet<string> = NO_MANAGERS, inFlight: ReadonlySet<string> = NO_KEYS): number | undefined {
  if (!data) return undefined
  const hidden = new Set([...pending.filter((entry) => !entry.error).map((entry) => entry.key), ...inFlight])
  const leaving = data.open.filter((item) => hidden.has(item.key) && !item.older && !fromInactive(item, inactive)).length
  return Math.max(0, data.counts.live - leaving)
}

/** The "+N from inactive managers, not counted" note: their live cards still shown. */
export function inactiveQuestionCount(data: QuestionsResponse | undefined, pending: readonly PendingDismissal[], inactive: ReadonlySet<string>): number {
  return visibleOpen(data, pending).filter((item) => !item.older && fromInactive(item, inactive)).length
}

/** Ids of the inactive managers, from the shared list cache (never fetched from here). */
export function useInactiveManagerIds(): ReadonlySet<string> {
  const list = useQuery<ManagerListResponse>({ queryKey: managerKeys.list, enabled: false }).data
  return useMemo(() => {
    const ids = (list?.managers ?? []).filter((manager) => manager.inactive !== undefined).map((manager) => manager.id)
    return ids.length === 0 ? NO_MANAGERS : new Set(ids)
  }, [list])
}

export function useLiveQuestionCount(enabled = true): number | undefined {
  const query = useQuestions(enabled)
  return liveQuestionCount(query.data, usePendingDismissals(), useInactiveManagerIds(), useAnsweringQuestions())
}

export function useInactiveQuestionCount(): number {
  const query = useQuestions()
  return inactiveQuestionCount(query.data, usePendingDismissals(), useInactiveManagerIds())
}
