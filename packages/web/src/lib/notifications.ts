import type { RunRecord, RunStatus } from '@open-mercato/cezar-api-client'
import { deriveAttention, wantsAttention } from './attention'

/* Browser notifications (R6 Step 1.7, spec §"Cross-cutting"): the pure half.
 *
 * The spec's sentence, verbatim: "browser Notification on `waiting`/`review`/failed via the
 * attention function — off by default, Settings toggle". Every decision here is one of those
 * clauses made executable:
 *
 *  - "via the attention function": the entering-set below is `wantsAttention` (lib/attention.ts),
 *    never a local status list — the one status grammar the whole cockpit shares.
 *  - "off by default": `normalizeNotifications` answers `enabled: false` for anything but the
 *    literal `true`, so an absent key, an old ui-state.json and garbage all mean off.
 *  - Fires only when the tab is hidden, and only with permission granted: `shouldNotify` — a
 *    visible cockpit already shows the pulsing dot, and a denied permission must degrade to
 *    silence, not to a throw.
 *
 * The impure sliver (constructing `Notification`, reading `document.visibilityState`) lives in
 * `components/run-notifications.tsx`; everything here is table-testable with plain values.
 */

// ---- the ui-state preference (`notifications` key, ADDITIVE) ------------------------------

export interface NotificationsPref {
  enabled: boolean
}

/** Off by default — the spec's word. */
export const DEFAULT_NOTIFICATIONS: NotificationsPref = { enabled: false }

/** The `notifications` key of a ui-state payload, coerced. Only the literal `true` enables:
 *  the server's ui-state schema is a passthrough, so this can meet any shape ever written. */
export function normalizeNotifications(raw: unknown): NotificationsPref {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { enabled: obj.enabled === true }
}

// ---- permission, with "no API at all" as a first-class answer ------------------------------

/** `Notification.permission`, plus the case the DOM type omits: a browser (or a jsdom/happy-dom
 *  test) with no `Notification` constructor at all. */
export type NotificationSupport = NotificationPermission | 'unsupported'

/** Read the current permission without ever touching the constructor — calling it (or
 *  `requestPermission`) is the enable flow's job, and ONLY the enable flow's (spec:
 *  "permission requested on enable only"). */
export function notificationSupport(): NotificationSupport {
  const N: unknown = (globalThis as { Notification?: unknown }).Notification
  if (typeof N !== 'function') return 'unsupported'
  const permission = (N as { permission?: unknown }).permission
  return permission === 'granted' || permission === 'denied' ? permission : 'default'
}

// ---- transition detection ------------------------------------------------------------------

export interface RunTransitions {
  /** Runs that ENTERED an attention state in this observation — the ones worth a notification. */
  entering: RunRecord[]
  /** The statuses to remember for the next observation. Rebuilt each time, so deleted runs
   *  fall out instead of accumulating forever. */
  statuses: Map<string, RunStatus>
}

/**
 * Diff one observation of the run list against the last known statuses.
 *
 * "Entering" is literal: a run notifies only when its status CHANGED into one that
 * `wantsAttention` — the top rungs of the attention ladder (permission/error/waiting-review),
 * exactly the spec's `waiting`/`review`/failed set. Two silences are deliberate:
 *
 *  - a run seen for the first time never notifies, whatever its status. First sight is the
 *    boot fetch or a reconnect reconciliation seeding the cache — a run that has been sitting
 *    in `waiting` for an hour is the dot's job, not a fresh "ding";
 *  - an unchanged status never notifies: a live run re-announces itself on every token tick,
 *    and each of those events is the same state, not a transition.
 *
 * A CHANGED status that still wants attention does notify (`waiting` → `failed`: the agent gave
 * up while you were away — that is news, not a repeat).
 */
export function diffRunTransitions(
  previous: ReadonlyMap<string, RunStatus>,
  runs: readonly RunRecord[] | undefined,
): RunTransitions {
  const statuses = new Map<string, RunStatus>()
  const entering: RunRecord[] = []
  for (const run of runs ?? []) {
    statuses.set(run.id, run.status)
    const before = previous.get(run.id)
    if (before === undefined || before === run.status) continue
    if (wantsAttention(run)) entering.push(run)
  }
  return { entering, statuses }
}

// ---- the gate ------------------------------------------------------------------------------

/**
 * Whether a detected transition may become a `Notification`. All three clauses of the spec's
 * gating, in one predicate: the toggle (off by default), the hidden tab (a visible cockpit
 * already shows the dot), and a granted permission (denied/default/unsupported all degrade to
 * silence — never a request from here, and never a throw).
 */
export function shouldNotify(gate: {
  enabled: boolean
  hidden: boolean
  permission: NotificationSupport
}): boolean {
  return gate.enabled && gate.hidden && gate.permission === 'granted'
}

// ---- content -------------------------------------------------------------------------------

export interface RunNotificationContent {
  title: string
  body: string
  /** Stable per run, so a second transition REPLACES the first notification instead of piling
   *  up one per status change of the same run. */
  tag: string
}

/** What the notification says: the run's display title (#389: `titleSummary ?? title`) and the
 *  attention label — the same phrase the dot's tooltip uses, from the same one function. */
export function describeRunNotification(run: RunRecord): RunNotificationContent {
  const label = deriveAttention(run).label
  return {
    title: run.titleSummary ?? run.title,
    body: `Task ${label}`,
    tag: `cezar-run-${run.id}`,
  }
}
