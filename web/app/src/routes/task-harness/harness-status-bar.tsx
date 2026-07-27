import { ChevronRightIcon, ListTreeIcon } from 'lucide-react'

import type { HarnessLedgerResponse, HarnessPhaseRecord } from '@/api/types'
import { StatusDot } from '@/components/status-dot'
import { cn } from '@/lib/utils'

import { activeHarnessPhase, currentImplementationCouncil } from './harness-state'
import { elapsed, phaseLabel, toneOf } from './harness-components'

/**
 * ONE status line for a harness run (review 2026-07-27, findings A3 + A5).
 *
 * It replaces four competing progress affordances that all said versions of the
 * same thing: the header's `Plan 4/4` mirror, the `Workflow steps complete ·
 * 18 of 18` strip, the horizontal phase rail, and the Plan dock. The rail in
 * particular could not be read at all — 18 phases at 2620px of content inside an
 * 820px viewport, no wrap, no auto-scroll, so the phase you care about (the last
 * one) was always off-screen.
 *
 * What survives is what you actually want at a glance while a three-hour run is
 * in flight: which phase is live, how far through, whether the council is
 * converging. The history moves behind `Timeline` (the run timeline sheet).
 */
export function HarnessStatusBar({
  ledger,
  onOpenTimeline,
  timelineOpen = false,
}: {
  ledger: HarnessLedgerResponse
  onOpenTimeline?: () => void
  timelineOpen?: boolean
}) {
  const phases = ledger.phases
  if (phases.length === 0) return null

  const active = activeHarnessPhase(ledger)
  const current: HarnessPhaseRecord | undefined = active ?? phases[phases.length - 1]
  const done = phases.filter((phase) => phase.status === 'done').length
  const council = currentImplementationCouncil(ledger)
  const reviewers = council?.reviewers ?? []
  const completed = reviewers.filter((reviewer) => reviewer.status === 'completed').length
  const running = reviewers.filter((reviewer) => reviewer.status === 'running').length
  const blocked = ledger.outcome.status === 'contested' || ledger.outcome.status === 'blocked'

  return (
    <div
      data-slot="harness-status-bar"
      className="flex min-w-0 items-center gap-2.5 py-2 text-[12.5px]"
    >
      <StatusDot
        tone={blocked ? 'danger' : toneOf(current?.status)}
        pulse={current?.status === 'running'}
      />
      <span className="shrink-0 font-semibold text-foreground">
        {current ? phaseLabel(current) : 'Starting'}
      </span>
      <span className="shrink-0 text-soft-foreground tabular-nums">
        · phase {Math.min(done + (active ? 1 : 0), phases.length)} of {phases.length}
      </span>

      <span
        aria-hidden="true"
        className="hidden h-[3px] min-w-[60px] max-w-[240px] flex-1 overflow-hidden rounded-full bg-muted sm:block"
      >
        <i
          className="block h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.round((done / phases.length) * 100)}%` }}
        />
      </span>

      {council ? (
        <span className="min-w-0 truncate text-muted-foreground max-sm:hidden">
          council round {council.round} ·{' '}
          <span className="tabular-nums">
            {completed}/{reviewers.length || '—'}
          </span>{' '}
          {running > 0 ? 'reviewing' : council.verdict === 'approve' ? 'approved' : 'returned'}
        </span>
      ) : null}

      {onOpenTimeline ? (
        <button
          type="button"
          data-slot="harness-timeline-toggle"
          aria-expanded={timelineOpen}
          onClick={onOpenTimeline}
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
            timelineOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <ListTreeIcon aria-hidden="true" className="size-3.5" />
          Timeline
          <ChevronRightIcon
            aria-hidden="true"
            className={cn('size-3 transition-transform', timelineOpen && 'rotate-90')}
          />
        </button>
      ) : null}
    </div>
  )
}

/** Wall time for one phase. The ledger records timestamps, not a duration —
 *  a phase still running measures to now, so a live run's total keeps moving. */
