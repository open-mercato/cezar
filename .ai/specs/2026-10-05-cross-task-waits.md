# Cross-task waits — a task waits for another task, in this project or another

> Slug: `cross-task-waits` · Status: **design complete — for specification review** · Extends:
> `2026-09-10-dispatch.md` (the settle → delivery ladder, the `cez task` transport, the
> spawn-parked slot exemption), `2026-07-24-long-running-waiting-sessions.md` (parked monitors),
> `2026-07-20-multi-project-workspace.md` (project contexts). Deferred sibling: "start after" for a
> NEW task (`--after <run>`), its own spec on top of the wait edge defined here.

## 📝 TLDR

Today a task can wait only for its OWN dispatched children (same project, same tree); anything else
is the agent polling by hand behind `CEZ:MONITORING`. This spec adds an engine-level **wait edge**:
a running task A declares it waits for task B — by run id, in the same or another registered
project — or **creates** B in another project and waits for it in one call. A parks without holding
a compute slot, and the engine wakes it when B **settles** (`done | review | failed | cancelled`),
delivering B's outcome into A's session. Every wait has an engine-owned exit (settle, delete,
project removal, cancel, deadline — default 24 h), it survives a restart, it is default-on and
`CEZ_TASK_WAITS=0` turns it off.

## 📝 Resolved decisions (Open Questions gate, owner answers 2026-10-05)

| # | Question | Decision |
|---|---|---|
| Q1 | Scope | `cez task wait` for a RUNNING task in this spec. "Start after" for a new task (`--after`) is a follow-up spec reusing the same edge. **Added by the owner:** a task that cannot finish without work in another project must be able to *create* that task and wait for it — in scope (Phase 2). |
| Q2 | Cross-project in v1 | Yes — it is the motivating case. |
| Q3 | What wakes the waiter | Any settle (`done | review | failed | cancelled`), outcome delivered verbatim; the agent judges. Same rule dispatch uses (`TERMINAL_STATUSES`). |
| Q4 | Who declares a wait | Both: the agent (`cez task wait`) and the user (cockpit). |
| Q5 | Default | On. `CEZ_TASK_WAITS=0` turns the whole feature off. |
| Q6 | Bound | Every edge carries a deadline: default 24 h, `--timeout <minutes>` overrides (1 min – 7 days). |
| Q7 | Addressing | `<projectId>/<runId|id8>` only; a bare `<runId|id8>` means this project. No branch/PR resolution. |

## 📝 Problem Statement

- Real work spans repos: a frontend task needs the API task in another project to land first; a
  migration task needs a library release in a sibling repo. Today the user sequences these by hand,
  or the agent parks on `CEZ:MONITORING` and polls `gh` on each of up to 40 wake-ups
  (`MAX_AUTO_CONTINUES`) — slow, token-costly, and blind to cezar's own run state: a cancelled or
  failed upstream run is invisible to it until the wake cap silently ends the polling.
- Dispatch already solves this shape for parent → child: settle detection, a structured outcome,
  delivery into a parked session (`deliverMessage`, falling back to `enqueueMessage`), and an
  uncapped slot exemption for a parent parked on its children (`unitParents`, `busySlots`). It is
  keyed on `dispatch.parentRunId` and confined to one project's `RunManager`, so it cannot express
  "any task waits for any task" and cannot reach another project at all.
- A dispatch child cannot live in another repo: it forks off the parent's branch and the parent
  merges it back. Work in another project is an *independent* task with its own worktree, review
  gate and PR — so "create and wait" there is not a dispatch child, and needs its own path.

## 📝 Proposed Solution

A persisted **wait edge** on the waiter's run record, resolved by a workspace-level **wait
resolver** that listens to every project store's terminal transitions.

1. **Declare** — `cez task wait <target> [--timeout <min>]` (agent) or "Wait for task…" (cockpit)
   calls `POST …/runs/:id/waits`. If the target has already settled, the route answers with its
   outcome and records nothing — the CLI prints it and the agent carries on. Otherwise an edge is
   written and the CLI prints "waiting — end your turn; you will be woken when it settles".
2. **Create and wait** — `cez task create "<objective>" --project <projectId> …` creates an
   independent, autonomous root task in that project (its own worktree off that project's base
   branch, its own review gate) and attaches a wait edge to the creator in the same request.
