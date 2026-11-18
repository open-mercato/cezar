import {
  questionCountsSchema,
  type HealthResponse,
  type QuestionCounts,
  type QuestionItem,
  type QuestionsResponse,
} from '@open-mercato/cezar-api-client'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'

import { cez, unwrap } from './client'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'

/**
 * The Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`): the workspace-level read,
 * its two writes, the `questions` topic and the client-side dismiss undo.
 */

export const questionKeys = {
  all: ['workspace', 'questions'] as const,
}

const questions = () => cez.api.v1.workspace.questions

export async function getQuestions(opts?: { signal?: AbortSignal }): Promise<QuestionsResponse> {
  return unwrap(await questions().$get({}, opts?.signal ? { init: { signal: opts.signal } } : undefined), '/workspace/questions')
}

export async function answerQuestion(key: string, text: string): Promise<QuestionItem> {
  return (await unwrap(await questions()[':key'].answer.$post({ param: { key: encodeURIComponent(key) }, json: { text } }), '/workspace/questions/:key/answer')).item
}

export async function dismissQuestion(key: string): Promise<QuestionItem> {
  return (await unwrap(await questions()[':key'].dismiss.$post({ param: { key: encodeURIComponent(key) } }), '/workspace/questions/:key/dismiss')).item
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
    if (!was || !item.closed) return data
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
 * only, since a browser WebSocket cannot carry a remote proxy's credentials. A frame is the counts;
 * the list behind them is re-read only while something shows it.
 */
export function useQuestionsSubscription(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    let release: (() => void) | undefined
    const sync = (): void => {
      const local = queryClient.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.localHandoff === true
      if (local && release === undefined) {
        release = subscribeTopic('questions', (data) => {
          const counts = questionCountsSchema.safeParse(data)
          if (!counts.success) return
          applyQuestionCounts(queryClient, counts.data)
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

export function applyQuestionCounts(queryClient: QueryClient, counts: QuestionCounts): void {
  const before = queryClient.getQueryData<QuestionsResponse>(questionKeys.all)
  if (before && before.counts.live === counts.live && before.counts.older === counts.older) return
  queryClient.setQueryData<QuestionsResponse>(questionKeys.all, (data) => (data ? { ...data, counts } : data))
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

type Entry = PendingDismissal & { timer?: ReturnType<typeof setTimeout>; remaining: number; startedAt: number; queryClient: QueryClient }

const dismissals = new Map<string, Entry>()
let snapshot: readonly PendingDismissal[] = []
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = [...dismissals.values()].map(({ key, label, paused, error }) => ({ key, label, paused, ...(error ? { error } : {}) }))
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
    dismissals.delete(key)
    publish()
    settleQuestion(entry.queryClient, item)
  } catch (failure) {
    // The card comes back with the reason: a dismissal that did not land must not look done.
    entry.error = failure instanceof Error ? failure.message : String(failure)
    entry.paused = true
    publish()
    void entry.queryClient.invalidateQueries({ queryKey: questionKeys.all })
  }
}

export function scheduleDismiss(queryClient: QueryClient, key: string, label: string): void {
  const existing = dismissals.get(key)
  if (existing && !existing.error) return
  clearTimeout(existing?.timer)
  const entry: Entry = { key, label, paused: false, remaining: DISMISS_UNDO_MS, startedAt: Date.now(), queryClient }
  dismissals.set(key, entry)
  arm(entry)
  publish()
}

export function undoDismiss(key: string): void {
  const entry = dismissals.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  dismissals.delete(key)
  publish()
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

/** Test seam. */
export function resetDismissals(): void {
  for (const entry of dismissals.values()) clearTimeout(entry.timer)
  dismissals.clear()
  publish()
}

export function usePendingDismissals(): readonly PendingDismissal[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
    () => snapshot,
  )
}

/** Open questions minus the ones waiting out their undo window: what every screen shows. */
export function visibleOpen(data: QuestionsResponse | undefined, pending: readonly PendingDismissal[]): QuestionItem[] {
  const hidden = new Set(pending.filter((entry) => !entry.error).map((entry) => entry.key))
  return (data?.open ?? []).filter((item) => !hidden.has(item.key))
}

/** The badge: the server's live count, less a dismissal still inside its undo window. Undefined
 *  until the first answer (or when the route is missing), so the badge says nothing rather than 0. */
export function liveQuestionCount(data: QuestionsResponse | undefined, pending: readonly PendingDismissal[]): number | undefined {
  if (!data) return undefined
  const hidden = new Set(pending.filter((entry) => !entry.error).map((entry) => entry.key))
  const leaving = data.open.filter((item) => hidden.has(item.key) && !item.older).length
  return Math.max(0, data.counts.live - leaving)
}

export function useLiveQuestionCount(enabled = true): number | undefined {
  const query = useQuestions(enabled)
  return liveQuestionCount(query.data, usePendingDismissals())
}
