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

/** Where the retired one-time toast (#1200) recorded itself. Still READ: a browser that saw the
 *  toast has spent one of its asks, so the dialog never opens as if it were the first. */
export const STAR_TOAST_SEEN_KEY = 'cez:star-toast-seen'

// ---- the count -------------------------------------------------------------------------------

/**
 * `842`, `1.2k`, `12.3k`, `120k`. Three significant-ish digits, never rounded UP past a
 * threshold it has not reached (`999` stays `999`, not `1.0k`), and no locale separators — the
 * chip lives in a 264 px column where a thousands separator buys nothing and costs a character.
 */
export function formatStarCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  const stars = Math.floor(count)
  if (stars < 1000) return String(stars)
  const thousands = stars / 1000
  // `toFixed` rounds half-up, which would print `1000k` at 999_950. Truncate instead: the count
  // is decoration, and understating it by a hair beats a number that cannot exist.
  const truncated = Math.floor(thousands * 10) / 10
  if (truncated < 100) return `${truncated.toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.floor(thousands)}k`
}

// ---- the ask's record ------------------------------------------------------------------------

/** `cez:star-ask` — how often this browser was asked, when, and whether it answered for good. */
export const STAR_ASK_KEY = 'cez:star-ask'

/** Proof of real use rather than a first try: this many runs ended well before we ask. */
export const STAR_ASK_MIN_SUCCESSES = 3
/** A "Maybe later" is honoured for two weeks. */
export const STAR_ASK_SNOOZE_MS = 14 * 24 * 60 * 60_000
/** Three asks, ever. Past that the chip in the sidebar is the whole request. */
export const STAR_ASK_MAX_ASKS = 3
/** "Watching" means a pointer or key moved this recently in a visible, focused window. */
export const STAR_ASK_PRESENCE_MS = 60_000
/** A success that lands while the user is away waits this long for them to come back. */
export const STAR_ASK_PENDING_MS = 30 * 60_000
/** Once everything lines up, wait this long and check again — never open under a moving click. */
export const STAR_ASK_SETTLE_MS = 1_500

export interface StarAskRecord {
  asks: number
  lastAskedAt?: string
  /** `starred` (followed the link) and `never` (said so) both end the asking for good. */
  outcome?: 'starred' | 'never'
}

/**
 * This browser's record, or `null` when it cannot be read.
 *
 * **`null` means "do not ask"** — the same fail-closed rule the toast had. Where the record cannot
 * be read it cannot be written either, so an ask there would have no memory and repeat on every
 * success. The failure mode of closed is one user who is never asked; the failure mode of open
 * is a nag.
 */
export function readStarAsk(storage: Pick<Storage, 'getItem'> | null = safeStorage()): StarAskRecord | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STAR_ASK_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<StarAskRecord>
      return {
        asks: Number.isInteger(parsed.asks) && parsed.asks! >= 0 ? parsed.asks! : STAR_ASK_MAX_ASKS,
        ...(typeof parsed.lastAskedAt === 'string' ? { lastAskedAt: parsed.lastAskedAt } : {}),
        ...(parsed.outcome === 'starred' || parsed.outcome === 'never' ? { outcome: parsed.outcome } : {}),
      }
    }
    const toast = storage.getItem(STAR_TOAST_SEEN_KEY)
    return toast === null ? { asks: 0 } : { asks: 1, lastAskedAt: toast }
  } catch {
    return null
  }
}

/** Never throws: a full quota must not take the cockpit down, and reading already fails closed. */
export function writeStarAsk(
  record: StarAskRecord,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(STAR_ASK_KEY, JSON.stringify(record))
  } catch {
    // Nothing to do: `readStarAsk` answers `null` (do not ask) wherever this keeps failing.
  }
}

/** Whether this browser may be asked now: no final answer, asks left, and any snooze over. */
export function mayAskForStar(record: StarAskRecord | null, now: number): boolean {
  if (!record || record.outcome || record.asks >= STAR_ASK_MAX_ASKS) return false
  if (!record.lastAskedAt) return true
  const last = Date.parse(record.lastAskedAt)
  return !Number.isFinite(last) || now - last >= STAR_ASK_SNOOZE_MS
}

/** How many of the listed runs ended well — the "really uses cezar" half of the gate. */
export function countSuccesses(runs: readonly Pick<RunRecord, 'status'>[] | undefined): number {
  return (runs ?? []).filter((run) => SUCCESS_STATUSES.has(run.status)).length
}

export interface PresenceInput {
  now: number
  visible: boolean
  focused: boolean
  lastInteractionAt: number
  /** A text field has focus: they are mid-thought, and a dialog would steal their keystrokes. */
  typing: boolean
  /** Something else is already asking for their attention. */
  dialogOpen: boolean
}

/** The "watching the screen" half: visible, focused, recently touched, and not busy. */
export function isUserPresent(p: PresenceInput): boolean {
  return (
    p.visible &&
    p.focused &&
    !p.typing &&
    !p.dialogOpen &&
    p.now - p.lastInteractionAt >= 0 &&
    p.now - p.lastInteractionAt <= STAR_ASK_PRESENCE_MS
  )
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
