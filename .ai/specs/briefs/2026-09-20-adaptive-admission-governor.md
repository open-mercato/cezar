# Adaptive admission governor - brief

- Date: 2026-09-20
- Category: feature
- Priority signal: medium-high - a workspace that sets `dispatchMaxConcurrent` (#1034) wants that
  ceiling to be a *maximum*, not a constant: when the machine is already under memory or CPU
  pressure, admitting four children is the fastest way to make everything slower.
- Risk signal: medium - this touches the ADMISSION mechanism, which is the highest-risk kind of
  change in this repo. The mitigations are structural, not tuning: reduction-only, never above the
  user's own ceiling, fail-open on every unreadable fact, no preemption, and no change at all to the
  default path (no cap set = nothing to reduce).
- Routing: Next: `om-auto-write-spec` "Adaptive admission governor - brief: this file".

## Problem

`DISPATCH_MAX_IN_FLIGHT` (4 per parent) and the opt-in workspace cap `dispatchMaxConcurrent` (#1034)
answer "how many children MAY run". They do not answer "how many SHOULD run right now". On a laptop
already swapping, or a container at its memory limit, four children is a decision to make the
machine thrash - and the host telemetry that could say so (`.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`)
is a *display*: it reports effective capacity and stops there.

The v2.3 spec pins the chain, the hard ceiling, the fail-open rule, the no-preemption rule and the
pressure sources (F12), and explicitly defers thresholds, hysteresis, max-hold and the
workspace-wide state to this spec.

## Agreed direction (option A - reduction below the user's own ceiling)

The governor is a **reduction layer**, never a second cap: it can only lower the ceiling the user
already chose, and only while the machine is measurably under pressure.

1. **No cap, no governor.** `dispatchMaxConcurrent` unset (`null`) means the user asked for no
   workspace ceiling; there is nothing to reduce, and the default path is byte-identical to today.
   (The per-parent `DISPATCH_MAX_IN_FLIGHT = 4` is an agent-facing contract, not a host-protection
   knob, and lowering it is an explicit non-goal.)
2. **Pressure from the process's own cgroup, raw.** `memory.current / memory.max`,
   `memory.events` (`high`, `oom`, `oom_kill`) and PSI (`memory.pressure`, `cpu.pressure`
   `avg10`) - never the cache-excluded display value, exactly as F12 pins it.
3. **Three levels, with hysteresis and a bounded hold.** `normal` → `elevated` (half the ceiling)
   → `critical` (a quarter). Entry needs the condition twice in a row, except `oom_kill`, which is
   critical immediately; exit needs six calm samples. A reduction is held at most 10 minutes, then
   re-evaluated - a governor that cannot lift is a new cap.
4. **Fail-open everywhere.** No cgroup files, no limit, no PSI, a stale read: `normal`, i.e. the
   user's ceiling applies unchanged. An unreadable machine must never throttle work.
5. **Visible where the ceiling is set.** One readout line on Settings -> (global) Resources, beside
   the `Max running dispatched tasks` field: the state and `effective of configured`. No new knob:
   the existing field IS the ceiling.

## What this is not

- Not preemption: a running child is never stopped; only new admissions wait.
- Not a second source of truth for capacity: it consumes the counters the telemetry spec pinned.
- Not adaptive scheduling of ordinary tasks: `maxParallel` and the per-project ceilings keep
  governing them, untouched.

