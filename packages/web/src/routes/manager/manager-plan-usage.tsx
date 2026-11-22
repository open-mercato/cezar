import { AlertTriangleIcon, GaugeIcon } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import type {
  ManagerMessage,
  PlanUsageAccount,
  PlanUsageConsumer,
  PlanUsageConsumerWindow,
  PlanUsageManagerPart,
  PlanUsageProvider,
  PlanUsageTurnStats,
  PlanUsageWindow,
} from '@open-mercato/cezar-api-client'
import { usePlanUsage, usePlanUsageConsumers } from '@/api/plan-usage'
import { ApproximateNote, PlanUsageLink, PlanUsageRows, PlanUsageSurface, PlanUsageTitle, type PlanUsageRow } from '@/components/plan-usage-details'
import { approxPp, clockTime, exactPp, managerConsumerId, planWindowHref, ranTogetherLabel, resetTime, untilLabel } from '@/lib/plan-usage'
import { cn } from '@/lib/utils'

/**
 * Plan-limit usage in a manager chat (spec 2026-11-20-manager-plan-usage-popover): the account's
 * current 5-hour window and week, and what this manager and the tasks it started used of it.
 * Each task's share stays the task's own everywhere else; here it is only grouped under its manager.
 */

export interface ManagerTurnUsage {
  messageId: string
  part: PlanUsageManagerPart
  at: string
  pp: number
  alonePp: number
  /** What the turn was made of, when the ledger recorded it (spec 2026-11-21 § 2.3). */
  turn?: PlanUsageTurnStats
}

/** The window's manager turns in aggregate: how big they ran, and routing versus its own work. */
export interface ManagerTurnShape {
  turns: number
  avgContext: number
  avgRequests: number
  tools: PlanUsageTurnStats['tools']
  /** Turns heavy enough that a task might have done them: many requests or much of its own work. */
  couldBeTasks: number
  /** Summed over the turns that reported them (Claude); null when none did. */
  tokens: TurnTokens | null
}

export interface TurnTokens { cacheRead: number; cacheWrite: number; output: number }

/** A turn's own cache reads, writes and output, when its runner reported them. */
export function turnTokens(turn: PlanUsageTurnStats): TurnTokens | null {
  if (turn.cacheReadTokens === undefined && turn.cacheWriteTokens === undefined && turn.outputTokens === undefined) return null
  return { cacheRead: turn.cacheReadTokens ?? 0, cacheWrite: turn.cacheWriteTokens ?? 0, output: turn.outputTokens ?? 0 }
}

/** 950 · 13k · 3.7M: token counts at a glance. */
export function tokenCount(n: number): string {
  // Round first, then pick the unit: 999,600 is 1.0M, never 1000k.
  if (Math.round(n) < 1000) return String(Math.round(n))
  const k = Math.round(n / 1000)
  if (k < 1000) return `${k}k`
  const tenths = Math.round(n / 100_000) / 10
  return tenths < 10 ? `${tenths.toFixed(1)}M` : `${Math.round(n / 1_000_000)}M`
}

/** "3.7M cache read · 942k cache written · 3k output". */
export const tokensLabel = (t: TurnTokens): string =>
  `${tokenCount(t.cacheRead)} cache read · ${tokenCount(t.cacheWrite)} cache written · ${tokenCount(t.output)} output`

/** The prompt cache lasts an hour: a turn recorded before `cold` existed is judged by its idle gap. */
const CACHE_TTL_MS = 60 * 60_000

/** Writes are left out on purpose: a manager writes files only to hand long text to a task, which
 *  is routing, not work a task should have done. */
export const couldBeTask = (turn: PlanUsageTurnStats): boolean => turn.requests >= 6 || turn.tools.own >= 4

/** The history was re-cached: its first request wrote over half its context (spec § 2.3). */
const isCold = (turn: PlanUsageTurnStats): boolean =>
  turn.cold ?? (!turn.fresh && turn.idleMs !== undefined && turn.idleMs >= CACHE_TTL_MS)

