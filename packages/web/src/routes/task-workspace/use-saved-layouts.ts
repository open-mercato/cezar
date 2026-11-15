import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import {
  MAX_SAVED_WORKSPACE_LAYOUTS,
  savedWorkspaceLayoutSchema,
  type SavedWorkspaceLayout,
  type WorkspaceUiState,
} from '@open-mercato/cezar-api-client'

import { BUILT_IN_LAYOUTS, isBuiltInLayoutName, isReservedLayoutName, isViewId, type SavedLayout } from './layout-state'

/** The built-ins the user hid, per browser (`localStorage`): a built-in is code, so hiding it is
 *  the one thing about it that is state — and it is this screen's preference, not the host's. */
const HIDDEN_BUILT_INS_KEY = 'cez:hidden-layouts'
const hiddenListeners = new Set<() => void>()
let hiddenCache: { raw: string | null; set: ReadonlySet<string> } = { raw: null, set: new Set() }

/** The hidden built-ins, read fresh — callers outside React (the first-visit default) use it too. */
export function hiddenBuiltInLayouts(): ReadonlySet<string> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(HIDDEN_BUILT_INS_KEY)
  } catch {
    // Storage disabled — nothing is hidden.
  }
  if (raw === hiddenCache.raw) return hiddenCache.set
  let names: string[] = []
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    names = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && isBuiltInLayoutName(entry)) : []
  } catch {
    names = []
  }
  hiddenCache = { raw, set: new Set(names) }
  return hiddenCache.set
}

function writeHiddenBuiltIns(names: ReadonlySet<string>): void {
  try {
    if (names.size === 0) localStorage.removeItem(HIDDEN_BUILT_INS_KEY)
    else localStorage.setItem(HIDDEN_BUILT_INS_KEY, JSON.stringify([...names]))
  } catch {
    // Storage disabled — hidden for this visit only.
  }
  hiddenCache = { raw: null, set: new Set() }
  for (const listener of hiddenListeners) listener()
}

const subscribeHidden = (listener: () => void) => {
  hiddenListeners.add(listener)
  return () => hiddenListeners.delete(listener)
}

/** The file's list, minus every entry the PUT schema would refuse: the GET answers the file
 *  verbatim, and one bad entry (hand-edited, a newer cezar's view) must neither crash a reader nor
 *  make every later write 400 — the `keybindings` rule (BACKWARD_COMPATIBILITY.md §2). */
export function readSavedLayouts(raw: unknown): SavedWorkspaceLayout[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const parsed = savedWorkspaceLayoutSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * The layouts the user saved by name — one list for every task of every project, kept in
 * `~/.cezar/ui-state.json` (`savedLayouts`). The `useProjectOrder` shape: the ui-state query is the
 * single copy, a write is optimistic, and writes are serialized so a slow answer cannot resurrect
 * a list the user has already changed.
 */
export function useSavedLayouts(): {
  /** The built-ins (minus hidden ones and those a user layout stands in for), then the user's. */
  saved: readonly SavedLayout[]
  /** Save under `layout.name`, replacing one already saved under it. */
  save: (layout: SavedLayout) => void
  remove: (name: string) => void
  /** Built-ins only: take it off this browser's menu, and put every hidden one back. */
  hideBuiltIn: (name: string) => void
  showBuiltIns: () => void
  hiddenBuiltIns: ReadonlySet<string>
} {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())
  const hiddenBuiltIns = React.useSyncExternalStore(subscribeHidden, hiddenBuiltInLayouts, hiddenBuiltInLayouts)

  const raw = uiState.data?.savedLayouts
  const saved = React.useMemo(() => {
    const own = raw
      ? readSavedLayouts(raw).filter(
          (layout) => !isReservedLayoutName(layout.name) && layout.columns.every((c) => isViewId(c.view)),
        )
      : []
    const taken = new Set(own.map((layout) => layout.name))
    return [...BUILT_IN_LAYOUTS.filter((layout) => !taken.has(layout.name) && !hiddenBuiltIns.has(layout.name)), ...own]
  }, [raw, hiddenBuiltIns])

  const write = React.useCallback(
    (change: (list: SavedWorkspaceLayout[]) => SavedWorkspaceLayout[]) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      if (current === undefined) return
      const savedLayouts = change(readSavedLayouts(current.savedLayouts)).slice(0, MAX_SAVED_WORKSPACE_LAYOUTS)
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
  const hideBuiltIn = React.useCallback((name: string) => {
    if (!isBuiltInLayoutName(name)) return
    writeHiddenBuiltIns(new Set([...hiddenBuiltInLayouts(), name]))
  }, [])
  const showBuiltIns = React.useCallback(() => writeHiddenBuiltIns(new Set()), [])

  return { saved, save, remove, hideBuiltIn, showBuiltIns, hiddenBuiltIns }
}
