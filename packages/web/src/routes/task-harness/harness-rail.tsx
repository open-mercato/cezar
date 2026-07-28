import { BotIcon, ShieldCheckIcon, WaypointsIcon } from 'lucide-react'

import type { HarnessLedgerResponse, HarnessPhaseRecord } from '@open-mercato/cezar-api-client'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { cn } from '@/lib/utils'

import { elapsed, phaseLabel, toneOf } from './harness-components'
import { activeHarnessPhase, blockingReasonList, displayedCouncil } from './harness-state'

/**
 * The run rail (review 2026-07-27, findings A2 + B1).
 *
 * Council state used to live on the Review tab alone, so learning whether round
 * three approved meant leaving the tab you were watching the run in. Claude
 * Desktop never makes you leave the conversation to see the artifact; it opens
 * beside it. This is that: phase, council and models beside the transcript, on
 * every harness surface.
 *
 * It folds away under `xl` — below that the reading measure is worth more than
 * the companion column, and the Review tab still holds everything.
 */
export function HarnessRail({
  ledger,
  onOpenTimeline,
  onOpenReviewer,
}: {
  ledger: HarnessLedgerResponse
  /** Opens the full run timeline — the rail shows only the tail. */
  onOpenTimeline?: () => void
  /** Opens the reviewer drill-down. Reading what a reviewer was actually asked
   *  used to mean leaving for the Review tab and scrolling past the findings to
   *  the council table, even though the same reviewers are listed right here. */
  onOpenReviewer?: (id: string) => void
}) {
  if (ledger.phases.length === 0 && ledger.models.length === 0) return null
  return (
    <aside
      data-slot="harness-rail"
      aria-label="Run state"
      className="sticky hidden flex-col gap-3 self-start overflow-y-auto xl:flex top-[calc(var(--run-header-h,0px)+0.75rem)] max-h-[calc(100dvh-var(--run-header-h,0px)-1.5rem)] [scrollbar-width:thin]"
    >
      <PhaseSection ledger={ledger} onOpenTimeline={onOpenTimeline} />
      <CouncilSection ledger={ledger} onOpenReviewer={onOpenReviewer} />
      <ModelsSection ledger={ledger} />
    </aside>
  )
}

