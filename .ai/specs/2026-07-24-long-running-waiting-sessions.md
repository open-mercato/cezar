# Durable monitoring sessions with bounded background capacity

> Issue: #654 · Extends: `2026-07-18-subagent-monitoring-status.md` (#490)

## TLDR

Stabilization agents can correctly declare `CEZ:MONITORING` while they wait for CI, but cezar still closes their live backend session after 15 minutes of inactivity. Make agent-declared monitoring sessions durable until the agent finishes, the user cancels, or the backend disconnects, while retaining the existing timeout for sessions genuinely waiting on a user. Add a workspace-wide `resources.maxMonitoringSessions` limit (default 2) so the scheduler supports **Y active task slots plus X parked monitoring sessions** without allowing an unbounded collection of live agent processes. Optional periodic wakeups are designed separately in `2026-07-24-monitoring-session-auto-wake.md` so the zero-cost lifecycle and the cost-bearing automation each remain independently deployable.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|----------|-----------------|-----|----------|
| Q1 | Which parked sessions become durable? | Only turns ending in `CEZ:MONITORING`; ordinary `waiting` sessions keep the 15-minute timeout. | The marker is an explicit agent-owned liveness declaration, while an unanswered user handoff can safely expire as today. | ok |
| Q2 | How should monitoring interact with task concurrency? | Allow `maxParallel` active slots plus `maxMonitoringSessions` exempt monitoring slots; overflow monitors stay alive but consume active capacity. | This bounds extra live processes without killing work or inventing a second queue. | ok |
| Q3 | What is the zero-config default? | `maxMonitoringSessions: 2`, workspace-wide, editable under Settings → Resources. | Two matches the current `maxParallel` default, supports common review/CI workflows, and keeps host exposure bounded. | ok |
| Q4 | Should the limit apply per project? | Workspace-wide only in this version. | Live agent processes consume host resources; the established workspace semaphore is the canonical host-governance boundary. | ok |
| Q5 | Does durability survive a cezar/server restart? | No new cross-process session resurrection; recovery follows each backend's existing resume behavior. | The issue is premature in-process inactivity closure. Persisting or reattaching arbitrary live processes is a separate capability. | ok |

## Problem Statement

Issue #654 records stabilization workflows that wait for CI and then end due to inactivity before CI finishes. The first half of the lifecycle already exists: #490 introduced `CEZ:MONITORING`, maps the run to `status: 'running', activity: 'monitoring'`, suppresses false “needs you” attention, and frees the normal task slot. The second half still uses the ordinary waiting lifecycle. Both turn-end paths call `armIdleTimer()`, and `src/workflows/run.ts` closes the backend session after the fixed `IDLE_TIMEOUT_MS = 15 * 60_000`.

That creates two failures:

1. a correctly marked autonomous wait is destroyed solely because an external CI job took longer than 15 minutes;
2. the idle-close path reports the unfinished agent step and run as successfully `done`, preserving stale `activity: 'monitoring'` on a terminal record and making the Tasks UI claim the task finished even though its workflow never reached `CEZ:DONE`;
3. workflow-owned cleanup after the wait—such as releasing an `in-progress` PR lock, submitting the final review, or moving a PR after CI—never runs; and
4. simply removing the timeout would make every parked monitor exempt from `maxParallel`, allowing an unbounded number of live agent processes to accumulate.

The product needs separate accounting for active execution and bounded background monitoring: Y tasks actively work while up to X additional sessions wait on their own downstream work.

### Production evidence from `mercato-development`

The persisted local Cezar project demonstrates the complete causal chain; this is not an inferred race:

| Run | Declared state | Cezar terminal sequence | Unfinished downstream state |
|---|---|---|---|
| `1433ac74…` / PR #4452 | Final assistant message ended in `CEZ:MONITORING` while a CI rerun was running. | At `10:20:02Z`, exactly 15 minutes after turn-end, Cezar appended `session closed after 15m of inactivity`, `done`, `session.ended`, `step-end: done`, and `run finished`. The persisted record is `status: done, activity: monitoring`. | The agent had said final approval and label cleanup would follow the rerun. PR #4452 retained `in-progress`, proving that completion cleanup did not run. |
| `2f4e0fe4…` / replacement PR #4457 | Final assistant message ended in `CEZ:MONITORING` while replacement CI was running. | The same idle-close → `done` sequence occurred exactly 15 minutes later, leaving `status: done, activity: monitoring`. | The replacement remained open and still required review/QA work. |
| `7c542c7c…` / replacement PR #4461 | Final assistant message ended in `CEZ:MONITORING`; a long `gh run watch` completed after turn-end. | The timer still closed the session at the original turn-end +15 minutes and marked the run done. | The replacement remained in `review`; the agent never got a turn to interpret the successful checks. |
| `4e88f320…` / replacement PR #4465 | Final assistant message explicitly said CI was queued and ended in `CEZ:MONITORING`. | The same false-success sequence occurred at +15 minutes. | The replacement remained in `review` with required QA outstanding. |

