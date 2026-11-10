import { useMemo } from 'react'

import { useHealth, useProjects } from '@/api/queries'
import type { HealthResponse, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { useActiveProjectId } from '@/lib/project-router'
import { withServedBootProject } from '@/lib/served-boot-project'

/** The boot repo's folder name from health — the fallback name while the registry cannot answer. */
export function healthRepoName(health: HealthResponse | undefined): string | null {
  const root = health?.repo?.root
  if (!root) return null
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null
}

/**
 * The display name of the project on screen: the registry entry for the URL's id, else — for
 * the CONFIRMED boot project only — health's repo folder. The document title, the rail header
 * and the task header (#2002) all read this one rule. `?.` on `projects`: a partially seeded
 * cache entry must degrade to "no name", not throw.
 */
export function activeProjectName(
  registry: ProjectsResponse | undefined,
  projectId: string | null,
  health: HealthResponse | undefined,
): string | null {
  const bootProjectId = registry?.bootProject ?? health?.bootProject ?? null
  const activeProject = registry?.projects?.find((project) => project.id === projectId)
  const isBootProject = projectId !== null && projectId === bootProjectId
  return activeProject?.name ?? (isBootProject ? healthRepoName(health) : null)
}

export interface ActiveProject {
  id: string
  name: string
  /** More than one registered project — the multi-project sidebar's rule. */
  multiProject: boolean
}

/** The project on screen, or null while nothing true can be said about it. */
export function useActiveProject(): ActiveProject | null {
  const projectId = useActiveProjectId()
  const health = useHealth().data
  const projects = useProjects().data
  return useMemo(() => {
    const registry = withServedBootProject(projects, projectId, health)
    const id = projectId ?? registry?.bootProject ?? health?.bootProject ?? null
    const name = activeProjectName(registry, id, health)
    if (id === null || name === null) return null
    return { id, name, multiProject: (registry?.projects?.length ?? 0) > 1 }
  }, [projects, projectId, health])
}
