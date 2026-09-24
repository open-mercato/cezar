import {
  useHostHistory,
  useHostLastFrameAt,
  useHostTransport,
  useHostUsage,
  useHostUsageRoute,
  useHostUsageSubscription,
} from '@/api/host-usage'
import { StatusDot } from '@/components/status-dot'
import { effectiveHostView, formatCpuCores } from '@/lib/host-effective'
import { formatMem } from '@/lib/tasks-table'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

/**
 * The Machine card - live host totals, and the effective capacity of THIS process's cgroup when it
 * has one (spec `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`).
 *
 * Its writers are viewport-scoped on purpose: below `md` this card is the only local reader, so its
 * own subscription (gated `enabled: !useIsDesktop()`) is the server sampler's 0→1 / 1→0, exactly as
 * in v1; on desktop the root subscription owns the topic for the session and the widget reads the
 * same store. A remote cockpit never opens a socket - `useHostUsageRoute()` reads
 * `GET /api/v1/workspace/host-usage` and folds each answer (with its one warm-up read) into the
 * store, and the header says `last known`.
 *
 * The 60 s sparkline and the receipt stamp now live in the per-app store rather than in component
 * state, so the sidebar widget and this card draw the same line and the same age. Values are read
 * through `effectiveHostView`, the one place that decides which number is effective: a limit whose
 * value is missing shows `—`, never the host figure.
 *
 * One more muted line reads the dispatch governor's snapshot off the same sample (spec
 * `.ai/specs/2026-09-20-adaptive-admission-governor.md`): the ceiling the admission gate enforces
 * right now, shown only while a `dispatchMaxConcurrent` ceiling is configured. The card reports it;
 * the semaphore decides it.
 */

/** How many points the sparkline plots; the store keeps exactly this ring. */
const HISTORY_LENGTH = 30
const SPARK_WIDTH = 100
const SPARK_HEIGHT = 32
/** Where the CPU bar changes colour: quiet below 60 %, amber to 85 %, red above. */
const CPU_WARN_PCT = 60
const CPU_DANGER_PCT = 85

const clampPct = (value: number): number => Math.min(100, Math.max(0, value))

