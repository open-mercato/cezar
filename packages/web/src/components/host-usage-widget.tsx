import { useEffect, useState } from 'react'

import {
  HOST_HISTORY_LENGTH,
  useHostHistory,
  useHostLastFrameAt,
  useHostTransport,
  useHostUsage,
} from '@/api/host-usage'
import { Link } from '@/lib/project-router'
import { effectiveHostView, formatCpuCores, formatMemPair } from '@/lib/host-effective'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

/**
 * The sidebar glance: effective CPU, its 60 s sparkline and compact RAM, one row above the footer
 * (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, Phase 2).
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

const SPARK_WIDTH = 100
const SPARK_HEIGHT = 24
/** A hand-drawn line needs two points; one sample is a dot nobody can read. */
const MIN_SPARK_POINTS = 2

const clampPct = (value: number): number => Math.min(100, Math.max(0, value))

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
  const memText = view === undefined ? '—' : formatMemPair(view.memUsedBytes, view.memTotalBytes)
  const points =
    history.length >= MIN_SPARK_POINTS
      ? history
          .map((point, index) => {
            // The SAME 30-point axis the card draws on, so both sparklines describe the same 60 s
            // of the same series - a short ring plots on the left, exactly as it does up there.
            const x = (index / (HOST_HISTORY_LENGTH - 1)) * SPARK_WIDTH
            const y = SPARK_HEIGHT - (clampPct(point.cpuPct) / 100) * SPARK_HEIGHT
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
      : undefined

  return (
    <Link
      to="/settings/resources"
      data-slot="host-usage-widget"
      data-state={stale ? 'stale' : 'live'}
      aria-label={`Machine usage: CPU ${cpuText}, memory ${memText}. Open Settings, Resources.`}
      className={cn(
        'flex flex-col gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-soft-foreground transition-colors hover:bg-muted hover:text-foreground',
        stale ? 'opacity-70' : null,
      )}
    >
      <span className="flex items-center gap-1.5">
        <span data-slot="host-usage-widget-cpu" className="font-medium tabular-nums text-foreground">
          {cpuText}
        </span>
        {view?.cpuLimited === true ? (
          <span data-slot="host-usage-widget-cores" className="tabular-nums">
            {view.cpuLimitKind === 'cpuset' ? 'cpuset ' : ''}
            {formatCpuCores(view.cpuCores)}
          </span>
        ) : null}
        <span data-slot="host-usage-widget-mem" className="ml-auto tabular-nums">
          {memText}
        </span>
      </span>
      {points === undefined ? null : (
        <svg
          data-slot="host-usage-widget-sparkline"
          className="h-4 w-full text-primary"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`CPU over the last ${history.length * 2} seconds`}
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </Link>
  )
}
