import {
  managerChangeEventSchema,
  managerListResponseSchema,
  managerMessageEventSchema,
  managerMessagesResponseSchema,
  managerOkResponseSchema,
  managerSummarySchema,
  type CreateManagerInput,
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

import { requestContract } from './client'

/**
 * Managers (spec `2026-10-31-managers`): the workspace-level routes, their queries and the reducers
 * the one workspace stream folds `manager-*` events through. Built on `requestContract` until the
 * server's chain carries these routes; then each function is a one-line move to `cez.api.v1`.
 */

const managerPath = (id: string, rest = '') => `/workspace/managers/${encodeURIComponent(id)}${rest}`

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
})

export const getManagers = (opts?: { signal?: AbortSignal }): Promise<ManagerListResponse> =>
  requestContract('/workspace/managers', managerListResponseSchema, { signal: opts?.signal })

export const createManager = (input: CreateManagerInput): Promise<ManagerSummary> =>
  requestContract('/workspace/managers', managerSummarySchema, jsonInit('POST', input))

export const updateManager = (id: string, patch: UpdateManagerInput): Promise<ManagerSummary> =>
  requestContract(managerPath(id), managerSummarySchema, jsonInit('PATCH', patch))

export const deleteManager = (id: string) => requestContract(managerPath(id), managerOkResponseSchema, jsonInit('DELETE'))

export const MANAGER_PAGE_SIZE = 50

export function getManagerMessages(
  id: string,
  before: number | undefined,
  opts?: { signal?: AbortSignal },
): Promise<ManagerMessagesResponse> {
  const query = new URLSearchParams({ limit: String(MANAGER_PAGE_SIZE) })
  if (before !== undefined) query.set('before', String(before))
  return requestContract(managerPath(id, `/messages?${query}`), managerMessagesResponseSchema, { signal: opts?.signal })
}

export const sendManagerMessage = (id: string, text: string) =>
  requestContract(managerPath(id, '/messages'), managerOkResponseSchema, jsonInit('POST', { text }))

export const stopManager = (id: string) => requestContract(managerPath(id, '/stop'), managerOkResponseSchema, jsonInit('POST'))
export const checkManager = (id: string) => requestContract(managerPath(id, '/check'), managerOkResponseSchema, jsonInit('POST'))
export const markManagerRead = (id: string) => requestContract(managerPath(id, '/read'), managerOkResponseSchema, jsonInit('POST'))

export const decideManagerAction = (id: string, actionId: string, decision: ManagerActionDecisionInput['decision']) =>
  requestContract(
    managerPath(id, `/actions/${encodeURIComponent(actionId)}/decision`),
    managerOkResponseSchema,
    jsonInit('POST', { decision }),
  )

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

export const MANAGER_EVENT_NAMES = ['manager-change', 'manager-message'] as const
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
  if (name === 'manager-message') {
    const parsed = managerMessageEventSchema.safeParse(payload)
    if (!parsed.success) return
    queryClient.setQueryData<MessagePages>(managerKeys.messages(parsed.data.managerId), (pages) =>
      applyManagerMessage(pages, parsed.data.message))
    return
  }
  const parsed = managerChangeEventSchema.safeParse(payload)
  if (!parsed.success) return
  const { id, manager, deleted = false } = parsed.data
  const before = queryClient.getQueryData<ManagerListResponse>(managerKeys.list)?.managers.find((row) => row.id === id)
  queryClient.setQueryData<ManagerListResponse>(managerKeys.list, (list) => applyManagerChange(list, id, manager, deleted))
  if (deleted) queryClient.removeQueries({ queryKey: managerKeys.messages(id) })
  // A frame that raced the page fetch would otherwise leave a half-written reply until reload.
  if (before?.status === 'working' && manager && manager.status !== 'working') {
    void queryClient.invalidateQueries({ queryKey: managerKeys.messages(id) })
  }
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
  return (managers ?? []).some((manager) => manager.unread > 0 || manager.pendingActions > 0)
}
