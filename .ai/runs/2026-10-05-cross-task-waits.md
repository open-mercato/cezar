# Cross-task waits — a task waits for another task, in this project or another

Engine: om-auto-create-pr (steps: 17, --loop: no)
Source doc: .ai/specs/2026-10-05-cross-task-waits.md

## Goal

Let a running task park on another task — same or another registered project, by run id, or one it
creates in another project — without holding a compute slot, and be woken by the engine with the
target's outcome when it settles, is deleted, its project is removed, or the edge's deadline passes.

## Scope

- `packages/contract/src/waits.ts` (new) — edge, input, outcome, response schemas; `RunRecord.waits`
  / `waitedBy`; `capabilities.taskWaits`.
- `packages/cezar/src/workspace/waits.ts` (new) — `WaitResolver`: declare, index, settle/delete/
  removal/deadline resolution, catch-up, boot sweep, cycle DFS, create-and-wait.
- `packages/cezar/src/workflows/run.ts` — park reason enum, `awaiting` park in both turn-end
  handlers, slot exemption, no wake timer, restart note, settle notification, delivery ladder.
- `packages/cezar/src/server/{server.ts,project-context.ts,capabilities.ts}` — routes, wiring, flag.
- `packages/cezar/src/dispatch/{task-cli.ts,prompts.ts,engine.ts}` — `cez task wait|waits`,
  `create --project`, prompt paragraph, budget input.
- `packages/web/` — waiter indicator + Stop waiting, "Wait for task…" dialog, "Created by" chip.
- `.env.example`, `docs/reference.md`, `AGENTS.md` (Phase 2 exception line), BACKWARD_COMPATIBILITY.md §2.

## Non-goals

- "Start after" for a NEW task (`--after`) — its own follow-up spec.
- Fan-in expressions, static DAG authoring, branch/PR addressing.
- Two cezar processes on one workspace.

## Design notes (deviations recorded here and in the PR)

- Settle detection uses an explicit `'settled'` store event emitted at the engine's terminal-
  transition sites (the same sites dispatch reports from: `dropActive`, the queued cancel, the
  restart settles) rather than filtering raw `'run'` status updates. A raw status filter would see
  restart recovery's transient `failed` (written right before the run is re-queued) as a settle and
  wake waiters with a false outcome.

## Risks

- Changing `enterMonitoring`'s boolean: guarded by tests pinning the dispatch-parent exemption and
  the `maxMonitoringSessions` cap for plain watchers.
- Timers across contexts: every timer is `unref`'d and cleared on resolve / project removal.

## Implementation Plan

Mirrors the spec's Implementation Plan (Phases 1–3, Steps 1–17).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Wait on an existing task

- [x] 1.1 Contract: wait schemas, RunRecord.waits, capabilities.taskWaits — 08c8346d
- [x] 1.2 Env + capability CEZ_TASK_WAITS — 19841746
- [x] 1.3 WaitResolver core — 61dc9198
- [x] 1.4 Registry wiring — 0e7529b3
- [x] 1.5 Refactor enterMonitoring to a park reason — 93a6a21e
- [x] 1.6 Engine park for awaiting — 99b015cf
- [x] 1.7 Delivery — 0e7529b3
- [x] 1.8 Routes — 0e7529b3
- [x] 1.9 CLI + prompt — 0e151579
- [x] 1.10 Dry-run e2e — c3511698

### Phase 2: Create and wait in another project

- [x] 2.1 Contract create branch + waitedBy — 08c8346d
- [x] 2.2 Create path — 5d469235
- [x] 2.3 Budget — 5d469235
- [x] 2.4 CLI + exception — 291d5c94

### Phase 3: Cockpit

- [ ] 3.1 Waiter indicator + Stop waiting
- [ ] 3.2 Wait for task dialog
- [ ] 3.3 Created by chip + hidden-when-off
