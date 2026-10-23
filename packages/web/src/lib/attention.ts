import type { RunRecord } from '@open-mercato/cezar-api-client'

/**
 * The one canonical attention function (spec, "Design system" → status grammar).
 *
 * Every surface that says "this run wants you" derives it from here: the quick-list dot, the
 * table's dot, the thread header, and — from Phase R6 — the browser notification. One function
 * means those can never disagree, which is the whole point of naming it in the spec.
 *
 * Deliberately UI-free: no React, no class names, no tokens. It maps a `RunRecord` to a bucket,
 * a tone name and whether the dot pulses; the components decide what those look like. That is
 * also what lets the notification path (R6) call it from outside a component tree.
 */

/**
 * The attention priority ladder, highest first (spec: permission > error > waiting/review >
 * running > unseen). `rank` is exported because it *is* the contract — a table test asserts the
 * order rather than trusting the if-chain below to be read correctly.
 */
export const ATTENTION_RANK = {
  permission: 0,
  error: 1,
  waiting: 2,
  running: 3,
  unseen: 4,
  none: 5,
} as const

export type AttentionBucket = keyof typeof ATTENTION_RANK

/** The dot tones the design system defines (`--success`/`--pending`/`--danger`/`--violet`, plus
 *  the neutral `--soft-foreground`). Named here rather than imported from `StatusDot` to keep
 *  this module UI-free; `attention.test.ts` asserts the two sets stay identical. */
export type AttentionTone = 'success' | 'pending' | 'danger' | 'violet' | 'neutral'

export interface Attention {
  bucket: AttentionBucket
  tone: AttentionTone
  /** True while the run is *transitioning* — the spec's "pulsing while transitioning" rule. */
  pulse: boolean
  /** Lower-case human phrase for the dot's tooltip / accessible name. */
  label: string
}

/**
 * Whether a run is blocked on a permission prompt.
 *
 * Always false today, on purpose. The `permission` bucket is in the ladder because the spec puts
 * it there and because R2 reserves the `permission.*` agent events that will feed it — but cezar
 * emits none of them yet, and `RunRecord` carries no field that means "a tool wants approval".
 * Inventing one (say, treating every `waiting` as a permission prompt) would put a bucket in the
 * UI that no data backs. So the slot stays, wired to the truth: nothing.
 *
 * When R2 lands the events, this is the only function that changes.
 */
function hasPendingPermission(_run: AttentionInput): boolean {
  return false
}

/**
 * Whether a run finished while the user was not looking.
 *
 * Still always false here, but now by DESIGN rather than for want of data. The "finished while
 * you weren't looking" question is answered by the read/unread channel (#unread-done-items):
 * `RunRecord.seenAt` + `isUnread()` in `lib/read-state.ts`. That signal is deliberately kept OFF
 * the status dot — the dot keeps saying done/failed, and unread rides the title's weight, so
 * status and "have I seen it" never collapse into one dot.
 * Routing unread through this `unseen` bucket would recolor the status dot violet, which is
 * exactly the conflation that design avoids, so the bucket stays reserved and unused.
 */
function isUnseen(_run: AttentionInput): boolean {
  return false
}

/** What attention derivation actually reads. `Pick`ed rather than the full `RunRecord` so
 *  surfaces that only have a status — the compare view's `GroupVariant` columns — can use the
 *  same canonical function instead of inventing a second status-to-tone mapping. `activity` is
 *  optional (#490), so status-only callers keep working unchanged. */
export type AttentionInput = Pick<
  RunRecord,
  'status' | 'activity' | 'autoResumeAt' | 'awaitingAnswerSince' | 'dispatch' | 'costUsd' | 'worktreeLifecycle'
>

export type BudgetStop = {
  spent: number
  ceiling: number
}

/** The dispatch brake is intentionally still an attention state: the user must decide whether
 * to send a message after spending reaches the child's ceiling. This helper only explains the
 * existing persisted brake; it does not alter the engine's stop or resume behavior. */
export function budgetStop(run: Pick<RunRecord, 'status' | 'dispatch' | 'costUsd'>): BudgetStop | undefined {
  const ceiling = run.dispatch?.overBudget ? run.dispatch.budgetUsd : undefined
  if (run.status !== 'waiting' || ceiling === undefined) return undefined
  return { spent: run.costUsd ?? 0, ceiling }
}

/**
 * A `failed` run whose session closed on an unanswered `CEZ:ASK`: no process is left, but the
 * question is still the user's. Every surface that asks "does this need you?" reads it the same way.
 */
export function isAwaitingAnswer(run: Pick<RunRecord, 'status' | 'awaitingAnswerSince'>): boolean {
  return run.status === 'failed' && run.awaitingAnswerSince !== undefined
}