function Section({
  icon,
  title,
  aside,
  children,
}: {
  icon: React.ReactNode
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-3 shadow-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-soft-foreground">{icon}</span>
        <span className="flex-1 text-[10.5px] font-semibold tracking-[0.06em] text-soft-foreground uppercase">
          {title}
        </span>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Wall time for one phase; a live phase measures to now. */
function phaseDurationMs(phase: HarnessPhaseRecord): number {
  if (!phase.startedAt) return 0
  const started = Date.parse(phase.startedAt)
  if (Number.isNaN(started)) return 0
  const ended = phase.endedAt ? Date.parse(phase.endedAt) : Date.now()
  return Number.isNaN(ended) ? 0 : Math.max(0, ended - started)
}

/** The last few phases, newest last — the shape of a timeline without the
 *  2620px of history the old horizontal rail insisted on showing at once. */
function PhaseSection({
  ledger,
  onOpenTimeline,
}: {
  ledger: HarnessLedgerResponse
  onOpenTimeline?: () => void
}) {
  const phases = ledger.phases
  if (phases.length === 0) return null
  const active = activeHarnessPhase(ledger)
  const activeIndex = active ? phases.indexOf(active) : phases.length - 1
  const end = Math.min(phases.length, Math.max(activeIndex + 1, 5))
  const shown = phases.slice(Math.max(0, end - 5), end)
  const done = phases.filter((phase) => phase.status === 'done').length

  return (
    <Section
      icon={<WaypointsIcon aria-hidden="true" className="size-3.5" />}
      title="Phase"
      aside={
        <span className="text-[11px] text-soft-foreground tabular-nums">
          {done} / {phases.length}
        </span>
      }
    >
      {/* The connector line is the point of the shape (mockup 01): without it
          this is a list of unrelated rows, with it you can see a run moving
          through its phases. It is drawn behind the dots, clipped at the first
          and last row, and each dot punches a hole in it with a card-coloured
          ring so the line never appears to pass through a status. */}
      <ol className="flex flex-col">
        {shown.map((phase, index) => (
          <li
            key={phase.id}
            className={cn(
              'grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 py-1 text-[12.5px]',
              phase === active ? 'font-semibold text-foreground' : 'text-muted-foreground',
            )}
          >
            <span className="relative flex justify-center">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute w-px bg-border',
                  index === 0 ? 'top-1/2' : '-top-3.5',
                  index === shown.length - 1 ? 'bottom-1/2' : '-bottom-3.5',
                )}
              />
              <StatusDot
                tone={toneOf(phase.status)}
                pulse={phase.status === 'running'}
                className="relative z-[1] shadow-[0_0_0_3px_var(--card)]"
              />
            </span>
            <span className="min-w-0 truncate">
              {phaseLabel(phase)}
              {phase.attempts > 1 ? (
                <span
                  title={`${phase.attempts} attempts`}
                  className="ml-1 font-normal text-soft-foreground tabular-nums"
                >
                  {phase.attempts}×
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-[11px] font-normal text-soft-foreground tabular-nums">
              {phaseDurationMs(phase) > 0 ? elapsed(phaseDurationMs(phase)) : ''}
            </span>
          </li>
        ))}
      </ol>
      {onOpenTimeline ? (
        <button
          type="button"
          data-slot="harness-rail-timeline"
          onClick={onOpenTimeline}
          className="mt-2.5 inline-flex h-[22px] items-center rounded-full border border-border px-2.5 text-[11.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Full timeline · {phases.length} phases
        </button>
      ) : null}
    </Section>
  )
}

function CouncilSection({
  ledger,
  onOpenReviewer,
}: {
  ledger: HarnessLedgerResponse
  onOpenReviewer?: (id: string) => void
}) {
  // The same resolver the drawer uses: a row here must name a reviewer the
  // drawer can find, or clicking it would silently do nothing.
  const council = displayedCouncil(ledger)
  if (!council) return null
  const reviewers = council.reviewers ?? []
  const blocked = ledger.outcome.status === 'contested' || ledger.outcome.status === 'blocked'

  return (
    <Section
      icon={<ShieldCheckIcon aria-hidden="true" className="size-3.5" />}
      title="Council"
      aside={
        <Pill dot={council.verdict === 'approve' ? 'success' : council.verdict ? 'danger' : 'neutral'}>
          round {council.round}
        </Pill>
      }
    >
      <ul className="flex flex-col">
        {reviewers.map((reviewer) => {
          const findings = reviewer.findings ?? []
          const blocking = findings.filter(
            (finding) => finding.severity === 'blocker' || finding.severity === 'major',
          ).length
          const body = (
            <>
              <StatusDot tone={toneOf(reviewer.status)} pulse={reviewer.status === 'running'} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium text-foreground">
                  {reviewerName(reviewer.id)}
                </span>
                <span className="block truncate text-[10.5px] text-soft-foreground">
                  {reviewerFamilyOf(ledger, reviewer.id) ?? reviewer.status}
                </span>
              </span>
              {findings.length > 0 ? (
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    blocking > 0 ? 'bg-danger/15 text-danger' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {blocking > 0 ? `${blocking} major` : `${findings.length} minor`}
                </span>
              ) : null}
            </>
          )
          return (
            <li key={reviewer.id} className="border-b border-border last:border-0">
              {onOpenReviewer ? (
                <button
                  type="button"
                  data-slot="harness-rail-reviewer"
                  onClick={() => onOpenReviewer(reviewer.id)}
                  title={`Open ${reviewerName(reviewer.id)} — prompt, response and findings`}
                  className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-1.5 text-[12.5px] hover:bg-muted"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-2 py-1.5 text-[12.5px]">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {blocked ? (
        <p className="mt-2 rounded-md border-l-2 border-danger bg-danger/5 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-danger">Publishing blocked.</span>{' '}
          {blockingReasonList(ledger).length} unresolved — open Review to accept or send back.
        </p>
      ) : null}
    </Section>
  )
}

function ModelsSection({ ledger }: { ledger: HarnessLedgerResponse }) {
  if (ledger.models.length === 0) return null
  const working = ledger.invocations.filter((invocation) => invocation.status === 'running').length
  const roles = [...new Set(ledger.models.flatMap((model) => model.roles))]
  return (
    <Section
      icon={<BotIcon aria-hidden="true" className="size-3.5" />}
      title="Models"
      aside={
        <span className="text-[11px] text-soft-foreground">
          {working} working · {Math.max(0, ledger.models.length - working)} idle
        </span>
      }
    >
      <ul className="flex flex-col">
        {ledger.models.map((model) => (
          <li
            key={model.id}
            className="flex items-start gap-2 border-b border-border py-1.5 text-[12.5px] last:border-0"
          >
            <StatusDot tone={toneOf(model.readiness)} />
            {/* Two lines, never a truncated identifier (finding B2): the dock
                used to render `claude/claude-haiku-4…` and `opencode/opencode/…`,
                cutting off exactly the part that says which model it is. */}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">
                {model.model || modelName(model.id)}
              </span>
              <span className="block font-mono text-[10px] leading-tight break-all text-soft-foreground">
                {model.binding ?? model.family ?? model.id}
              </span>
            </span>
            <span className="shrink-0 text-right text-[10.5px] text-soft-foreground tabular-nums">
              {model.invocations > 0 ? `${model.invocations} · ${elapsed(model.totalDurationMs)}` : '—'}
            </span>
          </li>
        ))}
      </ul>
      {/* The roles present in this run (mockup 01). The per-row identity is the
          model; this says what the roster is FOR without repeating a tag on
          every line. */}
      {roles.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {roles.map((role) => (
            <span
              key={role}
              className="rounded-[5px] bg-muted px-1.5 py-px text-[9px] font-bold tracking-[0.04em] text-muted-foreground uppercase"
            >
              {role}
            </span>
          ))}
        </div>
      ) : null}
    </Section>
  )
}

/** `runner/model` — show the model, which is the part that identifies it. */
function modelName(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(slash + 1) : id
}

function reviewerName(id: string): string {
  return modelName(id)
}

function reviewerFamilyOf(ledger: HarnessLedgerResponse, id: string): string | undefined {
  return ledger.models.find((model) => model.id === id)?.family
}