The acceptance criterion is therefore stronger than “show monitoring for 15 minutes”: once the assembled terminal assistant message selects monitoring, no ordinary idle timer may convert that epoch into a successful terminal run. Only an agent `CEZ:DONE`, an explicit user finish/cancel, or a real backend/session failure may terminate it.

## Proposed Solution

Keep `CEZ:MONITORING` as the only protocol signal; do not add another marker. Change its lifecycle and scheduler accounting:

1. **Durable monitoring lifecycle.** A monitoring turn does not arm the user-wait idle timer. It remains live until it emits `CEZ:DONE`, is cancelled/finished by the user, fails or disconnects at the backend boundary, or receives a follow-up that resumes active work. Plain waiting and `CEZ:ASK` retain the current 15-minute timeout.
2. **Bounded monitoring exemption.** Add `resources.maxMonitoringSessions`, integer 0–16, default 2. At most this many monitoring runs are subtracted from `busySlots()`. Any further monitor remains open but is not exempt, so it consumes one of `maxParallel` and prevents new queued work from starting until capacity returns.
3. **Live configuration.** Persist the setting in the existing optional `~/.cezar/config.json` resources object and edit it in Settings → Resources. A semaphore refresh applies it without restart. Missing, invalid, corrupt, or read-only config degrades to the default like existing resource keys.
4. **Visible capacity.** Explain the two-pool model beside the new control: “Active tasks: Y · extra monitoring sessions: X.” The existing task status remains “monitoring”; no new run status or notification behavior is introduced.

The overflow policy deliberately uses back-pressure rather than eviction. Killing the oldest or newest monitor could destroy the only agent tracking a deployment; silently demoting it to ordinary waiting would incorrectly request user attention. Counting overflow against active capacity is deterministic, reversible, and preserves every live session.

## Research

GitHub Actions separates running work from pending work through concurrency groups, and can bound the two states independently rather than treating every pending job as active execution. GitLab Runner documents a separate `request_concurrency` limit for long-polling requests because blocked requests can otherwise starve job-processing workers; its guidance is to size polling and execution capacity as distinct pools. Cezar adopts the useful shared principle—bounded capacity per lifecycle class—without their distributed-runner complexity: one workspace semaphore accounts for active agents and a small exempt monitoring pool.

## Architecture

### Workspace configuration

Extend `resourcesSchema` in `src/workspace/config.ts`:

```ts
maxMonitoringSessions: z.number().int().min(0).max(16).default(2).catch(2)
```

The key is additive and optional on disk. It is returned and accepted by the existing workspace config API, mirrored in web API types, and exposed through `WorkspaceResourceLimits`. `WorkspaceSemaphore.refresh()` continues to be the single live-update path. No new file, migration, environment variable, daemon, or startup requirement is introduced.

`0` is meaningful: monitoring remains durable but receives no extra capacity, so every monitoring session continues to count against `maxParallel`. This is the conservative operator choice for memory-constrained machines.

### Scheduler accounting

Today one `waiting` set includes both genuine user waits and monitoring runs, and `busySlots()` subtracts all of them. Split accounting without creating a new public status:

- retain `waiting` as the lifecycle set for parked live sessions and immediate resume behavior;
- add a private `monitoring` set (or derive a count from parked run records if that proves equally deterministic);
- add/remove a run from `monitoring` exactly where `activity: 'monitoring'` is written/cleared;
- compute ordinary waiting exemptions as today because they remain time-bounded;
- cap only the durable monitoring exemption.

Equivalent accounting:

```ts
const ordinaryWaiting = this.waiting.size - this.monitoring.size
const exemptMonitoring = Math.min(this.monitoring.size, this.semaphore.maxMonitoringSessions())
return this.active.size + this.starting.size - ordinaryWaiting - exemptMonitoring
```

This yields at steady state at most `maxParallel` slot-equivalent active work plus `maxMonitoringSessions` extra live monitors. If a running task becomes monitor X+1, it stays alive and continues occupying the slot it already held. No race can briefly grant an additional exemption: the set update and store transition happen in the same synchronous turn-end handler before `releaseSlot()` pumps queues.

The existing invariant that a user message resumes a parked session immediately—even if this temporarily exceeds the configured active ceiling—stays unchanged. On its next park or terminal transition, accounting converges again.

### Session lifecycle

At both turn-end sites in `src/workflows/run.ts`:

