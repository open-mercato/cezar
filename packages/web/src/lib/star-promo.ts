import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'

/**
 * The star ask's pure half: how the count is written, when the one-time toast may fire, and the
 * flag that guarantees it fires once.
 *
 * The whole feature is a request. Nothing here gates, delays, or degrades anything for a user
 * who never clicks — there is no reward path to get wrong, and no code that asks whether they
 * did. The impure slivers (the `<StarPromo />` watcher, the sidebar chip) live in components;
 * everything in this file is table-testable with plain values.
 */

/** Where every surface of the ask points. */
export const CEZAR_REPO_URL = 'https://github.com/open-mercato/cezar'

/**
 * The toast, from the brief (rendered in English like the rest of the cockpit, which has no i18n
 * layer): "Pierwszy PR gotowy 🎉 Jeśli cezar oszczędził Ci czas, gwiazdka pomaga innym go
 * znaleźć".
 */
export const STAR_TOAST_MESSAGE =
  'First PR ready 🎉 If cezar saved you time, a star helps others find it'

/**
 * The same ask for a run that finished without opening a PR.
 *
 * The brief named the TRIGGER as the first successful run and the COPY as "first PR ready", and
 * in cezar those are not the same event: a run ends at the review gate with its diff in the
 * worktree, and pushing a draft PR is a separate, optional step. Most first runs have no PR.
 * Celebrating one that does not exist is the kind of small lie that costs exactly the goodwill
 * this toast is asking for, so the opening clause follows the truth and the ask — the half that
 * is always true — is word-for-word the same.
 */
export const STAR_TOAST_MESSAGE_NO_PR =
  'First task done 🎉 If cezar saved you time, a star helps others find it'

/** Which of the two the moment earns. */
export function starToastMessage(withPullRequest: boolean): string {
  return withPullRequest ? STAR_TOAST_MESSAGE : STAR_TOAST_MESSAGE_NO_PR
}
export const STAR_TOAST_ACTION_LABEL = 'Star on GitHub'
/** Longer than an ordinary toast: this one asks the reader to do something, and the default five
 *  seconds is tuned for "that worked", not for a sentence plus a decision. Still auto-dismissing
 *  — an ask that has to be closed by hand is a modal wearing a toast's clothes. */
export const STAR_TOAST_MS = 12_000

/** `cez:star-toast-seen`. Namespaced like the cockpit's other local keys. */
export const STAR_TOAST_SEEN_KEY = 'cez:star-toast-seen'

// ---- the count -------------------------------------------------------------------------------

/**
 * `842`, `1.2k`, `12.3k`, `120k`. Three significant-ish digits, never rounded UP past a
 * threshold it has not reached (`999` stays `999`, not `1.0k`), and no locale separators — the
 * chip lives in a 264 px column where a thousands separator buys nothing and costs a character.
 */
export function formatStarCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  const n = Math.floor(count)
  if (n < 1000) return String(n)
  const thousands = n / 1000
  // `toFixed` rounds half-up, which would print `1000k` at 999_950. Truncate instead: the count
  // is decoration, and understating it by a hair beats a number that cannot exist.
  const truncated = Math.floor(thousands * 10) / 10
  if (truncated < 100) return `${truncated.toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.floor(thousands)}k`
}

// ---- the one-time flag -----------------------------------------------------------------------

/**
 * Whether the toast has already been shown in this browser.
 *
 * **Every failure answers `true`.** A private window, a disabled store, a quota-full origin — in
 * all of them the flag cannot be written, so a `false` here would mean the toast fires again on
 * the next successful run, and the next, forever. The failure mode of "seen" is one user who
 * never gets the ask; the failure mode of "not seen" is a nag. Only one of those is acceptable
 * for something billed as a single request.
 */
export function hasSeenStarToast(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  if (!storage) return true
  try {
    return storage.getItem(STAR_TOAST_SEEN_KEY) !== null
  } catch {
    return true
  }
}

/** Records the toast as shown. Called BEFORE the toast is published, so a write that throws
 *  halfway cannot leave a shown-but-unrecorded state. */
export function markStarToastSeen(storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STAR_TOAST_SEEN_KEY, new Date().toISOString())
  } catch {
    // Nothing to do and nothing to report: `hasSeenStarToast` already fails closed.
  }
}

/**
 * `localStorage`, or `null` where touching it throws (some privacy modes throw on the property
 * access itself, before any method call).
 *
 * `null` rather than `undefined` on purpose: `undefined` is what a default parameter consumes,
 * so a caller saying "there is no storage here" with `undefined` would silently get the real
 * one back — which is precisely the case the fail-closed rule above exists for.
 */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// ---- the trigger -----------------------------------------------------------------------------

/**
 * A run that finished well. `review` counts alongside `done` because cezar's review gate IS the
 * success shape for a changed run — headless `cezar run` exits 0 on it, and it is the status a
 * run that produced a PR parks in. A run the user cancelled or that failed is not a moment to
 * ask them for anything.
 */
const SUCCESS_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'review'])

export interface SuccessTransition {
  /** `true` when some run ENTERED a successful terminal status in this observation. */
  succeeded: boolean
  /** Whether one of those runs actually opened a pull request — which of the two messages the
   *  moment has earned. `false` when it succeeded without one, which is the common case. */
  withPullRequest: boolean
  /** The statuses to remember for the next observation. Rebuilt each time, so deleted runs fall
   *  out instead of accumulating. */
  statuses: Map<string, RunStatus>
}

/**
 * Diff one observation of the run list, exactly as `diffRunTransitions` does for notifications,
 * and for the same two reasons:
 *
 *  - a run seen for the FIRST time never counts. First sight is the boot fetch or a reconnect
 *    reconciliation seeding the cache, so a user opening the cockpit on a week of finished work
 *    is not greeted by a toast about a run from Tuesday;
 *  - an unchanged status never counts. A finished run re-announces itself on every refetch, and
 *    that is the same state, not a transition.
 */
export function diffSuccessTransition(
  previous: ReadonlyMap<string, RunStatus>,
  runs: readonly RunRecord[] | undefined,
): SuccessTransition {
  const statuses = new Map<string, RunStatus>()
  let succeeded = false
  let withPullRequest = false
  for (const run of runs ?? []) {
    statuses.set(run.id, run.status)
    const before = previous.get(run.id)
    if (before === undefined || before === run.status) continue
    if (!SUCCESS_STATUSES.has(run.status)) continue
    succeeded = true
    // Two runs can land in one observation. A PR is the more specific thing to celebrate, so
    // any of them having one wins — never the last one seen.
    if (run.pullRequestUrl) withPullRequest = true
  }
  return { succeeded, withPullRequest, statuses }
}