/** Why a turn cost what it did, most telling first; empty when nothing stands out. */
export function turnReasons(turn: PlanUsageTurnStats): string[] {
  const reasons: string[] = []
  // Bare labels: the figures are already on the detail line.
  if (!turn.fresh && isCold(turn)) reasons.push(turn.idleMs !== undefined && turn.idleMs >= CACHE_TTL_MS ? `cold start after ${Math.round(turn.idleMs / 3_600_000)} h idle` : 'cold start')
  if (turn.contextPeak >= 100_000) reasons.push('large context')
  if (turn.requests >= 6) reasons.push('many requests')
  if (turn.toolResultChars >= 20_000) reasons.push('big tool output')
  if (turn.fresh) reasons.push('new session')
  return reasons
}

export function turnShape(messages: ReadonlyArray<{ turn?: PlanUsageTurnStats }>): ManagerTurnShape | null {
  const turns = messages.flatMap((m) => (m.turn ? [m.turn] : []))
  if (turns.length === 0) return null
  const sum = (pick: (t: PlanUsageTurnStats) => number) => turns.reduce((s, t) => s + pick(t), 0)
  return {
    turns: turns.length,
    avgContext: sum((t) => t.contextPeak) / turns.length,
    avgRequests: sum((t) => t.requests) / turns.length,
    tools: { route: sum((t) => t.tools.route), look: sum((t) => t.tools.look), own: sum((t) => t.tools.own), write: sum((t) => t.tools.write) },
    couldBeTasks: turns.filter(couldBeTask).length,
    tokens: turns.reduce<TurnTokens | null>((acc, t) => {
      const own = turnTokens(t)
      if (!own) return acc
      return acc ? { cacheRead: acc.cacheRead + own.cacheRead, cacheWrite: acc.cacheWrite + own.cacheWrite, output: acc.output + own.output } : own
    }, null),
  }
}

export interface ManagerPlanUsage {
  account: PlanUsageAccount
  windowId: string
  startsAt: string
  resetsAt: string
  /** The manager plus the tasks it started, in this 5-hour window. */
  totalPp: number
  manager: PlanUsageConsumer | null
  tasks: Array<{ id: string; title: string; pp: number }>
  tasksPp: number
  /** Manager plus its tasks in the account's latest week; null when nothing is recorded there. */
  weekPp: number | null
  earlierTodayPp: number
  /** Started tasks that ran on another account today: different limits, so never added in. */
  otherAccountTasks: number
  /** This window's costliest turns, kept so a spike can be traced to the reply that made it. */
  topTurns: ManagerTurnUsage[]
  shape: ManagerTurnShape | null
}

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

/** The account a manager spends: its pinned one, else the one it last ran on, else the runner's default. */
export function managerAccountKey(
  entries: readonly PlanUsageConsumerWindow[] | undefined,
  managerId: string,
  provider: PlanUsageProvider,
  agentProfile: string | undefined,
): string {
  if (agentProfile) return `${provider}:${agentProfile}`
  const id = managerConsumerId(managerId)
  const latest = (entries ?? [])
    .filter((e) => e.consumer.id === id && e.account.provider === provider)
    .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))[0]
  return latest?.account.key ?? `${provider}:default`
}

