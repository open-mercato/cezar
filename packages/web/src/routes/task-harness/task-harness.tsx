import {
  AlertTriangleIcon,
  ChevronDownIcon,
  CheckCircle2Icon,
  GitPullRequestArrowIcon,
  Layers3Icon,
  LoaderCircleIcon,
  SearchXIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '@/api/client'
import {
  useAcceptContestedHarness,
  useHarnessInvocation,
  useRun,
  useRunHarness,
} from '@/api/queries'
import { useRunEvents } from '@/api/run-events'
import type {
  ApiRun,
  HarnessCouncilRecord,
  HarnessFindingRecord,
  HarnessInvocationRecord,
  HarnessLedgerResponse,
  HarnessPacketRecord,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { RunHeader } from '../task-thread/run-header'
import { elapsed, SeverityTag, toneOf } from './harness-components'
import { HarnessRail } from './harness-rail'
import { HarnessStatusBar, HarnessTimelineDialog } from './harness-status-bar'
import { ReviewerModal } from './reviewer-modal'
import { RUN_RAIL_GRID, runShellClass } from '../task-thread/run-shell'
import {
  blockingReasonList,
  displayedCouncil,
  mergeHarnessLedger,
  shortModelName,
  orderStepsByLedger,
} from './harness-state'

function HarnessLoadState({
  pending,
  error,
}: {
  pending: boolean
  error?: Error | null
}) {
  const notFound = error instanceof ApiError && error.status === 404
  return (
    <div className="flex min-h-full flex-col">
      <CenteredState
        icon={
          pending ? <LoaderCircleIcon className="motion-safe:animate-spin" />
          : notFound ? <SearchXIcon />
          : <AlertTriangleIcon />
        }
        tone={error && !notFound ? 'danger' : 'neutral'}
        title={
          pending ? 'Loading harness state…'
          : notFound ? 'No harness ledger'
          : 'Could not load the harness'
        }
        subtitle={
          error?.message ??
          'Reading the durable run ledger. Long-running progress resumes from this state after a restart.'
        }
      />
    </div>
  )
}

function useHarnessRouteState() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const harness = useRunHarness(id, Boolean(run.data?.harness))
  const events = useRunEvents(id)
  const lastHarnessSeq = events.reduce(
    (max, event) => (event.type.startsWith('harness.') ? Math.max(max, event.seq) : max),
    0,
  )
  useEffect(() => {
    if (lastHarnessSeq > 0 && harness.isError) void harness.refetch()
  }, [lastHarnessSeq, harness.isError, harness.refetch])
  const ledger = useMemo(() => mergeHarnessLedger(harness.data, events), [harness.data, events])
  return { id, run, harness, ledger }
}

function HarnessPage({
  run,
  ledger,
  tab,
  children,
}: {
  run: ApiRun
  ledger: HarnessLedgerResponse
  tab: 'review' | 'packets'
  children: ReactNode
}) {
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [openReviewer, setOpenReviewer] = useState<string | null>(null)
  return (
    <OpenReviewerContext.Provider value={setOpenReviewer}>
    <div data-route={`task-harness-${tab}`} className="flex min-h-full flex-col">
      <RunHeader run={run} tab={tab} orderedSteps={orderStepsByLedger(run.steps, ledger)} />
      {/* Same shell width as the header (review 2026-07-27): these two used to
          cap at 1120px and 820px respectively, so at any viewport above 820px
          the header block and the content cards were visibly out of line. */}
      <div className="sticky top-0 z-10 border-b border-border bg-card px-4 md:px-6">
        <div className={runShellClass(true)}>
          <HarnessStatusBar
            ledger={ledger}
            timelineOpen={timelineOpen}
            onOpenTimeline={() => setTimelineOpen((open) => !open)}
          />
        </div>
      </div>
      <main
        className={cn('flex flex-1 flex-col gap-3 px-4 py-5 md:px-6', runShellClass(true))}
      >
        <div className={RUN_RAIL_GRID}>
          <div className="flex min-w-0 flex-col gap-3">{children}</div>
          <HarnessRail
            ledger={ledger}
            runId={run.id}
            onOpenTimeline={() => setTimelineOpen((open) => !open)}
            onOpenReviewer={setOpenReviewer}
          />
        </div>
      </main>
      <HarnessTimelineDialog ledger={ledger} open={timelineOpen} onOpenChange={setTimelineOpen} />
      <ReviewerModal
        runId={run.id}
        ledger={ledger}
        reviewerId={openReviewer}
        onClose={() => setOpenReviewer(null)}
      />
    </div>
    </OpenReviewerContext.Provider>
  )
}

/** One row per distinct finding, with the SET of reviewers that raised it.
 *
 *  The previous version seeded the map from `council.findings` — whose `by`
 *  already carries the reviewer id — and then appended `reviewer.id` again from
 *  the per-reviewer pass, producing `mimo-v2.5-free, mimo-v2.5-free` in the
 *  table (review 2026-07-27). Attribution is a Set now, so a reviewer can only
 *  appear once however many passes contribute the same finding. */
export interface MergedFinding extends HarnessFindingRecord {
  raisedBy: string[]
}

export function reviewerFindings(council: HarnessCouncilRecord): MergedFinding[] {
  const findings = new Map<string, MergedFinding>()
  const add = (finding: HarnessFindingRecord, reviewerId?: string) => {
    const key = `${finding.severity}:${finding.title}`
    const prior = findings.get(key)
    const raisedBy = new Set(prior?.raisedBy ?? [])
    for (const id of (finding.by ?? '').split(',')) {
      const trimmed = id.trim()
      if (trimmed) raisedBy.add(trimmed)
    }
    if (reviewerId) raisedBy.add(reviewerId)
    findings.set(key, { ...(prior ?? {}), ...finding, raisedBy: [...raisedBy] })
  }
  for (const finding of council.findings ?? []) add(finding)
  for (const reviewer of council.reviewers ?? []) {
    for (const finding of reviewer.findings ?? []) add(finding, reviewer.id)
  }
  return [...findings.values()]
}

const BLOCKING = new Set(['blocker', 'major'])

/** Findings that gate publishing, worst first. */
export function blockingFindings(findings: readonly MergedFinding[]): MergedFinding[] {
  return findings.filter((finding) => BLOCKING.has(finding.severity))
}

function CouncilProgress({ ledger }: { ledger: HarnessLedgerResponse }) {
  const council = displayedCouncil(ledger)
  const reviewers = council?.reviewers ?? []
  const completed = reviewers.filter((reviewer) => reviewer.status === 'completed').length
  const running = reviewers.filter((reviewer) => reviewer.status === 'running').length
  const verdict = council?.verdict
  const resilient =
    ledger.roles !== null &&
    typeof ledger.roles === 'object' &&
    !Array.isArray(ledger.roles) &&
    (ledger.roles as { reviewPolicy?: unknown }).reviewPolicy === 'quorum'
  return (
    <section className="rounded-xl border border-border bg-card shadow-xs">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <ShieldCheckIcon aria-hidden="true" className="size-4 text-soft-foreground" />
        <h2 className="text-sm font-semibold">Council review</h2>
        {council ? <Pill>Round {council.round}</Pill> : null}
        <span className="ml-auto text-xs text-soft-foreground tabular-nums">
          {reviewers.length > 0
            ? `${completed}/${reviewers.length} completed${running ? ` · ${running} running` : ''}`
            : 'waiting for reviewers'}
        </span>
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusDot
            tone={
              verdict === 'approve' ? 'success'
              : verdict === 'request_changes' ? 'danger'
              : running ? 'pending'
              : 'neutral'
            }
            pulse={running > 0}
          />
          <span className="font-medium text-foreground">
            {verdict === 'approve' ? 'Approved'
            : verdict === 'request_changes' ? 'Changes requested'
            : council ? 'Council in progress' : 'Council has not started'}
          </span>
          <span className="text-soft-foreground">
            {resilient
              ? 'The configured cross-family quorum may continue only when its explicit threshold survives.'
              : 'Every configured reviewer is required; a missing result cannot silently lower the bar.'}
          </span>
        </div>
      </div>
    </section>
  )
}

/**
 * The council table (review 2026-07-27, finding C3).
 *
 * This used to be "Reviewer status" over `ledger.models` — the ORCHESTRATOR
 * included — with a Status column that fell back from `reviewer.status` to
 * `model.readiness`, so one column mixed two state machines: the orchestrator
 * read `ready` (a probe result) beside reviewers reading `completed` (a run
 * result). Reviewers only now, with the verdict and findings that make the
 * council's claim checkable; orchestrator and implementer live in the run rail.
 */
const OpenReviewerContext = createContext<(id: string) => void>(() => undefined)

function CouncilTable({ ledger }: { ledger: HarnessLedgerResponse }) {
  const onOpenReviewer = useContext(OpenReviewerContext)
  const council = displayedCouncil(ledger)
  const reviewers = council?.reviewers ?? []
  if (reviewers.length === 0) return null
  const modelById = new Map(ledger.models.map((model) => [model.id, model]))
  const families = new Set(
    reviewers.map((reviewer) => modelById.get(reviewer.id)?.family).filter(Boolean),
  )
  return (
    <section
      data-slot="harness-council-table"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Council</h2>
        <span className="text-xs text-soft-foreground">
          {reviewers.length} {reviewers.length === 1 ? 'reviewer' : 'reviewers'} ·{' '}
          {families.size} {families.size === 1 ? 'family' : 'families'}
          {council ? ` · round ${council.round}` : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="bg-card-2 text-[10px] tracking-wide text-soft-foreground uppercase">
            <tr>
              <th className="px-4 py-2 font-semibold">Reviewer</th>
              <th className="px-3 py-2 font-semibold">Family</th>
              <th className="px-3 py-2 font-semibold">Verdict</th>
              <th className="px-3 py-2 font-semibold">Findings</th>
              <th className="px-4 py-2 text-right font-semibold">Duration</th>
            </tr>
          </thead>
          <tbody>
            {reviewers.map((reviewer) => {
              const model = modelById.get(reviewer.id)
              const findings = reviewer.findings ?? []
              const blocking = blockingFindings(
                findings.map((finding) => ({ ...finding, raisedBy: [reviewer.id] })),
              ).length
              return (
                <tr
                  key={reviewer.id}
                  onClick={() => onOpenReviewer(reviewer.id)}
                  className="cursor-pointer border-t border-border first:border-0 hover:bg-card-2"
                >
                  <td className="px-4 py-2.5">
                    <span className="block font-semibold text-foreground">
                      {model?.model || shortModelName(reviewer.id)}
                    </span>
                    <span className="block font-mono text-[10.5px] text-soft-foreground">
                      {model?.binding ?? reviewer.model ?? reviewer.id}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex h-[19px] items-center rounded-full bg-muted px-2 text-[10.5px] font-semibold text-muted-foreground">
                      {model?.family ?? 'unknown'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <StatusDot tone={toneOf(reviewer.status)} pulse={reviewer.status === 'running'} />
                      {reviewer.verdict?.replace('_', ' ') ?? reviewer.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {findings.length === 0 ? (
                      <span className="text-soft-foreground">none</span>
                    ) : (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                          blocking > 0 ? 'bg-danger/15 text-danger' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {blocking > 0 ? `${blocking} blocking` : `${findings.length} minor`}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-soft-foreground tabular-nums">
                    {model && model.totalDurationMs > 0 ? elapsed(model.totalDurationMs) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Findings as severity-grouped CARDS (review 2026-07-27, finding C6).
 *
 * The matrix this replaces put one column per reviewer headed by the full model
 * id: at three reviewers it already overflowed and clipped "Raised by", and at
 * five it was unusable. Agreement is the interesting signal, so it renders as
 * chips — filled for the reviewers that raised it, outlined for those that did
 * not — which costs one line regardless of council size.
 */
function FindingGroup({
  title,
  findings,
  note,
  reviewers,
}: {
  title: string
  findings: readonly MergedFinding[]
  note?: string
  reviewers: readonly string[]
}) {
  if (findings.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityTag severity={findings[0]!.severity} />
        <span className="text-[10.5px] font-semibold tracking-[0.06em] text-soft-foreground uppercase">
          {title}
        </span>
        {note ? <span className="text-[11.5px] text-soft-foreground">{note}</span> : null}
      </div>
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {findings.map((finding, index) => (
          <article
            key={`${finding.severity}:${finding.title}:${index}`}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-border px-4 py-3 last:border-0"
          >
            <SeverityTag severity={finding.severity} />
            <div className="min-w-0">
              <h3 className="text-[13.5px] leading-snug font-semibold">{finding.title}</h3>
              {finding.location ? (
                <p className="mt-0.5 font-mono text-[11px] break-all text-soft-foreground">
                  {finding.location}
                </p>
              ) : null}
              {finding.evidence ? (
                <p className="mt-1.5 max-w-[76ch] text-[12px] leading-relaxed text-muted-foreground">
                  {finding.evidence}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {reviewers.map((id) => {
                  const raised = finding.raisedBy.includes(id)
                  return (
                    <span
                      key={id}
                      className={cn(
                        'inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-semibold',
                        raised
                          ? BLOCKING.has(finding.severity)
                            ? 'border-danger/45 bg-danger/8 text-danger'
                            : 'border-border bg-muted text-muted-foreground'
                          : 'border-border text-soft-foreground',
                      )}
                    >
                      {raised ? '●' : '○'} {shortModelName(id)}
                    </span>
                  )
                })}
              </div>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}

function Findings({ ledger }: { ledger: HarnessLedgerResponse }) {
  const council = displayedCouncil(ledger)
  const findings = council ? reviewerFindings(council) : []
  const reviewers = (council?.reviewers ?? []).map((reviewer) => reviewer.id)
  const blocking = blockingFindings(findings)
  const rest = findings.filter((finding) => !BLOCKING.has(finding.severity))

  if (findings.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card px-4 py-6 text-center shadow-xs">
        <p className="text-xs text-soft-foreground">
          {council?.verdict === 'approve'
            ? 'No findings — the council approved this round.'
            : 'No reconciled findings yet.'}
        </p>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-slot="harness-findings">
      <FindingGroup
        title={`${blocking.length} blocking ${blocking.length === 1 ? 'finding' : 'findings'}`}
        findings={blocking}
        reviewers={reviewers}
      />
      <FindingGroup
        title={`${rest.length} non-blocking ${rest.length === 1 ? 'finding' : 'findings'}`}
        findings={rest}
        reviewers={reviewers}
      />
    </div>
  )
}

/**
 * The verdict banner (review 2026-07-27, finding C1).
 *
 * The Review tab used to LEAD with a round verdict — a green `approve` pill over
 * a matrix of four NIT/MINOR findings — while the five major findings that
 * actually gated publishing appeared only inside this box, as one
 * semicolon-joined run-on line. The screen said "approved" about a run that
 * could not be published. The run OUTCOME leads now; the round verdict is
 * subordinate to it, and the blocking reasons are a list.
 */
function OutcomeBanner({ runId, ledger }: { runId: string; ledger: HarnessLedgerResponse }) {
  const [reason, setReason] = useState('')
  const accept = useAcceptContestedHarness(runId)
  const { status } = ledger.outcome
  const accepted = Boolean(ledger.outcome.acceptedAt)

  if (status === 'ready') {
    return (
      <section
        data-slot="harness-outcome"
        className="flex items-start gap-2.5 rounded-xl border border-success/40 bg-success/5 px-4 py-3"
      >
        <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <div>
          <h2 className="text-sm font-semibold">Verified and ready to publish</h2>
          <p className="mt-0.5 max-w-[76ch] text-xs leading-relaxed text-muted-foreground">
            The council converged and the staged diff carries no unresolved blocking findings.
          </p>
        </div>
      </section>
    )
  }
  if (status === 'pending') return null

  const reasons = blockingReasonList(ledger)

  return (
    <section
      data-slot="harness-outcome"
      className="rounded-xl border border-danger/45 bg-danger/5 px-4 py-3.5"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold">
            {accepted
              ? 'Contested result accepted'
              : status === 'blocked'
                ? 'This run is blocked'
                : `Publishing is blocked — ${reasons.length} unresolved ${
                    reasons.length === 1 ? 'finding' : 'findings'
                  }`}
          </h2>
          <p className="mt-1 max-w-[76ch] text-[13px] leading-relaxed text-muted-foreground">
            {accepted
              ? `Accepted ${ledger.outcome.acceptedAt}: ${ledger.outcome.acceptanceReason}`
              : 'The staged work is preserved. Send the run back to resolve these, or record why publishing is safe anyway.'}
          </p>

          {!accepted ? (
            <ul className="mt-2.5 flex flex-col gap-1">
              {reasons.map((item) => (
                <li
                  key={item}
                  className="flex gap-2 text-[12.5px] leading-relaxed text-muted-foreground"
                >
                  <span aria-hidden="true" className="text-danger">
                    •
                  </span>
                  <span className="min-w-0">{item}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {!accepted ? (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault()
                accept.mutate(reason, {
                  onSuccess: () => {
                    setReason('')
                    toast('Contested harness result accepted. Publishing controls are now unlocked.')
                  },
                  onError: (error) => toast(error.message, { tone: 'danger' }),
                })
              }}
            >
              <textarea
                aria-label="Reason for accepting contested result"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain why publishing is safe despite the unresolved findings…"
                className="min-h-16 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-ring"
              />
              <Button
                type="submit"
                variant="outline"
                className="self-start"
                disabled={reason.trim().length < 3 || accept.isPending}
              >
                <GitPullRequestArrowIcon aria-hidden="true" />
                Accept risk
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function TaskHarnessReviewRoute() {
  const { id, run, harness, ledger } = useHarnessRouteState()
  if (run.isPending || (run.data?.harness && harness.isPending)) return <HarnessLoadState pending />
  if (run.isError || harness.isError || !run.data || !ledger) {
    return <HarnessLoadState pending={false} error={(run.error ?? harness.error) as Error | undefined} />
  }
  return (
    <HarnessPage run={run.data} ledger={ledger} tab="review">
      <OutcomeBanner runId={id ?? run.data.id} ledger={ledger} />
      <Findings ledger={ledger} />
      <CouncilProgress ledger={ledger} />
      <CouncilTable ledger={ledger} />
    </HarnessPage>
  )
}

function packetManifest(packet: HarnessPacketRecord): Record<string, unknown> {
  return packet.manifest && typeof packet.manifest === 'object' && !Array.isArray(packet.manifest)
    ? (packet.manifest as Record<string, unknown>)
    : {}
}

function packetPaths(packet: HarnessPacketRecord): string[] {
  const manifest = packetManifest(packet)
  const paths = packet.paths ?? manifest.allowedPaths
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
}

function packetTitle(packet: HarnessPacketRecord): string {
  const manifest = packetManifest(packet)
  return packet.title ?? (typeof manifest.title === 'string' ? manifest.title : packet.originalId ?? packet.id)
}

export function TaskHarnessPacketsRoute() {
  const { run, harness, ledger } = useHarnessRouteState()
  if (run.isPending || (run.data?.harness && harness.isPending)) return <HarnessLoadState pending />
  if (run.isError || harness.isError || !run.data || !ledger) {
    return <HarnessLoadState pending={false} error={(run.error ?? harness.error) as Error | undefined} />
  }
  const counts = ledger.packets.reduce(
    (result, packet) => {
      const state = packet.state ?? packet.status ?? 'planned'
      if (state === 'gated') result.gated += 1
      else if (state === 'blocked' || state === 'aborted') result.blocked += 1
      else result.active += 1
      return result
    },
    { gated: 0, active: 0, blocked: 0 },
  )
  const packetInvocations = ledger.invocations.filter((invocation) => invocation.id.startsWith('packet-'))
  return (
    <HarnessPage run={run.data} ledger={ledger} tab="packets">
      <section className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
        <Layers3Icon aria-hidden="true" className="size-4 text-soft-foreground" />
        <span className="text-sm font-semibold">{ledger.packets.length} packets</span>
        <span className="text-xs text-success">{counts.gated} gated</span>
        <span className="text-xs text-soft-foreground">{counts.active} active</span>
        <span className="text-xs text-danger">{counts.blocked} blocked</span>
        <span className="ml-auto text-xs text-soft-foreground tabular-nums">
          {packetInvocations.length} worker invocations
        </span>
      </section>

      {ledger.packets.length === 0 ? (
        <CenteredState
          icon={<Layers3Icon />}
          tone="neutral"
          heading="h2"
          title={ledger.effectiveProfile === 'high-assurance' ? 'Packet plan has not started' : 'This profile does not use packets'}
          subtitle={
            ledger.effectiveProfile === 'high-assurance'
              ? 'The conductor will publish bounded, file-disjoint packets here before implementation.'
              : 'Choose high assurance for leased paths, bounded replacement attempts, and per-packet evidence gates.'
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ledger.packets.map((packet) => {
            const state = packet.state ?? packet.status ?? 'planned'
            const manifest = packetManifest(packet)
            const risk = packet.risk ?? (typeof manifest.risk === 'string' ? manifest.risk : undefined)
            const paths = packetPaths(packet)
            return (
              <article
                key={packet.originalId ?? packet.id}
                className={cn(
                  'flex min-h-52 flex-col rounded-xl border bg-card shadow-xs',
                  state === 'blocked' || state === 'aborted' ? 'border-danger/60' : 'border-border',
                )}
              >
                <div className="flex items-start gap-2 border-b border-border px-4 py-3">
                  {state === 'gated'
                    ? <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                    : <StatusDot tone={toneOf(state)} pulse={['implementing', 'reviewing', 'fixing'].includes(state)} />}
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">{packetTitle(packet)}</h2>
                    <p className="mt-0.5 font-mono text-[10.5px] text-soft-foreground">
                      {packet.originalId ?? packet.id}
                      {packet.attempt && packet.attempt > 1 ? ` · recovery attempt ${packet.attempt}` : ''}
                    </p>
                  </div>
                  {risk ? <Pill>{risk}</Pill> : null}
                </div>
                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-2 px-4 py-3 text-xs">
                  <dt className="text-[10px] font-semibold tracking-wide text-soft-foreground uppercase">State</dt>
                  <dd className="font-semibold text-foreground">{state}</dd>
                  <dt className="text-[10px] font-semibold tracking-wide text-soft-foreground uppercase">Paths</dt>
                  <dd className="min-w-0 space-y-1">
                    {paths.map((path) => (
                      <code key={path} className="block truncate rounded bg-muted px-1.5 py-0.5 text-[10.5px]">{path}</code>
                    ))}
                  </dd>
                  {packet.error ? (
                    <>
                      <dt className="text-[10px] font-semibold tracking-wide text-danger uppercase">Recovery</dt>
                      <dd className="text-danger">{packet.error}</dd>
                    </>
                  ) : null}
                </dl>
                <div className="mt-auto border-t border-border px-4 py-2 text-[10.5px] text-soft-foreground">
                  {state === 'gated' ? 'Leases released · evidence bound to diff'
                  : state === 'blocked' || state === 'aborted' ? 'Lease held for explicit recovery'
                  : 'Bounded worker execution in progress'}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </HarnessPage>
  )
}
