import {
  formatPlanPp,
  type PlanUsageConsumer,
  type PlanUsageProvider,
  type PlanUsageWindow,
  type PlanUsageWindowKind,
} from '@open-mercato/cezar-api-client'
import { approxPp, clockTime, exactPp, resetTime } from '@/lib/plan-usage'

/** URL search params of the details panel, so other pages can link to it (spec 2026-11-19-plan-usage). */
export const PLAN_PARAMS = { account: 'planAccount', window: 'planWindow', kind: 'planKind' } as const
export const PLAN_KINDS = ['five-hour', 'weekly'] as const

export const PROVIDER_NAME: Record<PlanUsageProvider, string> = { claude: 'Claude', codex: 'Codex' }

export type SegmentId = 'tasks' | 'managers' | 'internal' | 'unsplit' | 'untracked' | 'before' | 'outside' | 'left'
export interface Segment {
  id: SegmentId
  label: string
  pp: number
  /** Share of the bar's width, 0–100. */
  width: number
}

export const SEGMENT_FILL: Record<SegmentId, string> = {
  tasks: 'bg-violet',
  managers: 'bg-info',
  internal: 'bg-success',
  unsplit: 'bg-warning',
  untracked: 'bg-[repeating-linear-gradient(45deg,var(--color-warning)_0_2px,transparent_2px_5px)] opacity-70',
  // Unknown, not outside: striped so it never reads as anyone's share.
  before: 'bg-[repeating-linear-gradient(135deg,var(--color-soft-foreground)_0_2px,transparent_2px_5px)] opacity-60',
  outside: 'bg-soft-foreground/60',
  left: 'bg-muted',
}

const sum = (list: PlanUsageConsumer[], kind: PlanUsageConsumer['kind']) =>
  list.filter((c) => c.kind === kind).reduce((n, c) => n + Math.max(0, c.estimatePp), 0)

export function lastUsed(w: PlanUsageWindow): number | null {
  return w.usedPercent ? w.usedPercent.last : null
}

/** The stacked bar: who filled the limit, then what is left. Widths never exceed 100%. */
export function windowSegments(w: PlanUsageWindow): Segment[] {
  const used = lastUsed(w) ?? 0
  const raw: Omit<Segment, 'width'>[] = [
    { id: 'tasks', label: 'Tasks', pp: sum(w.consumers, 'task') },
    { id: 'managers', label: 'Managers', pp: sum(w.consumers, 'manager') },
    { id: 'internal', label: 'cezar internal', pp: sum(w.consumers, 'internal') },
    { id: 'unsplit', label: "Couldn't split", pp: Math.max(0, w.unsplitPp) },
    // Moved while cezar was not recording: the provider total, charged to nobody.
    { id: 'untracked', label: 'Not tracked', pp: Math.max(0, w.untrackedPp) },
    // Used before cezar's first reading: unknown who, so never folded into "Outside cezar".
    { id: 'before', label: 'Before tracking', pp: Math.max(0, w.beforeTrackingPp) },
    { id: 'outside', label: 'Outside cezar', pp: Math.max(0, w.outsideCezarPp) },
  ]
  // A provider correction lowered the total after these parts were counted: draw them to the
  // reading (QA F5), never past it.
  const parts = raw.reduce((n, s) => n + s.pp, 0)
  const fit = parts > used && parts > 0 ? used / parts : 1
  const all = [...raw.map((s) => ({ ...s, pp: s.pp * fit })), { id: 'left' as const, label: 'Left', pp: Math.max(0, w.leftPp ?? 100 - used) }]
  const total = all.reduce((n, s) => n + s.pp, 0)
  const scale = total > 100 ? 100 / total : 1
  return all.filter((s) => s.pp > 0).map((s) => ({ ...s, width: s.pp * scale }))
}

export function isLimitReached(w: PlanUsageWindow): boolean {
  return !!w.limitReachedAt && (lastUsed(w) ?? 0) >= 100
}

