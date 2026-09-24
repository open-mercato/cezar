import type {
  ProjectsResponse,
  WorkspaceLastLocation,
} from '@open-mercato/cezar-api-client'

import { orderProjects } from './project-order'
import { pathnameProjectId } from './project-router'

export type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>

/**
 * Where the remembered location lives: THIS browser, not the workspace file.
 *
 * It shipped in `~/.cezar/ui-state.json` and that made one answer serve every client — the phone
 * on the couch decided where the desktop's next bare-root launch landed, and two open cockpits
 * overwrote each other on every navigation. "The page this window was last on" describes a
 * browser, so it is stored per browser (like `cez-theme`). A server that still holds the legacy
 * `lastLocation` key keeps it; nothing reads it any more.
 */
export const LAST_LOCATION_STORAGE_KEY = 'cez-last-location'

/** The stored value, unvalidated — `locationToRestore` is what decides whether it is usable. */
export function readStoredLastLocation(): unknown {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_STORAGE_KEY)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    // Absent, private mode, or a hand-edited non-JSON value — no remembered location.
    return null
  }
}

export function writeStoredLastLocation(location: WorkspaceLastLocation): void {
  try {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(location))
  } catch {
    // Private mode / storage full — navigation continues, the next launch just starts at boot.
  }
}

const LAST_LOCATION_KEYS = new Set(['projectId', 'pathname', 'search', 'hash'])

function parsedLastLocation(value: unknown): WorkspaceLastLocation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !LAST_LOCATION_KEYS.has(key))) return null
  if (typeof record.projectId !== 'string' || record.projectId.length < 1 || record.projectId.length > 64) {
    return null
  }
  if (
    typeof record.pathname !== 'string' ||
    record.pathname.length < 1 ||
    record.pathname.length > 2_048 ||
    !record.pathname.startsWith('/p/')
  ) {
    return null
  }
  if (
    record.search !== undefined &&
    (typeof record.search !== 'string' || record.search.length > 4_096 || !record.search.startsWith('?'))
  ) {
    return null
  }
  if (
    record.hash !== undefined &&
    (typeof record.hash !== 'string' || record.hash.length > 2_048 || !record.hash.startsWith('#'))
  ) {
    return null
  }

  try {
    if (pathnameProjectId(record.pathname) !== record.projectId) return null
  } catch {
    return null
  }

  return {
    projectId: record.projectId,
    pathname: record.pathname,
    ...(record.search === undefined ? {} : { search: record.search }),
    ...(record.hash === undefined ? {} : { hash: record.hash }),
  }
}

function projectIsUsable(projectId: string, registry: ProjectsResponse): boolean {
  const project = registry.projects.find((entry) => entry.id === projectId)
  return project !== undefined && project.status !== 'missing'
}

export function locationToSave(
  location: LocationParts,
  registry: ProjectsResponse | undefined,
): WorkspaceLastLocation | null {
  if (registry === undefined) return null

  let projectId: string | null
  try {
    projectId = pathnameProjectId(location.pathname)
  } catch {
    return null
  }
  if (projectId === null || !projectIsUsable(projectId, registry)) return null

  return parsedLastLocation({
    projectId,
    pathname: location.pathname,
    ...(location.search === '' ? {} : { search: location.search }),
    ...(location.hash === '' ? {} : { hash: location.hash }),
  })
}

export function locationToRestore(
  value: unknown,
  registry: ProjectsResponse | undefined,
  bootProject: string | undefined,
): string | null {
  const location = parsedLastLocation(value)
  if (location === null) return null

  const projectIsAvailable =
    registry === undefined
      ? bootProject !== undefined && location.projectId === bootProject
      : projectIsUsable(location.projectId, registry)
  if (!projectIsAvailable) return null

  return `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`
}

/**
 * Where a bare `/` lands when there is nothing remembered to restore.
 *
 * The boot project, as it always was — EXCEPT when the registry does not list it. That is the
 * unregistered launch folder: `/api/v1/projects` stops listing it once the user has projects
 * (the seed-once rule, so starting cezar somewhere never adds a row behind their back), and
 * opening the cockpit on a project with no sidebar row would be the same takeover by another
 * route. The registry's own lead row — most recently opened, the sidebar's order — is the
 * honest landing instead; `missing` roots are skipped for the same reason a remembered location
 * pointing at one is not restored.
 *
 * Falls back to the boot project whenever there is no better answer (registry unavailable, or
 * every row missing): it is the one project this server can always serve.
 */
export function bareRootLanding(
  registry: ProjectsResponse | undefined,
  bootProject: string,
): string {
  if (registry === undefined) return bootProject
  const { projects } = registry
  if (projects.length === 0 || projects.some((project) => project.id === bootProject)) {
    return bootProject
  }
  const usable = projects.filter((project) => project.status !== 'missing')
  return orderProjects(usable, [])[0]?.id ?? bootProject
}

/** `left` is deliberately `unknown`: the comparison's caller reads it back out of storage, where
 *  the type system does not reach. Anything that does not parse as a location is simply not equal
 *  to one, so a corrupted value is overwritten rather than kept. */
export function sameLastLocation(left: unknown, right: WorkspaceLastLocation): boolean {
  const parsed = parsedLastLocation(left)
  return (
    parsed !== null &&
    parsed.projectId === right.projectId &&
    parsed.pathname === right.pathname &&
    (parsed.search ?? '') === (right.search ?? '') &&
    (parsed.hash ?? '') === (right.hash ?? '')
  )
}
