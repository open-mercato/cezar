import { dashboardTruthRevision, reconcileDashboardTruth } from './dashboard-truth'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import {
  dashboardSnapshotSchema,
  dashboardTasksPageSchema,
  dashboardFeedSchema,
  dashboardTelemetrySchema,
  type DashboardGroup,
  type DashboardFeed,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'
import { workspaceQueryKeys } from './queries'
import { dashboardLive } from './dashboard-live'

export const dashboardKeys = {
  snapshot: [...workspaceQueryKeys.dashboard, 'snapshot'] as const,
  feed: (filter: DashboardFeed['filter']) =>
    [...workspaceQueryKeys.dashboard, 'feed', filter] as const,
  telemetry: [...workspaceQueryKeys.dashboard, 'telemetry'] as const,
}
const snapshotTruthRevisions = new Map<string, number>()
export async function getDashboard(signal?: AbortSignal) {
  const revision = dashboardTruthRevision()
  const snapshot = dashboardSnapshotSchema.parse(
    await unwrap(
      await cez.api.v1.workspace.dashboard.$get({}, { init: { signal } }),
      '/workspace/dashboard',
    ),
  )
  if (!snapshotTruthRevisions.has(snapshot.snapshotId))
    snapshotTruthRevisions.set(snapshot.snapshotId, revision)
  if (snapshotTruthRevisions.size > 60)
    snapshotTruthRevisions.delete(snapshotTruthRevisions.keys().next().value!)
  // A fresh read can reuse an unchanged snapshot ID after a missed transition.
  // Its returned rows are current observations; saved pages retain the original
  // revision above so they cannot roll back newer truth for other identities.
  reconcileDashboardTruth(revision, [
    ...snapshot.questions.rows,
    ...snapshot.reviews.rows,
  ])
  return snapshot
}
export async function getDashboardTasks(
  snapshotId: string,
  group: DashboardGroup,
  offset = 0,
  limit = 20,
  signal?: AbortSignal,
) {
  const result = dashboardTasksPageSchema.parse(
    await unwrap(
      await cez.api.v1.workspace.dashboard.tasks.$get(
        { query: { snapshotId, group, offset: String(offset), limit: String(limit) } },
        { init: { signal } },
      ),
      '/workspace/dashboard/tasks',
    ),
  )
  const revision = snapshotTruthRevisions.get(snapshotId)
  if (revision !== undefined) reconcileDashboardTruth(revision, result.page.rows)
  return result
}
export function useDashboard(enabled: boolean) {
  return useQuery({
    queryKey: dashboardKeys.snapshot,
    queryFn: ({ signal }) => getDashboard(signal),
    enabled,
    staleTime: 5000,
    refetchOnMount: 'always',
    refetchInterval: enabled ? 15_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  })
}
export function useDashboardTelemetry(enabled: boolean) {
  const query = useQuery({
    queryKey: dashboardKeys.telemetry,
    enabled,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result = dashboardTelemetrySchema.parse(
        await unwrap(
          await cez.api.v1.workspace.dashboard.telemetry.$get({}, { init: { signal } }),
          '/workspace/dashboard/telemetry',
        ),
      )
      dashboardLive.seed(result.samples, result.asOf)
      return result
    },
  })
  return query
}
function useFeedSource(filter: DashboardFeed['filter'], enabled: boolean) {
  const query = useQuery({
    queryKey: dashboardKeys.feed(filter),
    queryFn: async ({ signal }) => {
      const revision = dashboardTruthRevision()
      const result = dashboardFeedSchema.parse(
        await unwrap(
          await cez.api.v1.workspace.dashboard.feed.$get(
            { query: { filter } },
            { init: { signal } },
          ),
          '/workspace/dashboard/feed',
        ),
      )
      reconcileDashboardTruth(
        revision,
        result.rows.flatMap((row) => row.kind === 'task-result' ? [row.run] : []),
      )
      return result
    },
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled && filter !== 'github' ? 15_000 : false,
    retry: false,
  })
  const followed = useRef(false)
  useEffect(() => {
    followed.current = false
  }, [filter, enabled])
  useEffect(() => {
    if (
      !enabled ||
      followed.current ||
      !query.data?.sources.some((s) => s.reason === 'Still loading GitHub')
    )
      return
    const timer = setTimeout(() => {
      if (document.visibilityState === 'hidden') return
      followed.current = true
      void query.refetch()
    }, 5000)
    return () => clearTimeout(timer)
  }, [enabled, query.data, query.refetch])
  return query
}

/** Local reconciliation must never become a GitHub publisher. The two candidates have
 * independent demand lifetimes; All merges them after each source has applied its cap. */
export function useDashboardFeed(filter: DashboardFeed['filter'], enabled: boolean) {
  const tasks = useFeedSource('tasks', enabled && filter !== 'github')
  const github = useFeedSource('github', enabled && filter !== 'tasks')
  const data = useMemo<DashboardFeed | undefined>(() => {
    if (filter === 'tasks') return tasks.data
    if (filter === 'github') return github.data
    const local = tasks.data
    const remote = github.data
    if (!local && !remote) return undefined
    const seed = local ?? remote!
    const asOf = new Date(
      Math.max(Date.parse(local?.asOf ?? seed.asOf), Date.parse(remote?.asOf ?? seed.asOf)),
    ).toISOString()
    const windowStart = new Date(Date.parse(asOf) - 7 * 24 * 60 * 60 * 1000).toISOString()
    const rows = [...(local?.rows ?? []), ...(remote?.rows ?? [])]
      .filter(
        (row) =>
          Date.parse(row.at) >= Date.parse(windowStart) && Date.parse(row.at) <= Date.parse(asOf),
      )
      .sort((a, b) => compareFeedRows(a, b))
    const omitted = new Set(
      rows
        .slice(60)
        .map((row) =>
          row.kind === 'task-result'
            ? `tasks:${row.run.projectId}`
            : row.key.slice(0, row.key.lastIndexOf(':')),
        ),
    )
    const sources = [...(local?.sources ?? []), ...(remote?.sources ?? [])].map((source) =>
      omitted.has(source.key) ? { ...source, truncated: true } : source,
    )
    return {
      ...seed,
      asOf,
      windowStart,
      filter: 'all',
      rows: rows.slice(0, 60),
      sources,
      coverage: local?.coverage ?? seed.coverage,
      truncated: rows.length > 60 || !!local?.truncated || !!remote?.truncated,
    }
  }, [filter, tasks.data, github.data])
  const selected = filter === 'github' ? github : tasks
  return {
    ...selected,
    data,
    githubError: github.isError,
    githubFetching: github.isFetching,
    /** Coverage reflects local task-index health only — retrying it must never target GitHub. */
    retryTasks: () => tasks.refetch(),
    retryFailed: () => {
      if (filter === 'github') return github.refetch()
      if (filter === 'tasks') return tasks.refetch()
      return Promise.all([
        ...(tasks.isError ? [tasks.refetch()] : []),
        ...(github.isError ? [github.refetch()] : []),
      ])
    },
    isPending: !data && selected.isPending,
    isError: selected.isError || (filter === 'all' && github.isError),
    isFetching: selected.isFetching || (filter === 'all' && github.isFetching),
    refetch: () => (filter === 'tasks' ? tasks.refetch() : github.refetch()),
  }
}

export function compareFeedRows(a: { at: string; key: string }, b: { at: string; key: string }) {
  return Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key)
}