export function MachineCard() {
  useHostUsageSubscription({ enabled: !useIsDesktop() })
  const transport = useHostTransport()
  const { isError } = useHostUsageRoute()
  const sample = useHostUsage()
  const history = useHostHistory()
  const lastFrameAt = useHostLastFrameAt()

  const view = sample === undefined ? undefined : effectiveHostView(sample)
  const cpuPct = view?.cpuPct
  const local = transport === 'local'
  const ageSeconds =
    lastFrameAt === undefined
      ? undefined
      : Math.max(0, Math.round((Date.now() - lastFrameAt) / 1000))
  const memTotal = view?.memTotalBytes ?? 0
  const usedPct =
    view?.memUsedBytes !== undefined && memTotal > 0
      ? clampPct((view.memUsedBytes / memTotal) * 100)
      : 0
  const cpuFill =
    cpuPct === undefined
      ? undefined
      : cpuPct > CPU_DANGER_PCT
        ? 'bg-danger'
        : cpuPct >= CPU_WARN_PCT
          ? 'bg-pending'
          : 'bg-primary'
  const cpuFillPct = cpuPct === undefined ? undefined : clampPct(cpuPct)
  const points =
    history.length >= 2
      ? history
          .map((point, index) => {
            const x = (index / (HISTORY_LENGTH - 1)) * SPARK_WIDTH
            const y = SPARK_HEIGHT - (clampPct(point.cpuPct) / 100) * SPARK_HEIGHT
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
      : undefined

  // A CPU limit without its own percentage shows `—`; without a limit the v1 `sampling…` applies.
  const cpuValueText =
    view === undefined || !view.cpuLimited
      ? cpuPct === undefined
        ? 'sampling…'
        : `${Math.round(cpuPct)}%`
      : cpuPct === undefined
        ? '—'
        : `${Math.round(cpuPct)}%`
  const cpuCoresText =
    view === undefined || !view.cpuLimited
      ? undefined
      : `${view.cpuLimitKind === 'cpuset' ? 'cpuset ' : ''}${formatCpuCores(view.cpuCores)}`
  const memValueText =
    view === undefined
      ? undefined
      : `${view.memUsedBytes === undefined ? '—' : formatMem(view.memUsedBytes)} / ${formatMem(view.memTotalBytes)}`
  // Same rule as every other row here: a snapshot without the pair has nothing to show, so the
  // line stays away rather than printing blanks.
  const admission = sample?.admission
  const admissionText =
    admission?.configured === undefined || admission.effective === undefined
      ? undefined
      : `Dispatch admission: ${admission.state} · ${admission.effective} of ${admission.configured}`

  return (
    <section
      data-slot="machine-card"
      aria-labelledby="machine-card-title"
      className="rounded-xl border border-border bg-card/60 p-4"
    >
      <header className="flex min-w-0 items-center gap-2">
        <StatusDot tone={local ? 'success' : 'neutral'} pulse={local} />
        <h2 id="machine-card-title" className="text-sm font-semibold">
          Machine
        </h2>
        <span data-slot="machine-card-mode" className="text-[11px] text-soft-foreground">
          {local ? 'live' : 'last known'}
        </span>
        <span
          data-slot="machine-card-freshness"
          className="ml-auto shrink-0 text-[11px] tabular-nums text-soft-foreground"
        >
          {ageSeconds === undefined ? 'waiting…' : `updated ${ageSeconds} s ago`}
        </span>
      </header>

      {view?.hasContainer === true ? (
        <p data-slot="machine-card-limits" className="mt-2 text-[11.5px] text-soft-foreground">
          cgroup limits detected · {view.source}
        </p>
      ) : null}

      {admissionText === undefined ? null : (
        <p data-slot="machine-card-admission" className="mt-2 text-[11.5px] text-soft-foreground">
          {admissionText}
        </p>
      )}

      {isError && sample === undefined ? (
        <p data-slot="machine-card-error" className="mt-3 text-[12.5px] text-soft-foreground">
          Host totals are unavailable right now.
        </p>
      ) : null}

      <div className="mt-3 grid gap-3">
        <div data-slot="machine-card-cpu" className="grid grid-cols-[86px_1fr] items-start gap-3">
          <span className="pt-0.5 text-[12.5px] text-soft-foreground">
            CPU{view?.cpuIsEffective === true ? ' (effective)' : ''}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span
                data-slot="machine-card-cpu-value"
                className="w-32 shrink-0 text-[13px] tabular-nums"
              >
                {cpuCoresText === undefined ? cpuValueText : `${cpuCoresText} · ${cpuValueText}`}
              </span>
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                {cpuFill === undefined || cpuFillPct === undefined ? null : (
                  <div
                    data-slot="machine-card-cpu-bar"
                    className={cn('h-full rounded-full', cpuFill)}
                    style={{ width: `${cpuFillPct}%` }}
                  />
                )}
              </div>
            </div>
            {points === undefined ? null : (
              <svg
                data-slot="machine-card-cpu-sparkline"
                className="mt-1.5 h-8 w-full text-primary"
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
          </div>
        </div>

        {view === undefined ? null : (
          <>
            <div
              data-slot="machine-card-memory"
              className="grid grid-cols-[86px_1fr] items-center gap-3"
            >
              <span className="text-[12.5px] text-soft-foreground">
                Memory{view.memIsEffective ? ' (effective)' : ''}
              </span>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  data-slot="machine-card-memory-value"
                  className="w-32 shrink-0 text-[13px] tabular-nums"
                >
                  {memValueText}
                </span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${usedPct}%` }} />
                </div>
              </div>
            </div>

            {sample?.swapTotalBytes === undefined ? null : (
              <div
                data-slot="machine-card-swap"
                className="grid grid-cols-[86px_1fr] items-center gap-3"
              >
                <span className="text-[12.5px] text-soft-foreground">Swap</span>
                <span className="text-[13px] tabular-nums">
                  {formatMem(sample.swapUsedBytes)} / {formatMem(sample.swapTotalBytes)}
                </span>
              </div>
            )}

            {sample?.loadAvg === undefined ? null : (
              <div
                data-slot="machine-card-load"
                className="grid grid-cols-[86px_1fr] items-center gap-3"
              >
                <span className="text-[12.5px] text-soft-foreground">Load average</span>
                <span className="flex items-center gap-2 text-[13px] tabular-nums">
                  {sample.loadAvg.one.toFixed(2)} · {sample.loadAvg.five.toFixed(2)} ·{' '}
                  {sample.loadAvg.fifteen.toFixed(2)}
                  {/* One rule: host load pairs with the host core count, so with a container it
                      pairs with `hostCpuCount`, and without one it is exactly v1's `cpuCount`. */}
                  <span
                    data-slot="machine-card-load-cores"
                    className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-soft-foreground"
                  >
                    {view.hasContainer && view.hostCpuCount !== undefined
                      ? `host ${view.hostCpuCount} cores`
                      : `${sample.cpuCount} cores`}
                  </span>
                </span>
              </div>
            )}

            {view.hasContainer && view.hostCpuCount !== undefined ? (
              <p
                data-slot="machine-card-host-context"
                className="text-[11.5px] tabular-nums text-soft-foreground"
              >
                host {formatCpuCores(view.hostCpuCount)} · {formatMem(sample?.memTotalBytes ?? 0)} RAM
              </p>
            ) : null}
          </>
        )}
      </div>

      <p
        data-slot="machine-card-caveat"
        className="mt-3 border-t border-border pt-2 text-[11px] text-soft-foreground"
      >
        {view?.hasContainer === true
          ? 'Effective values come from this process\u2019s own cgroup; host totals are labelled.'
          : 'Host totals - no cgroup limit detected for this process.'}
      </p>
    </section>
  )
}
