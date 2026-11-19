import { formatPlanPp, type PlanUsageConsumerWindow, type PlanUsageWindowKind } from '@open-mercato/cezar-api-client'

/** Ids spelled exactly as the server's ledger writes them (`usage-ledger/report.ts`). */
export const taskConsumerId = (projectId: string, runId: string) => `run:${projectId}/${runId}`
export const managerConsumerId = (managerId: string) => `mgr:${managerId}`

export const KIND_LABEL: Record<PlanUsageWindowKind, string> = { 'five-hour': '5h', weekly: 'week' }
export const KIND_LONG: Record<PlanUsageWindowKind, string> = { 'five-hour': '5-hour limit', weekly: 'weekly limit' }

/** `≈ 25%`: every task or manager share is an estimate, even when it ran alone (approved design). */
export const approxPp = (pp: number) => `≈ ${formatPlanPp(pp)}%`
/** A provider reading or an account-level remainder: not an estimate. */
export const exactPp = (pp: number) => `${formatPlanPp(pp)}%`

/** A consumer's windows of one kind, newest first. Absent = nothing measured, which is not 0%. */
export function consumerWindows(entries: PlanUsageConsumerWindow[] | undefined, consumerId: string, kind: PlanUsageWindowKind) {
  return (entries ?? [])
    .filter((e) => e.consumer.id === consumerId && e.kind === kind)
    .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// --- Task share helpers (task page chip + Tasks list column) ---

/** Runners whose subscription logins report plan limits; every other tool is "not reported". */
export const PLAN_LIMIT_RUNNERS: ReadonlySet<string> = new Set(['claude', 'codex'])

/** A run's windows of one kind, newest first. Matched on the run id (a UUID) so the project's
 *  `default` alias and its registry id find the same entries. */
export function taskWindows(entries: PlanUsageConsumerWindow[] | undefined, runId: string, kind: PlanUsageWindowKind) {
  return (entries ?? [])
    .filter((e) => e.consumer.kind === 'task' && e.consumer.runId === runId && e.kind === kind)
    .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))
}

/** `/dashboard` details panel for one account and window (built by the Dashboard's Plan limits card). */
export function planWindowHref(accountKey: string, windowId: string): string {
  const query = new URLSearchParams({ view: 'costs', planAccount: accountKey, planWindow: windowId })
  return `/dashboard?${query.toString()}`
}
