import {
  queryScope,
  type ApiRun,
  type CreateCardBody,
  type FrameworkDetailResponse,
  type FrameworksResponse,
  type InstallFrameworkResponse,
  type PatchCardBody,
  type RunRecord,
} from '@open-mercato/cezar-api-client'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { cez, sendMessage, unwrap } from './client'
import { queryKeys, useRuns, writePatchedRunToCaches } from './queries'
import { isCard, openAsk, type CardRun } from '@/lib/cards'

/**
 * The `/frameworks` and `/cards` families (spec 2026-11-15-framework-board § API). Boards and
 * lists read the EXISTING runs query — kept live by the global SSE stream — filtered to `run.card`;
 * nothing here polls. Detection (D6) is a request when a surface that needs it opens.
 */

export const frameworkKeys = {
  all: () => [queryScope(), 'frameworks'] as const,
  list: () => [queryScope(), 'frameworks', 'list'] as const,
  detail: (id: string) => [queryScope(), 'frameworks', 'detail', id] as const,
}

const scoped = () => cez.api.v1.p[':projectId']
const projectId = () => queryScope()
const signalInit = (signal?: AbortSignal) => (signal ? { init: { signal } } : undefined)

export async function getFrameworks(signal?: AbortSignal): Promise<FrameworksResponse> {
  return unwrap(await scoped().frameworks.$get({ param: { projectId: projectId() } }, signalInit(signal)), '/frameworks')
}

export async function getFramework(id: string, signal?: AbortSignal): Promise<FrameworkDetailResponse> {
  return unwrap(
    await scoped().frameworks[':id'].$get({ param: { projectId: projectId(), id: encodeURIComponent(id) } }, signalInit(signal)),
    `/frameworks/${id}`,
  ) as Promise<FrameworkDetailResponse>
}

export async function duplicateFramework(id: string, newId: string): Promise<{ id: string; path: string }> {
  return unwrap(
    await scoped().frameworks[':id'].duplicate.$post({ param: { projectId: projectId(), id: encodeURIComponent(id) }, json: { newId } }),
    `/frameworks/${id}/duplicate`,
  )
}

/** Runs the framework's pinned installer in this repo; `commit` commits it when on the base branch. */
export async function installFramework(id: string, commit: boolean): Promise<InstallFrameworkResponse> {
  return unwrap(
    await scoped().frameworks[':id'].install.$post({ param: { projectId: projectId(), id: encodeURIComponent(id) }, json: { commit } }),
    `/frameworks/${id}/install`,
  )
}

/** `null` removes the explicit choice — back to automatic (D6). */
export async function putProjectFramework(framework: string | null) {
  return unwrap(await scoped().project.framework.$put({ param: { projectId: projectId() }, json: { framework } }), '/project/framework')
}

export async function createCard(body: CreateCardBody): Promise<RunRecord> {
  return (await unwrap(await scoped().cards.$post({ param: { projectId: projectId() }, json: body }), '/cards')).run as RunRecord
}

const cardParam = (runId: string) => ({ projectId: projectId(), runId: encodeURIComponent(runId) })

export async function patchCard(runId: string, patch: PatchCardBody): Promise<RunRecord> {
  return (await unwrap(await scoped().cards[':runId'].$patch({ param: cardParam(runId), json: patch }), `/cards/${runId}`)).run as RunRecord
}

export async function rerunCard(runId: string, fromStage: string): Promise<RunRecord> {
  return (await unwrap(await scoped().cards[':runId'].rerun.$post({ param: cardParam(runId), json: { fromStage } }), `/cards/${runId}/rerun`))
    .run as RunRecord
}

export async function finishCardStage(runId: string): Promise<void> {
  await unwrap(await scoped().cards[':runId']['finish-stage'].$post({ param: cardParam(runId), json: {} }), `/cards/${runId}/finish-stage`)
}

/** SDD framework gate only (D9); the server answers 409 off the local machine, 422 on a script refusal. */
export async function approveCardGate(runId: string): Promise<void> {
  await unwrap(await scoped().cards[':runId'].approve.$post({ param: cardParam(runId), json: {} }), `/cards/${runId}/approve`)
}

