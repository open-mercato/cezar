# Execution plan — "Run next" for queued tasks

- Brief: `.ai/specs/briefs/2026-09-23-queued-task-run-next.md`
- Branch: `feat/queued-task-run-next`
- Engine: om-auto-create-pr (steps: 7, --loop: no)

## Goal

A queued task can be promoted with one action, "Run next". It then takes the first free slot the existing caps allow, in its own project and, as a preference, across the workspace.

## Scope

- Engine (`packages/cezar/src/workflows/run.ts`): `promote(runId)`, rank-aware enqueue, clear the mark at dequeue and on cancel, restart recovery keeps the order.
- Workspace semaphore (`packages/cezar/src/workspace/semaphore.ts`): an optional participant rank so `release()` pumps a project with a promoted head first.
- Record: optional `promotedAt` in the store schema and in the contract `RunRecord`.
- API: `POST /api/v1/runs/:id/promote` (+ scoped alias), contract response, BACKWARD_COMPATIBILITY.md §2 inventory.
- Cockpit: one shared queued-order comparator used by the list sort and by both "#N in queue" computations; a "Run next" action in the task header (action bar + overflow menu).

## Non-goals (from the brief)

- Arbitrary reordering (drag and drop / arrows), priority levels, bypassing the parallel cap, reordering queued messages, a `cez task` CLI subcommand.
- Row actions in the task list and sidebar. The header covers the need. Row menus are also being reworked in open PR #921, so they are left for a follow-up.

## Resolved unknowns (carried from the brief)

- Never bypasses `maxParallel`, the per-project cap or a usage-limit account hold.
- Several promoted runs: the newest promotion goes first. Promoting again re-stamps the run to the top.
- `promotedAt` is persisted. It is cleared at dequeue (in `pump()`) and on cancel, so a later re-queue (Continue deferred for capacity, usage-limit send-back) lands at the tail.
- The route answers 200 with the updated record, 404 for an unknown run, 409 when the run is not waiting in the engine's queue.
- The cross-project ordering is a preference applied when `release()` hands out a freed slot. It is not a global guarantee.

## Implementation Plan

### Phase 1: Engine
- 1.1 Add optional `promotedAt` to the store run schema and the contract `RunRecord`.
- 1.2 `RunManager.promote()`, rank-aware `enqueue()`, clearing at dequeue/cancel, recovery order, tests.
- 1.3 Semaphore `queueRank()` participant hook and the `release()` ordering, tests.

### Phase 2: API
- 2.1 `POST /runs/:id/promote` route, contract schema, BC inventory, route tests.

### Phase 3: Cockpit
- 3.1 Shared queued-order comparator (promoted first) for `sortRuns`, `queuePositions` and `queuePosition`, tests.
- 3.2 `promoteRun` client + hook, a "Run next" action in the run header (bar + menu), tests.

### Phase 4: Docs
- 4.1 Record the behavior in the queue spec / docs.

## Risks

- `pump()` and `release()` are the scheduler's hot path. The change is additive: no promoted run means the exact old order, and tests pin that.
- The `queued` record can re-enter the queue through several paths (`startRun`, `reviveQueuedRun`, `requeueWhileHeld`, deferred Continue). Only `reviveQueuedRun` can see a live `promotedAt` (restart / watchdog), so it goes through the rank-aware enqueue. Every other path follows a dequeue that has already cleared the mark.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Engine

- [x] 1.1 Add optional promotedAt to the run record schemas — edfef1ee
- [x] 1.2 RunManager.promote with rank-aware enqueue and clearing — f34f24a6
- [x] 1.3 Semaphore queue rank for cross-project ordering — bbdf5358

### Phase 2: API

- [x] 2.1 POST /runs/:id/promote route and contract — 08944df5

### Phase 3: Cockpit

- [x] 3.1 Shared queued-order comparator — e04d602c
- [x] 3.2 Run next action in the run header — 115a9182

### Phase 4: Docs

- [ ] 4.1 Document the Run next behavior