/** `Claude · default` header status: `63% used · resets 16:40` or `limit reached · back at 15:00`. */
export function windowStatus(w: PlanUsageWindow): string {
  const used = lastUsed(w)
  if (isLimitReached(w)) return `limit reached · back at ${resetTime(w.resetsAt, w.kind)}`
  if (used === null) return `no reading yet · resets ${resetTime(w.resetsAt, w.kind)}`
  return `${exactPp(used)} used · resets ${resetTime(w.resetsAt, w.kind)}`
}

export function byShare(list: PlanUsageConsumer[]): PlanUsageConsumer[] {
  return [...list].sort((a, b) => b.estimatePp - a.estimatePp || a.title.localeCompare(b.title))
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** `4 tasks · 1 manager · top: Retry temp-repo removal ≈ 25%, Release manager ≈ 5%`. */
export function topConsumersLine(w: PlanUsageWindow, limit = 3): string | null {
  if (w.consumers.length === 0) return null
  const tasks = w.consumers.filter((c) => c.kind === 'task').length
  const managers = w.consumers.filter((c) => c.kind === 'manager').length
  const internal = w.consumers.some((c) => c.kind === 'internal')
  const counts = [tasks ? plural(tasks, 'task') : '', managers ? plural(managers, 'manager') : '', internal ? 'cezar internal' : ''].filter(Boolean)
  const top = byShare(w.consumers).slice(0, limit).map((c) => `${c.title} ${approxPp(c.estimatePp)}`)
  return `${counts.join(' · ')} · top: ${top.join(', ')}`
}

function dayWord(iso: string, now: Date): string {
  const d = new Date(iso)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return 'today'
  if (diff === 1) return 'yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** `5h · 10:00–15:00 today` / `week · Nov 12 – Nov 19`: every estimate names its window. */
export function windowRange(w: Pick<PlanUsageWindow, 'kind' | 'startsAt' | 'resetsAt'>, now = new Date()): string {
  if (w.kind === 'weekly') {
    const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `week · ${date(w.startsAt)} – ${date(w.resetsAt)}`
  }
  return `5h · ${clockTime(w.startsAt)}–${clockTime(w.resetsAt)} ${dayWord(w.startsAt, now)}`
}

export interface WindowChoice { value: string; label: string }

/** Picker: current/previous of both kinds, then older windows of the shown kind, newest first. */
export function windowChoices(kind: PlanUsageWindowKind, older: PlanUsageWindow[], shownId?: string, now = new Date()): WindowChoice[] {
  const fixed: WindowChoice[] = [
    { value: 'five-hour:current', label: 'Current 5 hours' },
    { value: 'five-hour:previous', label: 'Previous 5 hours' },
    { value: 'weekly:current', label: 'This week' },
    { value: 'weekly:previous', label: 'Previous week' },
  ]
  const sorted = older
    .filter((w) => w.kind === kind && !w.current)
    .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))
  // The newest non-current window is "Previous": listing it again by date would be a duplicate.
  const rest = sorted.slice(1).map((w) => ({ value: w.id, label: windowRange(w, now) }))
  const out = [...fixed, ...rest]
  if (shownId && !out.some((c) => c.value === shownId)) out.push({ value: shownId, label: 'Selected window' })
  return out
}

export interface ChartGeometry {
  path: string
  points: { x: number; y: number; at: string; usedPercent: number }[]
  limit: { x: number; at: string } | null
  ticks: { x: number; label: string }[]
}

