import type {
  ProjectsResponse,
  WorkspaceLastLocation,
} from '@open-mercato/cezar-api-client'

import { pathnameProjectId } from './project-router'

export type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>

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

export function sameLastLocation(
  left: WorkspaceLastLocation | undefined,
  right: WorkspaceLastLocation,
): boolean {
  return (
    left !== undefined &&
    left.projectId === right.projectId &&
    left.pathname === right.pathname &&
    (left.search ?? '') === (right.search ?? '') &&
    (left.hash ?? '') === (right.hash ?? '')
  )
}
