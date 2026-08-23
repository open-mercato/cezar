import type { RunRecord } from '@open-mercato/cezar-api-client'
import { canBeUnread, isUnread } from '@/lib/read-state'
import { FINISHED_STATUSES } from '@/lib/tasks-table'

/**
 * The pure half of selecting rows in the Tasks table and editing them together: what a click on a
 * checkbox does, what the header checkbox says, and which bulk actions a given selection can
 * actually carry out.
 *
 * Pure on the same terms as `lib/tasks-table.ts` and `lib/task-groups.ts` — no React, no router,
 * no clock — because this is the behavior worth testing as a table, and because getting it wrong
 * is not cosmetic: a bulk action is N irreversible-ish writes at once.
 *
 * Two decisions the whole module rests on:
 *
 * 1. **A selection is a set of ids, and it is always read against the rows CURRENTLY ON SCREEN.**
 *    Nothing here trusts the set on its own. Rows leave the view constantly — a filter is typed,
 *    a status changes under an SSE patch, a run is archived — and an id that outlived its row
 *    must not be able to act. `selectionSummary` intersects the set with the visible list, and
 *    every action is built from that intersection, so a stale id is inert rather than dangerous.
 * 2. **An action offers itself only for the rows it would actually change.** Archiving a
 *    selection of five where two are already archived is a three-row action, and it says three.
 *    The alternative — sending five requests and calling two of them successes — reports work
 *    that never happened.
 */

/** The bulk edits the Tasks table offers. Deliberately the set that is undoable in one click:
 *  archive/restore are each other's inverse, and so are read/unread. Cancelling or deleting a
 *  batch of runs is not here — neither is reversible, and neither was asked for. */
export type BulkActionId = 'archive' | 'restore' | 'read' | 'unread'

/** Every action id, in the order the bar offers them. Exported so the bar renders from one list
 *  rather than a hand-written row that can drift from this module. */
export const BULK_ACTION_IDS: readonly BulkActionId[] = ['archive', 'restore', 'read', 'unread']

/**
 * Which runs, of those selected, each action would actually change.
 *
 * The gates are the SAME ones the single-row actions use elsewhere in the cockpit, deliberately:
 *
 *  - `archive` — not archived yet, and finished (`FINISHED_STATUSES`). A `review` run still wants
 *    a human, and the "Archive finished" broom has always refused to sweep one; a checkbox must
 *    not become the way around that rule.
 *  - `restore` — currently archived. No status gate: bringing a row back is undoing your own
 *    filing, and it is always safe.
 *  - `read` — currently unread (`isUnread`).
 *  - `unread` — currently read AND eligible to be unread at all (`canBeUnread`), which excludes
 *    cancelled, archived and still-running rows.
 */
export type BulkActionTargets = Record<BulkActionId, RunRecord[]>

export function bulkActionTargets(runs: readonly RunRecord[]): BulkActionTargets {
  return {
    archive: runs.filter((run) => !run.archived && FINISHED_STATUSES.has(run.status)),
    restore: runs.filter((run) => run.archived),
    read: runs.filter((run) => isUnread(run)),
    unread: runs.filter((run) => canBeUnread(run) && !isUnread(run)),
  }
}

/** What the header checkbox is: every visible row picked, some of them, or none. `some` is the
 *  indeterminate state — a real third value, not "not all", which is why it is spelled out. */
export type HeaderSelectionState = 'all' | 'some' | 'none'

export interface SelectionSummary {
  /** Selected AND still on screen — the only rows any action ever touches (see the module note). */
  runs: RunRecord[]
  /** How many of those there are — the number the bar prints. */
  count: number
  state: HeaderSelectionState
  /** What each action would change, already narrowed to `runs`. */
  targets: BulkActionTargets
}

/**
 * The whole selection, resolved against what is on screen.
 *
 * Computed in one pass and handed to the component as one object rather than four hooks, so the
 * bar's count, its per-action counts and the header checkbox can never be computed from three
 * different snapshots of the same list.
 */
export function selectionSummary(
  visible: readonly RunRecord[],
  selected: ReadonlySet<string>,
): SelectionSummary {
  const runs = visible.filter((run) => selected.has(run.id))
  const state: HeaderSelectionState =
    runs.length === 0 ? 'none' : runs.length === visible.length ? 'all' : 'some'
  return { runs, count: runs.length, state, targets: bulkActionTargets(runs) }
}

/** Tick or untick one row. A new Set, so React sees a change; the caller's is untouched. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next
}

/**
 * What the header checkbox does, given what it currently says.
 *
 * Only ever over the VISIBLE rows: select-all under a filter means "all of these", never "all
 * the tasks in the project, including the ones the filter is hiding" — the second reading is how
 * a bulk archive swallows rows nobody looked at.
 *
 * `some` clears rather than completes, matching every list that has ever had a tri-state header
 * box: the indeterminate box is a partial selection, and the escape from one is emptying it.
 */
export function toggleAllVisible(
  visible: readonly RunRecord[],
  selected: ReadonlySet<string>,
): Set<string> {
  const { state } = selectionSummary(visible, selected)
  if (state === 'none') {
    const next = new Set(selected)
    for (const run of visible) next.add(run.id)
    return next
  }
  // Drop exactly the visible ids. A selection made before a filter narrowed the list survives —
  // it is not on screen, so it cannot act, and re-widening the filter gets it back.
  const next = new Set(selected)
  for (const run of visible) next.delete(run.id)
  return next
}

/** An empty selection — the state the bar hides in, and what a completed bulk action returns to. */
export const NO_SELECTION: ReadonlySet<string> = new Set<string>()

/** Past tense, per action: what the receipt says a bulk edit DID. */
const BULK_DONE_VERB: Record<BulkActionId, string> = {
  archive: 'Archived',
  restore: 'Restored',
  read: 'Marked read',
  unread: 'Marked unread',
}

/**
 * The receipt a bulk edit leaves in a toast.
 *
 * A bulk action is N independent requests, and N requests can fail independently — so the message
 * has to be able to say "some". Reporting a flat success over a batch where two writes were
 * refused claims work that never happened, and reporting a flat failure hides the writes that
 * landed; both leave the reader with a list they cannot trust. The first failure's reason rides
 * along because with a local server it is nearly always the same reason for all of them, and it
 * is the only thing that makes the failure actionable.
 */
export function bulkResultMessage(
  action: BulkActionId,
  total: number,
  failures: readonly string[],
): string {
  const verb = BULK_DONE_VERB[action]
  const noun = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`
  if (failures.length === 0) return `${verb} ${noun(total)}.`
  const reason = failures[0]
  return `${verb} ${total - failures.length} of ${noun(total)} — ${failures.length} failed${
    reason ? `: ${reason}` : ''
  }`
}
