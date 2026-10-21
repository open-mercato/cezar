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
- `DISPATCH_MAX_IN_FLIGHT` (4 children per parent) is unchanged. A pool larger than
  `4 x parents running` will not fill: raise parents, not that constant. `DISPATCH_MAX_SUBTASKS`
  (50 per root) is a total, not a concurrency, and also stays.

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
- The headroom is shared, so two pools can each claim it; the one-gated-start-per-tick brake and
  the next sample absorb that.

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