function phaseDurationMs(phase: HarnessPhaseRecord): number {
  if (!phase.startedAt) return 0
  const started = Date.parse(phase.startedAt)
  if (Number.isNaN(started)) return 0
  const ended = phase.endedAt ? Date.parse(phase.endedAt) : Date.now()
  return Number.isNaN(ended) ? 0 : Math.max(0, ended - started)
}

/** Phases grouped into the four stages a harness run actually moves through, so
 *  eighteen rows read as four things. Order follows first appearance, so an
 *  unknown/new phase id lands in the stage it ran in rather than vanishing. */
const STAGE_OF: ReadonlyArray<[RegExp, string]> = [
  [/^(preflight|capture|qualify|diagnose)/i, 'Preparation'],
  [/spec/i, 'Specification'],
  [/^(implement|validate|fix|packet)/i, 'Implementation'],
  [/(review|council)/i, 'Review'],
  [/^stage/i, 'Handoff'],
]

function stageOf(phase: HarnessPhaseRecord): string {
  const id = `${phase.id} ${phase.name ?? ''}`
  for (const [pattern, stage] of STAGE_OF) if (pattern.test(id)) return stage
  return 'Other'
}

/**
 * The run timeline (mockup 04): the vertical, grouped replacement for the
 * horizontal rail. Retries and durations are first-class here because they are
 * where a long run's time and money actually went, and the old rail showed
 * neither.
 */
export function HarnessTimeline({ ledger }: { ledger: HarnessLedgerResponse }) {
  const phases = ledger.phases
  if (phases.length === 0) return null

  const groups: Array<{ stage: string; phases: HarnessPhaseRecord[] }> = []
  for (const phase of phases) {
    const stage = stageOf(phase)
    const last = groups[groups.length - 1]
    if (last && last.stage === stage) last.phases.push(phase)
    else groups.push({ stage, phases: [phase] })
  }

  const totalMs = phases.reduce((sum, phase) => sum + phaseDurationMs(phase), 0)
  const retries = phases.reduce((sum, phase) => sum + Math.max(0, (phase.attempts ?? 1) - 1), 0)

  return (
    <section
      data-slot="harness-timeline"
      aria-label="Run timeline"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-xs"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">Run timeline</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {phases.length} phases
          {retries > 0 ? ` · ${retries} ${retries === 1 ? 'retry' : 'retries'}` : ''}
          {totalMs > 0 ? ` · ${elapsed(totalMs)}` : ''}
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3">
        {groups.map((group, index) => (
          <div key={`${group.stage}-${index}`}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[10px] font-semibold tracking-[0.07em] text-soft-foreground uppercase">
                {group.stage}
              </span>
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-soft-foreground tabular-nums">
                {group.phases.length} {group.phases.length === 1 ? 'phase' : 'phases'}
              </span>
            </div>
            <ol className="flex flex-col gap-1">
              {group.phases.map((phase) => (
                <li
                  key={phase.id}
                  className={cn(
                    'grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs',
                    phase.status === 'running'
                      ? 'border-pending/50 bg-pending/5'
                      : phase.status === 'failed'
                        ? 'border-danger/40 bg-danger/5'
                        : 'border-border bg-card-2',
                  )}
                >
                  <StatusDot tone={toneOf(phase.status)} pulse={phase.status === 'running'} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {phaseLabel(phase)}
                    </span>
                    {phase.error ? (
                      <span className="block truncate text-[11px] text-danger">{phase.error}</span>
                    ) : null}
                  </span>
                  <span className="text-right text-[11px] tabular-nums">
                    {(phase.attempts ?? 1) > 1 ? (
                      <span
                        title={`${phase.attempts} attempts`}
                        className="rounded bg-muted px-1 font-semibold text-muted-foreground"
                      >
                        {phase.attempts}×
                      </span>
                    ) : null}
                  </span>
                  <span className="w-14 text-right text-[11px] text-soft-foreground tabular-nums">
                    {phaseDurationMs(phase) > 0 ? elapsed(phaseDurationMs(phase)) : '—'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  )
}
