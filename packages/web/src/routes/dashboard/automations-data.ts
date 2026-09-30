import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  dashboardAutomationsSchema,
  type DashboardAutomation,
  type DashboardAutomations,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from '@/api/client'
import { useProjects, workspaceQueryKeys } from '@/api/queries'
import { onWorkspaceEvent } from '@/api/global-events'

export function nextAutomationAt(automation: DashboardAutomation) {
  const at = Date.parse(automation.nextRunAt ?? '')
  const backoff = Date.parse(automation.state?.backoffUntil ?? '')
  return Number.isFinite(at) ? Math.max(at, Number.isFinite(backoff) ? backoff : at) : null
}
export function enabledAutomations(
  projects: { id: string; name: string; data?: DashboardAutomations }[],
) {
  return projects
    .flatMap((project) =>
      (project.data?.automations ?? [])
        .filter((a) => a.enabled)
        .map((automation) => ({ project, automation, at: nextAutomationAt(automation) })),
    )
    .sort(
      (a, b) =>
        (a.at ?? Infinity) - (b.at ?? Infinity) ||
        a.project.id.localeCompare(b.project.id) ||
        a.automation.id.localeCompare(b.automation.id),
    )
}
export function useDashboardAutomations(enabled: boolean) {
  const registry = useProjects()
  const client = useQueryClient()
  const registered = registry.data?.projects ?? []
  const boot = registry.data?.bootProject
  const projects =
    boot && !registered.some((p) => p.id === boot)
      ? [...registered, { id: boot, name: boot, status: 'ok' }]
      : registered
  const query = useQuery({
    queryKey: [
      ...workspaceQueryKeys.dashboard,
      'automations',
      projects.map((p) => [p.id, p.name, p.status]),
    ],
    enabled: enabled && !!registry.data,
    queryFn: async ({ signal }) => {
      let cursor = 0
      const result: { id: string; name: string; data?: DashboardAutomations; error?: string }[] =
        []
      await Promise.all(
        [0, 1].map(async () => {
          while (cursor < projects.length && !signal.aborted) {
            const project = projects[cursor++]!
            if (project.status === 'missing') {
              result.push({ ...project, error: 'Project folder unavailable' })
              continue
            }
            try {
              const data = dashboardAutomationsSchema.parse(
                await unwrap(
                  await cez.api.v1.workspace.dashboard.automations.$get(
                    { query: { projectId: project.id } },
                    { init: { signal } },
                  ),
                  '/workspace/dashboard/automations',
                ),
              )
              result.push({ id: project.id, name: project.name, data })
            } catch {
              result.push({
                id: project.id,
                name: project.name,
                error: 'Could not load automations',
              })
            }
          }
        }),
      )
      return result
    },
  })
  useEffect(() => {
    if (!enabled) return
    return onWorkspaceEvent((name) => {
      if (name === 'automation-change')
        void client.invalidateQueries({
          queryKey: [...workspaceQueryKeys.dashboard, 'automations'],
        })
    })
  }, [client, enabled])
  return {
    ...query,
    registry,
    retry: () => {
      void registry.refetch()
      void query.refetch()
    },
  }
}
