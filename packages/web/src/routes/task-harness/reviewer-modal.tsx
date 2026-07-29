import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'

import { useCouncilDecision, useHarnessInvocation } from '@/api/queries'
import type {
  HarnessInvocationRecord,
  HarnessLedgerResponse,
} from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { elapsed, SeverityTag, toneOf } from './harness-components'
import { displayedCouncil, shortModelName } from './harness-state'

/**
 * The reviewer drawer (review 2026-07-27, finding C7).
 *
 * Before this you could see that a reviewer completed and what it titled, but
 * never what it said, how long its transport took, whether it retried, or what
 * it cost — the review itself, the thing you paid for, had no surface at all.
 */
/**
 * The reviewer's actual conversation (user request 2026-07-27): what was sent,
 * and what came back — in prose, not as a raw artifact dump.
 *
 * A council reviewer is the expensive, judgement-carrying part of a run, and
 * until now the only trace of one was its verdict and a finding list. You could
 * not check whether it was asked the right question, whether it answered it, or
 * why two reviewers disagreed. One turn per attempt: the prompt, then the reply.
 */
function ReviewerConversation({
  runId,
  invocations,
}: {
  runId: string
  invocations: readonly HarnessInvocationRecord[]
}) {
  const ordered = [...invocations].reverse()
  const [openId, setOpenId] = useState<string | null>(ordered[0]?.id ?? null)
  const detail = useHarnessInvocation(runId, openId)

  if (ordered.length === 0) return null

  return (
    <section data-slot="reviewer-conversation" className="mb-5">
      <h3 className="text-[10.5px] font-semibold tracking-[0.06em] text-soft-foreground uppercase">
        Conversation
      </h3>
      {ordered.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ordered.map((invocation, index) => (
            <button
              key={invocation.id}
              type="button"
              onClick={() => setOpenId(invocation.id)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium',
                invocation.id === openId
                  ? 'border-primary/60 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <StatusDot tone={toneOf(invocation.status)} />
              attempt {ordered.length - index}
            </button>
          ))}
        </div>
      ) : null}

      {detail.isPending ? (
        <p className="mt-2 text-xs text-soft-foreground">Loading the conversation…</p>
      ) : detail.isError ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This conversation was not recorded — the run predates prompt capture.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <Turn
            label="Sent to the reviewer"
            body={detail.data?.prompt ?? null}
            empty="No prompt was recorded for this attempt."
          />
          <Turn
            label="Reviewer's response"
            body={formatReviewResponse(detail.data?.result ?? null)}
            empty={detail.data?.error ?? 'This attempt produced no response.'}
            tone={detail.data?.status === 'failed' ? 'danger' : 'default'}
          />
        </div>
      )}
    </section>
  )
}

function Turn({
  label,
  body,
  empty,
  tone = 'default',
}: {
  label: string
  body: string | null
  empty: string
  tone?: 'default' | 'danger'
}) {
  const lines = body ? body.split('\n').length : 0
  return (
    <details className="overflow-hidden rounded-lg border border-border bg-card-2">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
        <span className={cn('font-semibold', tone === 'danger' ? 'text-danger' : 'text-foreground')}>
          {label}
        </span>
        {body ? (
          <span className="text-soft-foreground tabular-nums">
            {lines} {lines === 1 ? 'line' : 'lines'}
          </span>
        ) : null}
        <ChevronDownIcon aria-hidden="true" className="ml-auto size-3.5 text-soft-foreground" />
      </summary>
      <pre className="max-h-96 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {body ?? empty}
      </pre>
    </details>
  )
}

/**
 * Reviewers answer with a JSON result file. Rendered raw it is a wall of escaped
 * strings, so it becomes readable prose — and anything that is not the expected
 * shape falls through untouched rather than being hidden.
 */
export function formatReviewResponse(raw: string | null): string | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
  const result = parsed as {
    verdict?: unknown
    findings?: unknown
    notes?: unknown
  }
  if (typeof result.verdict !== 'string' && !Array.isArray(result.findings)) return raw

  const out: string[] = []
  if (typeof result.verdict === 'string') out.push(`Verdict: ${result.verdict.replace('_', ' ')}`)
  const findings = Array.isArray(result.findings) ? result.findings : []
  out.push(`${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`)
  findings.forEach((entry, index) => {
    const finding = (entry ?? {}) as Record<string, unknown>
    const severity = typeof finding.severity === 'string' ? finding.severity.toUpperCase() : '—'
    out.push('', `${index + 1}. [${severity}] ${String(finding.title ?? 'untitled')}`)
    if (typeof finding.location === 'string') out.push(`   at ${finding.location}`)
    if (typeof finding.evidence === 'string') out.push(`   ${finding.evidence}`)
  })
  const notes = Array.isArray(result.notes) ? result.notes.filter((n) => typeof n === 'string') : []
  if (notes.length > 0) out.push('', 'Notes:', ...notes.map((note) => `   ${String(note)}`))
  return out.join('\n')
}