3. **Park** — at turn end, a run with any pending edge parks as a monitor with the same uncapped
   slot exemption a dispatch parent gets, and no periodic monitoring nudge (the edge is the wake
   source; polling would be the very cost this feature removes).
4. **Resolve** — when a target settles, is deleted, or its project is removed, or an edge's deadline
   passes, the resolver marks the edge resolved and delivers one message into the waiter through the
   existing ladder: `deliverMessage` into a live session, else `enqueueMessage` (a queued
   continuation that reopens the session — the path a restart or a closed session takes).

**Alternatives considered**

| Alternative | Why it lost |
|---|---|
| Status quo: agent polls behind `CEZ:MONITORING` | Token cost per wake, blind to cezar state, ends at the wake cap with no outcome. |
| Reuse `dispatch.parentRunId` | The target is not a child: wrong tree, wrong budget ledger, wrong merge direction, and cannot cross projects. |
| Automation trigger "on task settled" | Right shape for the deferred "start after" (a new task), wrong for a live session that must be woken with context. Revisit in the follow-up spec. |
| Close the waiter's session while it waits, always resume via continuation | Saves an idle process but pays a full context re-read on every wake. Kept only as the fallback (restart / session closed), exactly as dispatch does. |
| A separate `waits.json` per project | One more state file for `ensureDataGitignore` and a second source of truth; the run record already survives restart and is per-project. |

### Research — how the market leaders do it

- **GitHub Actions `needs` / Buildkite `depends_on` / GitLab `needs:project`** — static DAG edges
  declared up front; GitLab's cross-project `needs` is the closest analogue. They resolve on *any*
  terminal state and let the dependent decide (`if: always()` / `allow_failure`) — the Q3 decision.
- **Airflow `ExternalTaskSensor`** — a waiter in one DAG on a task in another, with a mandatory
  `timeout` and a "reschedule" mode that frees the worker slot while waiting. Both carried over:
  the deadline (Q6) and the slot exemption. Airflow's known pain is sensors deadlocking a pool;
  the uncapped exemption plus cycle refusal is the answer here.
- **Temporal child workflows / signals** — durable waits that survive worker restarts by persisting
  the await in history. Carried over: the edge lives on the persisted record and is re-evaluated on
  context build, so a restart loses no wake-up.
- **Skipped complexity:** static DAG authoring, fan-in expressions (`all_of` / `any_of`),
  retries-on-upstream-failure. A task may hold several edges and is woken once per edge; the agent
  composes any fan-in itself.

## 📝 Architecture

```
project P (waiter)                         workspace                         project Q (target)
RunManager ── POST /runs/:id/waits ──▶ WaitResolver ◀── store 'run'/'deleted' ── RunStore
   ▲                                     │   (one per server; subscribes to every
   │  deliverMessage / enqueueMessage    │    store via ProjectContextRegistry
   └─────────────────────────────────────┘    onStoreCreated, unsubscribes on dispose)
```

**New: `packages/cezar/src/workspace/waits.ts` — `WaitResolver`.** One instance per server,
constructed beside the `ProjectContextRegistry`. Responsibilities, all in one file:

- `declare(waiter, target, opts)` — validates (no self-wait, no cycle, target exists, edge limit),
  writes the edge through the waiter's store, arms the deadline timer.
- Store subscription — for every built context, `store.on('run')` filters terminal transitions and
  `store.on('deleted')` catches deletions; both look up an in-memory reverse index
  `targetKey → edge ids` (rebuilt from records on context build) and resolve matches.
- `onContextBuilt(ctx)` — **catch-up**: re-index the context's pending edges, resolve any whose
  target already settled / vanished, re-arm deadlines (an expired one resolves `timed-out` at once),
  and *ensure the target's context is built* so its runs actually progress.
- `onProjectRemoved(projectId)` — a NEW hook fired by the project-removal route (`removeProject`
  in `server.ts`), **not** by `ProjectContexts.dispose`: process shutdown runs `disposeAll()`, which
  disposes every context, and hooking that would cancel every cross-project wait on every shutdown.
  It resolves every edge whose target lives in the removed project as `target-unavailable`; the
  removed project's own edges die with its records.
- **Boot sweep** — only the boot project's context is built eagerly, so a waiter in another project
  would otherwise sit with no armed deadline until someone opened it. At boot the resolver reads
  every registered project's `runs.json` read-only (parse only, no context) and builds the context
  of any project holding a pending edge — as a target's context is built on declare. After the
  sweep, every project with a pending edge (waiter or target) is built, so the live path, the
  deadline timers and the cycle DFS all see the whole graph.
