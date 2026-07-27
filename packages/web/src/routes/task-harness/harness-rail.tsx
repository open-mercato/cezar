import { BotIcon, ShieldCheckIcon, WaypointsIcon } from 'lucide-react'

import type { HarnessLedgerResponse } from '@open-mercato/cezar-api-client'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { cn } from '@/lib/utils'

import { elapsed, phaseLabel, toneOf } from './harness-components'
import { activeHarnessPhase, blockingReasonList, currentImplementationCouncil } from './harness-state'

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
export function HarnessRail({ ledger }: { ledger: HarnessLedgerResponse }) {
  if (ledger.phases.length === 0 && ledger.models.length === 0) return null
  return (
    <aside
      data-slot="harness-rail"
      aria-label="Run state"
      className="sticky top-3 hidden max-h-[calc(100dvh-2rem)] flex-col gap-3 self-start overflow-y-auto xl:flex"
    >
      <PhaseSection ledger={ledger} />
      <CouncilSection ledger={ledger} />
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

/** The last few phases, newest last — the shape of a timeline without the
 *  2620px of history the old horizontal rail insisted on showing at once. */
function PhaseSection({ ledger }: { ledger: HarnessLedgerResponse }) {
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
      <ol className="flex flex-col">
        {shown.map((phase) => (
          <li
            key={phase.id}
            className={cn(
              'flex items-center gap-2 py-1 text-[12.5px]',
              phase === active ? 'font-semibold text-foreground' : 'text-muted-foreground',
            )}
          >
            <StatusDot tone={toneOf(phase.status)} pulse={phase.status === 'running'} />
            <span className="min-w-0 flex-1 truncate">{phaseLabel(phase)}</span>
            {phase.attempts > 1 ? (
              <span
                title={`${phase.attempts} attempts`}
                className="shrink-0 rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground tabular-nums"
              >
                {phase.attempts}×
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </Section>
  )
}

function CouncilSection({ ledger }: { ledger: HarnessLedgerResponse }) {
  const council = currentImplementationCouncil(ledger) ??
    [...ledger.councils].sort((a, b) => b.round - a.round)[0]
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
          return (
            <li
              key={reviewer.id}
              className="flex items-center gap-2 border-b border-border py-1.5 text-[12.5px] last:border-0"
            >
              <StatusDot tone={toneOf(reviewer.status)} pulse={reviewer.status === 'running'} />
              <span className="min-w-0 flex-1">
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
