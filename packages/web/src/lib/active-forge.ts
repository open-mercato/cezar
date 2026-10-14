import { useMemo } from 'react'

import type { ForgeInfo, HealthResponse, ProjectsResponse } from '@open-mercato/cezar-api-client'
import { useHealth, useProjects } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'

/** Shown for a non-boot GitHub project while the host's `gh` check says GitHub cannot be used. */
export const GH_UNAVAILABLE_REASON = 'the GitHub CLI is not installed or not logged in — run `gh auth login`'

/**
 * The forge of the project the cockpit is standing in (#1410).
 *
 * `/api/health` describes the BOOT folder only, so its `forge` answers for the active project only
 * when that project is the boot one. Any other project is classified from its registry entry's
 * `forge` field (#698) — the field the grouped sidebar already gates on — and its availability
 * comes from health's host-wide `gh` check, the one probe that is not about the boot folder.
 * The GitHub tab only needs a recognized remote; availability gates the PR list and Create PR,
 * and a per-repo failure (no access to that repository) is reported by the GitHub page and by
 * Create PR itself.
 *
 * `undefined` = not known yet (health or registry still loading); `null` = no forge remote.
 */
export function activeForgeOf(
  health: HealthResponse | undefined,
  registry: ProjectsResponse | undefined,
  projectId: string | null,
): ForgeInfo | null | undefined {
  const bootProjectId = registry?.bootProject ?? health?.bootProject ?? null
  // `default` is the API's reserved alias for the boot project.
  if (projectId === null || projectId === 'default' || projectId === bootProjectId) return health?.forge
  // Optional-chained past the contract: the task header must not crash on a partial answer.
  const entry = registry?.projects?.find((project) => project.id === projectId)
  if (!entry || !health) return undefined
  if (!entry.forge) return null
  const gh = health.checks?.find((check) => check.name === 'gh')
  // An older server that never probed `gh`: the kind is known, the availability is not.
  if (!gh) return { kind: entry.forge }
  return gh.available ? { kind: entry.forge, available: true } : { kind: entry.forge, available: false, reason: GH_UNAVAILABLE_REASON }
}

/** `activeForgeOf` for the URL's project, from the shell's cached health and registry. */
export function useActiveForge(): ForgeInfo | null | undefined {
  const health = useHealth().data
  const registry = useProjects().data
  const projectId = useActiveProjectId()
  return useMemo(() => activeForgeOf(health, registry, projectId), [health, registry, projectId])
}
