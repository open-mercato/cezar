import { useEffect, useState } from 'react'

import { useHostHistory, useHostLastFrameAt, useHostTransport, useHostUsage } from '@/api/host-usage'
import { Link } from '@/lib/project-router'
import { effectiveHostView, formatCpuCores, formatMemPair } from '@/lib/host-effective'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

/**
 * The sidebar glance: two labelled meters - effective CPU and RAM, each a bar and a percentage -
 * on ONE line above the footer (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`,
 * Phase 2). The 60 s CPU sparkline lives on the Machine card the row links to; the sidebar trades
 * it for a RAM meter, because an unlabelled line beside an unlabelled number did not say which
 * resource was which, and memory pressure is the one that actually stops a machine.
 *
 * **Height is the budget this component is designed against.** It is the first row of a footer
 * that also carries the search hint and the chrome controls, and every pixel it takes comes out
 * of the task list above it. That is why it is one line and not two stacked meters: stacking a
 * RAM row under a CPU row cost as much vertical space as the old CPU-line-plus-sparkline it
 * replaced (~47px), which bought labels at no saving at all. One line of `leading-[14px]` inside
 * `py-1` is 24px - roughly half - and that halving is the point, not a side effect.
 *
 * What one line cannot hold at the 264px minimum sidebar is the DETAIL text: the RAM GB pair and
 * the effective-core count. Two labels, two bars, two percentages and a GB pair do not fit across
 * ~218px of content box without squeezing the bars to a few pixels, so the details moved into the
 * `title` tooltip and the accessible name, which is where a number you read occasionally - rather
 * than glance at - belongs. The bar and its colour carry the at-a-glance half.
 *
 * Two gates, and both are about not paying for what nobody sees:
 *
 * - **Below `md` the widget is UNMOUNTED, not hidden.** The sidebar column is `hidden md:flex`, so
 *   a CSS-hidden row would still mount its hooks - and a mounted reader is exactly what would keep
 *   waking a component for a sampler the phone cannot see. The gate sits in this wrapper, before
 *   the hook-bearing row below it, because that row consumes the store.
 * - **Remote is unmounted too**: a hosted cockpit reads the route pair from the Settings card, and
 *   a session-long remote widget would be an unbounded fetch loop with a sidebar-width readout as
 *   its only payoff.
 *
 * The staleness clock is a RE-ARMED timeout at `lastFrameAt + 10 s`, never an interval: every new
 * frame clears and re-arms it, and unmount clears it. 10 s is deliberately five sampler ticks - a
 * single dropped frame is not staleness, five in a row is.
 */

/** Five server ticks: one dropped frame is a hiccup, five is a stopped sampler. */
export const HOST_WIDGET_STALE_MS = 10_000

/** Meter thresholds: past `WARN` the bar turns amber, past `CRITICAL` red. */
export const HOST_METER_WARN_PCT = 80
export const HOST_METER_CRITICAL_PCT = 90

type MeterLevel = 'ok' | 'warn' | 'critical'

const clampPct = (value: number): number => Math.min(100, Math.max(0, value))

const meterLevel = (pct: number | undefined): MeterLevel =>
  pct === undefined || pct < HOST_METER_WARN_PCT
    ? 'ok'
    : pct < HOST_METER_CRITICAL_PCT
      ? 'warn'
      : 'critical'

export function HostUsageWidget() {
  const desktop = useIsDesktop()
  const transport = useHostTransport()
  if (!desktop || transport !== 'local') return null
  return <HostUsageWidgetRow />
}

