import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { normalizeProjectOrder, PROJECT_ORDER_LIMIT } from './project-order'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Session-global controller for the sidebar's hand-picked project order (#952).
 *
 * The same shape as `useTaskTableColumns`, for the same reasons: the workspace ui-state query is
 * the single copy, every write composes from the optimistic cache, and the writes are serialized
 * so a slow response cannot resurrect an order the user has already dragged past.
 *
 * `PUT /workspace/ui-state` merges SHALLOWLY, so every write sends the whole `sidebar` object —
 * dropping the legacy `collapsed` map (or a key some newer cockpit wrote) on the way past would
 * be a silent data loss, and a drag is not an event that should cost the user anything else.
 */
export function useProjectOrder(): {
  /** The stored order, normalized. Empty means "never reordered" — the `lastOpenedAt` sort. */
  order: string[]
  /** The authoritative GET has landed. Until it does a write cannot preserve its siblings, so
   *  the reorder affordances stay disabled rather than gambling with the user's file. */
  canReorder: boolean
  /** Persist a full order (the ids currently on screen, in their new order). */
  setOrder: (ids: readonly string[]) => void
  /** Forget the hand-picked order and fall back to `lastOpenedAt`. */
  reset: () => void
} {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const newestSequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())

  const order = React.useMemo(
    () => normalizeProjectOrder(uiState.data?.sidebar?.projectOrder),
    [uiState.data?.sidebar?.projectOrder],
  )

  /** One write path for both "reorder" and "reset": reset is simply the absent list, which a
   *  whole-object `sidebar` write expresses by omitting the key. */
  const write = React.useCallback(
    (ids: string[] | null) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      if (current === undefined) return

      const { projectOrder: _dropped, ...siblings } = asRecord(current.sidebar)
      const sidebar = ids === null ? siblings : { ...siblings, projectOrder: ids }
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, {
        ...current,
        sidebar,
      })

      const writeSequence = ++sequence.current
      newestSequence.current = writeSequence
      const pending = writeChain.current.then(async () => {
        const merged = await putWorkspaceUiState({ sidebar }, { keepalive: true })
        if (writeSequence === newestSequence.current) {
          queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, merged)
        }
      })
      writeChain.current = pending.catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        // Back to server truth rather than leaving the drawer showing an order the file never
        // took — a silently diverged sidebar is the failure mode worth spending a refetch on.
        if (writeSequence === newestSequence.current) {
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        }
      })
    },
    [queryClient],
  )

  const setOrder = React.useCallback(
    (ids: readonly string[]) => {
      const next = normalizeProjectOrder(ids)
      if (next.length === 0) return
      write(next.slice(0, PROJECT_ORDER_LIMIT))
    },
    [write],
  )

  const reset = React.useCallback(() => write(null), [write])

  return { order, canReorder: uiState.data !== undefined, setOrder, reset }
}