- `monitoring`: update run/step state, add to `waiting` and `monitoring`, do **not** call `armIdleTimer()`, then ask the workspace semaphore to pump;
- plain waiting / structured ask: update waiting state, remove from `monitoring`, add to `waiting`, and arm the existing idle timer;
- done, resume, cancel, failure, finish, explicit close, and backend end: clear both parked sets and any timer through one idempotent helper.

Marker selection is made from the assembled terminal assistant text, after applying the existing precedence `CEZ:DONE` > `CEZ:ASK` > `CEZ:MONITORING`. Stripping the marker from display text must not alter the already-computed lifecycle decision. A monitoring turn must never fall through to the generic session-end success path merely because there is no active model turn.

The ordinary idle timer is a session-liveness policy, not evidence that the agent achieved its goal. In particular, its callback must not synthesize `done`, `step-end: done`, or `run finished` for a monitoring epoch. A genuine backend disconnect follows the existing failed/interrupted path and clears `activity`; every terminal write must clear `activity` so `status: done, activity: monitoring` is unrepresentable after this change.

No synthetic keepalive is sent to the agent CLI. Cezar owns the child/session lifecycle already; keeping its own idle-close timer disarmed is sufficient. If a backend independently disconnects or rejects a later resume, the existing failure path remains authoritative and visible.

### API Contracts

The existing workspace-level routes remain the only contract:

```ts
// GET /api/workspace/config
resources: {
  maxParallel: number
  maxMonitoringSessions: number
  memoryLimitMb: number | null
  worktreeRetentionDefault: number
}

// PUT /api/workspace/config
{ resources: { maxMonitoringSessions: 0..16 } }
```

The PUT boundary uses zod `safeParse`, merge-writes through `mergeWriteWorkspaceConfig`, returns `{ error }` on invalid input, and refreshes the semaphore after any resource patch. The route-parity rule is unaffected because this is a workspace route and never gets `/api/p/:projectId` aliases.

## Data Model

No `RunRecord` change is needed: `activity: 'monitoring'` is already persisted and backward compatible. The only new persisted value is the optional workspace resource key. Every schema object remains `.passthrough()`, invalid values fall back per-key, and merge-writes preserve unknown future fields.

No migration is required. Existing installations load `2`; deleting `~/.cezar/config.json` reconstructs that working default. A read-only home keeps the in-memory default and emits the existing single warning rather than failing boot.

## UI/UX

Add one `SettingsField` after “Max parallel tasks” in Global Settings → Resources:

- title: **Extra monitoring sessions**;
- a 0–16 select, matching the existing max-parallel control;
- hint: **How many agent sessions may wait on CI, sub-agents, or monitored commands without using an active task slot. Extra sessions stay alive but pause the queue.**;
- helper: **Capacity: {maxParallel} active + {maxMonitoringSessions} monitoring. Set 0 to make monitoring share active slots.**

Saving uses the existing mutation/cache update and needs no restart. Disable the select while saving and use the current toast/error behavior. Keyboard and screen-reader behavior matches the existing native select; its label is “Extra monitoring sessions.” Mobile layout remains a single vertical settings field.

Illustrative target mockup: `assets/long-running-waiting-sessions/mockup-01-resources-monitoring-capacity.png`.

The Tasks UI does not change: durable sessions already display the violet “monitoring” pill, remain in Working, suppress notifications, and allow the existing cancel/finish actions.

## Edge Cases & Failure Scenarios

- **Limit lowered below the current monitor count.** Never kill sessions. Recompute exemptions immediately; overflow consumes active capacity and new queued work waits. As monitors finish, capacity returns naturally.
- **Limit raised.** Newly exempt monitors free active capacity; `refresh()` must trigger a workspace pump so queued work starts without another event.
- **Cezar restarts.** Persisted monitoring activity is retained according to current run recovery, but this feature does not promise resurrection of a backend process that no longer exists. Recovery must never manufacture a live session.
- **Backend disconnects while monitoring.** Use the existing session-end/failure path, clear accounting, and surface the terminal state; do not loop reconnects indefinitely.
- **Agent forgets `CEZ:MONITORING`.** It becomes ordinary waiting and expires after 15 minutes, preserving backward compatibility.
- **A monitored command or sub-agent finishes after the assistant turn ends.** Its late event does not reset or terminate the epoch. The session remains monitoring until an explicit follow-up/wake lets the agent interpret the result and finish its workflow.
- **Idle callback races marker handling.** Parking cancels any previous idle timer before publishing `running`/`monitoring`; the callback re-checks the current epoch/activity and cannot emit terminal success for a monitor.
- **Agent emits `CEZ:ASK` and `CEZ:MONITORING`.** Existing precedence keeps ASK as genuine attention with the ordinary timeout.
- **Memory guard trips.** Existing per-task memory enforcement remains authoritative. Durable does not mean immune to explicit resource safety controls.
- **Non-git directory.** Its active cap stays 1; it may still use the workspace monitoring exemption because that pool protects the host, not git semantics.
- **Config unavailable/corrupt.** Use 2 and keep boot working.

