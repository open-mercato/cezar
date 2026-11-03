/**
 * A tab kept open across a self-update or rebuild still runs the old shell, whose lazy chunks
 * the new `web/dist` no longer has — every navigation to an unvisited page then fails with
 * "Importing a module script failed." (telemetry c66965f8). Reloading picks up the served build.
 */

const RELOADED_AT_KEY = 'cez:stale-build-reload-at'
/** A chunk that still fails this soon after a reload is really missing — report it, don't loop. */
const RETRY_WINDOW_MS = 60_000

let reloading = false

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

/** Reloads the page once to recover from a chunk that failed to load. True when a reload is under
 *  way (the caller should wait for it, not surface the error); false when one already ran within
 *  the last minute or the guard cannot be stored, so the failure is real. */
export function reloadForStaleBuild(
  storage: Storage | null = safeSessionStorage(),
  reload: () => void = () => window.location.reload(),
  now = Date.now(),
): boolean {
  if (reloading) return true
  if (!storage) return false
  try {
    const last = Number(storage.getItem(RELOADED_AT_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < RETRY_WINDOW_MS) return false
    storage.setItem(RELOADED_AT_KEY, String(now))
  } catch {
    return false // no way to remember the attempt, so no way to stop a reload loop
  }
  reloading = true
  reload()
  return true
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Test seam: forget an in-flight reload. */
export function resetStaleBuildReload(): void {
  reloading = false
}
