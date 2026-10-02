import { useQuery } from '@tanstack/react-query'
import { dashboardInsightsSchema, type DashboardInsightsQuery } from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'
import { workspaceQueryKeys } from './queries'

/** Delivered work, failure reasons, backend and automation stats for one period. */
export function useDashboardInsights(period: DashboardInsightsQuery['period'], enabled = true) {
  return useQuery({
    queryKey: [...workspaceQueryKeys.dashboard, 'insights', period],
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 15000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async ({ signal }) =>
      dashboardInsightsSchema.parse(
        await unwrap(
          await cez.api.v1.workspace.dashboard.insights.$get(
            {
              query: {
                period,
                tzOffsetMinutes: String(new Date().getTimezoneOffset()),
              },
            },
            { init: { signal } },
          ),
          '/workspace/dashboard/insights',
        ),
      ),
  })
}
