import { formatPlanPp, type PlanUsageConsumer, type PlanUsageConsumerWindow, type PlanUsageWindowKind } from '@open-mercato/cezar-api-client'

/** Ids spelled exactly as the server's ledger writes them (`usage-ledger/report.ts`). */
export const taskConsumerId = (projectId: string, runId: string) => `run:${projectId}/${runId}`
export const managerConsumerId = (managerId: string) => `mgr:${managerId}`

export const KIND_LABEL: Record<PlanUsageWindowKind, string> = { 'five-hour': '5h', weekly: 'week' }
export const KIND_LONG: Record<PlanUsageWindowKind, string> = { 'five-hour': '5-hour limit', weekly: 'weekly limit' }

/** `≈ 25%`: every task or manager share is an estimate, even when it ran alone (approved design). */
export const approxPp = (pp: number) => (pp === 0 ? '—' : `≈ ${formatPlanPp(pp)}%`)
/** A provider reading or an account-level remainder: not an estimate. */
export const exactPp = (pp: number) => `${formatPlanPp(pp)}%`

/** A consumer's windows of one kind, newest first. Absent = nothing measured, which is not 0%. */
export function consumerWindows(entries: PlanUsageConsumerWindow[] | undefined, consumerId: string, kind: PlanUsageWindowKind) {
  return (entries ?? [])
    .filter((e) => e.consumer.id === consumerId && e.kind === kind)
    .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))
}

/** A weekly reset is days away: name the day, not just the clock (QA F6). */
export function resetTime(iso: string, kind: PlanUsageWindowKind): string {
  if (kind === 'five-hour') return clockTime(iso)
  const d = new Date(iso)
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${clockTime(iso)}`
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// --- Task share helpers (task page chip + Tasks list column) ---

/** Days the consumers query covers; a run older than that is not "not measured", just not loaded. */
export const PLAN_USAGE_CONSUMERS_DAYS = 14

/** True when a run started before the consumers query's window, so no entry says nothing about it. */
export function beforeConsumersWindow(startedAt: string | undefined, now = Date.now()): boolean {
  const at = startedAt ? Date.parse(startedAt) : NaN
  return Number.isFinite(at) && at < now - PLAN_USAGE_CONSUMERS_DAYS * 86_400_000
}

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "2 other tasks", "1 other task and 1 manager". */
export function ranTogetherLabel(c: Pick<PlanUsageConsumer, 'ranTogetherWith'>): string {
  const { tasks, managers } = c.ranTogetherWith
  const parts = [tasks > 0 ? plural(tasks, 'other task') : '', managers > 0 ? plural(managers, 'manager') : '']
  return parts.filter(Boolean).join(' and ') || 'other cezar work'
}

/** "2 h 10 min", "45 min": how long until a window resets. */
export function untilLabel(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h} h${m > 0 ? ` ${m} min` : ''}` : `${m} min`
}