export function managerPlanUsage(
  entries: readonly PlanUsageConsumerWindow[] | undefined,
  managerId: string,
  started: ReadonlyArray<{ projectId: string; runId: string }>,
  accountKey: string,
  now: Date,
): ManagerPlanUsage | null {
  const id = managerConsumerId(managerId)
  // Matched on the run id: the ledger may spell the project as `default` where the card names its registry id.
  const startedRuns = new Set(started.map((t) => t.runId))
  const mine = (e: PlanUsageConsumerWindow) =>
    e.consumer.id === id || (e.consumer.kind === 'task' && e.consumer.runId !== undefined && startedRuns.has(e.consumer.runId))
  const today = (entries ?? []).filter((e) => e.kind === 'five-hour' && mine(e) && isToday(e, now))
  const onAccount = today.filter((e) => e.account.key === accountKey)
  const latest = onAccount.reduce<PlanUsageConsumerWindow | undefined>((a, e) => (!a || Date.parse(e.resetsAt) > Date.parse(a.resetsAt) ? e : a), undefined)
  if (!latest) return null
  const group = onAccount.filter((e) => e.windowId === latest.windowId)
  const manager = group.find((e) => e.consumer.id === id)?.consumer ?? null
  const tasks = group
    .filter((e) => e.consumer.id !== id)
    .map((e) => ({ id: e.consumer.id, title: e.consumer.title, pp: e.consumer.estimatePp }))
    .sort((a, b) => b.pp - a.pp)
  const tasksPp = tasks.reduce((s, t) => s + t.pp, 0)
  const weekly = (entries ?? []).filter((e) => e.kind === 'weekly' && e.account.key === accountKey && mine(e))
  const lastWeek = weekly.reduce<string | undefined>((a, e) => (!a || e.resetsAt > a ? e.resetsAt : a), undefined)
  const weekEntries = weekly.filter((e) => e.resetsAt === lastWeek)
  const topTurns = [...(manager?.messages ?? [])]
    .sort((a, b) => b.estimatePp - a.estimatePp)
    .slice(0, 3)
    .map((m) => ({ messageId: m.messageId, part: m.part, at: m.at, pp: m.estimatePp, alonePp: m.aloneInferredPp, ...(m.turn ? { turn: m.turn } : {}) }))
  return {
    account: latest.account,
    windowId: latest.windowId,
    startsAt: latest.startsAt,
    resetsAt: latest.resetsAt,
    totalPp: (manager?.estimatePp ?? 0) + tasksPp,
    manager,
    tasks,
    tasksPp,
    weekPp: weekEntries.length > 0 ? weekEntries.reduce((s, e) => s + e.consumer.estimatePp, 0) : null,
    earlierTodayPp: onAccount.filter((e) => e.windowId !== latest.windowId).reduce((s, e) => s + e.consumer.estimatePp, 0),
    otherAccountTasks: new Set(today.filter((e) => e.account.key !== accountKey && e.consumer.id !== id).map((e) => e.consumer.id)).size,
    topTurns,
    shape: turnShape(manager?.messages ?? []),
  }
}

export type LimitLevel = 'ok' | 'warning' | 'critical'

/** Amber from 80 %, red from 95 % or once the provider says the limit is reached. */
export function limitLevel(w: PlanUsageWindow | undefined): LimitLevel | null {
  if (!w?.usedPercent) return null
  const last = w.usedPercent.last
  if (last >= 95 || w.limitReachedAt !== undefined || w.readings.at(-1)?.status === 'blocked') return 'critical'
  return last >= 80 ? 'warning' : 'ok'
}

export interface AccountNow {
  key: string
  fiveHour: PlanUsageWindow | undefined
  week: PlanUsageWindow | undefined
  level: LimitLevel | null
}

function currentWindow(windows: readonly PlanUsageWindow[] | undefined, key: string): PlanUsageWindow | undefined {
  return windows?.find((w) => w.current && w.account.key === key && w.usedPercent !== null)
}

/** One reply's share of the 5-hour limit, for the line under it (restored 2026-11-22). */
export interface ReplyUsage {
  pp: number
  /** Of `pp`, the part measured while no other cezar work ran. */
  alonePp: number
  /** `Claude · default · 5-hour limit 10:00–15:00`, one per window the reply's share came from. */
  windows: string[]
  /** What the reply's turn was made of, when the ledger recorded it. */
  turn?: PlanUsageTurnStats
}

/** Per assistant message: its estimate in the 5-hour windows it ran in. Absent = no entry, never 0:
 *  the ledger rounds a share to 0.01 pp, so a share of 0 is no measurable share and gets no line.
 *  Keyed by the chat message id, which a turn keeps whatever session it ran in. */
export function replyUsageById(entries: readonly PlanUsageConsumerWindow[] | undefined, managerId: string): ReadonlyMap<string, ReplyUsage> {
  const id = managerConsumerId(managerId)
  const found = new Map<string, { pp: number; alonePp: number; windows: Array<{ label: string; startsAt: string }>; turn?: PlanUsageTurnStats }>()
  for (const e of entries ?? []) {
    if (e.kind !== 'five-hour' || e.consumer.id !== id) continue
    const window = { label: `${e.account.label} · 5-hour limit ${clockTime(e.startsAt)}–${clockTime(e.resetsAt)}`, startsAt: e.startsAt }
    for (const m of e.consumer.messages ?? []) {
      if (!(m.estimatePp > 0)) continue
      const prior = found.get(m.messageId)
      const turn = prior?.turn ?? m.turn
      const windows = prior?.windows ?? []
      found.set(m.messageId, {
        pp: (prior?.pp ?? 0) + m.estimatePp,
        alonePp: (prior?.alonePp ?? 0) + m.aloneInferredPp,
        windows: windows.some((w) => w.label === window.label) ? windows : [...windows, window],
        ...(turn ? { turn } : {}),
      })
    }
  }
  const out = new Map<string, ReplyUsage>()
  for (const [messageId, reply] of found) {
    // Oldest window first, whatever order the report lists them in.
    const windows = [...reply.windows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).map((w) => w.label)
    out.set(messageId, { pp: reply.pp, alonePp: reply.alonePp, windows, ...(reply.turn ? { turn: reply.turn } : {}) })
  }
  return out
}

