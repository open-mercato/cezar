import { useSyncExternalStore } from 'react'

/**
 * Focus (spec 2026-10-22-html-artifacts-and-impact, R2): a view may ask the app shell to fold the
 * desktop sidebar down to its icon rail while that view is on screen. The shell had no rail of its
 * own, so this is the whole mechanism: a view HOLDS the rail while mounted and releases it on
 * unmount (or when a hidden `<Activity>` cleans its effects up), and the rail's expand button asks
 * the holder to let go. Transient by design — the per-view preference lives with the view.
 */

interface Hold {
  onExit: () => void
}

const holds: Hold[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function railed(): boolean {
  return holds.length > 0
}

/** Fold the sidebar until the returned release runs. `onExit` fires when the user expands it from
 *  the rail, so the holder can record "focus off" for its view. */
export function holdSidebarRail(onExit: () => void): () => void {
  const hold: Hold = { onExit }
  holds.push(hold)
  emit()
  return () => {
    const at = holds.indexOf(hold)
    if (at < 0) return
    holds.splice(at, 1)
    emit()
  }
}

/** The rail's expand button: every holder is told to let go. */
export function exitSidebarRail(): void {
  for (const hold of [...holds]) hold.onExit()
}

export function useSidebarRail(): boolean {
  return useSyncExternalStore(subscribe, railed, railed)
}