## Risks & Impact Review

- **Host resource risk:** monitored sessions may retain agent CLI processes indefinitely. The bounded default and overflow accounting make the additional exposure explicit: at most two sessions beyond the active ceiling by default. Operators can set 0.
- **Scheduler regression risk:** `busySlots()` is a shared workspace contract and resume intentionally overshoots. Focused semaphore tests must cover multiple managers, dynamic limit changes, overflow, and release ordering.
- **Compatibility:** additive workspace response/request field and config key; existing clients ignore it, old files parse, and no status/event schema changes occur. No protected CLI, runner, workflow YAML, or route shape breaks.
- **Rollback:** reverting restores the 15-minute monitor timeout. The unknown `maxMonitoringSessions` config key survives `.passthrough()` round-trips and is harmless to older binaries.
- **Observability:** lifecycle events should distinguish ordinary idle closure from backend disconnection; no periodic monitor heartbeat or polling is added.

## Phasing

- **Phase 1 — durable lifecycle:** separate monitoring from ordinary waiting timers while retaining every existing terminal cleanup path.
- **Phase 2 — bounded scheduler capacity:** add the workspace setting and account for only X exempt monitoring sessions across projects.
- **Phase 3 — operator control and evidence:** expose the setting in Resources, document the two-pool model, and verify the real UI.

## Implementation Plan

### Phase 1 — Durable monitoring lifecycle

1. **Centralize parked-session bookkeeping.** Add private helpers in `src/workflows/run.ts` that park a run as ordinary waiting or monitoring and idempotently clear parked state/timers on resume and termination. Keep the public run/step statuses unchanged. *Tests:* existing waiting and monitoring turn-end tests still pass; both backend execution paths update the correct private sets.
2. **Disarm inactivity closure for monitors.** Call `armIdleTimer()` only for plain waiting and ASK turns. *Tests:* fake timers prove an ordinary waiting session closes at 15 minutes while a monitoring session remains open past the same boundary and can later resume/complete.
3. **Prevent false terminal success.** Guard the idle callback and generic session-end path so a monitoring epoch cannot emit `done`, `step-end: done`, or `run finished`; clear `activity` on every real terminal transition. *Tests:* reproduce the production event sequence with a trailing marker and late tool result, advance beyond 15 minutes, and assert the run remains `running`/`monitoring`, no terminal events exist, and a later follow-up can complete normally. Add a store invariant/regression assertion that terminal records never retain `activity: monitoring`.
4. **Cover every exit.** Clear monitoring bookkeeping and any pending wake timer on sendMessage, continuation start, done, explicit finish, cancel, failure, backend end, and recovery cleanup. *Tests:* parameterized lifecycle assertions prove no stale monitor count/timer survives a terminal/resumed transition.

### Phase 2 — Bounded monitoring capacity

5. **Add the workspace resource contract.** Extend workspace config/schema, `WorkspaceResourceLimits`, production loader, API response/input schemas, and web API types with `maxMonitoringSessions` default 2 and range 0–16. *Tests:* missing/valid/invalid/corrupt values, passthrough preservation, read-modify-write, GET/PUT validation, and read-only degradation.
6. **Apply capped exemptions.** Update `busySlots()` to subtract every time-bounded ordinary wait but only `min(monitoring, maxMonitoringSessions)` durable monitors. Ensure resource refresh pumps managers after a changed limit. *Tests:* with Y=2/X=1, two active + one monitor may coexist; monitor #2 occupies an active slot and blocks a queued task; completion/lower/raise transitions restore capacity; aggregate behavior holds across two project managers and per-project active caps.
7. **Protect recovery and non-git behavior.** Rebuild private monitoring bookkeeping only for genuinely recoverable live state and preserve the non-git active cap. *Tests:* stale persisted activity cannot grant a phantom exemption; non-git remains one active task plus allowed monitors.

### Phase 3 — Settings UI, documentation, and validation

8. **Add Resources control.** Render the 0–16 capacity select and dynamic “Y active + X monitoring” helper; save through the existing workspace config mutation. *Tests:* initial value, change payload, cache refresh, disabled state, 0 semantics, error toast, and accessible label.
9. **Add regression-level UI coverage.** Extend the browser smoke suite to change the setting, reload Resources, and verify persistence plus the capacity helper. Capture before/after screenshots for the PR; keep `needs-qa` until human sign-off.
10. **Document the lifecycle contract.** Update the #490 spec’s superseding note and user-facing resource documentation to state that monitoring is durable but bounded, ordinary waiting still expires, and overflow back-pressures the queue. Run the complete validation gate and package test because workspace config is a shipped compatibility surface.