- Cycle detection — DFS over pending edges across all built contexts at declare time.

**Why the catch-up is complete (the invariant it rests on).** A project's runs only execute inside a
built context, and contexts are disposed only on project removal or process exit. So a target can settle only while
its context is built (live path), and a waiter can only need waking while *its* context is built.
If the waiter's context is not built when the target settles, the waiter is not running either, and
the catch-up at its build delivers the outcome. Declaring a wait on an unbuilt project builds it
(same as opening it from the sidebar — `recover()` included), because a target that never runs
would only ever end at the deadline.

**Changed: `workflows/run.ts`.**

- Turn end — one helper, called from BOTH turn-end handlers (streaming and non-streaming; AGENTS.md
  § "Find every construction site"): a run with ≥1 pending edge whose turn did not end in `CEZ:DONE`
  or `CEZ:ASK` parks via `enterMonitoring(runId, 'awaiting')`. **Pending edges take precedence over
  the autonomous nudge**, exactly as a dispatch park does (`run.ts` "the caller then skips the
  autonomous nudge"): otherwise an autonomous waiter that ends its turn without a marker is nudged
  up to `MAX_AUTO_CONTINUES` times instead of parking. The boolean `spawnParked` becomes a
  reason (`'watching' | 'spawned' | 'awaiting'`); `busySlots` exempts `spawned` and `awaiting`
  uncapped, for the same reason it exempts spawned parents: a waiter capped by
  `maxMonitoringSessions` can hold the slot its own target needs, and three of them deadlock the
  workspace. `armMonitoringWakeTimer` is skipped for `awaiting`.
- `CEZ:DONE` / a terminal settle / cancel / delete of the WAITER — its pending edges resolve as
  `waiter-ended` (no delivery; one note on the waiter's event log). This is the exit for a waiter
  that finished without its dependency.
- A user message into an awaiting waiter wakes it as today; its edges stay pending. If the next turn
  parks again, it parks `awaiting` again.
- `ActiveRun` gets no new field: parking reads the edges from the record, which `execute`,
  `runContinuation` and `recover()` all already load — there is no second construction site to miss.

**Changed: `dispatch/task-cli.ts`** — subcommands `wait`, `waits`, and `create --project`.
**Changed: `dispatch/prompts.ts`** — the dispatch system-prompt section gets a short paragraph:
when to wait vs. dispatch a child (same repo, result merged into my branch → child; other repo or an
independent PR → `create --project`; already running elsewhere → `wait`), and "never poll a task you
can wait on".

### State transitions — every exit from `awaiting`

| Trigger | Who fires it | Edge becomes | Waiter receives |
|---|---|---|---|
| Target reaches `done`/`review`/`failed`/`cancelled` | target store `'run'` event → resolver | `settled` | outcome message: status, title, branch, PR URL, cost, `cez task report` result if the target filed one, last error |
| Target run deleted | target store `'deleted'` → resolver | `target-deleted` | "the task you waited for was deleted" |
| Target's project removed from the registry | `ProjectContextRegistry.dispose` → resolver | `target-unavailable` | "project Q was removed" |
| Deadline passes | resolver timer (re-armed on context build) | `timed-out` | "timed out after N min; target is still <status>" — the agent may wait again |
| User clicks "Stop waiting" | `DELETE …/waits/:waitId` | `cancelled` | "the user stopped this wait" |
| User message | `deliverMessage` | unchanged (pending) | the message |
| Waiter `CEZ:DONE` / settles / cancelled / deleted | `run.ts` settle path | `waiter-ended` | nothing (it is gone) |
| cezar restart | A parked waiter is stored `status: 'running'`, so `recover()` resumes it as it resumes every monitor today: one agent turn, holding a slot, with the restart note extended by "you are still waiting for <targets> — end your turn". The turn ends and the run parks `awaiting` again. Catch-up (`onContextBuilt`, which runs after `recover()`) resolves anything that settled while cezar was down and delivers it through `deliverMessage` into that resumed turn. | per the rows above | outcome in the resumed session |
| `CEZ_TASK_WAITS=0` set after edges exist | boot | edges left as written and inert; resolver not started; the turn-end helper ignores edges | the restart note does not mention waits; the run follows the pre-feature turn-end rules (a waiter ending with no marker is nudged or settles as any run would) |

No row ends in "a human must type something": settle, delete, removal and deadline are all
engine-fired, and the deadline is mandatory.

## 📝 Data Model

On `RunRecord` (waiter side), optional so old `runs.json` files parse; zod in `packages/contract`:

```ts
waitEdgeSchema = z.object({
  id: z.string(),                                  // uuid
  target: z.object({ projectId: z.string(), runId: z.string() }),  // full run id, resolved at declare
  targetTitle: z.string(),                         // snapshot for the UI when Q is unbuilt/removed
  origin: z.enum(['agent', 'user']),             // derived by the route, never from the body
  created: z.boolean().optional(),                 // true when this request also created the target (Phase 2)
  createdAt: z.string(), deadline: z.string(),
  state: z.enum(['pending', 'settled', 'target-deleted', 'target-unavailable', 'timed-out', 'cancelled', 'waiter-ended']),
  resolvedAt: z.string().optional(),
  outcome: z.object({ status: runStatusSchema, prUrl: z.string().optional(), costUsd: z.number().optional() }).optional(),
});
RunRecord.waits?: WaitEdge[]    // bounded: ≤ 4 pending, resolved history trimmed to the last 20
```

On the created target (Phase 2), optional: `RunRecord.waitedBy?: { projectId, runId }` — the
creator, for the "created by" link and the budget charge. Nothing else is written; no new files,
so `ensureDataGitignore` is untouched. Run state never migrates (AGENTS.md); absent fields mean "no
waits".

Limits: 4 pending edges per waiter (mirrors `MAX_CHILDREN_IN_FLIGHT`); Phase 2 creations count
toward the creator's existing 4-in-flight dispatch cap.

## 📝 API Contracts

Project-scoped, chained into the existing runs/dispatch family, mounted at `/api/v1/<path>` and
`/api/v1/p/:projectId/<path>` (route parity), validated as middleware, schemas in
`packages/contract/src/waits.ts`:

| Route | Body / response |
|---|---|
| `POST /runs/:id/waits` | body `waitInputSchema` = `{ target: { projectId?, runId }, timeoutMinutes?: 1–10080 }`; Phase 2 adds `{ create: { projectId, objective, title?, budget?, runner?, model?, scope?, success? }, timeoutMinutes? }`, XOR with `target` → `200` discriminated on `kind` (`as const`, so hono keeps the discriminant): `{ kind: 'pending', edge: WaitEdge }` or `{ kind: 'settled', outcome: WaitOutcome }` (target already settled, nothing recorded) |
| `DELETE /runs/:id/waits/:waitId` | → `200 { edge }` (`cancelled`) |

`origin` is not in the body: the route sets `agent` when the request comes from the CLI on behalf
of the run (the `cez task` client sends the run's `CEZ_TASK_ID`) and `user` otherwise, so an agent
cannot speak as the user. An omitted `target.projectId` means the waiter's own project; `'default'`
resolves to the boot project, matching route parity.

Refusals (`{ error }`): `400` self-wait / malformed target; `404` unknown project, unknown or
ambiguous id8 (ambiguous lists candidates); `409` cycle (names the loop), edge limit reached,
waiter not live (`queued`, settled), target project `missing` on disk, feature off
(`CEZ_TASK_WAITS=0` — "waits are disabled on this cockpit; continue without waiting or stop and
report"). The waits list itself rides on the existing run payloads (`waits` field) — no GET route.

`capabilities` gains `taskWaits: boolean`. BACKWARD_COMPATIBILITY.md §2 inventories both routes;
`contract-parity*`, `typed-bodies`, `route-parity` and `bc-route-inventory` cover them.

**CLI** (`cez task`, same three env vars; refuses with exit 2 and a "do not poll instead" message
when the capability is off):

```
cez task wait <projectId/>runId [--timeout <min>]   declare; prints outcome if already settled
cez task waits                                     this task's edges and their state
cez task create "<objective>" --project <projectId> [--title …] [--budget <usd>] [--runner …] [--model …] [--timeout <min>]
```

**Env:** `CEZ_TASK_WAITS` — default on, `0` disables routes, CLI, prompt paragraph, resolver and
cockpit affordances. Documented in `.env.example` and `docs/reference.md` in the same commit.
Phase 1 (waiting only) widens no exposure — it starts no process and touches no network — so it
needs no exception. Phase 2 (an agent starting a task in another project) is the exposure dispatch
was approved for; its step adds the AGENTS.md § Zero config owner-approved exception line
(2026-10-05) in the same commit.

## 📝 UI/UX

- **Waiter (task detail + list row):** activity reads "Waiting for *Q / Add export endpoint*" with
  the target's live status chip (from the target project's cache when built; the `targetTitle`
  snapshot otherwise), "times out in 23 h", and **Stop waiting**. Resolved edges render as a
  timeline note. Clicking the target navigates to `/p/Q/…`.
- **"Wait for task…"** in a running/parked task's action menu: a picker of registered projects →
  their non-settled runs (search by title/id8), timeout field prefilled 24 h. Declared with
  `origin: 'user'`; a note is delivered into the waiter ("the user asked you to wait for … — end
  your turn; you will be woken").
- **Created target (Phase 2):** a "Created by *P / task*" chip on the target's detail page.
- Hidden entirely when `capabilities.taskWaits` is false. Keyboard-accessible menu and dialog,
  light/dark tokens, no new live channel — waiter updates arrive on the existing SSE run stream.

## 📝 Edge Cases & Failure Scenarios

| Case | Behavior |
|---|---|
| Target already settled at declare | Immediate `{ settled }`, no edge, no park. |
| A waits B, B waits A (any length, any projects) | `409` naming the loop at the second declare. |
| Target is `review` and the user later Continues it | Edge resolved at the first settle; later activity does not re-wake A. A may wait again. |
| Target is itself a long monitor / awaiting | Fine — A waits; the deadline bounds it. |
| Waiter's session was closed (idle, crash) when B settles | `enqueueMessage` → queued continuation reopens the session; obeys `maxParallel` like any queued work. |
| Server down when B settles (B settled in recovery) | A's context build catch-up resolves it. |
| `runs.json` corrupt in Q | Q degrades to fresh (store rule); A's edge resolves `target-deleted` at catch-up — loud, not silent. |
| Target project root missing (`409` context) | Declare refuses; an existing edge resolves `target-unavailable` at catch-up. |
| Delivery fails (waiter cancelled concurrently) | Edge already resolved; nothing to deliver; no retry loop. |
| Two cezar processes on one workspace | Out of scope, as for dispatch: one server owns the registry. |
| Phase 2 create fails (target project worktree error) | Route returns the create error; no edge written. |

## 📝 Risks & Impact Review

- **Unbounded idle processes.** `awaiting` is uncapped, like spawned parents. Bound: ≤ 4 edges per
  waiter, a mandatory deadline, and every waiter is a task the user (or a budgeted tree) started.
  Accepted for the same reason the dispatch exemption was; a cap here reintroduces the deadlock.
- **Cost (Phase 2).** An agent can start a task in another project. Brakes: the creator's 4-in-flight
  cap; when the creator has a dispatch budget, `--budget` is required and carved from it, and the
  target's actual cost is charged back at settle. `remainingBudgetUsd(parent, children)`
  (`dispatch/engine.ts`) only sees children in the creator's own store, so it gains the creator's
  `created` edges as a second input: a pending one reserves its `--budget`, a settled one costs
  `outcome.costUsd` (same reserve-then-actual rule the function already applies to children); with `CEZ_TASK_WAITS=0` the path is closed.
- **Security.** No new exposure class: the API is loopback-bound behind the origin guard, and a task
  can already call any project route the cockpit can. Delivered outcomes carry run metadata only,
  not the target's transcript.
- **Compatibility.** Additive: optional record fields, new routes, one capability flag, one env var.
  An older cezar reading a record with `waits` ignores it (passthrough) and its waiter simply runs
  as an ordinary monitor.
- **Changing a working mechanism.** `enterMonitoring`'s boolean becomes a reason enum; `busySlots`
  must keep `spawned` exactly as today. Guard tests pin the dispatch parent exemption and the
  `maxMonitoringSessions` cap for plain watchers.
- **Rollback.** `CEZ_TASK_WAITS=0` closes every entry point and leaves existing edges inert; a run
  that was told to wait follows the pre-feature turn-end rules, which may cost one nudge or an early
  settle — never a hang. Reverting the code leaves only ignorable optional fields. Reverting the code leaves only
  ignorable optional fields.

## 📋 Phasing

1. **Wait on an existing task** (same and cross-project) — edge, resolver, park/exemption, deadline,
   routes, CLI `wait`/`waits`, prompt paragraph, capability + env. Shippable alone: agents can
   wait; the cockpit shows `monitoring` as today.
2. **Create and wait in another project** — `create` branch of the route, `cez task create
   --project`, `waitedBy`, budget carve/charge, in-flight cap.
3. **Cockpit** — waiter indicator, Stop waiting, "Wait for task…" picker, "Created by" chip.

## 📋 Implementation Plan

### Phase 1 — Wait on an existing task

1. **Contract.** `packages/contract/src/waits.ts`: `waitEdgeSchema`, `waitInputSchema` (target
   branch only), `waitOutcomeSchema`, responses; `RunRecord.waits` optional; `capabilities.taskWaits`.
   Test: schema round-trips; an old record without `waits` parses.
2. **Env + capability.** `CEZ_TASK_WAITS` read once, exposed as `capabilities().taskWaits`;
   `.env.example`, `docs/reference.md`. Test: default on, `0` off.
3. **`WaitResolver` core** (no wiring): declare validation (self, id8 resolution, limit, cycle DFS),
   reverse index, resolve-on-settle, deadline timers, catch-up. Pure tests with in-memory stores:
   every row of the transitions table, including a regression test that a waiter whose context is
   built after the target settled is still delivered.
4. **Registry wiring.** Subscribe via `onStoreCreated`/`onContextBuilt`; `onProjectRemoved` from
   the removal route resolves `target-unavailable`; boot sweep builds projects with pending edges;
   declare builds an unbuilt target context. Tests with two temp projects, including **shutdown
   (`disposeAll`) leaves every edge `pending`** and a non-boot waiter's deadline fires after restart.
5. **Refactor, no behavior change.** `enterMonitoring(runId, spawnParked: boolean)` → a reason
   enum (`'watching' | 'spawned'`). Guard tests only: the dispatch-parent exemption and the
   `maxMonitoringSessions` cap for plain watchers are unchanged.
6. **Engine park.** Add `'awaiting'`; one turn-end helper used by both handlers, ahead of the
   autonomous nudge; `busySlots` exempts `awaiting`; no wake timer for `awaiting`; restart note
   names pending targets; waiter settle resolves `waiter-ended`. Tests: an autonomous waiter ending
   with no marker parks rather than being nudged, in BOTH turn-end handlers (prove each fails with
   the helper removed — `git stash`); exemption counts.
7. **Delivery.** Resolver → owning `RunManager` → `deliverMessage` || `enqueueMessage`; outcome
   message builder (reuses the dispatch report formatter where shapes match). Test: live session,
   closed session, post-restart.
8. **Routes.** `POST /runs/:id/waits`, `DELETE /runs/:id/waits/:waitId` chained into the family,
   validated as middleware, 409 when off. Tests: contract-parity, typed-bodies, route-parity,
   BACKWARD_COMPATIBILITY.md §2 inventory.
9. **CLI + prompt.** `cez task wait`, `cez task waits` in `task-cli.ts`; prompt paragraph in
   `prompts.ts`, omitted when the capability is off. Tests: CLI against a fake fetch; prompt snapshot
   with and without the capability.
10. **Dry-run e2e.** `CEZ_DRY_RUN=1`: two projects, A waits on B, B finishes, A wakes. Gate: full
   validation sequence.

### Phase 2 — Create and wait in another project

11. **Contract** `create` branch of `waitInputSchema`; `RunRecord.waitedBy`.
12. **Create path.** Route builds the target context, starts an autonomous root task through the
    target manager's `startRun` (base branch, review gate), writes the edge atomically after the
    start succeeds. Counts toward the creator's in-flight cap. Tests: success, target start failure
    leaves no edge, cap refusal.
13. **Budget.** Require `--budget` when the creator has a dispatch budget; extend
    `remainingBudgetUsd` with the creator's `created` edges (pending reserves, settled charges
    `outcome.costUsd`). Tests mirror the `engine.test.ts` budget cases.
14. **CLI + exception.** `cez task create --project`; prompt paragraph updated; AGENTS.md § Zero config exception line and `.env.example` wording for the create path. Dry-run e2e: A creates in Q,
    waits, wakes with Q's outcome.

### Phase 3 — Cockpit

15. Waiter indicator + Stop waiting on detail and list row (component tests, light/dark).
16. "Wait for task…" dialog with project → run picker (component + e2e smoke).
17. "Created by" chip on created targets. Hidden-when-off test for every affordance.
