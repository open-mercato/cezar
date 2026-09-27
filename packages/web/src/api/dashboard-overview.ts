import { useQuery } from '@tanstack/react-query'
import {
  dashboardOverviewSchema,
  type DashboardOverviewQuery,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'
import { workspaceQueryKeys } from './queries'

export function useDashboardOverview(options: Partial<DashboardOverviewQuery>, enabled = true) {
  return useQuery({
    queryKey: [...workspaceQueryKeys.dashboard, 'overview', options],
    enabled,
    staleTime: 5000,
    refetchInterval: enabled && !options.snapshotId ? 15000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async ({ signal }) =>
      dashboardOverviewSchema.parse(
        await unwrap(
          await cez.api.v1.workspace.dashboard.overview.$get(
            {
              query: {
                period: options.period ?? '7d',
                group: options.group ?? 'completed',
                tzOffsetMinutes: String(
                  options.tzOffsetMinutes ?? new Date().getTimezoneOffset(),
                ),
                ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
                ...(options.projectId ? { projectId: options.projectId } : {}),
                offset: String(options.offset ?? 0),
                limit: '20',
              },
            },
            { init: { signal } },
          ),
          '/workspace/dashboard/overview',
        ),
      ),
  })
}
