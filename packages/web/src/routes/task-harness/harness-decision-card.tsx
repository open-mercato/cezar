import { useMemo, useRef, useState } from 'react'
import { CheckCircle2Icon, CircleHelpIcon, LoaderCircleIcon } from 'lucide-react'
import { harnessCheckUnavailable, harnessFailedValidationChecks, harnessFindingHistory, harnessValidationFindingId, harnessValidationNeedsAttention, type ApiRun, type HarnessLedgerResponse, type HarnessReviewActionInput } from '@open-mercato/cezar-api-client'
import { useAcceptContestedHarness, useHarnessReviewAction } from '@/api/harness'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

const findingLabels = {
  open: 'Open', 'fixed-unverified': 'Fixed, awaiting verification',
  resolved: 'No longer reported', environment: 'Environment issue',
}

/** One handoff, shared by Chat and Review; publication still uses the existing server gate. */
export function HarnessDecisionCard({ run, ledger }: { run: ApiRun; ledger: HarnessLedgerResponse }) {
  const action = useHarnessReviewAction(run.id)
  const accept = useAcceptContestedHarness(run.id)
  const [selected, setSelected] = useState<string[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [showRisk, setShowRisk] = useState(false)
  const [historyFilter, setHistoryFilter] = useState<'attention' | 'resolved' | 'all'>('attention')
  const [reason, setReason] = useState('')
  const findingsRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => harnessFindingHistory(ledger), [ledger])
  const candidates = rows.filter((row) => row.kind === 'implementation' && ['open', 'fixed-unverified'].includes(row.status))
  const failedChecks = harnessFailedValidationChecks(ledger.validation)
  const validationIds = new Set((ledger.validation ?? []).map((check) => harnessValidationFindingId(check.command)))
  const reviewFindings = candidates.filter((row) => !validationIds.has(row.id))
  const chosen = (selected ?? candidates.filter((row) => ['blocker', 'major'].includes(row.severity)).map((row) => row.id))
    .filter((id) => candidates.some((row) => row.id === id)).slice(0, 50)
  const unavailable = (ledger.validation ?? []).filter(harnessCheckUnavailable)
  const setup = ledger.environment !== undefined && ledger.environment.status !== 'ready'
  const checksNeedAttention = !setup && harnessValidationNeedsAttention(ledger)
  const accepted = Boolean(ledger.outcome.acceptedAt)
  const ready = (ledger.outcome.status === 'ready' && !setup) || accepted
  const hardBlocked = !setup && !checksNeedAttention && ledger.outcome.status === 'blocked'
  const visibleRows = rows.filter((row) => historyFilter === 'all' || (historyFilter === 'resolved' ? row.status === 'resolved' : row.kind === 'implementation' && row.status !== 'resolved'))
  const busy = action.isPending || ['queued', 'running'].includes(run.status) ||
    (ledger.outcome.status === 'pending' && !ledger.reviewAction && !['failed', 'waiting'].includes(run.status))
  const resumable = !busy && ledger.reviewAction && ['pending', 'running'].includes(ledger.reviewAction.status)
  const latestAction = ledger.reviewAction
  const implemented = ledger.phases.some((phase) => phase.id === 'implement' && phase.status === 'done')
  const canAccept = run.status === 'review' && ledger.stage.status === 'staged' && ledger.outcome.status === 'contested' && !accepted
  if (ledger.outcome.pendingDecision || (!setup && !ready && ledger.outcome.status === 'pending' && !latestAction && rows.length === 0)) return null

  const request = (kind: HarnessReviewActionInput['action'], resumeExisting = false, findingIds = chosen) => {
    if (!ledger.actionRevision || busy) return
    const resume = resumeExisting && resumable && latestAction?.action === kind
    action.mutate({
      requestId: resume ? latestAction.id : crypto.randomUUID(),
      action: kind, revision: ledger.actionRevision,
      ...(kind === 'fix' ? { findingIds: resume ? latestAction.findingIds : findingIds } : {}),
    }, { onError: (error) => toast(error.message, { tone: 'danger' }) })
  }
  const inspect = () => {
    setExpanded(true)
    requestAnimationFrame(() => { findingsRef.current?.focus(); findingsRef.current?.scrollIntoView?.({ block: 'nearest' }) })
  }
  return (
    <section id={`harness-decision-${run.id}`} tabIndex={-1} data-slot="harness-decision-card" aria-label="Review decision" className={cn(
      'scroll-mt-24 rounded-xl border p-4', ready ? 'border-success/40 bg-success/5' : hardBlocked ? 'border-danger/40 bg-danger/5' : 'border-warning/40 bg-warning/5',
    )}>
      <div className="flex items-start gap-2.5">
        {ready ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          : <CircleHelpIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <h2 className="text-lead font-semibold">{busy ? 'Verification in progress' : setup ? 'Project setup needed' : checksNeedAttention ? 'Checks need attention' : hardBlocked ? 'This run is blocked' : ready ? accepted ? 'Risk accepted — publishing is available' : 'Review complete — changes ready' : 'Changes saved — verification needed'}</h2>
          <p className="mt-1 text-ui text-muted-foreground">
            {setup ? ledger.environment?.detail.split('\n')[0]
              : checksNeedAttention ? `${failedChecks.length} project ${failedChecks.length === 1 ? 'check failed' : 'checks failed'}. Your changes are preserved. Repair the checks before requesting another review.`
              : ready ? 'Inspect the staged changes before finishing or creating a PR. Nothing publishes automatically.'
                : 'Your changes are preserved. Choose the next step below; reaching the review limit does not start more paid work.'}
          </p>
          {hardBlocked ? <ul className="mt-2 list-inside list-disc text-label text-muted-foreground">{ledger.outcome.blockingReasons.map((message) => <li key={message}>{message}</li>)}</ul> : null}
          {ledger.loops ? <p className="mt-1 text-meta text-muted-foreground">{ledger.loops.fixRounds}/{ledger.loops.maxFixRounds} automatic review rounds used{checksNeedAttention ? ' · fresh review has not started' : latestAction ? ` · requested action: ${latestAction.status}` : ''}</p> : null}
          {unavailable.length > 0 ? <p className="mt-2 text-label text-warning">{unavailable.length} {unavailable.length === 1 ? 'check could not run. It has' : 'checks could not run. They have'} not passed.</p> : null}
          {checksNeedAttention ? <div className="mt-2 text-label" aria-label="Failed project checks">
            <ul className="flex flex-col gap-1 text-muted-foreground">{failedChecks.map((check) => <li key={check.command} className="break-words"><details>
              <summary className="cursor-pointer"><code>{check.command}</code><span className="text-meta"> · output</span></summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-meta">{check.evidence}</pre>
            </details></li>)}</ul>
            {ledger.baselineValidation?.some(harnessCheckUnavailable) ? <p className="mt-2 text-meta text-muted-foreground">Baseline checks could not run; these failures have not been compared with a working baseline.</p> : null}
          </div> : null}
          {candidates.length ? <p className="mt-1 text-label text-muted-foreground">{reviewFindings.length} review {reviewFindings.length === 1 ? 'finding' : 'findings'} to verify · {rows.filter((row) => row.status === 'resolved').length} no longer reported</p> : null}
          {!ready ? <div className="mt-3 flex flex-wrap items-center gap-2">
            {setup ? <Button disabled={busy || !ledger.actionRevision} onClick={() => request('prepare', Boolean(resumable && latestAction?.action === 'prepare'))}>
              {action.isPending ? <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" /> : null}{ledger.environment?.installCommand ? `Prepare project${implemented ? ' & verify' : ' & resume'}` : 'Retry project checks'}
            </Button> : checksNeedAttention ? <>
              <Button disabled={busy || !ledger.actionRevision || !implemented} onClick={() => request('fix', false, failedChecks.map((check) => harnessValidationFindingId(check.command)))}>Fix {failedChecks.length} failing {failedChecks.length === 1 ? 'check' : 'checks'}</Button>
              <Button variant="outline" disabled={busy || !ledger.actionRevision || !implemented} onClick={() => request('verify')}>Re-run checks</Button>
            </> : <Button disabled={busy || !ledger.actionRevision || !implemented} onClick={() => request(resumable && latestAction ? latestAction.action : 'verify', Boolean(resumable))}>
              {action.isPending ? <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" /> : null}{resumable ? 'Resume requested action' : 'Verify final fixes'}
            </Button>}
            <Button variant="outline" onClick={inspect}>Inspect findings</Button>
            <Link to={`/tasks/${run.id}/changes`} className="text-label font-medium underline underline-offset-4">Inspect changes</Link>
            {canAccept ? <Button variant="ghost" disabled={busy} onClick={() => setShowRisk((value) => !value)}>Accept risk…</Button> : null}
          </div> : null}
          {!ready ? <p className="mt-2 text-meta text-muted-foreground">
            {setup ? `${ledger.environment?.installCommand ? `Runs ${ledger.environment.installCommand} from this task worktree. ` : 'Repair setup in the task terminal, then retry project checks. '}${implemented ? 'Then runs checks and one fresh review.' : 'Then resumes the original task.'}`
              : resumable && latestAction?.onePass === false ? 'Resumes the original task with its remaining automatic review rounds.'
                : checksNeedAttention ? 'Fix failing checks requests one repair pass, then validation. A fresh review runs only after checks pass. Re-run checks verifies manual fixes. Neither action starts another repair loop.'
                  : 'Verification runs checks and one fresh review. Fix selected findings adds one repair pass. Neither action starts another repair loop.'}
          </p> : null}
        </div>
      </div>
      {showRisk && canAccept ? <form className="mt-4 flex flex-col gap-2 border-t border-border pt-3" onSubmit={(event) => {
        event.preventDefault()
        accept.mutate(reason, { onSuccess: () => { setShowRisk(false); setReason('') }, onError: (error) => toast(error.message, { tone: 'danger' }) })
      }}>
        <p className="text-label text-muted-foreground">This unlocks publishing despite the outstanding concerns{unavailable.length ? ' and checks that never ran' : ''}. Record why you accept that risk.</p>
        <Textarea aria-label="Reason for accepting contested result" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Explain the risk you accept…" />
        <Button type="submit" variant="outline" className="self-start" disabled={reason.trim().length < 3 || accept.isPending}>Accept risk and unlock publishing</Button>
      </form> : null}
      <details className="mt-3 border-t border-border pt-3" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer text-label font-medium">Finding history ({rows.length})</summary>
        <div ref={findingsRef} tabIndex={-1} className="mt-2 flex flex-col gap-2 outline-none">
          <p className="text-meta text-muted-foreground">Resolved means a later completed review no longer reported the finding. Its earlier evidence stays in this history.</p>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Finding history filter">{(['attention', 'resolved', 'all'] as const).map((filter) => <Button key={filter} size="sm" variant={historyFilter === filter ? 'outline' : 'ghost'} aria-pressed={historyFilter === filter} onClick={() => setHistoryFilter(filter)}>{filter === 'attention' ? 'Needs attention' : filter === 'resolved' ? 'No longer reported' : 'All history'}</Button>)}</div>
          {visibleRows.length === 0 ? <p className="text-label text-muted-foreground">No findings in this group.</p> : visibleRows.map((row) => (
            <div key={row.id} className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-label">
              {candidates.some((candidate) => candidate.id === row.id) ? <input type="checkbox" className="mt-1 size-4 accent-primary" checked={chosen.includes(row.id)} aria-label={`Select finding: ${row.title}`} disabled={busy || (!chosen.includes(row.id) && chosen.length >= 50)}
                onChange={(event) => setSelected(event.target.checked ? [...chosen, row.id] : chosen.filter((id) => id !== row.id))} /> : null}
              <span className="min-w-0"><span className="break-words font-medium">{row.title}</span><span className="mt-0.5 block text-meta text-muted-foreground">{findingLabels[row.status]} · {validationIds.has(row.id) ? 'Validation' : row.kind === 'spec' ? 'Specification' : 'Implementation'} · {row.severity} · round {row.firstRound}{row.lastRound !== row.firstRound ? `–${row.lastRound}` : ''}{row.reviewers.length ? ` · ${row.reviewers.join(', ')}` : ''}</span>
                {row.location ? <code className="block break-all text-meta text-muted-foreground">{row.location}</code> : null}
                {row.evidence ? <details className="mt-1 text-meta text-muted-foreground"><summary className="cursor-pointer">Evidence</summary><span className="block whitespace-pre-wrap break-words">{row.evidence}</span></details> : null}
              </span>
            </div>
          ))}
          {candidates.length > 0 && !ready ? <Button variant="outline" className="self-start" disabled={busy || setup || !chosen.length || !ledger.actionRevision} onClick={() => request('fix')}>Fix {chosen.length} selected {chosen.length === 1 ? 'finding' : 'findings'}</Button> : null}
          {(ledger.validation ?? []).length ? <details><summary className="cursor-pointer text-label">Validation evidence</summary><ul className="mt-2 flex flex-col gap-2">{ledger.validation!.map((check, index) => <li key={`${check.command}-${index}`} className="rounded border border-border bg-card p-2 text-meta">
            <p className="font-medium">{check.command} · {harnessCheckUnavailable(check) ? 'Could not run' : check.status === 'failed' && check.preexisting ? 'Pre-existing failure' : check.status}</p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{check.evidence}</pre>
          </li>)}</ul></details> : null}
        </div>
      </details>
    </section>
  )
}
