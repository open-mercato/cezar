import { useEffect, useState } from 'react'

import { useHostHistory, useHostLastFrameAt, useHostTransport, useHostUsage } from '@/api/host-usage'
import { Link } from '@/lib/project-router'
import { effectiveHostView, formatCpuCores, formatMemPair } from '@/lib/host-effective'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

/**
 * The sidebar glance: two labelled meter rows - effective CPU and RAM, each a bar, a percentage
 * and a detail - above the footer (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`,
 * Phase 2). The 60 s CPU sparkline lives on the Machine card the row links to; the sidebar trades
 * it for a RAM meter, because an unlabelled line beside an unlabelled number did not say which
 * resource was which, and memory pressure is the one that actually stops a machine.
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

  return (
    <Link
      to="/settings/resources"
      data-slot="host-usage-widget"
      data-state={stale ? 'stale' : 'live'}
      // How many frames the store holds - the e2e proof that the root writer keeps feeding it.
      data-frames={history.length}
      aria-label={`Machine usage: CPU ${cpuText}${cpuCores === undefined ? '' : ` of ${cpuCores}`}, RAM ${memPctText} (${memText}). Open Settings, Resources.`}
      title={`CPU ${cpuText}${cpuCores === undefined ? '' : ` of ${cpuCores}`} · RAM ${memText}`}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-soft-foreground transition-colors hover:bg-muted hover:text-foreground',
        stale ? 'opacity-70' : null,
      )}
    >
      <Meter
        label="CPU"
        pct={stale ? undefined : cpuPct}
        valueSlot="host-usage-widget-cpu"
        value={cpuText}
        detailSlot="host-usage-widget-cores"
        detail={cpuCores}
      />
      <Meter
        label="RAM"
        pct={stale ? undefined : memPct}
        valueSlot="host-usage-widget-mem-pct"
        value={memPctText}
        detailSlot="host-usage-widget-mem"
        detail={memText}
      />
    </Link>
  )
}

interface MeterProps {
  label: string
  pct: number | undefined
  valueSlot: string
  value: string
  detailSlot: string
  detail: string | undefined
}

/** One grid row: label, bar, percentage, detail - the four columns line up across both rows. */
function Meter({ label, pct, valueSlot, value, detailSlot, detail }: MeterProps) {
  const level = meterLevel(pct)
  return (
    <>
      <span className="font-medium tracking-wide text-muted-foreground">{label}</span>
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
      <span data-slot={detailSlot} className="text-right tabular-nums">
        {detail ?? ''}
      </span>
    </>
  )
}
