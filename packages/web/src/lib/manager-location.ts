const LAST_MANAGER_KEY = 'cez-last-manager'

/** Per tab, like the browser's own history: two windows keep their own last chat. */
export function rememberManagerLocation(location: string): void {
  // Setup is a door, not a place to come back to.
  if (location.startsWith('/manager/new')) return
  try {
    sessionStorage.setItem(LAST_MANAGER_KEY, location)
  } catch {
    // Private mode: Manager falls back to `/manager`.
  }
}

/**
 * Where the sidebar's Manager row leads: the chat or list this tab left, else `/manager`. A
 * remembered chat whose manager is gone from a loaded list falls back too, so the row never opens
 * a dead end (spec 2026-10-31-managers).
 */
export function managerHref(managerIds: readonly string[] | undefined): string {
  let remembered: string | null = null
  try {
    remembered = sessionStorage.getItem(LAST_MANAGER_KEY)
  } catch {
    return '/manager'
  }
  if (remembered === null || !/^\/manager(?:[/?]|$)/.test(remembered)) return '/manager'
  const id = /^\/manager\/([^/?#]+)/.exec(remembered)?.[1]
  if (id !== undefined && managerIds !== undefined && !managerIds.includes(decodeURIComponent(id))) return '/manager'
  return remembered
}
