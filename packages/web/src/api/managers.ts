import {
  managerChangeEventSchema,
  managerDeltaEventSchema,
  managerMessageEventSchema,
  apiPath,
  type AttachmentEntry,
  type CreateManagerInput,
  type ManagerDeltaEvent,
  type ManagerActionDecisionInput,
  type ManagerListResponse,
  type ManagerMessage,
  type ManagerMessagesResponse,
  type ManagerSummary,
  type UpdateManagerInput,
} from '@open-mercato/cezar-api-client'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'

import { cez, unwrap } from './client'

/**
 * Managers (spec `2026-10-31-managers`): the workspace-level routes, their queries and the reducers
 * the one workspace stream folds `manager-*` events through.
 */

const managerParam = (id: string) => ({ id: encodeURIComponent(id) })
const managers = () => cez.api.v1.workspace.managers
const managerPath = (id: string, rest = '') => `/workspace/managers/${encodeURIComponent(id)}${rest}`

export async function getManagers(opts?: { signal?: AbortSignal }): Promise<ManagerListResponse> {
  return unwrap(await managers().$get({}, { init: { signal: opts?.signal } }), '/workspace/managers')
}

export async function createManager(input: CreateManagerInput): Promise<ManagerSummary> {
  return unwrap(await managers().$post({ json: input }), '/workspace/managers')
}

export async function updateManager(id: string, patch: UpdateManagerInput): Promise<ManagerSummary> {
  return unwrap(await managers()[':id'].$patch({ param: managerParam(id), json: patch }), managerPath(id))
}

export async function deleteManager(id: string) {
  return unwrap(await managers()[':id'].$delete({ param: managerParam(id) }), managerPath(id))
}

export const MANAGER_PAGE_SIZE = 50

export async function getManagerMessages(
  id: string,
  before: number | undefined,
  opts?: { signal?: AbortSignal; pending?: boolean },
): Promise<ManagerMessagesResponse> {
  const query = {
    limit: String(MANAGER_PAGE_SIZE),
    ...(before === undefined ? {} : { before: String(before) }),
    ...(opts?.pending ? { pending: '1' as const } : {}),
  }
  const since = streamClock
  const page = await unwrap(
    await managers()[':id'].messages.$get({ param: managerParam(id), query }, { init: { signal: opts?.signal } }),
    managerPath(id, '/messages'),
  )
  // The page was read before the deltas that raced it here: fold them in, or they are lost.
  return { ...page, messages: page.messages.map((message) => reconcileLive(id, message, since)) }
}

/** The card the approvals pill jumps to. Older pending cards can sit beyond one page. */
export async function getOldestPendingAction(id: string): Promise<ManagerMessage | undefined> {
  let before: number | undefined
  let oldest: ManagerMessage | undefined
  for (;;) {
    const page = await getManagerMessages(id, before, { pending: true })
    const first = page.messages[0]
    if (!first) return oldest
    oldest = first
    if (!page.hasMore) return oldest
    before = first.seq
  }
}

export async function sendManagerMessage(id: string, text: string, images?: AttachmentEntry[]) {
  const json = { text, ...(images?.length ? { images } : {}) }
  const sent = await unwrap(await managers()[':id'].messages.$post({ param: managerParam(id), json }), managerPath(id, '/messages'))
  // A server older than this page drops what it does not know and still answers ok. Rejecting
  // hands the draft back; a silent success would lose the user's files.
  if ((images?.length ?? 0) > 0 && sent.attachments !== images?.length) {
    throw new Error('This cezar server dropped your attachments because it is older than this page. Restart cezar and send again.')
  }
  return sent
}

export const managerAttachmentUrl = (id: string, file: string): string =>
  apiPath(managerPath(id, `/attachments/${encodeURIComponent(file)}`))

export async function stopManager(id: string) {
  return unwrap(await managers()[':id'].stop.$post({ param: managerParam(id) }), managerPath(id, '/stop'))
}

export async function checkManager(id: string) {
  return unwrap(await managers()[':id'].check.$post({ param: managerParam(id) }), managerPath(id, '/check'))
}

export async function markManagerRead(id: string) {
  return unwrap(await managers()[':id'].read.$post({ param: managerParam(id) }), managerPath(id, '/read'))
}

export async function decideManagerAction(id: string, actionId: string, decision: ManagerActionDecisionInput['decision']) {
  return unwrap(
    await managers()[':id'].actions[':actionId'].decision.$post({
      param: { ...managerParam(id), actionId: encodeURIComponent(actionId) },
      json: { decision },
    }),
    managerPath(id, `/actions/${encodeURIComponent(actionId)}/decision`),
  )
}

