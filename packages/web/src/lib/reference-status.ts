import type { ReferenceStatus } from '@open-mercato/cezar-api-client'

/**
 * What each PR/issue status MEANS, in one table.
 *
 * Split from the chip that paints it so the words and the tone are data, not JSX: the same
 * eleven statuses are read by the chip, by its tooltip, and by the tests that pin them, and a
 * status whose color says "fine" while its sentence says "blocked" is the exact defect a shared
 * table prevents.
 *
 * `tone` names a role, never a color — `danger` is what the token sheet paints red today. The
 * five roles are the design system's own status vocabulary (see `StatusDot`), so a status can
 * only ever look like something the cockpit already looks like.
 */
export interface ReferenceStatusPresentation {
  /** The two or three words the tooltip leads with. Sentence case, never shouted. */
  label: string
  /** Why that word, in one clause — what the tooltip adds over the color. */
  hint: string
  tone: ReferenceStatusTone
}

export type ReferenceStatusTone =
  | 'success'
  | 'danger'
  | 'violet'
  | 'neutral'
  | 'pending'
  | 'info'
  | 'conflict'

export const REFERENCE_STATUS: Record<ReferenceStatus, ReferenceStatusPresentation> = {
  // ---- pull requests --------------------------------------------------------------------
  draft: {
    label: 'Draft',
    hint: 'the author has not marked it ready for review',
    // Neutral, not amber: a draft is not in progress towards anything, it is parked.
    tone: 'neutral',
  },
  'review-required': {
    label: 'Waiting for review',
    hint: 'checks are fine, no one has reviewed it yet',
    // NOT violet, which is where `merged` and `completed` live: this one is waiting on a person
    // and that is the opposite of finished. Blue is the only hue the cockpit does not otherwise
    // use, so it reads as its own thing at a glance rather than as a shade of done.
    tone: 'info',
  },
  'changes-requested': {
    label: 'Changes requested',
    hint: 'a reviewer asked for edits before this can merge',
    tone: 'danger',
  },
  'checks-pending': {
    label: 'Checks running',
    hint: 'CI has not finished on the latest commit',
    tone: 'pending',
  },
  'checks-failing': {
    label: 'Checks failing',
    hint: 'CI is red on the latest commit',
    tone: 'danger',
  },
  ready: {
    label: 'Ready to merge',
    hint: 'open, checks pass, nothing is waiting on a reviewer',
    tone: 'success',
  },
  merged: {
    label: 'Merged',
    hint: 'this landed on its base branch',
    tone: 'violet',
  },
  closed: {
    label: 'Closed',
    hint: 'closed without merging — the work did not land',
    tone: 'danger',
  },
  // ---- issues ---------------------------------------------------------------------------
  open: {
    label: 'Open',
    hint: 'still open on the tracker',
    tone: 'success',
  },
  completed: {
    label: 'Closed as completed',
    hint: 'the issue was resolved',
    tone: 'violet',
  },
  'not-planned': {
    label: 'Closed as not planned',
    hint: 'the issue was declined — nothing shipped for it',
    tone: 'neutral',
  },
}

/**
 * The OTHER axis, in the same shape: a pull request whose branch no longer merges into its base.
 *
 * It sits BESIDE the table rather than in it because it is not one of the eleven. Those answer
 * "whose move is it" and are mutually exclusive; this is a second fact that can be true alongside
 * any of them — most sharply alongside `ready`, whose whole sentence ("open, checks pass, nothing
 * is waiting on a reviewer") stays true of a pull request GitHub will not merge. That pair is what
 * this was reported for.
 *
 * It is still painted on the SAME chip — the one that links to the pull request — because a
 * reference has one chip and this is that reference's state. What it takes over is the colour, the
 * glyph and the tooltip's headline; the status it overrode keeps its own line in that tooltip, so
 * nothing is lost by showing the blocker first.
 *
 * `conflict` and not `danger`: red already says "the checks failed" and "a reviewer asked for
 * changes" on these very chips, and a third meaning on one colour is how a colour stops meaning
 * anything. Not `pending` either — nothing resolves this on its own. It is the author's move.
 */
export const REFERENCE_CONFLICT: ReferenceStatusPresentation = {
  label: 'Merge conflicts',
  hint: 'this branch no longer merges cleanly into its base — rebase or merge the base in',
  tone: 'conflict',
}

/**
 * Is this one of the eleven statuses this bundle knows how to paint?
 *
 * The guard exists because the vocabulary is documented as ADDITIVE
 * (`BACKWARD_COMPATIBILITY.md`, `/github/ref-status`): a newer server may answer with a value
 * added after this bundle was built, and a `sessionStorage` payload written by a newer bundle
 * outlives a rollback in the same tab. Both must land on the neutral chip the cockpit painted
 * before statuses existed — the promise the compatibility entry makes — rather than on a
 * `REFERENCE_STATUS[status]` that is `undefined` and a render that throws.
 */
export function isReferenceStatus(value: unknown): value is ReferenceStatus {
  return typeof value === 'string' && Object.hasOwn(REFERENCE_STATUS, value)
}

/** What a status looks like, or `undefined` for one this bundle does not know (see
 *  `isReferenceStatus`). The one lookup every caller should use — indexing `REFERENCE_STATUS`
 *  directly types the miss away without removing it. */
export function referenceStatusPresentation(
  status: ReferenceStatus | undefined,
): ReferenceStatusPresentation | undefined {
  return status !== undefined && isReferenceStatus(status) ? REFERENCE_STATUS[status] : undefined
}

/** The tooltip's full sentence: `Merged — this landed on its base branch`. */
export function referenceStatusText(status: ReferenceStatus): string {
  const { label, hint } = REFERENCE_STATUS[status]
  return `${label} — ${hint}`
}