const sharedLabel = (usage: ReplyUsage): string =>
  usage.alonePp >= usage.pp ? 'ran alone' : usage.alonePp > 0 ? 'partly shared with other work' : 'shared with other work'

/** "Claude · default · 5-hour limit 10:00–15:00 · ran alone · 2 requests · 35k context". */
export function replyUsageDetail(usage: ReplyUsage): string {
  const t = usage.turn
  return [usage.windows.join(' and '), sharedLabel(usage), ...(t ? [plural(t.requests, 'request', 'requests'), `${Math.round(t.contextPeak / 1000)}k context`] : [])].join(' · ')
}

/** The grey line under a reply; rendered only when the ledger has an entry for it. It opens the
 *  breakdown as a popover, or a bottom sheet on a phone, so touch and keyboard reach it too. */
export function ReplyUsageNote({ usage }: { usage: ReplyUsage }) {
  const label = `This reply ${approxPp(usage.pp)} of 5h`
  const rows: PlanUsageRow[] = [
    { slot: 'manager-reply-usage-share', label: usage.windows.length > 1 ? `Share of 5-hour limits (${usage.windows.length} windows)` : 'Share of the 5-hour limit', value: approxPp(usage.pp) },
    // Only a measurable part: "It shared with other work" already says when there is none.
    ...(usage.alonePp > 0 ? [{ slot: 'manager-reply-usage-alone', label: 'While no other cezar work ran', value: approxPp(usage.alonePp), indent: true }] : []),
    ...(usage.turn ? [
      { slot: 'manager-reply-usage-requests', label: 'Model requests', value: String(usage.turn.requests) },
      { slot: 'manager-reply-usage-context', label: 'Peak context', value: `${Math.round(usage.turn.contextPeak / 1000)}k tokens` },
    ] : []),
  ]
  const trigger = (
    <button
      type="button"
      data-slot="manager-reply-usage"
      aria-label={`${label}: show what it cost`}
      className="mt-1 block rounded-sm text-left text-xs text-muted-foreground tabular-nums underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {label}
    </button>
  )
  return (
    <PlanUsageSurface slot="manager-reply-usage-details" trigger={trigger} tooltip={replyUsageDetail(usage)}>
      <PlanUsageTitle>What this reply cost</PlanUsageTitle>
      {usage.windows.map((window) => <p key={window} data-slot="plan-usage-window" className="text-meta text-muted-foreground">{window}</p>)}
      <p className="text-meta text-muted-foreground">It {sharedLabel(usage)}.</p>
      <PlanUsageRows rows={rows} />
    </PlanUsageSurface>
  )
}

export function useManagerPlanUsage(
  { managerId, provider, agentProfile }: { managerId: string; provider: PlanUsageProvider | null; agentProfile?: string | undefined },
  messages: readonly ManagerMessage[],
  now: number,
) {
  const enabled = provider !== null
  const entries = usePlanUsageConsumers(enabled).data?.entries
  const key = managerAccountKey(entries, managerId, provider ?? 'claude', agentProfile)
  const fiveHour = currentWindow(usePlanUsage({ kind: 'five-hour', account: key }, enabled).data?.windows, key)
  const week = currentWindow(usePlanUsage({ kind: 'weekly', account: key }, enabled).data?.windows, key)
  const started = useMemo(() => managerStartedTasks(messages), [messages])
  // `now` ticks every 30 s; the day boundary only needs that resolution.
  const usage = useMemo(() => managerPlanUsage(entries, managerId, started, key, new Date(now)), [entries, managerId, started, key, now])
  const account: AccountNow = { key, fiveHour, week, level: limitLevel(fiveHour) }
  const replies = useMemo(() => replyUsageById(entries, managerId), [entries, managerId])
  return { enabled, usage, account, replies }
}

