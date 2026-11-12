import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { getRunCommits } from '@/api/client'
import { queryKeys, useArchiveRun } from '@/api/queries'
import type { ApiRun, RunCommitsResponse, StepState } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { deriveAttention, isIdleClosed } from '@/lib/attention'
import { Link } from '@/lib/project-router'
import { formatCost, taskPrUrl, taskReference } from '@/lib/tasks-table'
import { cn, isHttpUrl } from '@/lib/utils'

import { clockLabel, turnDuration } from './thread-time'
import type { ThreadFooter, ThreadState } from './thread-state'

/**
 * The outcome card (spec: attention-first cockpit (2026-11-11), Proposal 4): the review gate
 * made visible. Every closed run ends its thread in ONE card — the outcome in a sentence, the
 * facts a reviewer wants before clicking anything, and the actions, one of them primary. A run
 * that closed on an open question keeps the ask card instead (task-thread.tsx decides), so the
 * thread always ends in a decision and never in two.
 *
 * The sentence is the agent's own last words, trimmed — no model call, no server route.
 */

export type OutcomeKind = 'review' | 'done' | 'cancelled' | 'idle' | 'failed'

export function outcomeKind(run: Pick<ApiRun, 'status' | 'awaitingAnswerSince' | 'idleClosedAt'>): OutcomeKind | undefined {
  switch (run.status) {
    case 'review':
      return 'review'
    case 'done':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return isIdleClosed(run) ? 'idle' : 'failed'
    default:
      return undefined
  }
}

const SENTENCE_MAX = 160

/** Markdown the sentence must not carry: fences, emphasis, headings, list bullets, links. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
}

/** The first sentence of the agent's last message — or its first line when it has no period —
 *  capped at ~160 characters. Undefined when the thread holds no assistant text. */
export function outcomeSentence(thread: Pick<ThreadState, 'turns'>): string | undefined {
  let last: string | undefined
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.kind === 'message' && item.role === 'assistant' && item.text.trim() !== '') last = item.text
    }
  }
  if (last === undefined) return undefined
  const line = plainText(last)
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  if (!line) return undefined
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line
  return sentence.length > SENTENCE_MAX ? `${sentence.slice(0, SENTENCE_MAX - 1).trimEnd()}…` : sentence
}

const CHECK_OUTPUT_LINES = 6

/** The check command that failed and the head of what it printed — the failed card's cause. */
export function failingCheck(thread: Pick<ThreadState, 'turns'>): { command: string; output: string } | undefined {
  for (let t = thread.turns.length - 1; t >= 0; t -= 1) {
    const items = thread.turns[t]!.items
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!
      if (item.kind !== 'tool' || item.name !== 'check' || item.status !== 'failed') continue
      const command = item.title?.replace(/^Ran\s+/, '') ?? 'check'
      const lines = (item.output ?? '').split('\n').filter((line) => line.trim() !== '')
      const output = lines.slice(0, CHECK_OUTPUT_LINES).join('\n') + (lines.length > CHECK_OUTPUT_LINES ? '\n…' : '')
      return { command, output }
    }
  }
  return undefined
}

/** The step a failed run stopped in — the last failed one, as the rail paints it. */
function failedStep(steps: readonly StepState[]): { index: number; total: number; name: string } | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]!.status === 'failed') return { index: i + 1, total: steps.length, name: steps[i]!.name }
  }
  return undefined
}

const TITLES: Record<OutcomeKind, string> = {
  review: 'Finished · needs your review',
  done: 'Done',
  cancelled: 'Cancelled',
  idle: 'Closed after inactivity',
  failed: 'Failed',
}

