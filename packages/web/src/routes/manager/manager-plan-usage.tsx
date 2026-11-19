import { GaugeIcon } from 'lucide-react'
import { useMemo } from 'react'
import { formatPlanPp, type ManagerMessage, type PlanUsageAccount, type PlanUsageConsumerWindow } from '@open-mercato/cezar-api-client'
import { usePlanUsageConsumers } from '@/api/plan-usage'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { approxPp, clockTime, managerConsumerId, taskConsumerId } from '@/lib/plan-usage'

/** Plan-limit usage in a manager chat (session-usage design, screen 5). Tasks it starts count on the task. */

export interface ManagerUsageWindow {
  windowId: string
  account: PlanUsageAccount
  startsAt: string
  resetsAt: string
  estimatePp: number
  parts: { chat: number; watch: number; job: number }
  turns: { chat: number; watch: number; job: number }
  quietWatchTurns: number
}

export interface ManagerUsageToday {
  totalPp: number
  windows: ManagerUsageWindow[]
  /** Tasks it started that have an estimate in today's windows; null when none can be derived. */
  tasks: { count: number; pp: number } | null
}

export interface ReplyUsage {
  pp: number
  /** `Claude · default · 5-hour limit 10:00–15:00`: every estimate names its account and window. */
  where: string
}

const ZERO = { chat: 0, watch: 0, job: 0 }

export const windowLabel = (account: PlanUsageAccount, startsAt: string, resetsAt: string) =>
  `${account.label} · 5-hour limit ${clockTime(startsAt)}–${clockTime(resetsAt)}`

/** A 5-hour window counts as today's when it holds a moment of today (local) up to now. */
function isToday(entry: Pick<PlanUsageConsumerWindow, 'startsAt' | 'resetsAt' | 'current'>, now: Date): boolean {
  if (entry.current) return true
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Date.parse(entry.resetsAt) > midnight && Date.parse(entry.startsAt) <= now.getTime()
}