/** A step chart of the provider's readings across the window, 0–100% (viewBox 0 0 width height). */
export function chartGeometry(w: PlanUsageWindow, width: number, height: number, now = Date.now()): ChartGeometry {
  const start = Date.parse(w.startsAt)
  const end = Date.parse(w.resetsAt)
  const span = Math.max(1, end - start)
  const x = (t: number) => Math.min(width, Math.max(0, ((t - start) / span) * width))
  const y = (pct: number) => height - (Math.min(100, Math.max(0, pct)) / 100) * height
  const readings = [...w.readings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const points = readings.map((r) => ({ x: x(Date.parse(r.at)), y: y(r.usedPercent), at: r.at, usedPercent: r.usedPercent }))
  let path = ''
  if (points.length) {
    path = `M${fix(points[0]!.x)},${fix(points[0]!.y)}`
    for (const p of points.slice(1)) path += ` H${fix(p.x)} V${fix(p.y)}`
    // Hold the last reading until now (live window) or the reset.
    path += ` H${fix(x(w.current ? Math.min(now, end) : end))}`
  }
  const tickCount = w.kind === 'weekly' ? 7 : 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const t = start + (span * i) / tickCount
    const label = w.kind === 'weekly'
      ? new Date(t).toLocaleDateString(undefined, { weekday: 'short' })
      : clockTime(new Date(t).toISOString())
    return { x: fix((width * i) / tickCount), label }
  })
  return { path, points, limit: w.limitReachedAt ? { x: fix(x(Date.parse(w.limitReachedAt))), at: w.limitReachedAt } : null, ticks }
}
const fix = (n: number) => Math.round(n * 10) / 10

/** `3 tasks, manager` — who it shared slices with; `—` when nobody. */
export function ranTogether(c: PlanUsageConsumer): string {
  const { tasks, managers, internal } = c.ranTogetherWith
  const parts = [
    tasks ? plural(tasks, 'task') : '',
    managers === 1 ? 'manager' : managers > 1 ? plural(managers, 'manager') : '',
    internal ? 'cezar internal' : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : '—'
}

/** `chat ≈ 4% · watch ≈ 0.6% · job ≈ 0.4%`: only the parts a manager actually used. */
export function managerParts(c: PlanUsageConsumer): string | null {
  if (!c.parts) return null
  const parts = (['chat', 'watch', 'job'] as const).filter((p) => c.parts![p] > 0)
  return parts.length ? parts.map((p) => `${p} ${approxPp(c.parts![p])}`).join(' · ') : null
}

/** `tracking was off 20:00–20:10`: why a slice is charged to nobody, with its time. */
export function gapReasons(w: PlanUsageWindow): string {
  if (w.trackingGaps.length === 0) return 'nothing was recorded'
  return w.trackingGaps.map((g) => `${g.reason === 'tracking-off' ? 'tracking was off' : 'nothing recorded until cezar started recording'} ${clockTime(g.from)}–${g.to ? clockTime(g.to) : 'now'}`).join('; ')
}

export interface RemainderRow { id: string; label: string; value: string }

/** Account-level rows under the consumers: plain numbers, shown only when above zero. */
export function remainderRows(w: PlanUsageWindow): RemainderRow[] {
  const rows: RemainderRow[] = []
  if (w.unsplitPp > 0) rows.push({ id: 'unsplit', label: "Couldn't be split", value: exactPp(w.unsplitPp) })
  if (w.outsideCezarPp > 0) rows.push({ id: 'outside', label: 'Outside cezar', value: exactPp(w.outsideCezarPp) })
  if (w.untrackedPp > 0) rows.push({ id: 'untracked', label: `Not tracked · ${gapReasons(w)}`, value: exactPp(w.untrackedPp) })
  if (w.beforeTrackingPp > 0) rows.push({ id: 'before', label: "Before cezar's first reading", value: exactPp(w.beforeTrackingPp) })
  if (w.correctionPp > 0) rows.push({ id: 'correction', label: 'Provider correction', value: `−${formatPlanPp(w.correctionPp)}%` })
  return rows
}

/** Parse `planWindow`/`planKind` into the query the panel asks for. */
export function panelQuery(windowParam: string | null, kindParam: string | null): { kind?: PlanUsageWindowKind; window: string } {
  const kind = (PLAN_KINDS as readonly string[]).includes(kindParam ?? '') ? (kindParam as PlanUsageWindowKind) : 'five-hour'
  const window = windowParam || 'current'
  // A window id names its own kind; filtering by another would hide it.
  return window === 'current' || window === 'previous' ? { kind, window } : { window }
}
