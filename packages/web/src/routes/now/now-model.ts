import type { RunRecord } from '@open-mercato/cezar-api-client'

import {
  budgetStop,
  deriveAttention,
  isAwaitingAnswer,
  isIdleClosed,
  type AttentionTone,
} from '@/lib/attention'
import { lastActivityAt } from '@/lib/task-groups'
import { activeStepIndex, railProgress } from '@/routes/task-thread/step-rail'

/**
 * The Now view's three sections, as pure derivations over the runs index (spec: attention-first
 * cockpit (2026-11-11), Proposal 2). A view over `lib/attention.ts`, never a second state machine:
 * every "needs you" row is one `deriveAttention` already names, with the ONE action that resolves it.
 */

/** Why a row sits under "Needs you" — ordered: questions, review gate, waits, failures. */
export type NeedsYouReason = 'question' | 'review' | 'budget' | 'waiting' | 'lifecycle' | 'failed'

/** The one primary action per reason. */
export type NeedsYouAction = 'answer' | 'review' | 'resume' | 'reply' | 'open' | 'retry'

const REASON_RANK: Record<NeedsYouReason, number> = {
  question: 0,
  review: 1,
  budget: 2,
  waiting: 2,
  lifecycle: 2,
  failed: 3,
}

const REASON_ACTION: Record<NeedsYouReason, NeedsYouAction> = {
  question: 'answer',
  review: 'review',
  budget: 'resume',
  waiting: 'reply',
  lifecycle: 'open',
  failed: 'retry',
}

export const NEEDS_YOU_ACTION_LABEL: Record<NeedsYouAction, string> = {
  answer: 'Answer',
  review: 'Review changes',
  resume: 'Resume',
  reply: 'Reply',
  open: 'Open',
  retry: 'Retry',
}

export interface NeedsYouRow {
  run: RunRecord
  reason: NeedsYouReason
  action: NeedsYouAction
  /** The reason line's leading phrase ("Asked a question"). */
  label: string
  /** The reason line's detail — the failure's first line, the budget numbers. */
  detail?: string
  /** When this wait began — the row's age. */
  since: string
  tone: AttentionTone
  pulse: boolean
}

const MAX_DETAIL = 140

/** The first line of a failure, bounded — a row has one line for it. */
export function failureHead(error: string | undefined): string | undefined {
  const line = error?.split('\n').find((part) => part.trim() !== '')?.trim()
  if (!line) return undefined
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line
}

function money(usd: number): string {
  return `$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(2)}`
}

export function needsYouReason(run: RunRecord): NeedsYouReason | undefined {
  if (run.archived) return undefined
  if (run.worktreeLifecycle?.needsAttention) return 'lifecycle'
  if (isAwaitingAnswer(run)) return 'question'
  if (run.status === 'review') return 'review'
  if (run.status === 'waiting') return budgetStop(run) ? 'budget' : 'waiting'
  // A scheduled resume asks for nothing; an idle close is an outcome (#690), not a gate.
  if (run.status === 'failed' && !run.autoResumeAt && !isIdleClosed(run)) return 'failed'
  return undefined
}

function needsYouRow(run: RunRecord, reason: NeedsYouReason): NeedsYouRow {
  const attention = deriveAttention(run)
  const base = {
    run,
    reason,
    action: REASON_ACTION[reason],
    since: run.waitingSince ?? run.awaitingAnswerSince ?? lastActivityAt(run),
    tone: attention.tone,
    pulse: attention.pulse,
  }
  switch (reason) {
    case 'question':
      return { ...base, label: 'Asked a question' }
    case 'review':
      return { ...base, label: 'Finished, waiting for review' }
    case 'budget': {
      const stop = budgetStop(run)
      return {
        ...base,
        label: 'Budget reached',
        ...(stop ? { detail: `${money(stop.spent)} of ${money(stop.ceiling)} spent` } : {}),
      }
    }
    case 'waiting':
      return { ...base, label: 'Paused, waiting for your reply' }
    case 'lifecycle':
      return {
        ...base,
        label: run.worktreeLifecycle?.phase === 'setup' ? 'Worktree setup needs attention' : 'Worktree cleanup needs attention',
      }
    case 'failed': {
      const detail = failureHead(run.error)
      return { ...base, label: 'Failed', ...(detail ? { detail } : {}) }
    }
  }
}

/** The "Needs you" rows: questions first, then the review gate, then waits, then failures;
 *  the newest wait first within a reason. */
export function needsYouRows(runs: readonly RunRecord[]): NeedsYouRow[] {
  const rows: NeedsYouRow[] = []
  for (const run of runs) {
    const reason = needsYouReason(run)
    if (reason) rows.push(needsYouRow(run, reason))
  }
  return rows.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || b.since.localeCompare(a.since))
}

export interface RunningRow {
  run: RunRecord
  /** `queued` rows carry no step; `scheduled` is a usage-limit wait with an appointment. */
  kind: 'running' | 'queued' | 'scheduled'
  /** "step k of n" + the step's name, once the workflow has steps. */
  step?: { index: number; total: number; name: string }
  /** 0..1 — the step rail's own measure. */
  progress: number
  label: string
}

export function runningRows(runs: readonly RunRecord[]): RunningRow[] {
  const rows: RunningRow[] = []
  for (const run of runs) {
    if (run.archived) continue
    const kind: RunningRow['kind'] | undefined =
      run.status === 'running' ? 'running'
      : run.status === 'queued' ? 'queued'
      : run.status === 'failed' && run.autoResumeAt ? 'scheduled'
      : undefined
    if (!kind) continue
    const steps = run.steps ?? []
    const index = activeStepIndex(steps)
    const current = steps[index]
    rows.push({
      run,
      kind,
      ...(current && kind === 'running' ? { step: { index: index + 1, total: steps.length, name: current.name } } : {}),
      progress: kind === 'running' ? railProgress(steps) : 0,
      label: deriveAttention(run).label,
    })
  }
  // Live work first, then the queue in its start order (createdAt), then appointments.
  const rank = { running: 0, queued: 1, scheduled: 2 } as const
  return rows.sort((a, b) =>
    rank[a.kind] - rank[b.kind] ||
    (a.kind === 'queued' ? a.run.createdAt.localeCompare(b.run.createdAt) : lastActivityAt(b.run).localeCompare(lastActivityAt(a.run))),
  )
}

/** The local calendar day of an instant, for "today" — the thread's own `localDayKey` rule. */
function dayKey(at: string | number | undefined): string | undefined {
  if (at === undefined) return undefined
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Outcomes that settled today (local day): done, cancelled, or closed idle — never a failure
 *  (that is a "Needs you" row) and never an archived run. Newest first. */
export function finishedTodayRows(runs: readonly RunRecord[], now: number): RunRecord[] {
  const today = dayKey(now)
  return runs
    .filter((run) => {
      if (run.archived || !run.finishedAt) return false
      const outcome = run.status === 'done' || run.status === 'cancelled' || isIdleClosed(run)
      return outcome && dayKey(run.finishedAt) === today
    })
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
}

/** "Finished today" shows at most this many; the rest is one click away on the table. */
export const FINISHED_TODAY_CAP = 8

/** The header's "Now · <project> · <weekday, date>" date — the viewer's locale and day. */
export function todayLabel(now: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now))
}