export function OutcomeCard({
  run,
  thread,
  footer,
  offerContinue = false,
  onContinue,
  blockedReason,
  onContinueWithHint,
  issueUrl,
}: {
  run: ApiRun
  thread: ThreadState
  /** The closed footer line — kept as the card's small meta, word for word. */
  footer: Extract<ThreadFooter, { state: 'closed' }>
  /** Show Continue/Retry even when the footer carries no "continue to" advice. */
  offerContinue?: boolean
  /** Absent when there is no session to reopen at all. */
  onContinue?: () => Promise<unknown>
  /** Why Continue cannot run yet (provider loading or disconnected): shown disabled, saying why. */
  blockedReason?: string
  /** "Continue with a hint": put the cursor in the composer so the next message is the hint. */
  onContinueWithHint?: () => void
  issueUrl?: string
}) {
  const kind = outcomeKind(run) ?? 'done'
  const attention = deriveAttention(run)
  const sentence = outcomeSentence(thread)
  const check = kind === 'failed' ? failingCheck(thread) : undefined
  const step = kind === 'failed' ? failedStep(run.steps) : undefined
  const prUrl = taskPrUrl(run)
  const pr = isHttpUrl(prUrl) ? prUrl : undefined
  const reference = taskReference(run)
  const duration = turnDuration(run.startedAt, run.finishedAt)
  const clock = clockLabel(run.finishedAt)
  const cost = formatCost(run.costUsd)
  // Only what the Commits tab already fetched: a closed thread must not pay a request for a count.
  const commits = useQuery<RunCommitsResponse>({
    queryKey: queryKeys.runs.commits(run.id),
    queryFn: ({ signal }) => getRunCommits(run.id, { signal }),
    enabled: false,
  })
  const commitCount = commits.data?.commits.length
  const archive = useArchiveRun('task_view')
  const changesTo = `/tasks/${run.id}/changes`
  const hasChanges = run.diffStat !== undefined && (run.diffStat.files > 0 || run.diffStat.adds > 0 || run.diffStat.dels > 0)
  const retry = onContinue ? <ContinueButton primary={kind === 'failed'} label={kind === 'failed' ? 'Retry' : 'Continue'} onContinue={onContinue} blockedReason={blockedReason} /> : null

  const title = kind === 'failed' && step ? `Failed in step ${step.index} of ${step.total} · ${step.name}` : TITLES[kind]

  return (
    <section
      data-slot="outcome-card"
      data-kind={kind}
      aria-label={title}
      className={cn(
        'mt-auto w-full max-w-[640px] overflow-hidden rounded-xl border bg-card text-ui',
        kind === 'review' ? 'border-info/45' : kind === 'failed' ? 'border-danger/45' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <StatusDot
          tone={kind === 'done' || kind === 'cancelled' ? 'neutral' : attention.tone}
          pulse={kind === 'review' && attention.pulse}
          aria-label={attention.label}
        />
        <b className="min-w-0 truncate font-semibold text-foreground">{title}</b>
        {clock || duration ? (
          <span data-slot="outcome-time" className="ml-auto shrink-0 text-meta text-soft-foreground tabular-nums">
            {[clock, duration].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </div>

      <div className="grid gap-2 px-4 py-3">
        {sentence ? (
          <p data-slot="outcome-sentence" className="text-foreground">
            {sentence}
          </p>
        ) : null}
        {check ? (
          <pre
            data-slot="outcome-check"
            className="max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-meta text-muted-foreground"
          >
            <span className="text-foreground">{check.command}</span>
            {check.output ? `\n${check.output}` : ''}
          </pre>
        ) : null}
        <div data-slot="outcome-facts" className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-label text-muted-foreground">
          {run.diffStat ? (
            <span className="font-mono text-meta">
              {run.diffStat.files} {run.diffStat.files === 1 ? 'file' : 'files'} <DiffStatLabel stat={run.diffStat} className="text-meta" />
            </span>
          ) : null}
          {commitCount ? (
            <span className="font-mono text-meta">
              {commitCount} {commitCount === 1 ? 'commit' : 'commits'}
            </span>
          ) : null}
          {reference ? <TaskReferenceChip run={run} reference={reference} className="h-5" /> : null}
          {run.branch ? <span className="font-mono text-meta">{run.branch}</span> : null}
          {cost ? <span className="font-mono text-meta tabular-nums">{cost}</span> : null}
        </div>
        {/* The run's own closing line — the footer every test and script already reads. On a
            failure it IS the cause line (the reducer already keeps it to one showing). */}
        <div
          data-slot="thread-footer"
          data-state={footer.state}
          className={cn(
            'flex flex-wrap items-center gap-2',
            footer.tone === 'danger' ? 'text-label text-danger' : 'text-xs text-soft-foreground',
          )}
        >
          <FooterLabel label={footer.label} offerContinue={offerContinue} onContinue={onContinue} blockedReason={blockedReason} />
          {pr ? (
            <a data-slot="pr-link" href={pr} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
              PR ↗
            </a>
          ) : null}
          {isHttpUrl(issueUrl) ? (
            <a data-slot="issue-link" href={issueUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
              Issue ↗
            </a>
          ) : null}
        </div>
      </div>

      <div data-slot="outcome-actions" className="flex flex-wrap gap-2 px-4 pt-0 pb-3.5">
        {kind === 'failed' ? (
          <>
            {retry}
            {onContinueWithHint && onContinue ? (
              <Button type="button" variant="outline" size="sm" data-action="continue-hint" onClick={onContinueWithHint}>
                Continue with a hint
              </Button>
            ) : null}
            {hasChanges ? (
              <Button asChild variant="outline" size="sm">
                <Link to={changesTo} data-action="review">Review changes</Link>
              </Button>
            ) : null}
          </>
        ) : kind === 'review' ? (
          <>
            <Button asChild size="sm">
              <Link to={changesTo} data-action="review">Review changes</Link>
            </Button>
            {pr ? (
              <Button asChild variant="outline" size="sm">
                <a href={pr} target="_blank" rel="noopener noreferrer" data-action="open-pr">Open PR</a>
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {pr ? (
              <Button asChild size="sm">
                <a href={pr} target="_blank" rel="noopener noreferrer" data-action="open-pr">Open PR</a>
              </Button>
            ) : null}
            {hasChanges ? (
              <Button asChild variant={pr ? 'outline' : 'primary'} size="sm">
                <Link to={changesTo} data-action="review">Review changes</Link>
              </Button>
            ) : null}
            {kind === 'idle' ? retry : null}
          </>
        )}
        {!run.archived ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="archive"
            disabled={archive.isPending}
            onClick={() =>
              archive.mutate({ id: run.id, archived: true }, { onError: (error: Error) => toast(error.message, { tone: 'danger' }) })
            }
          >
            Archive
          </Button>
        ) : null}
      </div>
    </section>
  )
}

/** A primary Retry / outline Continue riding the footer's one delivery seam. */
function ContinueButton({
  primary,
  label,
  onContinue,
  blockedReason,
}: {
  primary: boolean
  label: string
  onContinue: () => Promise<unknown>
  blockedReason?: string
}) {
  const [pending, setPending] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant={primary ? 'primary' : 'outline'}
      data-action="retry"
      disabled={pending || blockedReason !== undefined}
      title={blockedReason ?? 'Reopen the session and pick up where it stopped'}
      onClick={() => {
        setPending(true)
        onContinue()
          .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
          .finally(() => setPending(false))
      }}
    >
      {label}
    </Button>
  )
}

/** The server's own advice — "… — continue to resume it" — names an action, so where that
 *  action is on offer the word IS the action: the same one-click Continue as an empty send. */
const CONTINUE_ADVICE = /— continue to /i

export function FooterLabel({
  label,
  offerContinue = false,
  onContinue,
  blockedReason,
}: {
  label: string
  /** Show Continue after the label even when it carries no "continue to" advice. */
  offerContinue?: boolean
  /** Absent when there is no session to reopen at all — the advice then stays plain text. */
  onContinue?: () => Promise<unknown>
  /** Why it cannot run yet (provider loading or disconnected): the button shows, disabled. */
  blockedReason?: string
}) {
  const match = onContinue ? CONTINUE_ADVICE.exec(label) : null
  if (!onContinue) return <span>{label}</span>
  if (!match) {
    if (!offerContinue) return <span>{label}</span>
    return (
      <span>
        {label} <span aria-hidden="true">·</span>{' '}
        <FooterContinueButton onContinue={onContinue} blockedReason={blockedReason} />
      </span>
    )
  }
  const before = label.slice(0, match.index)
  const after = label.slice(match.index + match[0].length)
  return (
    <span>
      {before}—{' '}
      <FooterContinueButton onContinue={onContinue} blockedReason={blockedReason} /> to {after}
    </span>
  )
}

function FooterContinueButton({
  onContinue,
  blockedReason,
}: {
  onContinue: () => Promise<unknown>
  blockedReason?: string
}) {
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      data-slot="footer-continue"
      disabled={pending || blockedReason !== undefined}
      title={blockedReason ?? 'Reopen the session and pick up where it stopped'}
      onClick={() => {
        setPending(true)
        onContinue()
          .catch((error: unknown) =>
            toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
          )
          .finally(() => setPending(false))
      }}
      // A text button in the message's own red: it is part of the sentence it completes, so it
      // keeps that sentence's colour; the weight and underline are what mark it as the action.
      className="rounded-sm font-semibold underline underline-offset-2 hover:brightness-125 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
    >
      Continue
    </button>
  )
}
