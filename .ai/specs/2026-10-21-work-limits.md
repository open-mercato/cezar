# Work limits - separate pools and limits that follow free resources

> Slug: `work-limits` · Status: **implemented** · Builds on: `2026-10-21-host-resource-limits.md`
> (the host sampler subscription, the per-tick start brake) · Same safety principles as
> `2026-09-20-adaptive-admission-governor.md` and `2026-09-20-dispatch-admission-scheduler.md`.

## TLDR

1. Every concurrency bound goes from 16 to **128** (`MAX_CONCURRENCY` in the contract).
2. Dispatched children can draw on **their own pools**: `maxSubagents` (kind `implement`) and
   `maxReviewers` (kind `review`). Intake tasks filling `maxParallel` can no longer starve the
   reviews they wait for.
3. `autoScale` lowers every pool to what free memory and CPU can carry.

All three are inert by default.

## The deadlock this removes

A top-level task (an automation or tracker "intake") holds a `maxParallel` slot while it waits for
its dispatched children. The children queue for the SAME slots. With `maxParallel` full of intake
tasks, no review can start, so no intake task finishes. Parked parents are already exempt from the
count (spawn-parked, dispatch A5); parents that are still working are not.

## Pools

- A run is `main`, `subagent` or `review`. Only a run with `dispatch.parentRunId` can be a child;
  its `dispatch.kind` picks the pool. A kind gets its own pool only when that key is set
  (`WorkspaceSemaphore.classify`); otherwise it is `main` and behaves as before.
- `RunManager.busyByClass()` splits `busySlots()` per run with the same exemptions (waiting,
  monitoring up to `maxMonitoringSessions`, spawn-parked parents). With no separate pool it returns
  `busySlots()` itself, so the default path is unchanged by construction.
- `pump()` checks the candidate's OWN pool (`poolHasRoom`), so a full main pool no longer blocks a
  review behind it in the FIFO. A slot freed in any pool already routes through `release()`.
- **Per-project `maxParallel` binds the main pool only.** It exists to keep one repo from
  hogging the machine with top-level tasks; capping its dispatched children by the same number
  would recreate the deadlock per project. The non-git "one at a time" rule still counts every
  class. The worktree-lifecycle coordinator also gates on the main pool.
- `SemaphoreParticipant.busyByClass` is optional; a participant without it counts as all `main`.
- **Per-parent fan-out** is `resources.maxChildrenPerParent` (default 4 = the old
  `DISPATCH_MAX_IN_FLIGHT`, range 1..32), so a pool larger than `4 x parents running` can fill.
  `dispatch()` enforces `min(configured, intent.inFlight)`; the contract constant stays the default
  and fallback, the intent's `inFlight` bound is the configured maximum (32), and the agent prompt
  is composed with the effective value in `prepareDispatchSession`, the one function both
  `ActiveRun` construction sites call. `DISPATCH_MAX_SUBTASKS` (50) only bounds the OPTIONAL
  per-tree ceiling a user sets in the composer; with none set a tree is unbounded, so it does not
  block ~100-process scale and stays a schema bound.
- **Nested children.** A sub-agent that dispatches its own children and keeps running holds a slot of
  its pool, so with `maxSubagents` full of such parents the grandchildren could never start. Rule: a
  child of a child (depth >= 2) whose own pool is full borrows a main-pool slot when main has room
  (`RunManager.borrowed`; it then counts against main, not its pool). The borrow is opportunistic,
  so when both pools are full the stall remains; that needs the whole workspace saturated, and
  raising either pool clears it.

## autoScale

`effectiveCapacity` (pure, `workspace/effective-capacity.ts`):

```
headroom  = floor(min(freeMem / memPerRun, freeCpuCores / cpuPerRun))
effective = max(1, min(configured, busyInPool + headroom))      per pool
```

- `freeMem` = host available memory (the cgroup limit's headroom when one exists) minus
  `hostReserve.memoryMb`. `freeCpuCores` = effective cores (cgroup quota / cpuset / host) x idle
  fraction.
- `memPerRun`, `cpuPerRun` = mean over the agent trees running now (`process-usage`); 1 GiB and 0.5
  core until something is measured (Windows reports 0 CPU, so its CPU term always falls back).
  Floors of 256 MiB and 0.1 core keep a near-idle reading from promising hundreds of runs.
- **Reduction only**, never below one (a pool at zero parks parents on children that cannot start),
  never preempts: a limit under the busy count only blocks new starts.
- **Hysteresis**: lowered at once, raised only after 3 consecutive samples (~6 s) that want more
  (`stepScale`). A raise re-pumps the queue.
- **Fail open**: no fresh host sample, or neither resource readable, returns the configured limits
  immediately (no slow ramp).
- The headroom is computed once per sample and SHARED across pools in proportion to each pool's
  unused configured capacity (configured - busy); the integer remainder goes to main, then review,
  then subagent. So the sum of limits never exceeds busy_total + room (the floor of 1 per pool is
  the one overshoot). A first design gave main the room first; the live check showed that starves
  both child pools at their floor whenever main is not full, which recreates the stall.
- **Brake.** autoScale alone brakes starts to one per tick only once the room is below 2; with
  more room starts are admitted up to the effective limits immediately.
- **Stale / config change.** `effectiveLimits()` ignores a reading older than a stale window; a
  config change re-bases the limits on the current headroom.

## Exposure

`GET/PUT /api/v1/workspace/config` `resources` gains `maxSubagents`, `maxReviewers`, `autoScale` and
`effective: {maxParallel, maxSubagents, maxReviewers}` (what admission uses now). Settings ->
Resources shows "effective X of Y" while autoScale has lowered a limit and polls every 5 s while it
is on.

`WorkspaceSemaphore.freeCapacity(): {main, subagent, review}` is `max(0, effective - busy)` per
pool, for a fleet hub that reports spare capacity. A kind without its own pool reports the main
pool's room, because that is the slot it would take.

## Scale notes (~100 processes)

The process sampler is one `ps`/CIM snapshot per 2 s regardless of run count, and the pump cost is
O(queued x running) lookups per sweep. Not measured beyond that; the first real bottleneck at that
size is more likely the agent CLIs' own memory, which is what `autoScale` and the host reserve
watch.
