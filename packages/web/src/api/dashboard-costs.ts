import { dashboardTruthRevision, reconcileDashboardTruth } from './dashboard-truth'
import { useQuery } from '@tanstack/react-query'
import { dashboardCostsSchema, type DashboardCosts } from '@open-mercato/cezar-api-client'
import { cez, unwrap, ApiError } from './client'
import { workspaceQueryKeys } from './queries'
export const costsKey = [...workspaceQueryKeys.dashboard, 'costs'] as const
const snapshotTruthRevisions = new Map<string, number>()
export async function getDashboardCosts(
  options: {
    period: DashboardCosts['period']
    sort: DashboardCosts['sort']
    snapshotId?: string
    projectId?: string
    offset?: number
    tzOffsetMinutes?: number
  },
  signal?: AbortSignal,
) {
  const revision = dashboardTruthRevision()
  const result = dashboardCostsSchema.parse(
    await unwrap(
      await cez.api.v1.workspace.dashboard.costs.$get(
        {
          query: {
            ...options,
            offset: String(options.offset ?? 0),
            limit: '20',
          },
        },
        { init: { signal } },
      ),
      '/workspace/dashboard/costs',
    ),
  )
  // Only a fresh capture establishes a revision; paging a saved cohort is not a
  // fresh observation and must never overwrite a later SSE transition.
  if (!options.snapshotId && !snapshotTruthRevisions.has(result.snapshotId))
    snapshotTruthRevisions.set(result.snapshotId, revision)
  if (snapshotTruthRevisions.size > 60)
    snapshotTruthRevisions.delete(snapshotTruthRevisions.keys().next().value!)
  const capturedRevision = snapshotTruthRevisions.get(result.snapshotId)
  if (capturedRevision !== undefined)
    reconcileDashboardTruth(capturedRevision, result.tasks.rows)
  return result
}
export function useDashboardCosts(
  period: DashboardCosts['period'],
  sort: DashboardCosts['sort'],
  policy: string,
) {
  return useQuery({
    queryKey: [...costsKey, period, sort, policy],
    queryFn: ({ signal }) =>
      getDashboardCosts(
        { period, sort, tzOffsetMinutes: new Date().getTimezoneOffset() },
        signal,
      ),
    staleTime: 5000,
    refetchOnMount: 'always',
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  })
}
export function useCostTasks(
  snapshot: DashboardCosts,
  projectId: string | undefined,
  sort: DashboardCosts['sort'],
  count: number,
) {
  return useQuery({
    queryKey: [
      ...costsKey,
      'tasks',
      snapshot.snapshotId,
      projectId,
      sort,
      count,
      snapshot.visibility,
    ],
    retry: false,
    queryFn: async ({ signal }) => {
      const tzOffsetMinutes = snapshot.tzOffsetMinutes ?? new Date().getTimezoneOffset()
      const read = async (snapshotId?: string) => {
        let page = await getDashboardCosts(
          { period: snapshot.period, sort, snapshotId, projectId, tzOffsetMinutes },
          signal,
        )
        const rows = [...page.tasks.rows]
        while (page.tasks.nextOffset !== null && rows.length < count) {
          page = await getDashboardCosts(
            {
              period: snapshot.period,
              sort,
              snapshotId: page.snapshotId,
              projectId,
              offset: page.tasks.nextOffset,
            },
            signal,
          )
          rows.push(...page.tasks.rows)
        }
        return { ...page, tasks: { ...page.tasks, rows } }
      }
      try {
        return await read(snapshot.snapshotId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return read()
        throw error
      }
    },
  })
}
