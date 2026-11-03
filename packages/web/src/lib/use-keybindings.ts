import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { trackShortcutRebound } from './telemetry'
import { assignBinding, effectiveBindings, resetBinding, sanitizeOverrides, type Overrides } from './keybindings'

/**
 * The user's shortcuts, stored in the workspace ui-state (`~/.cezar/ui-state.json`) beside
 * Appearance — they describe the person at the keyboard, so every project and every browser on
 * this machine shares them. Same write discipline as `useProjectOrder`: optimistic cache, writes
 * serialized, the whole `keybindings` object sent (the PUT merges shallowly).
 */
export function useKeybindings() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())
  const stored = uiState.data?.keybindings
  const overrides = React.useMemo(() => sanitizeOverrides(stored), [stored])
  const bindings = React.useMemo(() => effectiveBindings(overrides), [overrides])

  const write = React.useCallback(
    (change: (current: Overrides) => Record<string, string | null>) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      // Until the GET lands a write could not preserve the stored map — refuse rather than guess.
      if (current === undefined) return
      const keybindings = change(sanitizeOverrides(current.keybindings))
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, { ...current, keybindings })
      const writeSequence = ++sequence.current
      const pending = writeChain.current.then(async () => {
        const merged = await putWorkspaceUiState({ keybindings }, { keepalive: true })
        if (writeSequence === sequence.current) queryClient.setQueryData(workspaceQueryKeys.uiState, merged)
      })
      writeChain.current = pending.catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        if (writeSequence === sequence.current) void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
      })
    },
    [queryClient],
  )

  return {
    overrides,
    /** command id → chord, defaults included. */
    bindings,
    ready: uiState.data !== undefined,
    assign: React.useCallback(
      (id: string, chord: string | null) => {
        write((current) => assignBinding(current, id, chord))
        trackShortcutRebound(id)
      },
      [write],
    ),
    reset: React.useCallback((id: string) => write((current) => resetBinding(current, id)), [write]),
    resetAll: React.useCallback(() => write(() => ({})), [write]),
  }
}