// ---- cache ---------------------------------------------------------------------------------

export const managerKeys = {
  all: ['workspace', 'managers'] as const,
  list: ['workspace', 'managers', 'list'] as const,
  messages: (id: string) => ['workspace', 'managers', 'messages', id] as const,
}

type MessagePages = InfiniteData<ManagerMessagesResponse, number | undefined>

/** Most recently active first; a manager that never spoke sorts by its creation. */
export function orderManagers(managers: readonly ManagerSummary[]): ManagerSummary[] {
  const at = (manager: ManagerSummary) => Date.parse(manager.lastActivityAt ?? manager.createdAt) || 0
  return [...managers].sort((a, b) => at(b) - at(a))
}

export function applyManagerChange(
  list: ManagerListResponse | undefined,
  id: string,
  manager: ManagerSummary | undefined,
  deleted: boolean,
): ManagerListResponse | undefined {
  if (!list) return list
  const others = list.managers.filter((row) => row.id !== id)
  if (deleted || !manager) return deleted ? { managers: others } : list
  const at = list.managers.findIndex((row) => row.id === id)
  if (at === -1) return { managers: [...others, manager] }
  const managers = [...list.managers]
  managers[at] = manager
  return { managers }
}

/** Replace by id, else append to the newest page (page 0); `seq` orders the chat on read. */
export function applyManagerMessage(pages: MessagePages | undefined, message: ManagerMessage): MessagePages | undefined {
  if (!pages || pages.pages.length === 0) return pages
  let replaced = false
  const next = pages.pages.map((page) => {
    const at = page.messages.findIndex((row) => row.id === message.id)
    if (at === -1) return page
    replaced = true
    const messages = [...page.messages]
    messages[at] = message
    return { ...page, messages }
  })
  if (replaced) return { ...pages, pages: next }
  const [newest, ...older] = pages.pages
  return { ...pages, pages: [{ ...newest!, messages: [...newest!.messages, message] }, ...older] }
}

// ---- streaming replies ---------------------------------------------------------------------

type Assistant = Extract<ManagerMessage, { kind: 'assistant' }>

/** The newest streaming state the stream has shown per reply, and deltas that arrived ahead of it.
 *  `at` is the `streamClock` tick its text last changed on. */
const live = new Map<string, { managerId: string; message: Assistant; at: number }>()
let streamClock = 0
const ahead = new Map<string, ManagerDeltaEvent[]>()
/** Replies the stream saw settle: a page read before that must not bring `streaming` back. */
const settled = new Map<string, Assistant>()
const AHEAD_LIMIT = 500
const SETTLED_LIMIT = 100

const isStreaming = (message: ManagerMessage): message is Assistant => message.kind === 'assistant' && message.streaming

function forget(messageId: string): void {
  live.delete(messageId)
  ahead.delete(messageId)
}

function remember(message: Assistant): void {
  forget(message.id)
  settled.delete(message.id)
  settled.set(message.id, message)
  if (settled.size > SETTLED_LIMIT) settled.delete(settled.keys().next().value!)
}

/** Apply what chains onto `message`; a delta it already holds is skipped, one past its end waits. */
function fold(message: Assistant, deltas: readonly ManagerDeltaEvent[]): { message: Assistant; waiting: ManagerDeltaEvent[] } {
  let next = message
  const waiting: ManagerDeltaEvent[] = []
  for (const delta of deltas) {
    if (delta.offset > next.text.length) {
      waiting.push(delta)
      continue
    }
    const end = delta.offset + delta.append.length
    if (end > next.text.length || (end === next.text.length && delta.commands)) {
      next = { ...next, text: next.text.slice(0, delta.offset) + delta.append, ...(delta.commands ? { commands: delta.commands } : {}) }
    }
  }
  return { message: next, waiting: waiting.slice(-AHEAD_LIMIT) }
}

function settleLive(managerId: string, message: Assistant): Assistant {
  const pending = ahead.get(message.id)
  const { message: folded, waiting } = pending ? fold(message, pending) : { message, waiting: [] }
  if (waiting.length > 0) ahead.set(message.id, waiting)
  else ahead.delete(message.id)
  const previous = live.get(message.id)
  const at = previous?.message.text === folded.text ? previous.at : ++streamClock
  live.set(message.id, { managerId, message: folded, at })
  return folded
}

/** A fetched message against what the stream already showed. The stream wins only when it grew the
 *  page's own text after the read began; a shorter page is otherwise a rewrite the stream missed. */
