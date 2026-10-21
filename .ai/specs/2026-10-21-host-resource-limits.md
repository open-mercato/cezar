# Host resource limits - keep a personal computer usable while agents run

> Slug: `host-resource-limits` · Status: **implemented** · Relates to:
> `2026-09-20-adaptive-admission-governor.md`, `2026-09-20-dispatch-admission-scheduler.md`
> (same safety principles), `2026-09-20-host-resource-telemetry.md` (the sampler it reads).

## TLDR

Three opt-in `resources` keys in `~/.cezar/config.json` make cezar a polite guest on a laptop:
agents run at a lower OS priority, and NEW tasks wait while the machine is short of memory or busy.
Defaults change nothing.

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `agentCpuPriority` | `normal` | `low` = nice 10 / BELOW_NORMAL, `idle` = nice 19 / IDLE class |
| `hostReserve.memoryMb` | `null` | no new start below this much available RAM |
| `hostReserve.cpuPct` | `null` | no new start above this host CPU % |
| `totalAgentMemoryMb` | `null` | no new start while summed agent-tree RSS is at/above this |

## Behaviour

- **Priority** is applied with `os.setPriority(pid)` in `registerRunProcess`, the one place an
  agent's root pid is known. Children spawned later inherit it (niceness on Unix, priority class on
  Windows). EPERM / dead pid / unsupported platform are swallowed. Lifecycle and check-step
  processes are NOT touched: they have no equally central spawn point and are short-lived.
- **Admission** is one extra term in `pump()`'s capacity check (`WorkspaceSemaphore.hostAdmits()`),
  evaluated after the `maxParallel` terms so a refusal always means "otherwise startable".
- **Reduction only.** The gate can delay a start, never raise a configured limit and never touch a
  running task. Resumes of `waiting` runs bypass `pump()` and are never gated (#347).
- **Fail open.** No host sample yet, a sample older than `HOST_SAMPLE_STALE_MS`, or a missing
  `cpuPct` (needs a delta window) means "admit". Unreadable telemetry must not wedge a queue.
- **Liveness.** When nothing holds a slot (`busy() === 0`) one run is always admitted, so a queue
  cannot dead-end behind a machine that is busy with something else.
- **Ramp brake / hysteresis.** After a gated start, the next gated start waits for a fresh
  telemetry tick (~2 s), because a just-started agent has not allocated yet and a burst of queued
  runs would all pass the same stale reading. Pressure that has cleared is noticed on the next tick.
- **Wake-up.** A refusal is remembered; the next tick calls `release()` so queued runs start as
  soon as pressure eases. The host sampler is subscribed only while `hostReserve` is set, the
  agent-usage listener only while `totalAgentMemoryMb` is set; `refresh()` (config PUT) re-syncs both.
- **Containers.** Memory headroom is `min(host available, memLimit - memUsed)` when a cgroup
  memory limit exists; CPU uses the cgroup's own `cpuPct` when present.

## Why `totalAgentMemoryMb` exists next to `hostReserve`

`hostReserve` reacts to what the whole machine is doing (a browser can eat the headroom).
`totalAgentMemoryMb` is a budget for cezar's own footprint, independent of other apps, and it works
where host memory is unreadable. Per-task `memoryLimitMb` bounds one task, not the sum.

## UI

Settings -> Resources: a "Keep this computer responsive" On/Off preset (low priority, 2048 MiB
free, 90 % CPU) plus the individual fields.

## Limits

CPU on Windows host telemetry comes from `os.cpus()` deltas and is fine; per-run CPU from
process-usage is 0 on Windows (not used here). The `idle` class can starve agents on a busy
machine by design.