/** Same rule as the chat's task cards (`lib/managers.ts` startedTasks): a `task create` command's output. */
const STARTED_TASK = /^\[\[task:([^\]/\s]+)\/([^\]\s]+)\]\]$/gm
export function managerStartedTasks(messages: readonly ManagerMessage[]): Array<{ projectId: string; runId: string }> {
  const seen = new Set<string>()
  const out: Array<{ projectId: string; runId: string }> = []
  for (const message of messages) {
    if (message.kind !== 'assistant') continue
    for (const command of message.commands) {
      if (command.isError || !/\btask create\b/.test(command.summary)) continue
      for (const match of (command.output ?? '').matchAll(STARTED_TASK)) {
        const key = `${match[1]}/${match[2]}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ projectId: match[1]!, runId: match[2]! })
      }
    }
  }
  return out
}

export function managerUsageToday(
  entries: readonly PlanUsageConsumerWindow[] | undefined,
  managerId: string,
  started: ReadonlyArray<{ projectId: string; runId: string }>,
  now: Date,
): ManagerUsageToday | null {
  const id = managerConsumerId(managerId)
  const today = (entries ?? []).filter((e) => e.kind === 'five-hour' && isToday(e, now))
  const windows = today
    .filter((e) => e.consumer.id === id)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .map((e): ManagerUsageWindow => ({
      windowId: e.windowId,
      account: e.account,
      startsAt: e.startsAt,
      resetsAt: e.resetsAt,
      estimatePp: e.consumer.estimatePp,
      parts: e.consumer.parts ?? ZERO,
      turns: e.consumer.turns ?? ZERO,
      quietWatchTurns: e.consumer.quietWatchTurns ?? 0,
    }))
  if (windows.length === 0) return null
  const startedIds = new Set(started.map((t) => taskConsumerId(t.projectId, t.runId)))
  const counted = new Set<string>()
  let taskPp = 0
  for (const e of today) {
    if (!startedIds.has(e.consumer.id)) continue
    counted.add(e.consumer.id)
    taskPp += e.consumer.estimatePp
  }
  return {
    totalPp: windows.reduce((sum, w) => sum + w.estimatePp, 0),
    windows,
    tasks: counted.size > 0 ? { count: counted.size, pp: taskPp } : null,
  }
}

/** Per assistant message: its estimate in the 5-hour window it ran in. Absent = no entry, never 0. */
export function replyUsageById(entries: readonly PlanUsageConsumerWindow[] | undefined, managerId: string): ReadonlyMap<string, ReplyUsage> {
  const id = managerConsumerId(managerId)
  const out = new Map<string, ReplyUsage>()
  for (const e of entries ?? []) {
    if (e.kind !== 'five-hour' || e.consumer.id !== id) continue
    for (const m of e.consumer.messages ?? []) {
      const prior = out.get(m.messageId)
      out.set(m.messageId, {
        pp: (prior?.pp ?? 0) + m.estimatePp,
        where: prior?.where ?? windowLabel(e.account, e.startsAt, e.resetsAt),
      })
    }
  }
  return out
}

export function useManagerPlanUsage(managerId: string, messages: readonly ManagerMessage[], now: number) {
  const entries = usePlanUsageConsumers().data?.entries
  const started = useMemo(() => managerStartedTasks(messages), [messages])
  // `now` ticks every 30 s; the day boundary only needs that resolution.
  const today = useMemo(() => managerUsageToday(entries, managerId, started, new Date(now)), [entries, managerId, started, now])
  const replies = useMemo(() => replyUsageById(entries, managerId), [entries, managerId])
  return { today, replies }
}

function watchLabel(turns: number, quiet: number): string {
  if (turns === 0) return 'Watch checks'
  if (quiet === turns) return `Watch checks (${turns}, nothing new found)`
  if (quiet > 0) return `Watch checks (${turns}, ${quiet} found nothing new)`
  return `Watch checks (${turns})`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Row({ label, value, slot }: { label: string; value: string; slot: string }) {
  return (
    <div data-slot={slot} className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className="shrink-0 tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

/** Header chip "Today ≈ N% of 5h" with its chat / watch / jobs breakdown. */
export function ManagerUsageChip({ name, usage }: { name: string; usage: ManagerUsageToday | null }) {
  if (!usage) return null
  const sum = (pick: (w: ManagerUsageWindow) => number) => usage.windows.reduce((s, w) => s + pick(w), 0)
  const chat = { turns: sum((w) => w.turns.chat), pp: sum((w) => w.parts.chat) }
  const watch = { turns: sum((w) => w.turns.watch), pp: sum((w) => w.parts.watch), quiet: sum((w) => w.quietWatchTurns) }
  const job = { turns: sum((w) => w.turns.job), pp: sum((w) => w.parts.job) }
  return (
    <Popover>
      <PopoverTrigger
        data-slot="manager-usage-chip"
        aria-label={`Plan limit used today: ${approxPp(usage.totalPp)} of the 5-hour limit`}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground tabular-nums outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:hidden"
      >
        <GaugeIcon aria-hidden="true" className="size-3" />
        Today {approxPp(usage.totalPp)} of 5h
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm" data-slot="manager-usage-popover">
        <p className="font-medium">{name} — today</p>
        {usage.windows.map((w) => (
          <div key={w.windowId} data-slot="manager-usage-window" className="mt-2">
            <p className="text-xs text-muted-foreground">{windowLabel(w.account, w.startsAt, w.resetsAt)}</p>
            <p className="font-semibold tabular-nums">{approxPp(w.estimatePp)} of the 5-hour limit</p>
          </div>
        ))}
        <dl className="mt-3 flex flex-col gap-1 border-t border-border pt-2 text-xs">
          {chat.turns > 0 || chat.pp > 0 ? <Row slot="manager-usage-chat" label={`Chat (${plural(chat.turns, 'reply', 'replies')})`} value={approxPp(chat.pp)} /> : null}
          {watch.turns > 0 || watch.pp > 0 ? <Row slot="manager-usage-watch" label={watchLabel(watch.turns, watch.quiet)} value={approxPp(watch.pp)} /> : null}
          {job.turns > 0 || job.pp > 0 ? <Row slot="manager-usage-job" label={`Jobs (${job.turns})`} value={approxPp(job.pp)} /> : null}
        </dl>
        {usage.tasks ? (
          <div data-slot="manager-usage-tasks" className="mt-2 border-t border-border pt-2 text-xs">
            <dl><Row slot="manager-usage-tasks-row" label={`Tasks it started (${usage.tasks.count}), counted on those tasks`} value={approxPp(usage.tasks.pp)} /></dl>
            <p className="mt-1 text-muted-foreground">
              Never counted twice: the {formatPlanPp(usage.tasks.pp)}% belongs to {usage.tasks.count === 1 ? 'that task' : `the ${usage.tasks.count} tasks`}; it's listed so you can see what the manager set in motion.
            </p>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** The grey line under a reply; rendered only when the ledger has an entry for it. */
export function ReplyUsageNote({ usage }: { usage: ReplyUsage }) {
  return (
    <p data-slot="manager-reply-usage" title={usage.where} className="mt-1 text-xs text-muted-foreground tabular-nums">
      This reply {approxPp(usage.pp)} of 5h
      <span className="sr-only"> ({usage.where})</span>
    </p>
  )
}