/** The runs a "needs you" list keeps: waiting, in review, or awaiting an answer. */
export function isNeedsYouStatus(run: Pick<RunRecord, 'status' | 'awaitingAnswerSince' | 'worktreeLifecycle'>): boolean {
  return !!run.worktreeLifecycle?.needsAttention || run.status === 'waiting' || run.status === 'review' || isAwaitingAnswer(run)
}

/**
 * `RunRecord` → attention.
 *
 * The chain below *is* the priority order — first match wins, so `error` can never be masked by a
 * lower rung. Tones follow the mockups (`mockups/tasks-home.html`):
 *
 *  - `waiting` → amber/pending: the agent stopped and is asking you something.
 *  - `review` → violet, matching the violet PR chip beside it: there is work to look at.
 *    (The legacy UI painted both amber; the redesign splits them, per the mockup.)
 *  - `running` → violet, pulsing.
 *  - `queued` → neutral and still: parked, not transitioning. Its row shows `#2` instead.
 *  - `done`/`failed` → the green/red outcome, still.
 */
export function deriveAttention(run: AttentionInput): Attention {
  const lifecycle = run.worktreeLifecycle
  if (lifecycle?.needsAttention) return {bucket: 'waiting', tone: 'pending', pulse: false, label: lifecycle.phase === 'setup' ? 'setup needs attention' : 'cleanup needs attention'}
  if (lifecycle?.activeOperationId) return {bucket: 'running', tone: 'pending', pulse: true, label: lifecycle.phase === 'setup' ? 'preparing worktree' : 'cleaning up worktree'}
  if (hasPendingPermission(run)) {
    return { bucket: 'permission', tone: 'violet', pulse: true, label: 'needs permission' }
  }
  // A run a provider usage limit stopped is `failed` on the record, but it is not an outcome —
  // it is a task with an appointment (spec 2026-08-03-auto-resume-after-usage-limit). Painting
  // it red would report a failure that is about to undo itself, and putting it in the `error`
  // bucket would notify the user about work that needs nothing from them. It reads as parked,
  // like `queued`: amber, still, and asking for nothing. Ahead of the `failed` rung because the
  // chain is first-match-wins.
  if (run.status === 'failed' && run.autoResumeAt) {
    return { bucket: 'none', tone: 'pending', pulse: false, label: 'scheduled' }
  }
  // A session that closed on an unanswered `CEZ:ASK` — the inactivity timer, a crash, a restart —
  // is `failed` on the record because the process is gone, but the question is still the user's to
  // answer. Reporting it as a failure (or, before that, as done) hid a task that was waiting on
  // you; it wears the `waiting` rung instead, and the answer reopens the session.
  if (isAwaitingAnswer(run)) {
    return { bucket: 'waiting', tone: 'pending', pulse: true, label: 'needs you' }
  }
  if (run.status === 'failed') {
    return { bucket: 'error', tone: 'danger', pulse: false, label: 'failed' }
  }
  if (run.status === 'waiting') {
    return {
      bucket: 'waiting',
      tone: 'pending',
      pulse: true,
      label: budgetStop(run)?.ceiling !== undefined ? 'budget reached' : 'needs you',
    }
  }
  if (run.status === 'review') {
    return { bucket: 'waiting', tone: 'violet', pulse: true, label: 'needs review' }
  }
  if (run.status === 'running' && run.activity === 'monitoring') {
    // Still working, but on its OWN downstream work (a sub-agent / a monitored
    // command), not on you (#490). A sub-state of `running`, so it stays in the
    // `running` bucket — no notification, no "Needs you" — with its own label.
    return { bucket: 'running', tone: 'violet', pulse: true, label: 'monitoring' }
  }
  if (run.status === 'running') {
    return { bucket: 'running', tone: 'violet', pulse: true, label: 'running' }
  }
  if (isUnseen(run)) {
    return { bucket: 'unseen', tone: 'violet', pulse: false, label: 'unseen' }
  }
  if (run.status === 'queued') {
    return { bucket: 'none', tone: 'neutral', pulse: false, label: 'queued' }
  }
  if (run.status === 'done') {
    return { bucket: 'none', tone: 'success', pulse: false, label: 'done' }
  }
  return { bucket: 'none', tone: 'neutral', pulse: false, label: 'cancelled' }
}

/**
 * True when a run is asking for a human: a permission prompt, an error, or a waiting/review gate.
 * This is the predicate Phase R6's notifications gate on — the spec fires them "on
 * `waiting`/`review`/failed via the attention function", which is exactly the top three rungs.
 *
 * It is deliberately *not* the sidebar's "Needs you" bucket, which is narrower (waiting/review
 * only): a failed run is worth a notification, but in the list it belongs under Recent with its
 * outcome rather than in the pile of things you can act on. See `lib/task-groups.ts`.
 */
export function wantsAttention(run: RunRecord): boolean {
  return ATTENTION_RANK[deriveAttention(run).bucket] <= ATTENTION_RANK.waiting
}