const LEVEL_TEXT: Record<LimitLevel, string> = { ok: '', warning: 'text-warning', critical: 'text-destructive' }
const LEVEL_BAR: Record<LimitLevel, string> = { ok: 'bg-muted-foreground', warning: 'bg-warning', critical: 'bg-destructive' }

function Meter({ pct, level, className }: { pct: number; level: LimitLevel; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-block h-1 overflow-hidden rounded-full bg-muted', className)}>
      <span className={cn('block h-full', LEVEL_BAR[level])} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  )
}

function AccountLimit({ label, w, now, slot }: { label: string; w: PlanUsageWindow; now: number; slot: string }) {
  const level = limitLevel(w) ?? 'ok'
  const pct = w.usedPercent?.last ?? 0
  return (
    <div data-slot={slot} className="mt-1.5">
      <div className="flex items-baseline justify-between gap-3 tabular-nums">
        <span>{label}</span>
        <span className={LEVEL_TEXT[level]}>{level === 'critical' && w.limitReachedAt ? 'Limit reached' : `${exactPp(pct)} used`}</span>
      </div>
      <Meter pct={pct} level={level} className="my-1 h-1.5 w-full" />
      <p className="text-meta text-muted-foreground">
        resets {resetTime(w.resetsAt, w.kind)}{w.kind === 'five-hour' ? ` · in ${untilLabel(w.resetsAt, now)}` : ''}
      </p>
    </div>
  )
}

const PART_LABEL: Record<PlanUsageManagerPart, string> = { chat: 'Chat reply', watch: 'Watch check', job: 'Job' }

