# Deactivate a manager without deleting it (2026-11-19)

Extends `2026-10-31-managers.md`. Design page: `2026-11-19-manager-deactivate.html` (interactive mockups).
Status: **implemented** (PR #2339).

## Problem

A manager costs tokens on its own: watch checks on a cadence, saved jobs, follow-up turns when a
task it follows settles. Today the only way to make one stop is to delete it, which throws away its
chat, memory, jobs and automation links — or to hand-zero its cadence, switch each job off and turn
follow-ups off, then remember to undo all three. Users want an off switch: a laptop going to sleep,
a VPS saving cost, a manager they only need during a release.

## Model

- `Manager.inactive?: { since: string }` in `managers.json` (a user setting, like `notify`; shared
  by every cockpit on the machine). Absent = active, so every existing manager is unchanged.
- `Manager.activeSince?: string`: written on reactivation, the floor for every due time (below).
- Nothing else is touched: chat, memory (`state.json`), jobs, `cronMinutes`, `followUp`,
  connectors and automation links all stay as they were, so reactivating restores them exactly.
- `PATCH /api/v1/workspace/managers/:id { active, catchUp?: true }`; workspace route
  `POST /api/v1/workspace/managers/activity { active }` for the bulk action. Both are cockpit-only: no
  `cez-manager` tool route can change it — a manager never switches itself or another manager on.

## While inactive

"No model calls" is enforced at one gate, `enqueue`. Everything below follows from it.

| What | Inactive behaviour |
| --- | --- |
| Watch checks | Not armed: `nextDue` returns nothing, so the timer never fires for it. No snapshot is read. |
| Jobs | Do not fire. They are still listed and editable. |
| Follow-up turns | **Dropped as turns, kept as notes**: the task's card still posts (no model), and its line joins `state.notes`, so the next chat turn hears it. This is the existing `followUp: false` path. Not queued: a queue would turn into a burst of N turns on reactivation, and the catch-up check covers the gap in one. |
| Chat | `POST …/messages` and the Questions answer route answer 409 unless `reactivate: true` is sent; the cockpit asks first. |
| Check now, connector probe and call | 409 `manager inactive`. |
| Account reconnect, crash recovery, usage-limit replay | Skip inactive managers. Deactivating clears a pending replay. |
| OS notification, phone push | Off. The task's own surfaces (Questions inbox task group, Now) still show it. |
| Turn in flight when deactivated | Stopped, as Stop does; the queue is cleared. |

## Answers to the open questions

- **Tasks it started** keep running: they are independent runs. Their status cards keep posting to
  the manager's chat (server-written, no model), and anything waiting on the user surfaces through
  the task's own Questions inbox group and Now, as for any task.
- **Approvals** stay answerable and keep counting in the Approvals badge: `decide` performs the merge
  or enable itself and only leaves a note, so it costs nothing. The card says "Manager inactive — it
  hears your decision when reactivated."
- **Questions** stay visible, marked "manager inactive", but drop out of the Questions badge. Two
  ways out: **Dismiss** works as is — `dismissAsk` closes the card and leaves a note, no model call,
  and the manager stays inactive; its option chips stay tappable, but an answer is a chat
  turn, so a tap first asks **Reactivate and answer?** with the chosen answer shown.
- **Automations that report to it** still run and still post their report into its chat (no model);
  the unread dot shows grey.
- **Sending a message**: the composer stays usable; Send reads **Reactivate and send** and opens a
  one-step confirm. Not blocked (hostile) and not queued (a state with no exit).
- **Reactivation** is quiet by default. The server posts one "While inactive" divider counting task
  updates, automation reports, and skipped checks and job runs (no model). An unticked **Catch me up**
  checkbox in the reactivate dialog runs one forced check: one model call, chosen by the user.
  Every due time is floored at `activeSince`, so overdue jobs do not fire in a burst.
- **Toggle**: gear menu (above Delete…), sidebar row context menu (right-click and the hover ⋯), the
  folded rail's context menu, the phone chat's gear sheet, and Settings → Manager. Deactivating
  always confirms and lists what stops.
- **Bulk**: the sidebar's Managers heading menu and Settings → Manager offer **Deactivate all…** /
  **Reactivate all**. Cheap: it is a loop over the same PATCH.

## Appearance

The avatar is greyscale at reduced opacity with a small pause badge (colour is never the only cue).
The name turns muted, the preview line reads "Inactive · since 14:02", and inactive managers sort
after active ones under a thin divider. The same component is used everywhere it renders: sidebar,
folded rail, manager index and CezarBot home, Questions and Approvals source blocks, the notch.

## Tests (phase 2)

- Engine, fake clock: an inactive manager with a cadence and two jobs, clock moved past every due
  time; `tick` enqueues nothing and the runner factory is never called.
- A followed task settles while inactive: the card posts, the note is kept, no follow-up turn.
- Chat and Check now return 409; chat with `reactivate: true` reactivates and runs one turn.
- Reactivate: no immediate turn without `catchUp`; with it, exactly one forced watch; the next job
  fires at `activeSince + everyMinutes`, not at once.
- Dismissing an inactive manager's question closes it with no turn and leaves it inactive.
- Cockpit: the grey avatar and badge, the confirm flow, the Questions badge exclusion.
