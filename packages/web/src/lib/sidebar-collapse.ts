/**
 * The multi-project sidebar's per-project collapse map — per BROWSER, not per workspace.
 *
 * This used to live under `sidebar.collapsed` in `~/.cezar/ui-state.json`, which meant one
 * workspace-wide answer for every client at once: collapsing a group on the phone collapsed it on
 * the desktop, and each toggle cost a PUT that a second open cockpit could clobber. Which groups
 * are shut is a property of the window you are looking at — a narrow phone wants everything shut,
 * a wide desktop does not — so it belongs in localStorage next to the theme and the appearance
 * mirror. Legacy files keep their `sidebar` key; nothing reads it any more.
 */

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'cez-sidebar-collapsed'

/** Project id → collapsed. Absent entry means "no answer yet" (see `isProjectCollapsed`). */
export type SidebarCollapsed = Record<string, boolean>

/** Coerce anything (missing key, an older shape, a hand-edited value) into a collapse map:
 *  non-boolean entries are dropped rather than rendered as a truthy collapse. */
export function normalizeCollapsed(raw: unknown): SidebarCollapsed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const map: SidebarCollapsed = {}
  for (const [projectId, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') map[projectId] = value
  }
  return map
}

export function readStoredCollapsed(): SidebarCollapsed {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
    return raw === null ? {} : normalizeCollapsed(JSON.parse(raw))
  } catch {
    // Absent, private mode, or non-JSON — the defaults below still give every group an answer.
    return {}
  }
}

export function writeStoredCollapsed(collapsed: SidebarCollapsed): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed))
  } catch {
    // Private mode / storage full — the collapse still applies for this page.
  }
}

/**
 * Whether a group renders collapsed.
 *
 * The stored answer wins whenever there is one — including an explicit `false`, which is how a
 * user pins a non-active project open. With no entry the default is "the project you are
 * looking at is open, the rest are shut": the alternative (everything open) turns a 40-project
 * workspace into an unusable scroll on first boot, and costs a runs request per project.
 */
export function isProjectCollapsed(
  collapsed: SidebarCollapsed | undefined,
  projectId: string,
  activeProjectId: string | null,
): boolean {
  const stored = collapsed?.[projectId]
  if (stored !== undefined) return stored
  return projectId !== activeProjectId
}
