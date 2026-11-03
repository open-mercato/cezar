import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  GitPullRequestArrowIcon,
  LoaderCircleIcon,
  SearchXIcon,
} from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '@/api/client'
import {
  useHarnessFeedbackRefresh,
  useRun,
  useRunHarness,
} from '@/api/queries'
import { useAcceptContestedHarness } from '@/api/harness'
import { useRunEvents } from '@/api/run-events'
import type {
  ApiRun,
  HarnessCouncilRecord,
  HarnessFindingRecord,
  HarnessLedgerResponse,
  RunEvent,
} from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { RunHeader } from '../task-thread/run-header'
import { elapsed, SeverityTag, toneOf } from './harness-components'
import { CouncilDecisionCard, HarnessRail } from './harness-rail'
import { HarnessStatusBar, HarnessTimelineDialog } from './harness-status-bar'
import { ReviewerModal } from './reviewer-modal'
import { RUN_RAIL_CONTAINER, RUN_RAIL_GRID, runShellClass } from '../task-thread/run-shell'
import {
  blockingReasonList,
  displayedCouncil,
  harnessRailHasContent,
  mergeHarnessLedger,
  shortModelName,
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

const isHarnessEvent = (event: RunEvent): boolean => event.type.startsWith('harness.')

function useHarnessRouteState() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const harnessRun = Boolean(run.data?.harness)
  const harness = useRunHarness(id, harnessRun)
  // Stream from the durable snapshot and keep harness frames only: this page never shows the
  // transcript, and replaying it from seq 0 held every token delta for nothing (review round 2).
  // `mergeHarnessLedger` skips anything at or below snapshotSeq, so the cut loses no state; a
  // ledger that errored (not written yet) streams from 0 so its first event can trigger the refetch.
  const events = useRunEvents(harnessRun && !harness.isPending ? id : undefined, {
    afterSeq: harness.data?.snapshotSeq ?? 0,
    keep: isHarnessEvent,
  })
  useHarnessFeedbackRefresh(id, harnessRun, events, harness.data?.snapshotSeq)
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
  tab: 'review'
  children: ReactNode
}) {
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [openReviewer, setOpenReviewer] = useState<string | null>(null)
  return (
    <OpenReviewerContext.Provider value={setOpenReviewer}>
    <div data-route={`task-harness-${tab}`} className={cn('flex min-h-full flex-col', RUN_RAIL_CONTAINER)}>
      <RunHeader run={run} tab={tab} hideWorkflowProgress />
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
      <div
        className={cn('flex flex-1 flex-col gap-3 px-4 py-5 md:px-6', runShellClass(true))}
      >
        {harnessRailHasContent(ledger) ? (
          <div data-slot="run-rail-grid" className={RUN_RAIL_GRID}>
            <div className="flex min-w-0 flex-col gap-3">{children}</div>
            <HarnessRail
              ledger={ledger}
              runId={run.id}
              onOpenTimeline={() => setTimelineOpen((open) => !open)}
              onOpenReviewer={setOpenReviewer}
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">{children}</div>
        )}
      </div>
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
          <thead className="eyebrow bg-card-2 text-soft-foreground">
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
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenReviewer(reviewer.id)
                      }}
                      className="block rounded-sm text-left font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {model?.model || shortModelName(reviewer.id)}
                    </button>
                    <span className="block font-mono text-micro text-soft-foreground">
                      {model?.binding ?? reviewer.model ?? reviewer.id}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex h-[19px] items-center rounded-full bg-muted px-2 text-micro font-semibold text-muted-foreground">
                      {model?.family ?? 'unknown'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <StatusDot
                        tone={reviewer.verdict === 'request_changes' ? 'danger' : toneOf(reviewer.status)}
                        pulse={reviewer.status === 'running'}
                      />
                      {reviewer.verdict?.replace('_', ' ') ?? reviewer.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {findings.length === 0 ? (
                      <span className="text-soft-foreground">none</span>
                    ) : (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-micro font-semibold uppercase',
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
        <span className="text-micro font-semibold tracking-[0.06em] text-soft-foreground uppercase">
          {title}
        </span>
        {note ? <span className="text-meta text-soft-foreground">{note}</span> : null}
      </div>
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {findings.map((finding, index) => (
          <article
            key={`${finding.severity}:${finding.title}:${index}`}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-border px-4 py-3 last:border-0"
          >
            <SeverityTag severity={finding.severity} />
            <div className="min-w-0">
              <h3 className="text-ui leading-snug font-semibold">{finding.title}</h3>
              {finding.location ? (
                <p className="mt-0.5 font-mono text-meta break-all text-soft-foreground">
                  {finding.location}
                </p>
              ) : null}
              {finding.evidence ? (
                <p className="mt-1.5 max-w-[76ch] text-label leading-relaxed text-muted-foreground">
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
                        'inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-micro font-semibold',
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
  const specPaused = ledger.outcome.pendingDecision?.kind === 'spec'

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
          <h2 className="text-lead font-bold">
            {accepted
              ? 'Contested result accepted'
              : status === 'blocked'
                ? 'This run is blocked'
                : specPaused
                  ? 'Implementation paused — specification risk needs a decision'
                : `Publishing is blocked — ${reasons.length} unresolved ${
                    reasons.length === 1 ? 'finding' : 'findings'
                  }`}
          </h2>
          <p className="mt-1 max-w-[76ch] text-ui leading-relaxed text-muted-foreground">
            {accepted
              ? `Accepted ${ledger.outcome.acceptedAt}: ${ledger.outcome.acceptanceReason}`
              : specPaused
                ? 'No implementation has started. Accepting records the decision and resumes the same hash-bound run.'
                : status === 'contested'
                  ? 'The staged work is preserved. Send the run back to resolve these, or record why publishing is safe anyway.'
                  : 'The staged work is preserved. Resolve these and continue the run.'}
          </p>

          {!accepted ? (
            <ul className="mt-2.5 flex flex-col gap-1">
              {reasons.map((item) => (
                <li
                  key={item}
                  className="flex gap-2 text-label leading-relaxed text-muted-foreground"
                >
                  <span aria-hidden="true" className="text-danger">
                    •
                  </span>
                  <span className="min-w-0">{item}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* Only a contested outcome can be accepted; the server refuses every other. */}
          {!accepted && status === 'contested' ? (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault()
                accept.mutate(reason, {
                  onSuccess: (result) => {
                    setReason('')
                    toast(
                      result.resumed
                        ? 'Specification risk accepted. The implementation run resumed.'
                        : 'Contested harness result accepted. Publishing controls are now unlocked.',
                    )
                  },
                  onError: (error) => toast(error.message, { tone: 'danger' }),
                })
              }}
            >
              <textarea
                aria-label="Reason for accepting contested result"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  specPaused
                    ? 'Explain why implementation may proceed despite the unresolved specification risk…'
                    : 'Explain why publishing is safe despite the unresolved findings…'
                }
                className="min-h-16 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-ring"
              />
              <Button
                type="submit"
                variant="outline"
                className="self-start"
                disabled={reason.trim().length < 3 || accept.isPending}
              >
                <GitPullRequestArrowIcon aria-hidden="true" />
                {specPaused ? 'Accept and resume' : 'Accept risk'}
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
      {/* The rail hides below @5xl/run; the paused council's exits must stay reachable. */}
      <div className="@5xl/run:hidden">
        <CouncilDecisionCard runId={id ?? run.data.id} ledger={ledger} />
      </div>
      <Findings ledger={ledger} />
      <CouncilTable ledger={ledger} />
    </HarnessPage>
  )
}