function reconcileLive(managerId: string, message: ManagerMessage, since: number): ManagerMessage {
  if (!isStreaming(message)) {
    forget(message.id)
    return message
  }
  const final = settled.get(message.id)
  if (final) return final
  const known = live.get(message.id)
  const grown = known && known.at > since && known.message.text.length > message.text.length && known.message.text.startsWith(message.text)
  return settleLive(managerId, grown ? known.message : message)
}

function cachedStreaming(queryClient: QueryClient, delta: ManagerDeltaEvent): { managerId: string; message: Assistant } | undefined {
  const message = managerChat(queryClient.getQueryData<MessagePages>(managerKeys.messages(delta.managerId))).find((row) => row.id === delta.messageId)
  return message && isStreaming(message) ? { managerId: delta.managerId, message } : undefined
}

function applyDelta(queryClient: QueryClient, delta: ManagerDeltaEvent): void {
  const known = live.get(delta.messageId) ?? cachedStreaming(queryClient, delta)
  if (!known) {
    ahead.set(delta.messageId, [...(ahead.get(delta.messageId) ?? []), delta].slice(-AHEAD_LIMIT))
    return
  }
  ahead.set(delta.messageId, [...(ahead.get(delta.messageId) ?? []), delta])
  const message = settleLive(delta.managerId, known.message)
  if (message === known.message) return
  queryClient.setQueryData<MessagePages>(managerKeys.messages(delta.managerId), (pages) => applyManagerMessage(pages, message))
}

/** Test seam: the module keeps per-reply state across a page's life. */
export function resetManagerStreams(): void {
  live.clear()
  ahead.clear()
  streamClock = 0
  settled.clear()
}

export const MANAGER_EVENT_NAMES = ['manager-change', 'manager-message', 'manager-delta'] as const
export type ManagerEventName = (typeof MANAGER_EVENT_NAMES)[number]

function parseFrame(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/** Fold one stream frame into the cache. Never seeds a cache nobody fetched: a list built from a
 *  single row would read as "this is every manager". */
export function applyManagerEvent(queryClient: QueryClient, name: ManagerEventName, data: string): void {
  const payload = parseFrame(data)
  if (name === 'manager-delta') {
    const parsed = managerDeltaEventSchema.safeParse(payload)
    if (parsed.success) applyDelta(queryClient, parsed.data)
    return
  }
  if (name === 'manager-message') {
    const parsed = managerMessageEventSchema.safeParse(payload)
    if (!parsed.success) return
    const { managerId } = parsed.data
    let message = parsed.data.message
    if (message.kind === 'assistant') {
      if (message.streaming) {
        // The stream is ordered: a full frame already holds every delta sent before it.
        ahead.delete(message.id)
        message = settleLive(managerId, message)
      }
      else remember(message)
    }
    queryClient.setQueryData<MessagePages>(managerKeys.messages(managerId), (pages) => applyManagerMessage(pages, message))
    return
  }
  const parsed = managerChangeEventSchema.safeParse(payload)
  if (!parsed.success) return
  const { id, manager, deleted = false } = parsed.data
  const before = queryClient.getQueryData<ManagerListResponse>(managerKeys.list)?.managers.find((row) => row.id === id)
  queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) => applyManagerChange(list, id, manager, deleted))
  if (deleted) {
    queryClient.removeQueries({ queryKey: managerKeys.messages(id) })
    for (const [messageId, entry] of live) if (entry.managerId === id) forget(messageId)
  }
  // A frame that raced the page fetch would otherwise leave a half-written reply until reload.
  if (before?.status === 'working' && manager && manager.status !== 'working') {
    void refreshManagerChat(queryClient, id).catch(() => {})
  }
}

// ---- catching up -------------------------------------------------------------------------

/** Fold a fresh newest page in by id; an unchanged row keeps its object, so its memoized row stays.
 *  A page with no row in common past more history left a gap: it replaces the chat. */
export function mergeNewestPage(pages: MessagePages | undefined, fresh: ManagerMessagesResponse): MessagePages | undefined {
  if (!pages || pages.pages.length === 0) return pages
  const cached = new Map<string, ManagerMessage>()
  for (const page of pages.pages) for (const message of page.messages) cached.set(message.id, message)
  if (fresh.hasMore && fresh.messages.length > 0 && !fresh.messages.some((message) => cached.has(message.id))) {
    return { pages: [fresh], pageParams: [undefined] }
  }
  let next = pages
  for (const message of fresh.messages) {
    const known = cached.get(message.id)
    if (known && JSON.stringify(known) === JSON.stringify(message)) continue
    next = applyManagerMessage(next, message)!
  }
  return next
}

