import { dashboardTruthRevision, reconcileDashboardTruth } from './dashboard-truth'
import { useSyncExternalStore } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { dashboardCostsSchema, type DashboardCosts } from '@open-mercato/cezar-api-client'
import { cez, unwrap, ApiError } from './client'
import { workspaceQueryKeys } from './queries'
export const costsKey = [...workspaceQueryKeys.dashboard, 'costs'] as const
// Policy belongs to the live workspace client, not a cached ranking/cohort or a
// browser-history entry. Keep it through cache clearing and release it with the client.
function createPolicyStore() {
  let started = 0
  let observed = 0
  let visibility: DashboardCosts['visibility'] | undefined
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => visibility,
    async read(options: Parameters<typeof getDashboardCosts>[0], signal?: AbortSignal) {
      const revision = ++started
      const result = await getDashboardCosts(options, signal)
      // A response to an earlier request must not undo a later observation.
      if (!signal?.aborted && revision > observed) {
        observed = revision
        if (visibility?.cost !== result.visibility.cost || visibility?.tokens !== result.visibility.tokens) {
          visibility = result.visibility
          listeners.forEach(listener => listener())
        }
      }
      return result
    },
  }
}
const policyStores = new WeakMap<QueryClient, ReturnType<typeof createPolicyStore>>()
function policyStore(client: QueryClient) {
  let store = policyStores.get(client)
  if (!store) {
    store = createPolicyStore()
    policyStores.set(client, store)
  }
  return store
}
export function useDashboardCostPolicy() {
  const store = policyStore(useQueryClient())
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
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
  const store = policyStore(useQueryClient())
  return useQuery({
    queryKey: [...costsKey, period, sort, policy],
    queryFn: ({ signal }) =>
      store.read(
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
  const store = policyStore(useQueryClient())
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
        let page = await store.read(
          { period: snapshot.period, sort, snapshotId, projectId, tzOffsetMinutes },
          signal,
        )
        const rows = [...page.tasks.rows]
        while (page.tasks.nextOffset !== null && rows.length < count) {
          page = await store.read(
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
