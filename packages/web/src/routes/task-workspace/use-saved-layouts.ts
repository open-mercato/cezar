import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import { MAX_SAVED_WORKSPACE_LAYOUTS, type SavedWorkspaceLayout, type WorkspaceUiState } from '@open-mercato/cezar-api-client'

import { isReservedLayoutName, isViewId, type SavedLayout } from './layout-state'

const NONE: readonly SavedLayout[] = []

/**
 * The layouts the user saved by name — one list for every task of every project, kept in
 * `~/.cezar/ui-state.json` (`savedLayouts`). The `useProjectOrder` shape: the ui-state query is the
 * single copy, a write is optimistic, and writes are serialized so a slow answer cannot resurrect
 * a list the user has already changed.
 */
export function useSavedLayouts(): {
  saved: readonly SavedLayout[]
  /** Save under `layout.name`, replacing one already saved under it. */
  save: (layout: SavedLayout) => void
  remove: (name: string) => void
} {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())

  const raw = uiState.data?.savedLayouts
  const saved = React.useMemo(
    () =>
      raw
        ? raw.filter(
            (layout) =>
              !isReservedLayoutName(layout.name) && layout.columns.length > 0 && layout.columns.every((c) => isViewId(c.view)),
          )
        : NONE,
    [raw],
  )

  const write = React.useCallback(
    (change: (list: SavedWorkspaceLayout[]) => SavedWorkspaceLayout[]) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      if (current === undefined) return
      const savedLayouts = change(current.savedLayouts ?? []).slice(0, MAX_SAVED_WORKSPACE_LAYOUTS)
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, { ...current, savedLayouts })

      const writeSequence = ++sequence.current
      const pending = writeChain.current.then(async () => {
        const merged = await putWorkspaceUiState({ savedLayouts }, { keepalive: true })
        if (writeSequence === sequence.current) queryClient.setQueryData(workspaceQueryKeys.uiState, merged)
      })
      writeChain.current = pending.catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        if (writeSequence === sequence.current) void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
      })
    },
    [queryClient],
  )

  const save = React.useCallback(
    (layout: SavedLayout) =>
      write((list) => {
        const copy: SavedWorkspaceLayout = { name: layout.name, columns: layout.columns.map(({ view, width }) => ({ view, width })) }
        const at = list.findIndex((entry) => entry.name === layout.name)
        return at < 0 ? [...list, copy] : list.map((entry, index) => (index === at ? copy : entry))
      }),
    [write],
  )
  const remove = React.useCallback((name: string) => write((list) => list.filter((entry) => entry.name !== name)), [write])

  return { saved, save, remove }
}
