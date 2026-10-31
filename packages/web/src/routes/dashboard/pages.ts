import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DashboardSnapshot,
  DashboardGroup,
  DashboardTaskRow,
} from '@open-mercato/cezar-api-client'
import { dashboardKeys, getDashboard, getDashboardTasks } from '@/api/dashboard'
import { ApiError } from '@/api/client'
export function useDashboardPage(
  snapshot: DashboardSnapshot | undefined,
  group: DashboardGroup,
  count: number,
  enabled = true,
) {
  const client = useQueryClient()
  return useQuery({
    queryKey: [...dashboardKeys.snapshot, snapshot?.snapshotId, group, count],
    enabled: enabled && !!snapshot,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!snapshot) throw new Error('Dashboard not loaded')
      const rows = []
      try {
        for (let offset = 0; offset < count; ) {
          const answer = await getDashboardTasks(
            snapshot.snapshotId,
            group,
            offset,
            Math.min(20, count - offset),
            signal,
          )
          rows.push(...answer.page.rows)
          if (answer.page.nextOffset === null) break
          offset = answer.page.nextOffset
        }
        return rows
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const fresh = await getDashboard(signal)
          client.setQueryData(dashboardKeys.snapshot, fresh)
        }
        throw error
      }
    },
  })
}

/** A missing row in a page may simply have moved to the next page. Resolve only staged
 * identities that fell outside the loaded prefix, against the same immutable snapshot. */
export function useDisplacedRows(
  snapshot: DashboardSnapshot,
  group: DashboardGroup,
  offset: number,
  missing: DashboardTaskRow[],
) {
  const client = useQueryClient()
  const lookupGroup = group === 'questions' || group === 'reviews' ? 'needs-you' : group
  const lookupOffset = lookupGroup === 'needs-you' ? 0 : offset
  const ids = missing.map((row) => `${row.projectId}:${row.id}`).sort()
  return useQuery({
    queryKey: [...dashboardKeys.snapshot, snapshot.snapshotId, group, 'displaced', ...ids],
    enabled: ids.length > 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const wanted = new Set(ids)
      const found = new Map<string, DashboardTaskRow>()
      try {
        for (let next: number | null = lookupOffset; next !== null && wanted.size; ) {
          const answer = await getDashboardTasks(snapshot.snapshotId, lookupGroup, next, 20, signal)
          for (const row of answer.page.rows) {
            const key = `${row.projectId}:${row.id}`
            if (wanted.delete(key)) found.set(key, row)
          }
          next = answer.page.nextOffset
        }
        return found
      } catch (error) {
        if (error instanceof ApiError && error.status === 409)
          client.setQueryData(dashboardKeys.snapshot, await getDashboard(signal))
        throw error
      }
    },
  })
}