export function ReviewerModal({
  runId,
  ledger,
  reviewerId,
  onClose,
}: {
  runId: string
  ledger: HarnessLedgerResponse
  reviewerId: string | null
  onClose: () => void
}) {
  const council = displayedCouncil(ledger)
  const reviewer = (council?.reviewers ?? []).find((entry) => entry.id === reviewerId)
  const model = ledger.models.find((entry) => entry.id === reviewerId)
  const invocations = ledger.invocations.filter(
    (invocation) => invocation.reviewerId === reviewerId || invocation.binding.model === reviewerId,
  )
  const open = reviewerId !== null && reviewer !== undefined

  // A failed reviewer inside a paused council is actionable right here: the
  // same decision endpoint the rail's banner uses, one click from the failure.
  const pendingDecision = ledger.outcome.pendingDecision
  const decision = useCouncilDecision(runId)
  const retryable =
    reviewer?.status === 'failed' &&
    ledger.outcome.status === 'blocked' &&
    pendingDecision?.kind === 'council'
  const act = (action: 'retry' | 'proceed', done: string) => {
    decision.mutate(action, {
      onSuccess: () => {
        toast(done)
        onClose()
      },
      onError: (error) =>
        toast(error instanceof Error ? error.message : 'could not resume the run', { tone: 'danger' }),
    })
  }
  const retry = () => act('retry', 'Retrying the failed reviewer(s) — the run resumed')
  const proceed = () =>
    act('proceed', 'Proceeding with the completed reviewers — the run resumed')

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => (next ? undefined : onClose())}>
      <DialogContent
        className="flex max-h-[85vh] w-[min(760px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]"
        data-slot="harness-reviewer-modal"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <StatusDot tone={toneOf(reviewer?.status)} />
            {model?.model || shortModelName(reviewerId ?? '')}
            <span className="inline-flex h-[19px] items-center rounded-full bg-muted px-2 text-[10.5px] font-semibold text-muted-foreground">
              {model?.family ?? 'unknown'}
            </span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            {model?.binding ?? reviewer?.model ?? reviewerId}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-px border-b border-border bg-border">
          {[
            ['Verdict', reviewer?.verdict?.replace('_', ' ') ?? reviewer?.status ?? '—'],
            ['Invocations', String(model?.invocations ?? invocations.length)],
            ['Duration', model && model.totalDurationMs > 0 ? elapsed(model.totalDurationMs) : '—'],
          ].map(([label, value]) => (
            <div key={label} className="bg-card px-5 py-2.5">
              <span className="block text-[10px] tracking-[0.05em] text-soft-foreground uppercase">
                {label}
              </span>
              <b className="block text-[13px] font-semibold">{value}</b>
            </div>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {reviewer?.reason ? (
            <div className="mb-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5">
              <p className="text-xs leading-relaxed text-danger">{reviewer.reason}</p>
              {retryable ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    disabled={decision.isPending}
                    onClick={retry}
                    data-slot="reviewer-retry"
                  >
                    <RotateCcwIcon aria-hidden="true" className="size-3.5" />
                    {decision.isPending ? 'Resuming…' : 'Retry the failed reviewer(s)'}
                  </Button>
                  {pendingDecision?.canProceed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      disabled={decision.isPending}
                      onClick={proceed}
                      data-slot="reviewer-proceed"
                    >
                      Continue without this reviewer
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <ReviewerConversation runId={runId} invocations={invocations} />

          <h3 className="text-[10.5px] font-semibold tracking-[0.06em] text-soft-foreground uppercase">
            Findings
          </h3>
          {(reviewer?.findings ?? []).length === 0 ? (
            <p className="mt-2 text-xs text-soft-foreground">
              This reviewer raised nothing on the final diff.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2.5">
              {(reviewer?.findings ?? []).map((finding, index) => (
                <li key={`${finding.title}-${index}`} className="flex flex-col gap-1">
                  <span className="flex items-start gap-2">
                    <SeverityTag severity={finding.severity} />
                    <span className="text-[13px] leading-snug font-medium">{finding.title}</span>
                  </span>
                  {finding.location ? (
                    <span className="font-mono text-[11px] break-all text-soft-foreground">
                      {finding.location}
                    </span>
                  ) : null}
                  {finding.evidence ? (
                    <span className="text-[12px] leading-relaxed text-muted-foreground">
                      {finding.evidence}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {invocations.length > 0 ? (
            <>
              <h3 className="mt-5 text-[10.5px] font-semibold tracking-[0.06em] text-soft-foreground uppercase">
                Transport
              </h3>
              <ul className="mt-2 flex flex-col gap-1.5">
                {invocations.map((invocation) => (
                  <li
                    key={invocation.id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-card-2 px-2.5 py-1.5 text-[11.5px]"
                  >
                    <StatusDot tone={toneOf(invocation.status)} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                      {invocation.binding.runner} · {invocation.binding.model || 'auto'}
                    </span>
                    <span className="shrink-0 text-soft-foreground tabular-nums">
                      {invocation.durationMs ? elapsed(invocation.durationMs) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
