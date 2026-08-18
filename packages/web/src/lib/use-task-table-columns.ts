import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { WorkspaceUiState } from '@open-mercato/cezar-api-client'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  TASK_COLUMNS,
  toggleExpandedColumn,
  type NormalizedExpandedColumns,
  type TaskColumnId,
} from './task-columns'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Session-global controller for desktop Tasks-table density. Reads the shared workspace query,
 * composes every click from its optimistic cache, and serializes bounded keepalive writes so an
 * older response can never resurrect stale column state.
 */
export function useTaskTableColumns(): {
  expandedColumns: NormalizedExpandedColumns
  isExpanded: (id: TaskColumnId) => boolean
  toggleColumn: (id: TaskColumnId) => void
  isPending: boolean
} {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const newestSequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())

  const expandedColumns = React.useMemo(
    () => normalizeExpandedColumns(uiState.data?.taskTable?.expandedColumns),
    [uiState.data?.taskTable?.expandedColumns],
  )

  const toggleColumn = React.useCallback(
    (id: TaskColumnId) => {
      if (!TASK_COLUMNS.find((column) => column.id === id)?.canFold) return

      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      // A shallow taskTable write can only preserve forward-compatible siblings after the
      // authoritative GET has populated the cache. The route also disables its controls while
      // this is undefined, but keep the controller safe for every caller and failed-query path.
      if (current === undefined) return
      const currentTaskTable = asRecord(current?.taskTable)
      const taskTable = {
        ...currentTaskTable,
        expandedColumns: toggleExpandedColumn(currentTaskTable.expandedColumns, id),
      }
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, {
        ...current,
        taskTable,
      })

      const writeSequence = ++sequence.current
      newestSequence.current = writeSequence
      const write = writeChain.current.then(async () => {
        const merged = await putWorkspaceUiState({ taskTable }, { keepalive: true })
        if (writeSequence === newestSequence.current) {
          queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, merged)
        }
      })
      writeChain.current = write.catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        if (writeSequence === newestSequence.current) {
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        }
      })
    },
    [queryClient],
  )

  const isExpanded = React.useCallback(
    (id: TaskColumnId) => isColumnExpanded(id, expandedColumns),
    [expandedColumns],
  )

  return { expandedColumns, isExpanded, toggleColumn, isPending: uiState.isPending }
}
