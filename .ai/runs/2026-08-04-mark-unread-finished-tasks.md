# Execution plan — "Mark unread" for finished tasks (#775)

**Issue:** [#775](https://github.com/open-mercato/cezar/issues/775) — Implement: "Mark unread" for finished tasks
**Branch:** `feat/mark-unread-finished-tasks`
**Base:** `main`

## Goal

Give a finished task an explicit way *back* into the unread list — the "mark as unread" twin of
the read receipt #767 shipped — so a task you opened but do not want to lose can return to the
unread list and be picked up later.

## Scope

Today the read state is write-once-forward: `seenAt` is only ever *stamped*, by opening a thread
(`POST /runs/:id/read`) or by the `read-all` sweep. `isUnread` already reads "absent or stale
receipt", so **unread is fully expressible today** — there is simply no user-reachable way to get
back into it. Clearing the receipt is therefore the entire server-side change; no new field, no
migration.

In scope:

- `RunStore.setUnread(id)` — clear the receipt, `touch`, return the record.
- `POST /api/v1/runs/:id/unread` — bodyless mirror of `/runs/:id/read`, 404 on unknown id.
- `BACKWARD_COMPATIBILITY.md` §2 route inventory gains `unread` (the drift guard in
  `bc-route-inventory.test.ts` fails without it).
- Cockpit: `markRunUnseen` client call, `useMarkRunUnseen` optimistic hook, a `markUnread` action
  flag, the header control (desktop row + mobile kebab), and the auto-mark-read suppression that
  keeps the action from being instantly undone inside the open thread.

## Non-goals

Deliberately untouched, per the issue's own "Out of scope":

- A per-row "Mark unread" in the Tasks table, the sidebar quick-list or the mobile card — those
  rows have no action menu today, and adding one is its own design question.
- A bulk "Mark all unread" sweep — the inverse of a sweep has no clear use.
- The `capabilities.readState` flag (#769) — **verified not landed** on `main` at plan time
  (no `readState` anywhere in `capabilities.ts` or the cockpit), so there is nothing to gate on.
- The browser-level e2e spec — belongs with #768's `unread.e2e.ts`.

## Design decisions

1. **The server stays dumb.** Clearing a receipt is always a legal write: `setUnread` succeeds for
   any known run, including one that is already unread (idempotent) or cancelled. The "does this
   action mean anything here?" policy lives in the cockpit's `runActionFlags`, which is how this
   repo already splits server truth from UI policy.

2. **`canBeUnread` is extracted rather than restated.** `runActionFlags.markUnread` must be
   "currently read AND could be unread". `isReadDoneItem` alone cannot express that — it is true
   for cancelled and archived runs, neither of which can ever wear the marker. Rather than
   restating the eligibility clauses in `run-actions.ts`, the eligibility half of `isUnread`
   (done/failed · has `finishedAt` · not archived) is extracted into an exported `canBeUnread` in
   `lib/read-state.ts`, `isUnread` is rewritten in terms of it, and the flag becomes
   `canBeUnread(run) && !isUnread(run)`. One rule, three readers, no drift.

3. **Suppression is per-visit component state in `TaskThreadRoute`, keyed by run id.** The auto-
   mark-read effect (`task-thread.tsx` L86–L97) re-fires on every render where `isUnread` is true,
   so marking unread inside the open thread would be instantly undone. The suppression ref stores
   `{ runId, suppressed }`, which makes the reset implicit: mounting the thread for a *different*
   run (or a fresh mount for the same one) sees a non-matching entry and auto-reads normally —
   the email grammar this feature is modelled on. Passed down as an `onMarkedUnread` callback
   through `ThreadView` → `RunHeader`, optional so the three `task-git` tabs (which render the same
   header but run no auto-read effect) keep working untouched.

## Implementation Plan

### Phase 1 — Server: clear the receipt

1.1 `RunStore.setUnread(id)` in `packages/cezar/src/runs/store.ts`, directly beside `setRead`:
`delete run.seenAt`, `touch`, return the record; `undefined` for an unknown id.
1.2 `POST /api/v1/runs/:id/unread` in `packages/cezar/src/server/server.ts`, beside
`/runs/:id/read`. Bodyless, returns the updated record, `404 {error: 'not found'}` for an unknown
id. It sits under `/runs/:id/`, so the `read-all` registration-order caveat does not apply.
1.3 `BACKWARD_COMPATIBILITY.md` §2: add `unread` to the `POST /api/v1/runs/:id/{…}` brace group,
in the same commit as the route (the inventory is the contract, and its drift guard enforces it).
1.4 Tests: `store.test.ts` (clears, idempotent, unknown id, and the cleared run counts again for
`markAllRead`) and `read-run.test.ts` (route clears `seenAt`, 404s, read→unread→read round-trip).

### Phase 2 — Cockpit data layer

2.1 `canBeUnread` extracted and exported from `packages/web/src/lib/read-state.ts`, with `isUnread`
rewritten in terms of it (pure refactor — behavior identical, pinned by the existing table test).
2.2 `markRunUnseen(id)` in `packages/web/src/api/client.ts`, mirroring `markRunSeen`.
2.3 `useMarkRunUnseen()` in `packages/web/src/api/queries.ts`, mirroring `useMarkRunSeen`: cancels
both `runs.list()` and `runs.detail(id)`, optimistically *clears* `seenAt`, guarded rollback on
error so a run that could not be marked unread honestly stays read.
2.4 `markUnread` flag in `packages/web/src/routes/task-thread/run-actions.ts`.
2.5 Tests: `read-state.test.ts` rows for `canBeUnread`, `run-actions.test.ts` rows for the flag per
status (true for a read `done`/`failed` run; false while active, already unread, archived, or
`cancelled`).

### Phase 3 — Cockpit UI

3.1 `run-header.tsx`: `useRunActions` gains the `markUnread` mutation (error → danger toast, like
its siblings); the desktop actions row and the mobile `RunActionsMenu` gain a "Mark unread" entry
next to Archive, using `MailIcon` for the email metaphor the violet marker already borrows.
3.2 `task-thread.tsx`: the run-id-keyed `suppressAutoRead` ref gating the auto-mark-read effect,
plumbed to the header as `onMarkedUnread`.
3.3 Tests: `run-header.test.tsx` (the control appears only when the flag says so and fires the
mutation) and `task-thread.test.tsx` (the regression that matters — marking unread inside the open
thread is not re-stamped by the auto-read effect, and a later fresh mount does mark it read again).

### Phase 4 — Validation gate and PR

4.1 Full `validation.commands` gate: `npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`.
4.2 Labels, `om-auto-review-pr` autofix pass, summary comment.

## Risks

- **The auto-read effect undoing the action** — the one non-obvious trap, called out in the issue.
  Mitigated by the suppression ref and pinned by a named regression test in `task-thread.test.tsx`;
  without that test the feature could silently regress to looking broken.
- **`bc-route-inventory.test.ts` drift** — a new route without its §2 entry fails the suite. Landed
  in the same commit (1.3), by design.
- **`runActionFlags` matrix churn** — `run-actions.test.ts` asserts exhaustive expected objects per
  status, so the new flag touches every row. Mechanical, but it must be reviewed rather than
  bulk-edited: each row's value is a real assertion about that status.
- **Mixed-version cockpit/server** — a new cockpit against an old server 404s on the new route.
  Tracked in #769 (`capabilities.readState`), which has not landed; the mutation's guarded rollback
  means the failure mode is "the run visibly stays read", not a corrupted cache.

## Progress

PR: #776

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server — clear the receipt

- [x] 1.1 `RunStore.setUnread(id)` clears the read receipt — 6e1df428
- [x] 1.2 `POST /api/v1/runs/:id/unread` route — 6e1df428
- [x] 1.3 `BACKWARD_COMPATIBILITY.md` §2 route inventory gains `unread` — 6e1df428
- [x] 1.4 Store and route tests — 6e1df428

### Phase 2: Cockpit data layer

- [x] 2.1 Extract `canBeUnread` in `lib/read-state.ts` — d3ddd7fb
- [x] 2.2 `markRunUnseen` API client call — d3ddd7fb
- [x] 2.3 `useMarkRunUnseen` optimistic mutation hook — d3ddd7fb
- [x] 2.4 `markUnread` flag in `runActionFlags` — d3ddd7fb
- [x] 2.5 `read-state.test.ts` and `run-actions.test.ts` coverage — d3ddd7fb

### Phase 3: Cockpit UI

- [x] 3.1 "Mark unread" control in the run header (desktop row + mobile kebab) — 0a5812cd
- [x] 3.2 Per-visit auto-mark-read suppression in `task-thread.tsx` — 0a5812cd
- [x] 3.3 `run-header.test.tsx` and `task-thread.test.tsx` coverage — 0a5812cd

### Phase 4: Validation and PR

- [x] 4.1 Full validation gate green — typecheck, npm test (5320), test:unit (36), build, test:package (12)
- [x] 4.2 Labels, review pass, summary comment
- [x] Post-review fix: pin the read/unread routes in contract-parity + correct the `seenAt` docs — 50828a46
