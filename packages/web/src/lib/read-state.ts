import type { RunRecord } from '@open-mercato/cezar-api-client'

/**
 * The read/unread grammar for *done items* (#unread-done-items) — the email-style "which
 * finished tasks still need my eyes?" signal.
 *
 * Deliberately UI-free and a SEPARATE channel from `lib/attention.ts`: the status dot keeps
 * saying done/failed, and unread rides its own trailing violet marker + weight (the approved
 * "Option B"), so "what happened" and "have I seen it" never collapse into one dot. Pure and
 * table-tested (`read-state.test.ts`), like the other `lib/*` deciders, so the sidebar row, the
 * Tasks table, the mobile card and the nav badge all read one answer and can never disagree.
 */

/** The terminal statuses a *done item* can be — the sidebar's "Recent" set. */
const DONE_STATUSES: readonly RunRecord['status'][] = ['done', 'failed', 'cancelled']

/** The subset that can carry an *unread* marker. Cancelled is excluded on purpose: you stopped
 *  the run yourself, so there is nothing you "haven't seen". */
const UNREAD_ELIGIBLE: readonly RunRecord['status'][] = ['done', 'failed']

/** What the read/unread rule reads — `Pick`ed (like `AttentionInput`) so a test or a partial
 *  record can call it without a full `RunRecord`. */
export type ReadStateInput = Pick<
  RunRecord,
  'status' | 'finishedAt' | 'seenAt' | 'archived' | 'autoResumeAt'
>

/**
 * A run stopped by a provider usage limit with a resume already scheduled (spec
 * 2026-08-03-auto-resume-after-usage-limit).
 *
 * It is `failed` on the record, but it is not a *done item*: it has an appointment to pick the
 * work back up, so neither half of this grammar applies — there is no outcome to have missed
 * (no unread marker, no nav-badge count) and no history to dim (not a read done item). The
 * status dot says `scheduled` for the same reason (`lib/attention.ts`).
 */
function isScheduledResume(run: ReadStateInput): boolean {
  return run.status === 'failed' && run.autoResumeAt !== undefined
}

/** A finished run — done, failed, or cancelled. These are the rows the read/unread treatment
 *  applies to (the "Recent" bucket); everything else carries its live attention signal instead. */
export function isDoneItem(status: RunRecord['status']): boolean {
  return DONE_STATUSES.includes(status)
}

/**
 * Whether a run is *eligible* to wear the unread marker at all — the receipt-independent half
 * of `isUnread`:
 *  - only `done`/`failed` runs qualify (cancelled is self-initiated, so never unread);
 *  - a usage-limit failure with a resume already scheduled is not a done item at all
 *    (`isScheduledResume`) — there is no outcome to have missed yet, so it can neither wear
 *    the marker nor be put back into it;
 *  - it must actually have finished (`finishedAt`) — a record caught mid-transition is not yet
 *    a done item;
 *  - archived runs are never unread: archiving is a stronger "I'm done with this" than reading.
 *
 * Split out (#775) because "Mark unread" needs exactly this question minus the receipt: the
 * action is offered for a run that is currently read AND *could* be unread, which is
 * `canBeUnread(run) && !isUnread(run)`. `isReadDoneItem` cannot answer it — that one is true
 * for cancelled and archived rows too, neither of which can ever go unread. Exported rather
 * than restated in `run-actions.ts` so the eligibility rule keeps exactly one definition.
 */
export function canBeUnread(run: ReadStateInput): boolean {
  if (run.archived) return false
  if (isScheduledResume(run)) return false
  if (!UNREAD_ELIGIBLE.includes(run.status)) return false
  return run.finishedAt !== undefined
}

/**
 * Whether a done item is *unread*: a finished run you have not opened since it finished.
 *
 * Eligible (`canBeUnread` above) and unread until seen SINCE it finished. Comparing
 * `seenAt < finishedAt` (not merely "has a receipt") is what makes a resumed-and-re-finished
 * run go unread again for free — its `finishedAt` moves past the old receipt. An explicit
 * "Mark unread" (#775) takes the other road: it *clears* the receipt, and an absent one is
 * unread by this same clause.
 *
 * ISO-8601 strings compare lexicographically because every timestamp cezar writes is UTC
 * (`toISOString()` → trailing `Z`), so `<` on the strings is `<` on the instants.
 */
export function isUnread(run: ReadStateInput): boolean {
  // Read into a local so the narrowing survives the `canBeUnread` call, which checks the same
  // clause but cannot narrow the caller's field.
  const finishedAt = run.finishedAt
  if (finishedAt === undefined) return false
  if (!canBeUnread(run)) return false
  return run.seenAt === undefined || run.seenAt < finishedAt
}

/**
 * A *read* done item: a finished row that is not unread — a done/failed run you have already
 * opened, or a cancelled run (never unread). This is what the treatment dims: the read history
 * steps back so the unread rows read at a glance. Non-finished rows are never "read" — they show
 * their live attention state, not a past outcome — so they are excluded here.
 */
export function isReadDoneItem(run: ReadStateInput): boolean {
  if (isScheduledResume(run)) return false
  return isDoneItem(run.status) && !isUnread(run)
}

/** How many done items are unread — the Tasks nav badge's number. Archived runs are already
 *  excluded by `isUnread`, so this counts exactly the rows that wear the unread marker. */
export function unreadDoneCount(runs: readonly ReadStateInput[]): number {
  return runs.reduce((total, run) => (isUnread(run) ? total + 1 : total), 0)
}
