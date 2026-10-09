import { CircleAlertIcon, HourglassIcon, LoaderCircleIcon, PlayIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import type { ContinueAction } from './follow-up-engine'
import type { ThreadEntry, ThreadState } from './thread-state'

/**
 * One failure, said once.
 *
 * A failed session reaches the thread through three independent channels, all carrying the same
 * sentence: the failed step's `step-end` ("step task failed — …", a danger note), the engine's
 * closing `lifecycle` line ("run failed — …", a dim note) and the run record's `error` (the
 * footer's "Session failed — …"). Each is a real event and each is right; together they read as
 * three failures. This module folds them into one `Alert` at the foot of the thread, and keeps
 * everything that is NOT a repetition: which step failed, any second, different message, and any
 * other error the backend reported on the way down.
 */

const STEP_FAILED = /^step (\S+) failed(?: — ([\s\S]*))?$/
const RUN_FAILED = /^run failed(?: — ([\s\S]*))?$/

interface FailureNote {
  source: 'step' | 'run'
  stepId?: string
  reason?: string
}

/** Recognise the two engine-written failure lines (`thread-state.ts` `step-end`, and
 *  `src/workflows/run.ts` "run failed — …"). Anything else is not ours to fold. */
export function parseFailureNote(text: string): FailureNote | undefined {
  const step = STEP_FAILED.exec(text)
  if (step) return { source: 'step', stepId: step[1], ...(step[2] ? { reason: step[2].trim() } : {}) }
  const run = RUN_FAILED.exec(text)
  if (run) return { source: 'run', ...(run[1] ? { reason: run[1].trim() } : {}) }
  return undefined
}

/**
 * History's version of the same fold: inside one run of notes, a "run failed — E" that only
 * repeats the "step X failed — E" above it is dropped (the step line carries strictly more). A
 * run failure with a DIFFERENT reason, or with no step line before it, stays.
 */
export function collapseFailureNotes(entries: readonly ThreadEntry[]): readonly ThreadEntry[] {
  let stepReason: string | undefined | null = null
  let changed = false
  const kept: ThreadEntry[] = []
  for (const entry of entries) {
    if (entry.kind !== 'note') {
      stepReason = null
      kept.push(entry)
      continue
    }
    const failure = parseFailureNote(entry.text)
    if (failure?.source === 'step') stepReason = failure.reason
    if (failure?.source === 'run' && stepReason !== null && stepReason === failure.reason) {
      changed = true
      continue
    }
    kept.push(entry)
  }
  return changed ? kept : entries
}

export interface FailureDigest {
  /** The failed step, when the transcript or the record names one. */
  step?: { id: string; name: string }
  /** Why — the run record's own error, else the first reason the transcript gave. */
  reason?: string
  /** Every OTHER distinct message reported with the failure, in stream order. */
  details: string[]
  /** The transcript notes this digest speaks for — the thread leaves them out. */
  hiddenIds: ReadonlySet<string>
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * What the alert says for a run that is failed RIGHT NOW. Only the notes that close the last
 * turn are folded: a failure line with more transcript after it belongs to an earlier attempt
 * the run already moved past, and stays where it happened. Dim asides in that tail ("session
 * closed after 15m of inactivity") are context, not the failure, and stay too.
 */
export function digestFailure(run: ApiRun, thread: ThreadState): FailureDigest {
  const hiddenIds = new Set<string>()
  const messages: string[] = []
  let stepId: string | undefined
  const items = thread.turns.at(-1)?.items ?? []
  let start = items.length
  while (start > 0 && items[start - 1]!.kind === 'note') start -= 1
  for (const entry of items.slice(start)) {
    if (entry.kind !== 'note') continue
    const failure = parseFailureNote(entry.text)
    if (failure !== undefined) {
      hiddenIds.add(entry.id)
      stepId ??= failure.stepId
      if (failure.reason !== undefined) messages.push(failure.reason)
    } else if (entry.tone === 'danger') {
      hiddenIds.add(entry.id)
      messages.push(entry.text)
    }
  }
  const reason = run.error?.trim() || messages[0]
  const details: string[] = []
  for (const message of messages) {
    if (reason !== undefined && same(message, reason)) continue
    if (!details.some((seen) => same(seen, message))) details.push(message)
  }
  const failedStep =
    (stepId !== undefined ? run.steps.find((step) => step.id === stepId) : undefined) ??
    (stepId === undefined ? run.steps.find((step) => step.status === 'failed') : undefined)
  const step =
    failedStep !== undefined
      ? { id: failedStep.id, name: failedStep.name || failedStep.id }
      : stepId !== undefined
        ? { id: stepId, name: stepId }
        : undefined
  return { ...(step ? { step } : {}), ...(reason ? { reason } : {}), details, hiddenIds }
}

/**
 * The failed session's one statement, as the thread's closing block. Destructive in meaning,
 * calm in colour: a tinted surface and a red mark, the words in the reading colours.
 *
 * `continueAction` is the SAME hook instance the composer and the header badge use, so the
 * button reopens the session on the runner/model the pills show — it is the composer's empty
 * submit ("just reopen the session"), not a second API.
 */
export function SessionFailureAlert({
  run,
  digest,
  continueAction,
  canResume,
  links,
}: {
  run: ApiRun
  digest: FailureDigest
  continueAction: ContinueAction
  /** A session exists to reopen (`hasContinuation` in the thread). */
  canResume: boolean
  /** The PR / issue links the closed footer has always carried. */
  links?: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  // A usage-limit stop with a resume armed is not a broken task (see `AutoResumeHint`, which
  // says when it resumes) — so it is not painted as one.
  const scheduled = Boolean(run.autoResumeAt)
  const Icon = scheduled ? HourglassIcon : CircleAlertIcon
  const title = scheduled
    ? 'Session stopped — it resumes on its own'
    : digest.step !== undefined
      ? `Session failed at “${digest.step.name}”`
      : 'Session failed'
  const resume = async () => {
    setBusy(true)
    try {
      await continueAction.continueWith('', [])
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not continue the session', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Alert
      data-slot="thread-footer"
      data-state="closed"
      data-tone={scheduled ? 'dim' : 'danger'}
      className={cn('mt-auto rounded-xl px-4 py-3.5', scheduled ? 'bg-card' : 'border-danger/20 bg-danger/[0.04]')}
    >
      <Icon aria-hidden="true" className={scheduled ? 'text-muted-foreground!' : 'text-danger!'} />
      <AlertTitle
        data-slot="failure-title"
        className="text-foreground"
        {...(digest.step !== undefined ? { title: `Step id: ${digest.step.id}` } : {})}
      >
        {title}
      </AlertTitle>
      <AlertDescription className="gap-2 text-[13px] leading-relaxed">
        {digest.reason !== undefined ? (
          <p data-slot="failure-reason" className="break-words first-letter:uppercase">
            {digest.reason}
          </p>
        ) : null}
        {digest.details.length > 0 ? (
          <ul data-slot="failure-details" className="flex list-disc flex-col gap-0.5 pl-4 text-xs">
            {digest.details.map((detail) => (
              <li key={detail} className="break-words first-letter:uppercase">
                {detail}
              </li>
            ))}
          </ul>
        ) : null}
        {canResume || links ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            {canResume ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="failure-continue"
                disabled={busy || !continueAction.canContinue}
                title={continueAction.canContinue ? 'Reopen the session where it stopped' : continueAction.reason}
                onClick={() => void resume()}
              >
                {busy ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : <PlayIcon aria-hidden="true" />}
                Continue
              </Button>
            ) : null}
            {links}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