/** Ask the framework's state again (engine step 3) — the cockpit-focus half of the watcher. */
export async function recheckCards(): Promise<void> {
  await unwrap(await scoped().cards.recheck.$post({ param: { projectId: projectId() }, json: {} }), '/cards/recheck')
}

/**
 * Answer a `gate.human` through the ask-answer path the task view uses (spec § API: "Gate approve /
 * request changes reuse the existing ask-answer route"): the card's reply, `<header>: <answer>`.
 */
export async function answerCardGate(run: RunRecord, decision: 'approve' | 'reject', comment = ''): Promise<void> {
  const ask = openAsk(run)
  const header = ask?.questions[0]?.header ?? 'Approval'
  const text = decision === 'approve' ? 'Approve' : `Request changes${comment.trim() ? `: ${comment.trim()}` : ''}`
  await sendMessage(run.id, { text: `${header}: ${text}`, ...(ask ? { askRequestId: ask.requestId } : {}) })
}

// ---- reads --------------------------------------------------------------------------------

export function useFrameworks(enabled = true) {
  return useQuery({ queryKey: frameworkKeys.list(), queryFn: ({ signal }) => getFrameworks(signal), enabled })
}

export function useFramework(id: string | undefined) {
  return useQuery({
    queryKey: frameworkKeys.detail(id ?? ''),
    queryFn: ({ signal }) => getFramework(id!, signal),
    enabled: Boolean(id),
  })
}

const selectCards = (runs: ApiRun[]): CardRun[] => runs.filter(isCard) as CardRun[]

/** The project's cards, out of the runs list the SSE stream already keeps live — no new poll. */
export function useCards() {
  return useRuns(selectCards)
}

/** Stage id → name per framework id, from the frameworks listing. */
export function stageNamesOf(data: FrameworksResponse | undefined, framework: string | undefined): Map<string, string> {
  const fw = data?.frameworks.find((f) => f.id === framework)
  return new Map((fw?.stages ?? []).map((s) => [s.id, s.name]))
}

/**
 * `POST /cards/recheck` on window focus — only while the caller is mounted AND some card is
 * parked at a framework gate, so a board with nothing to ask about sends nothing.
 */
export function useCardRecheckOnFocus(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onFocus = () => void recheckCards().catch(() => undefined)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled])
}

// ---- writes -------------------------------------------------------------------------------

function settleRun(queryClient: QueryClient, run: RunRecord | undefined) {
  if (run) writePatchedRunToCaches(queryClient, run)
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
}

export function useCreateCard() {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: createCard, onSuccess: (run) => settleRun(queryClient, run) })
}

export function usePatchCard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, patch }: { runId: string; patch: PatchCardBody }) => patchCard(runId, patch),
    onSuccess: (run) => settleRun(queryClient, run),
  })
}

export function useRerunCard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, fromStage }: { runId: string; fromStage: string }) => rerunCard(runId, fromStage),
    onSuccess: (run) => settleRun(queryClient, run),
  })
}

export function useFinishCardStage() {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: finishCardStage, onSuccess: () => settleRun(queryClient, undefined) })
}

export function useApproveCardGate() {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: approveCardGate, onSuccess: () => settleRun(queryClient, undefined) })
}

export function useAnswerCardGate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ run, decision, comment }: { run: RunRecord; decision: 'approve' | 'reject'; comment?: string }) =>
      answerCardGate(run, decision, comment),
    onSuccess: () => settleRun(queryClient, undefined),
  })
}

export function usePutProjectFramework() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: putProjectFramework,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: frameworkKeys.all() }),
  })
}

export function useDuplicateFramework() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, newId }: { id: string; newId: string }) => duplicateFramework(id, newId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: frameworkKeys.all() }),
  })
}

export function useInstallFramework() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, commit }: { id: string; commit: boolean }) => installFramework(id, commit),
    // Availability (and detection, once `.ai/sdd/sdd.mjs` lands) changes with the files.
    onSettled: () => queryClient.invalidateQueries({ queryKey: frameworkKeys.all() }),
  })
}
