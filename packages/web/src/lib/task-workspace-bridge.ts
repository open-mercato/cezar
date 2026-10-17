import type { ViewId } from '@/routes/task-workspace/layout-state'

/**
 * What the mounted task workspace lets the ⌘P palette drive (spec 2026-10-17-task-palette). The
 * workspace owns its layouts, drawer and full view as local state; publishing a handle here is
 * what lets a palette mounted outside the route reach them without lifting all of it up.
 *
 * Read when the palette opens rather than subscribed to: the palette is modal, so nothing on the
 * workspace changes underneath it except through the palette's own commands, which close it.
 */
export interface TaskWorkspaceBridge {
  runId: string
  /** The view cards, in strip order — index + 1 is the card's number key. */
  views: readonly ViewId[]
  /** The fixed view on screen, or null when a saved multi-column layout is. */
  activeView: ViewId | null
  openView: (view: ViewId) => void
  openViewBeside: (view: ViewId) => void
  /** Saved multi-column layouts, in strip order. Not numbered: the number keys are the views', then Notes'. */
  layouts: readonly { name: string; label: string; active: boolean }[]
  selectLayout: (name: string) => void
  newLayout: () => void
  maximized: boolean
  toggleMaximized: () => void
  splitView: (() => void) | null
  terminal: { allowed: boolean; open: boolean; inColumn: boolean; toggle: () => void; openInColumn: () => void }
  /** Null when no Chat column shows a composer. */
  focusComposer: (() => void) | null
  openFile: (path: string) => void
  /** Suppress the workspace's auto-mark-read for this visit, as the header's Mark unread does (#775). */
  markedUnread: () => void
}

let current: TaskWorkspaceBridge | null = null
let pendingFile: { runId: string; path: string } | null = null

export function publishTaskWorkspace(bridge: TaskWorkspaceBridge): void {
  current = bridge
}

/** Withdraw — only if `bridge` is still the published one, so an unmount racing the next task's
 *  mount cannot clear the newcomer. */
export function withdrawTaskWorkspace(bridge: TaskWorkspaceBridge): void {
  if (current === bridge) current = null
}

/** The bridge for `runId`, or null when that task is not the one on screen. */
export function taskWorkspaceFor(runId: string | undefined): TaskWorkspaceBridge | null {
  return runId !== undefined && current?.runId === runId ? current : null
}

/** A file picked for a task that is not on screen yet: the workspace opens it when it mounts. */
export function queueFileOpen(runId: string, path: string): void {
  pendingFile = { runId, path }
}

export function takeQueuedFileOpen(runId: string): string | null {
  if (pendingFile?.runId !== runId) return null
  const { path } = pendingFile
  pendingFile = null
  return path
}

/** Test seam. */
export function resetTaskWorkspaceBridge(): void {
  current = null
  pendingFile = null
}
