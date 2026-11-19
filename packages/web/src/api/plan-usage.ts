import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  planUsageConsumersResponseSchema,
  planUsageReportSchema,
  planUsageTrackingSchema,
  type PlanUsageWindowKind,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'
import { PLAN_USAGE_CONSUMERS_DAYS } from '@/lib/plan-usage'

/** Plan-limit usage (design rev 3): one workspace-level ledger behind every surface. */
export const planUsageKeys = {
  // Not under `dashboard`: that prefix refetches on every run event, and these poll on their own.
  all: ['workspace', 'plan-usage'] as const,
  report: (q: PlanUsageReportQuery) => [...planUsageKeys.all, 'report', q] as const,
  consumers: ['workspace', 'plan-usage', 'consumers'] as const,
  tracking: ['workspace', 'plan-usage', 'tracking'] as const,
}

export interface PlanUsageReportQuery {
  kind?: PlanUsageWindowKind
  account?: string
  /** `current` (default), `previous`, `all` or a window id. */
  window?: string
  intervals?: boolean
}

/** Readings move while agents work; a minute is fresh enough for a share of a 5-hour window. */
const REFRESH_MS = 60_000

export function usePlanUsage(query: PlanUsageReportQuery, enabled = true) {
  return useQuery({
    queryKey: planUsageKeys.report(query),
    enabled,
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }) => planUsageReportSchema.parse(await unwrap(
      await cez.api.v1.workspace['plan-usage'].$get({
        query: {
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.account ? { account: query.account } : {}),
          ...(query.window ? { window: query.window } : {}),
          ...(query.window && !['current', 'previous'].includes(query.window) ? { days: '90' } : {}),
          ...(query.intervals ? { intervals: '1' as const } : {}),
        },
      }, { init: { signal } }),
      '/workspace/plan-usage',
    )),
  })
}

/** Every consumer's share of every window in the last two weeks: one request for the task list,
 *  the task page and manager chats alike, so they never disagree. */
export function usePlanUsageConsumers(enabled = true) {
  return useQuery({
    queryKey: planUsageKeys.consumers,
    enabled,
    refetchInterval: REFRESH_MS,
    staleTime: 30_000,
    queryFn: async ({ signal }) => planUsageConsumersResponseSchema.parse(await unwrap(
      await cez.api.v1.workspace['plan-usage'].consumers.$get({ query: { days: String(PLAN_USAGE_CONSUMERS_DAYS) } }, { init: { signal } }),
      '/workspace/plan-usage/consumers',
    )),
  })
}

export function usePlanUsageTracking() {
  return useQuery({
    queryKey: planUsageKeys.tracking,
    queryFn: async ({ signal }) => planUsageTrackingSchema.parse(await unwrap(
      await cez.api.v1.workspace['plan-usage'].tracking.$get({}, { init: { signal } }),
      '/workspace/plan-usage/tracking',
    )),
  })
}

export function useSetPlanUsageTracking() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: { account: string; enabled: boolean }) => planUsageTrackingSchema.parse(await unwrap(
      await cez.api.v1.workspace['plan-usage'].tracking.$put({ json: input }),
      '/workspace/plan-usage/tracking',
    )),
    onSuccess: (tracking) => {
      client.setQueryData(planUsageKeys.tracking, tracking)
      void client.invalidateQueries({ queryKey: planUsageKeys.all })
    },
  })
}
