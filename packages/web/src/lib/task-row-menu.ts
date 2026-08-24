import type { RunRecord } from '@open-mercato/cezar-api-client'

import { isUnread } from '@/lib/read-state'
import { runActionFlags } from '@/routes/task-thread/run-actions'

/**
 * What the sidebar row's right-click menu offers, as a pure function of the record.
 *
 * The *policy* is not restated here: which actions a run can take is already
 * `runActionFlags` (`routes/task-thread/run-actions.ts`), the table-tested rule the run header's
 * buttons read, and a second copy of "may this be deleted?" is exactly how two surfaces come to
 * disagree. What this module adds is what is genuinely new to a MENU: the item order, the label
 * each item wears (Archive vs Unarchive, Mark read vs Mark unread — the record says which), and
 * which items are destructive enough to confirm first.
 *
 * Pure and table-tested like the other `lib/*` deciders, so the component below it is markup.
 */

/** The verbs a row offers. Each maps to exactly one endpoint in `components/task-row-menu.tsx`. */
export type TaskRowAction =
  | 'rename'
  | 'archive'
  | 'unarchive'
  | 'mark-read'
  | 'mark-unread'
  | 'cancel'
  | 'delete'

export interface TaskRowMenuItem {
  action: TaskRowAction
  /** Exactly what the item says — the run header's wording, so the two surfaces read alike. */
  label: string
  /** Confirm before running, and paint in the danger tone. */
  destructive: boolean
  /** A separator belongs ABOVE this item. Carried here rather than derived in the component so
   *  the grouping is part of the table test — an item that moves group is a visible change. */
  startsGroup: boolean
}

/**
 * The menu for one run, in display order: rename, then the "file it away" group (read state and
 * the archive), then the destructive group (cancel or delete — `runActionFlags` makes those two
 * mutually exclusive, so the group is never both).
 *
 * Rename is unconditional. Every other item asks `runActionFlags` first, which is why a running
 * task offers Cancel and no Delete, an archived one offers Unarchive and no Mark unread, and a
 * queued one offers neither of the read actions: it has not finished, so there is no outcome to
 * have seen or missed.
 */
export function taskRowMenuItems(run: RunRecord): TaskRowMenuItem[] {
  const flags = runActionFlags(run)
  const items: TaskRowMenuItem[] = [
    // A title is the one thing every run has, whatever it is doing, and `PATCH /runs/:id` takes
    // it in any status — so the action the brief actually asked for is never missing.
    { action: 'rename', label: 'Rename', destructive: false, startsGroup: false },
  ]

  // Read state, both directions. The run header only offers "Mark unread"; the menu offers its
  // inverse too, because the sidebar is where you SEE the unread marker, so the sidebar is where
  // "yes, I have dealt with that one" wants to be — the same pairing the global Tasks page has.
  if (isUnread(run)) {
    items.push({ action: 'mark-read', label: 'Mark read', destructive: false, startsGroup: true })
  } else if (flags.markUnread) {
    items.push({ action: 'mark-unread', label: 'Mark unread', destructive: false, startsGroup: true })
  }

  if (flags.archive) {
    items.push({
      action: run.archived ? 'unarchive' : 'archive',
      label: run.archived ? 'Unarchive' : 'Archive',
      destructive: false,
      // Only when it is the group's first item — a menu with no read action still wants the
      // separator between "rename" and "file it away", and never two rules in a row.
      startsGroup: !items.some((item) => item.startsGroup),
    })
  }

  if (flags.cancel) {
    items.push({ action: 'cancel', label: 'Cancel', destructive: true, startsGroup: true })
  }
  if (flags.deleteRun) {
    items.push({ action: 'delete', label: 'Delete', destructive: true, startsGroup: true })
  }

  return items
}
