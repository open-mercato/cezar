# "Run next": let a queued task take the first free slot

- Date: 2026-09-23
- Category: feature
- Priority signal: medium — the owner regularly has long queues and has no way to push one task ahead short of cancelling others
- Risk signal: medium — touches the run queue, restart recovery and the workspace semaphore's ordering key
- Routing: Next: om-auto-create-pr "Add a 'Run next' action that moves a queued task to the front so it takes the first free slot — brief: .ai/specs/briefs/2026-09-23-queued-task-run-next.md"

## Problem

With many tasks queued behind the parallel cap, the operator often wants one specific task to start as soon as a slot frees, not after everything queued before it. Today every project's `RunManager` queue is strict FIFO by `createdAt` (`pump()` in `packages/cezar/src/workflows/run.ts`, rebuilt by `recover()` after a restart), and the workspace semaphore's `release()` hands a freed slot to the project whose queue head is oldest. There is no reorder, no priority and no "start now". The only workarounds are cancelling and re-creating the other tasks, which loses their prompts and state, or temporarily raising `maxParallel`, which overloads the host. Neither is acceptable for routine use.

## Agreed direction

Add a single **"Run next"** action on a queued task. The task is marked as promoted and is preferred over every unpromoted queued run when the next slot frees, in its own project and when the workspace semaphore hands out a freed slot. It never bypasses a cap.

Rejected:
- **Full drag/arrow reordering** with persisted positions. More UI and more state than the need calls for.
- **Priority levels.** They generalise the same need at higher cost and are left for later if ever needed.
- **"Start now", bypassing the cap.** The cap protects the host.
- **Build nothing.** The workarounds are destructive (cancel/re-create) or unsafe (raising the cap).

## Resolved unknowns

| Question | Answer |
|----------|--------|
| Does it bypass `maxParallel` / per-project caps? | No. The run waits for the first free slot the existing gates allow. |
| Scope: own project only, or workspace-wide? | Workspace-wide preference. When a freed slot is broadcast (`WorkspaceSemaphore.release()`), a project whose best queued run is promoted is pumped before projects with only unpromoted runs. Treat it as a preference, not a guarantee: `release()` is best-effort, and other paths call `pump()` directly. Word it that way in code and docs. |
| Order among several promoted runs? | Most recently promoted first (stack: "next" means next). Promoting an already-promoted run re-stamps it to the top. |
| State and persistence | Optional `promotedAt` (ISO string) on the run record, so it survives a restart. `recover()` re-queues promoted runs first (newest `promotedAt`), then the rest by `createdAt`. |
| When is `promotedAt` cleared? | When the run is dequeued to start (in `pump()` where it enters `starting`) and when it is cancelled. A run that later re-enters the queue must go back to normal FIFO (tail): a deferred Continue, the usage-limit send-back, a restart re-queue. Each re-queue path needs a regression test. The key one: promote → start → Continue into a full queue → it lands at the tail. |
| In-manager ordering | `pump()` picks the best-ranked runnable run: promoted (newest `promotedAt`) before unpromoted (FIFO). The existing account-hold skip still applies, so a promoted run on a held account keeps waiting and the next eligible run starts. A full per-project cap likewise leaves the slot to another project. |
| Semaphore ordering key | `SemaphoreParticipant.oldestQueuedAt()` (one epoch-ms number) cannot express it. Add an **optional** participant method, e.g. `queueRank(): [promoted ? 0 : 1, promoted ? -promotedAtMs : createdAtMs] \| null`, computed over the best-ranked queued run and not `queue[0]` (the queue is not strictly FIFO: re-queues push to the tail). Fall back to `oldestQueuedAt()` for participants without it, so existing test stubs keep working. |
| API | `POST /runs/:id/promote` (with the scoped project alias). Returns 200 with the updated run and triggers a pump. Returns 409 when the run is not `queued`. Add the contract schema in `packages/contract/src/runs.ts`, the route-parity entries and the BACKWARD_COMPATIBILITY.md route inventory entry, per repo conventions. The new record field stays optional (additive). |
| UI | A "Run next" button on a queued task: in the task thread's queued state and in the task list row actions. Queue-position labels ("#N in queue") in `packages/web/src/routes/task-thread/run-actions.ts` and `packages/web/src/lib/task-groups.ts` must use one shared comparator (promoted first). They stay per-project, as today. |
| Undo | None needed. Promoting another task puts that one ahead. |

## Non-goals

- Arbitrary reordering (drag and drop, up/down arrows) of the whole queue.
- Priority levels or per-project priority.
- Starting a task beyond the parallel cap ("start now").
- Reordering queued follow-up messages inside a session.
- A `cez task` CLI subcommand for promotion.

## Affected areas (if known)

- `packages/cezar/src/workflows/run.ts`: `pump()` selection, `oldestQueuedAt()` / new rank, `recover()` ordering, clearing on dequeue and cancel.
- `packages/cezar/src/workspace/semaphore.ts`: `SemaphoreParticipant`, `release()` ordering.
- `packages/contract/src/runs.ts`: run record `promotedAt`, promote response schema.
- Server runs routes plus the scoped alias; BACKWARD_COMPATIBILITY.md route inventory.
- `packages/web/src/routes/task-thread/run-actions.ts`, `packages/web/src/lib/task-groups.ts`, the queued task view and the task list row actions.
