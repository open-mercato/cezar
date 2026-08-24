# Execution plan — right-click task menu in the sidebar (rename, archive, and the rest)

**Brief:** "Chciałbym móc zmienić nazwy czatów pod prawym guzikiem myszy. i móc także modyfikować
taski z poziomu panelu bocznego jak archwizowac odarchiwizowac itp." — I want to rename chats from
the right mouse button, and to modify tasks from the side panel too: archive, unarchive and so on.
**Branch:** `feat/sidebar-task-context-menu`
**Engine:** `Engine: om-auto-create-pr (steps: 9, --loop: no)`

## Goal

Give every task row in the cockpit's sidebar a real right-click context menu, so the two things the
brief asks for stop requiring a detour through the task thread: **rename the task in place**, and
**archive / unarchive it** (plus the neighbouring row actions the run header already offers — mark
unread, cancel, delete). Today the sidebar row is navigation only: the sole way to rename a task is
to open it and click the pencil in the run header, and the sole way to archive one is the run
header's Archive button or the Tasks table's "Archive finished" broom. A list of "chats" you can
only read is the wrong affordance for the surface people spend the most time in.

## Scope

The cockpit SPA only (`packages/web`). No server, contract or API-route change: every action the
menu offers already has an endpoint, and this run only reaches them from one more place.

- `packages/web/src/api/client.ts` — three project-scoped twins (`patchProjectRun`,
  `cancelProjectRun`, `deleteProjectRun`) alongside the existing `archiveProjectRun` /
  `setProjectRunRead`, so a row belonging to a project other than the mounted scope acts on **its
  own** project.
- `packages/web/src/api/queries.ts` — one shared invalidation helper for the run caches a row
  action can move, whichever project the row belongs to.
- `packages/web/src/components/ui/context-menu.tsx` — new shadcn-style wrapper over the Radix
  `ContextMenu` primitive (already on disk as part of the `radix-ui` package the repo depends on),
  matching `ui/dropdown-menu.tsx` line for line.
- `packages/web/src/lib/task-row-menu.ts` — new pure module: which items the menu offers for a
  given run, and what each one is called.
- `packages/web/src/components/task-row-menu.tsx` — the menu itself: the trigger wrapper, the
  mutations, the destructive-action confirm dialog.
- `packages/web/src/components/task-quick-list.tsx` — wraps each run row in the menu and hosts the
  inline rename input.
- Unit tests beside each of the above.

### Non-goals

- **The Tasks table and the global Tasks page.** Both already carry their own row affordances
  (inline rename in the Task cell, archive/read buttons per row); giving them a second, parallel
  menu is a separate design question and not what the brief asks for.
- **The variant group tile.** A collapsed `×N` tile stands for several runs at once, so "rename
  this" and "archive this" have no single referent. Its member rows — which are ordinary run rows —
  do get the menu.
- **New capabilities.** Nothing here invents an action the cockpit cannot already perform: the menu
  is a second door to endpoints the run header already calls. No bulk selection, no drag-to-archive,
  no keyboard shortcut scheme.
- **Renaming anything other than a task.** Projects, workflows and skills keep their current
  editing surfaces.
- **Touch long-press.** Radix's context menu brings its own long-press behaviour for free; tuning
  it for mobile is not part of this run and mobile keeps every affordance it has today.

## Implementation Plan

### Phase 1 — Act on the row's own project