function fetchIdle(queryClient: QueryClient, key: readonly unknown[]): Promise<void> {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  if (!query || query.state.fetchStatus !== 'fetching') return Promise.resolve()
  return new Promise((resolve) => {
    const stop = queryClient.getQueryCache().subscribe((event) => {
      if (event.query !== query || (event.type !== 'removed' && query.state.fetchStatus === 'fetching')) return
      stop()
      resolve()
    })
  })
}

/**
 * Catch one chat up after a turn ends or the stream was down: re-read only its newest page. A
 * refetch of the infinite query re-reads every loaded page — 30 requests for a long chat. A chat
 * nobody shows is only marked stale; it is trimmed to one page on unmount, so its refetch is one.
 */
export async function refreshManagerChat(queryClient: QueryClient, id: string): Promise<void> {
  const key = managerKeys.messages(id)
  const query = queryClient.getQueryCache().find<ManagerMessagesResponse, Error, MessagePages>({ queryKey: key, exact: true })
  if (!query?.state.data) return
  if (query.getObserversCount() === 0) return queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' })
  const since = streamClock
  const fresh = await getManagerMessages(id, undefined)
  // A next-page fetch writes back the pages it started from: land after it, not under it.
  await fetchIdle(queryClient, key)
  // Deltas may have landed while waiting.
  const page = { ...fresh, messages: fresh.messages.map((message) => reconcileLive(id, message, since)) }
  queryClient.setQueryData<MessagePages>(key, (pages) => mergeNewestPage(pages, page))
}

/** Every cached chat, for a reconnect or a tab coming back. */
export async function refreshManagerChats(queryClient: QueryClient): Promise<void> {
  const ids = queryClient.getQueryCache().findAll({ queryKey: [...managerKeys.all, 'messages'] }).map((query) => String(query.queryKey[3]))
  await Promise.all(ids.map((id) => refreshManagerChat(queryClient, id)))
}

/** Keep only the newest page of a chat the reader left: returning re-mounts every cached row. */
export function trimManagerChat(queryClient: QueryClient, id: string): void {
  queryClient.setQueryData<MessagePages>(managerKeys.messages(id), (pages) =>
    pages && pages.pages.length > 1 ? { pages: pages.pages.slice(0, 1), pageParams: pages.pageParams.slice(0, 1) } : pages)
}

// ---- hooks ---------------------------------------------------------------------------------

export function useManagers(enabled = true) {
  return useQuery({
    queryKey: managerKeys.list,
    queryFn: ({ signal }) => getManagers({ signal }),
    enabled,
  })
}

export function useManagerMessages(id: string) {
  return useInfiniteQuery({
    queryKey: managerKeys.messages(id),
    queryFn: ({ pageParam, signal }) => getManagerMessages(id, pageParam, { signal }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => (page.hasMore ? page.messages[0]?.seq : undefined),
    // The stream keeps it current; a refetch per focus would re-read every loaded page.
    // Catching up goes through `refreshManagerChat`, which reads only the newest.
    staleTime: Infinity,
  })
}

/** The flattened chat, oldest first. */
export function managerChat(pages: { pages: ManagerMessagesResponse[] } | undefined): ManagerMessage[] {
  return (pages?.pages ?? []).flatMap((page) => page.messages).sort((a, b) => a.seq - b.seq)
}

export function useManagerChat(id: string) {
  const query = useManagerMessages(id)
  const messages = useMemo(() => managerChat(query.data), [query.data])
  return { ...query, messages }
}

export function useUpdateManager(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateManagerInput) => updateManager(id, patch),
    onSuccess: (manager) => {
      queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) => applyManagerChange(list, id, manager, false))
    },
  })
}

export function useCreateManager() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createManager,
    onSuccess: (manager) => {
      queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) =>
        applyManagerChange(list, manager.id, manager, false))
    },
  })
}

export function useDeleteManager(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => deleteManager(id),
    onSuccess: () => {
      queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) => applyManagerChange(list, id, undefined, true))
      queryClient.removeQueries({ queryKey: managerKeys.messages(id) })
    },
  })
}

/** Does any manager want the user? Drives the switch's dot and the phone menu's. */
export function managersNeedAttention(managers: readonly ManagerSummary[] | undefined): boolean {
  return (managers ?? []).some((manager) => manager.unread > 0 || manager.pendingActions > 0 || manager.pendingQuestions > 0)
}
