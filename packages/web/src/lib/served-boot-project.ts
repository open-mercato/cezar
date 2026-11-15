import type { HealthResponse, ProjectsResponse } from '@open-mercato/cezar-api-client'

/**
 * The registry plus the folder `serve` was started in, while that folder is the project on
 * screen and the registry does not hold it (#1432).
 *
 * The server lists an unregistered launch folder only while the registry is empty (#1057), but
 * `serve` opens the cockpit on it — without this row it would show with no sidebar entry, no
 * name and no way to add it. Built only from what health says about the boot folder, and only
 * in local mode, where `repoRoot` is the absolute path an Add project request needs.
 */
export function withServedBootProject(
  registry: ProjectsResponse | undefined,
  activeProjectId: string | null,
  health: HealthResponse | undefined,
): ProjectsResponse | undefined {
  if (registry === undefined || health === undefined) return registry
  if (activeProjectId === null || activeProjectId !== registry.bootProject) return registry
  // `?.`: a partially seeded health cache entry must degrade to "nothing to add", not throw.
  if (health.bootProject !== activeProjectId || health.capabilities?.localHandoff !== true) return registry
  if (registry.projects.some((project) => project.id === activeProjectId)) return registry

  const root = health.repoRoot
  const name = root?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  if (!name) return registry
  return {
    ...registry,
    projects: [
      {
        id: activeProjectId,
        root,
        name,
        addedAt: '',
        lastOpenedAt: '',
        source: 'local',
        status: health.repo ? 'ok' : 'not-git',
        unregistered: true,
        ...(health.repo ? { branch: health.repo.branch } : {}),
      },
      ...registry.projects,
    ],
  }
}