function watchLabel(turns: number, quiet: number): string {
  if (turns === 0) return 'Watch checks'
  if (quiet === turns) return `Watch checks (${turns}, nothing new found)`
  if (quiet > 0) return `Watch checks (${turns}, ${quiet} found nothing new)`
  return `Watch checks (${turns})`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function usageRows(u: ManagerPlanUsage): PlanUsageRow[] {
  const rows: PlanUsageRow[] = []
  const m = u.manager
  if (m) {
    rows.push({ slot: 'manager-usage-self', label: 'The manager itself', value: approxPp(m.estimatePp) })
    const parts = m.parts ?? { chat: 0, watch: 0, job: 0 }
    const turns = m.turns ?? { chat: 0, watch: 0, job: 0 }
    if (turns.chat > 0 || parts.chat > 0) rows.push({ slot: 'manager-usage-chat', label: `Chat (${plural(turns.chat, 'reply', 'replies')})`, value: approxPp(parts.chat), indent: true })
    if (turns.watch > 0 || parts.watch > 0) rows.push({ slot: 'manager-usage-watch', label: watchLabel(turns.watch, m.quietWatchTurns ?? 0), value: approxPp(parts.watch), indent: true })
    if (turns.job > 0 || parts.job > 0) rows.push({ slot: 'manager-usage-job', label: `Jobs (${turns.job})`, value: approxPp(parts.job), indent: true })
    if (m.aloneInferredPp > 0) rows.push({ slot: 'manager-usage-alone', label: 'While it was the only cezar work', value: approxPp(m.aloneInferredPp), indent: true })
    if (m.sharedEstimatePp > 0) rows.push({ slot: 'manager-usage-shared', label: `Its share while ${ranTogetherLabel(m)} ran`, value: approxPp(m.sharedEstimatePp), indent: true })
  }
  if (u.tasks.length > 0) {
    rows.push({ slot: 'manager-usage-tasks', label: `Tasks it started (${u.tasks.length})`, value: approxPp(u.tasksPp) })
    const shown = u.tasks.length > 3 ? u.tasks.slice(0, 2) : u.tasks
    shown.forEach((t, i) => rows.push({ slot: `manager-usage-task-${i}`, label: <span className="block truncate">{t.title}</span>, value: approxPp(t.pp), indent: true }))
    const rest = u.tasks.slice(shown.length)
    if (rest.length > 0) rows.push({ slot: 'manager-usage-task-rest', label: `${rest.length} more`, value: approxPp(rest.reduce((s, t) => s + t.pp, 0)), indent: true })
  }
  if (u.earlierTodayPp > 0) rows.push({ slot: 'manager-usage-earlier', label: 'Earlier 5-hour limits today', value: approxPp(u.earlierTodayPp) })
  return rows
}

function TurnLabel({ t }: { t: ManagerTurnUsage }) {
  const reasons = t.turn ? turnReasons(t.turn) : []
  const tokens = t.turn ? turnTokens(t.turn) : null
  return (
    <span className="block">
      <span className="block">{PART_LABEL[t.part]} · {clockTime(t.at)} · {t.alonePp >= t.pp ? 'ran alone' : t.alonePp > 0 ? 'partly shared' : 'shared'}</span>
      {t.turn ? (
        <span data-slot="manager-usage-turn-detail" className="block text-meta text-muted-foreground">
          {plural(t.turn.requests, 'request', 'requests')} · {Math.round(t.turn.contextPeak / 1000)}k context{reasons.length > 0 ? ` · ${reasons.join(', ')}` : ''}
        </span>
      ) : null}
      {tokens ? (
        <span data-slot="manager-usage-turn-tokens" className="block text-meta text-muted-foreground tabular-nums">{tokensLabel(tokens)}</span>
      ) : null}
    </span>
  )
}

function TurnShapeSection({ shape }: { shape: ManagerTurnShape }) {
  const { route, look, own, write } = shape.tools
  return (
    <section data-slot="manager-usage-shape" className="mt-2 border-t border-border pt-2">
      <p className="eyebrow text-muted-foreground">Turn shape</p>
      <p className="mt-1 tabular-nums">
        {Math.round(shape.avgContext / 1000)}k context · {shape.avgRequests.toFixed(1)} requests per turn ({plural(shape.turns, 'turn', 'turns')})
      </p>
      <p className="text-meta text-muted-foreground tabular-nums">
        Tool calls: {route} routing work to tasks, {look} looking up state, {own} its own work{write > 0 ? `, ${write} writing files` : ''}
      </p>
      {shape.tokens ? (
        <p data-slot="manager-usage-shape-tokens" className="text-meta text-muted-foreground tabular-nums">Tokens: {tokensLabel(shape.tokens)}</p>
      ) : null}
      {shape.couldBeTasks > 0 ? (
        <p data-slot="manager-usage-could-be-task" className="text-meta text-muted-foreground">
          {plural(shape.couldBeTasks, 'turn', 'turns')} did enough work that a task could have done it.
        </p>
      ) : null}
    </section>
  )
}

/** The popover / sheet body; the chip and the near-limit strip open the same one. */
function ManagerUsageDetails({ usage, account, provider, now }: { usage: ManagerPlanUsage | null; account: AccountNow; provider: PlanUsageProvider; now: number }) {
  const label = usage?.account.label ?? account.fiveHour?.account.label
  return (
    <>
      {account.fiveHour ? (
        <section data-slot="manager-usage-account" className="mb-2 border-b border-border pb-2">
          <p className="eyebrow text-muted-foreground">Account now · {label}</p>
          <AccountLimit slot="manager-usage-account-five" w={account.fiveHour} now={now} label={`5-hour limit ${clockTime(account.fiveHour.startsAt)}–${clockTime(account.fiveHour.resetsAt)}`} />
          {account.week ? <AccountLimit slot="manager-usage-account-week" w={account.week} now={now} label="Week" /> : null}
        </section>
      ) : null}
      <PlanUsageTitle>Plan limit used by this manager and its tasks</PlanUsageTitle>
      {usage ? (
        <>
          <p data-slot="plan-usage-window" className="text-meta text-muted-foreground">
            {usage.account.label} · 5-hour limit {clockTime(usage.startsAt)}–{clockTime(usage.resetsAt)}
          </p>
          <p data-slot="plan-usage-total" className="mt-2 tabular-nums">
            {approxPp(usage.totalPp)} of the 5-hour limit{usage.weekPp !== null ? ` · ${approxPp(usage.weekPp)} of the week` : ''}
          </p>
          <PlanUsageRows rows={usageRows(usage)} />
          {usage.otherAccountTasks > 0 ? (
            <p data-slot="manager-usage-other-accounts" className="mt-1 text-meta text-muted-foreground">
              {plural(usage.otherAccountTasks, 'task', 'tasks')} it started ran on another account, with its own limit.
            </p>
          ) : null}
          {usage.topTurns.length > 0 ? (
            <section data-slot="manager-usage-turns" className="mt-2 border-t border-border pt-2">
              <p className="eyebrow text-muted-foreground">Largest turns</p>
              <PlanUsageRows
                className="mt-1"
                rows={usage.topTurns.map((t, i) => ({
                  slot: `manager-usage-turn-${i}`,
                  label: <TurnLabel t={t} />,
                  value: approxPp(t.pp),
                }))}
              />
            </section>
          ) : null}
          {usage.shape ? <TurnShapeSection shape={usage.shape} /> : null}
        </>
      ) : (
        <p data-slot="manager-usage-none" className="mt-1 text-muted-foreground">Nothing measured for this manager today.</p>
      )}
      {usage && usage.tasks.length > 0 ? (
        <p className="mt-2 text-meta text-muted-foreground">Each task's share also shows on that task, and counts once on the Dashboard.</p>
      ) : null}
      <ApproximateNote provider={provider} splitBy="task and manager" />
      <PlanUsageLink to={planWindowHref(account.key, usage?.windowId ?? account.fiveHour?.id ?? 'current')}>
        See all tasks and managers on this account
      </PlanUsageLink>
    </>
  )
}

interface UsageProps {
  usage: ManagerPlanUsage | null
  account: AccountNow
  provider: PlanUsageProvider
  now: number
}

function Surface({ trigger, ...props }: UsageProps & { trigger: ReactElement }) {
  return (
    <PlanUsageSurface slot="manager-usage-popover" trigger={trigger}>
      <ManagerUsageDetails {...props} />
    </PlanUsageSurface>
  )
}

/** Header chip: the account's 5-hour use with a meter, and what this manager and its tasks spent of it. */
export function ManagerUsageChip(props: UsageProps) {
  const { usage, account } = props
  const five = account.fiveHour
  if (!usage && !five) return null
  const level = account.level ?? 'ok'
  const pct = five?.usedPercent?.last ?? 0
  const share = usage ? `manager + tasks ${approxPp(usage.totalPp)}` : ''
  const aria = [
    five ? `Plan limit: ${exactPp(pct)} of the 5-hour limit used, resets ${clockTime(five.resetsAt)}` : 'Plan limit',
    usage ? `this manager and its tasks ${approxPp(usage.totalPp)}` : '',
  ].filter(Boolean).join('; ')
  return (
    <Surface
      {...props}
      trigger={
        <button
          type="button"
          data-slot="manager-usage-chip"
          data-level={five ? level : undefined}
          aria-label={aria}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground tabular-nums outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-9',
            LEVEL_TEXT[level],
          )}
        >
          {five ? <Meter pct={pct} level={level} className="w-6 md:w-8" /> : <GaugeIcon aria-hidden="true" className="size-3" />}
          {five ? (
            <span>
              {exactPp(pct)}
              <span className="max-md:hidden"> of 5h{usage ? ` · ${share}` : ''}</span>
            </span>
          ) : (
            <span>
              <span className="max-md:hidden">Manager + tasks </span>
              {approxPp(usage!.totalPp)}
              <span className="max-md:hidden"> of 5h</span>
            </span>
          )}
        </button>
      }
    />
  )
}

/** Above the composer only near the limit (≥ 80 %), where the next turn is decided. */
export function ManagerLimitStrip(props: UsageProps) {
  const five = props.account.fiveHour
  const level = props.account.level
  if (!five || (level !== 'warning' && level !== 'critical')) return null
  const pct = five.usedPercent?.last ?? 0
  const week = props.account.week?.usedPercent?.last
  const reached = level === 'critical' && five.limitReachedAt !== undefined
  return (
    <Surface
      {...props}
      trigger={
        <button
          type="button"
          data-slot="manager-limit-strip"
          data-level={level}
          className={cn(
            'mb-1.5 flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-left text-xs tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-9',
            level === 'critical' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warning/40 bg-warning/10 text-warning',
          )}
        >
          <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {reached ? '5-hour limit reached' : `5-hour limit ${exactPp(pct)} used`} · resets {clockTime(five.resetsAt)}
            <span className="max-md:hidden"> (in {untilLabel(five.resetsAt, props.now)})</span>
            {week !== undefined ? ` · week ${exactPp(week)}` : ''}
          </span>
        </button>
      }
    />
  )
}