function HostUsageWidgetRow() {
  const sample = useHostUsage()
  const history = useHostHistory()
  const lastFrameAt = useHostLastFrameAt()
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (lastFrameAt === undefined) {
      setStale(false)
      return
    }
    const remaining = lastFrameAt + HOST_WIDGET_STALE_MS - Date.now()
    if (remaining <= 0) {
      setStale(true)
      return
    }
    setStale(false)
    const timer = setTimeout(() => setStale(true), remaining)
    return () => clearTimeout(timer)
  }, [lastFrameAt])

  const view = sample === undefined ? undefined : effectiveHostView(sample)
  const cpuPct = view?.cpuPct
  const cpuText = stale
    ? 'stale'
    : view !== undefined && view.cpuLimited && cpuPct === undefined
      ? '—'
      : cpuPct === undefined
        ? history.length === 0
          ? 'sampling…'
          : '—'
        : `${Math.round(cpuPct)}%`
  const memPct =
    view === undefined || view.memUsedBytes === undefined || view.memTotalBytes <= 0
      ? undefined
      : (view.memUsedBytes / view.memTotalBytes) * 100
  const memPctText = stale ? 'stale' : memPct === undefined ? '—' : `${Math.round(memPct)}%`
  const memText = view === undefined ? '—' : formatMemPair(view.memUsedBytes, view.memTotalBytes)
  const cpuCores =
    view?.cpuLimited === true
      ? `${view.cpuLimitKind === 'cpuset' ? 'cpuset ' : ''}${formatCpuCores(view.cpuCores)}`
      : undefined
  // ONE string behind both the tooltip and the accessible name: it is the only home the GB pair
  // and the effective-core count have now, and a hovering user and a screen-reader user must not
  // get different readings of the same row. Comma-separated rather than `·`-separated for the
  // same reason - a middle dot is announced as "middle dot" by readers that do not drop it.
  const summary =`CPU ${cpuText}${cpuCores === undefined ? '' : ` of ${cpuCores}`}, RAM ${memPctText} (${memText})`

  return (
    <Link
      to="/settings/resources"
      data-slot="host-usage-widget"
      data-state={stale ? 'stale' : 'live'}
      // How many frames the store holds - the e2e proof that the root writer keeps feeding it.
      data-frames={history.length}
      aria-label={`Machine usage: ${summary}. Open Settings, Resources.`}
      title={summary}
      className={cn(
        // Six columns on ONE 14px line: label · bar · value, twice. The two `minmax(0,1fr)`
        // tracks are the bars, so they split whatever the fixed text leaves over and stay equal
        // to each other however wide `sampling…` renders. `leading-[14px]` is load-bearing: the
        // default `normal` line box for 11px text is ~13px, and pinning it keeps the row's height
        // a property of this file rather than of the font the browser happened to pick.
        'grid grid-cols-[auto_minmax(0,1fr)_auto_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-md border border-border px-2 py-1 text-[11px] leading-[14px] text-soft-foreground transition-colors hover:bg-muted hover:text-foreground',
        stale ? 'opacity-70' : null,
      )}
    >
      <Meter
        label="CPU"
        pct={stale ? undefined : cpuPct}
        valueSlot="host-usage-widget-cpu"
        value={cpuText}
      />
      <Meter
        label="RAM"
        pct={stale ? undefined : memPct}
        valueSlot="host-usage-widget-mem-pct"
        value={memPctText}
        gutter
      />
    </Link>
  )
}

interface MeterProps {
  label: string
  pct: number | undefined
  valueSlot: string
  value: string
  /** Extra space before the label, so the second meter reads as its own thing and not as a
   *  continuation of the first one's percentage. Only the trailing meter sets it. */
  gutter?: boolean
}

/**
 * Three of the row's six columns: label, bar, percentage. A fragment rather than a wrapper,
 * because the bar has to be a grid track of the row itself - nested in a flex box it could only
 * size against its own content, and the two bars would stop matching each other.
 */
function Meter({ label, pct, valueSlot, value, gutter }: MeterProps) {
  const level = meterLevel(pct)
  return (
    <>
      <span
        className={cn(
          'font-medium tracking-wide text-muted-foreground',
          gutter === true ? 'ml-1' : null,
        )}
      >
        {label}
      </span>
      <span
        data-slot={`host-usage-widget-${label.toLowerCase()}-bar`}
        data-level={level}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === undefined ? undefined : Math.round(clampPct(pct))}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-500',
            level === 'critical' ? 'bg-destructive' : level === 'warn' ? 'bg-pending' : 'bg-primary',
          )}
          style={{ width: `${pct === undefined ? 0 : clampPct(pct)}%` }}
        />
      </span>
      <span
        data-slot={valueSlot}
        className={cn(
          'text-right font-medium tabular-nums',
          level === 'critical'
            ? 'text-destructive'
            : level === 'warn'
              ? 'text-pending-strong'
              : 'text-foreground',
        )}
      >
        {value}
      </span>
    </>
  )
}