The sidebar paints run rows from two places. `TaskQuickListContainer` renders the mounted scope's
runs; `ProjectGroups` renders **other** projects' runs through the same `QuickListBuckets`, handing
each group an explicit `scope={project.id}`. Every existing mutation helper in `api/client.ts`
except `archiveProjectRun` / `setProjectRunRead` sends `queryScope()` — the *active* project — so a
menu wired to them would rename or delete a same-id task in the wrong repository. The global Tasks
page already learned this lesson (`useIndexedRunMutation`'s comment says so); this phase gives the
remaining three verbs the same explicit-project spelling, and adds the matching cache invalidation:
a row's project may not be the mounted scope, and the boot project's list is cached under the
`'default'` alias rather than under its own id.

### Phase 2 — The context-menu primitive

`ui/dropdown-menu.tsx` is the house style for a Radix menu: thin wrappers, `data-slot` attributes,
the shared popover/item classes. `ui/context-menu.tsx` is its right-click twin and is written the
same way, so the two menus are visually indistinguishable and a test can query either by slot.

### Phase 3 — What the menu offers, and the menu itself

Which actions a run offers is already a pure, table-tested function — `runActionFlags` in
`routes/task-thread/run-actions.ts`, which the run header maps to buttons. The menu reuses it rather
than restating the rules, and `lib/task-row-menu.ts` adds only what is new here: the row-menu item
list in display order, each with its label (Archive vs Unarchive, Mark read vs Mark unread — the
record says which) and whether it is destructive. Pure, so a table test pins one row of the truth
table per run status. `components/task-row-menu.tsx` then binds that list to the mutations from
Phase 1, routes Cancel and Delete through an `AlertDialog` confirm with the same words the run
header uses, and reports every failure as a danger toast.

### Phase 4 — Wire it into the sidebar rows

`RunRow` in `task-quick-list.tsx` gains the menu wrapper and the rename state: picking **Rename**
flips the row's title span into the shared `TitleEditInput` (`components/editable-title.tsx` — the
one rename state machine the run header and the Tasks table already share), Enter/blur commits
through `patchProjectRun`, Escape abandons. The row's width-priority rule, its `data-slot` hooks and
its link targets are unchanged — the menu is a wrapper, not a re-layout.

### Phase 5 — Tests and the validation gate

Unit-test the pure policy, the menu component (open, act, confirm), and the sidebar rename round
trip; then run the repo's full gate in order.

## Risks

- **Acting on the wrong project.** The whole of Phase 1 exists because of this, and it is the one
  failure here that silently destroys the wrong data (`Delete` removes a worktree and a branch). The
  tests assert the request path carries the row's project id, not the mounted scope's.
- **Right-click over a link.** The row is an anchor; a context menu must suppress the browser's own
  menu without swallowing ordinary left-clicks or middle-click-to-open-in-a-new-tab. Radix's trigger
  handles this, and a test pins that a plain click still navigates.
- **jsdom and Radix.** Radix positions menus with floating-ui, which needs `ResizeObserver`; the
  existing `tools-menu.test.tsx` stubs it, and these tests do the same.
- **Menu on a row that is mid-flight.** A queued or running task offers Cancel but not Delete, and
  vice versa — `runActionFlags` already encodes that, so the risk is only in forgetting to use it.
  Reusing the function rather than re-deriving the rules is the mitigation.

## Progress

PR: #921

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Act on the row's own project

- [x] 1.1 Add `patchProjectRun`, `cancelProjectRun` and `deleteProjectRun` to `api/client.ts`, with rows in the `client.test.ts` request table — 4c4bfa51
- [x] 1.2 Add the cross-project run-cache invalidation helper to `api/queries.ts`, with a test — 4c4bfa51

### Phase 2: The context-menu primitive

- [ ] 2.1 Add `components/ui/context-menu.tsx` mirroring `ui/dropdown-menu.tsx`

### Phase 3: What the menu offers, and the menu itself

- [ ] 3.1 Add `lib/task-row-menu.ts` — the pure item list — with a table test per run state
- [ ] 3.2 Add `components/task-row-menu.tsx` — the menu, the mutations and the confirm dialog
- [ ] 3.3 Add `components/task-row-menu.test.tsx`

### Phase 4: Wire it into the sidebar rows

- [ ] 4.1 Wrap `RunRow` in the menu and host the inline rename in `components/task-quick-list.tsx`
- [ ] 4.2 Extend `components/task-quick-list.test.tsx` for the menu and the rename round trip

### Phase 5: Tests and the validation gate

- [ ] 5.1 Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`)
