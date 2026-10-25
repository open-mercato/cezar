# Adaptive admission governor - pressure-aware reduction of the dispatch ceiling

> Slug: `adaptive-admission-governor` · Status: **draft v1.1, for review** · Brief:
> `.ai/specs/briefs/2026-09-20-adaptive-admission-governor.md` · Consumes: the dispatch cap from
> #1034 (`dispatchMaxConcurrent`) and the effective-capacity measurement from #1042
> (`.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`) · Delivery: one implementation PR
> stacked on those two while they are open · v1.1 folds the independent review (unit `25ed2607`,
> verdict `changes`): the hold is now clock-bounded (B1), both "no ceiling" spellings are named
> (M1), the payload key is absent without a ceiling (M2), the full pinned chain and the pressure
> scope are stated (m1/m4), and the verdict's nits are addressed.

## 📝 TLDR

The dispatch ceiling becomes a **maximum** instead of a constant. While the process's own cgroup is
under memory or CPU pressure, the governor lowers `dispatchMaxConcurrent` - half at `elevated`, a
quarter at `critical`, never below one child - and lifts the reduction once the machine has been
calm for six samples. It only ever lowers, it never touches a running child, and with no ceiling set
there is nothing to lower: the default path does not change at all. One readout line on
Settings -> Resources shows the state and `effective of configured`.

## 📝 Problem Statement

- **A fixed ceiling cannot know the machine is struggling.** #1034 ships `dispatchMaxConcurrent` as
  an opt-in workspace ceiling and `DISPATCH_MAX_IN_FLIGHT = 4` bounds each parent. Both are static:
  four children on a laptop that is already swapping turn "more parallel work" into "less finished
  work".
- **The measurement exists but nothing consumes it.** #1042 turns host telemetry into effective
  capacity (the process's own cgroup: quota, cpuset, memory limit, cache-excluded usage). It is a
  display. The v2.3 spec pins the governor's chain and stops there on purpose.
- **A governor that cannot be trusted is worse than none.** The failure everyone fears is a cap that
  never lifts, or one that throttles a healthy machine because a file was unreadable. Both are
  structural properties, so this spec fixes them structurally: reduction-only, fail-open,
  hysteresis with a bounded hold, no preemption.

## 📝 Proposed Solution

### 1. The chain, and which term this governor supplies

The v2.3 pin (`.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`) is six terms; this governor
SUPPLIES one of them and leaves the other five exactly where they already are, which is what makes it
a small change:

| Term in the `min(...)` | Who enforces it | Does this governor touch it? |
| --- | --- | --- |
| `adaptive ceiling` | **this spec** - the shared workspace semaphore's admission ceiling | yes, it IS the term |
| `DISPATCH_MAX_IN_FLIGHT` (4) | the request-time check in `run.ts` (~1990) | no |
| `intent.inFlight` | the same request-time check (per-parent intent) | no |
| `maxParallel` | `capacity()` in `run.ts` (~1381) | no |
| `projectMaxParallel` | `capacity()` (per-project override) | no |
| `dispatchMaxConcurrent` | the workspace semaphore (#1034) - the user's ceiling | reduced, never raised |

- `configured` is the user's `dispatchMaxConcurrent`; the governor lowers it, never raises it, and
  never touches the other terms.
- **`configured` has TWO accepted "no ceiling" spellings** (#1034's own contract, and the settings
  form): `null` and `<= 0`. Both mean "no cap" there, so both mean "nothing to reduce" here. A
  literal `configured: 0` must never reach the wire (the contract is `.positive()`) and must never
  collapse to `max(1, ceil(0 * factor)) = 1` - that would turn an explicit no-cap into the tightest
  possible cap.
- Ordinary runs never consult any of this: the gate in `workflows/run.ts` is per-candidate and only
  for `queued.dispatch?.parentRunId`.

### 2. Signals and thresholds (one read per evaluation, no timer)

| Signal | `elevated` | `critical` |
| --- | --- | --- |
| `memory.current / memory.max` (only when `memory.max` is finite) | ≥ 0.85 | ≥ 0.95 |
| `memory.events.high` delta (throttle events) | > 0 since the last sample | - |
| `memory.events.oom_kill` delta | - | > 0 since the last sample (immediate) |
| `memory.pressure` `avg10` | ≥ 20 | ≥ 50 |
| `cpu.pressure` `avg10` | ≥ 80 | - |

Every row is optional: a container without PSI simply contributes nothing, and a machine where
nothing is readable is `normal` (fail-open). The worst reached level wins.

**Scope of the read (v1.1, from the review):** pressure comes from the LEAF cgroup the process
actually lives in - usage and PSI - while limits come from the ancestor walk, exactly the rule
`cgroup-probe.ts` already pins ("ancestors for limits, the leaf for usage"). Reading PSI from the
narrowest cgroup is what keeps a busy sibling from throttling this workspace, and reading
`memory.max` from the ancestor walk is what makes the ratio meaningful under a systemd scope or
`--cgroupns=host`.

### 3. Hysteresis and the CLOCK-bounded hold

- **Enter**: two consecutive samples at a level (or one `oom_kill`, which is critical at once). The
  streak is the deadband: at the 2 s cadence that is ~4 s of sustained pressure, so a single spike
  cannot halve a fan-out. (A separate value deadband - the pin's `cpuHigh`/`cpuLow` idea - is
  deliberately NOT added: with a 2 s sampler and a 6-sample exit it would only lengthen the same
  protection. If a future cadence changes, this is the knob to revisit.)
- **Exit**: six consecutive `normal` samples (~12 s of calm) **OR** `GOVERNOR_MAX_HOLD_MS = 10 min`
  since the reduction was taken - whichever comes FIRST. The hold is a CLOCK bound, evaluated on
  the next look (an admission sweep, or the readout read): a quiet workspace therefore lifts on its
  next look rather than waiting for samples it would never take. A governor that cannot lift is a
  new cap, and this rule is what forbids it. The streak may only make the lift EARLIER, never later.
- **Stale or unreadable is not pressure.** A missing sample, an unreadable file, a throwing reader
  and a gap longer than the sample interval all read as `normal` (fail-open) and do not count as a
  sample in either streak.
- **Cadence**: evaluated lazily, at most once every `GOVERNOR_SAMPLE_INTERVAL_MS = 2 s`, on the
  admission path or a readout read. No interval, no daemon, no cost while nothing dispatches.

**Transitions** (the table the review asked for):

| From → to | Trigger | State effects |
| --- | --- | --- |
| `normal → elevated/critical` | 2 consecutive samples at the worse level, or an `oom_kill` | `since` and the hold window start; both streaks reset |
| `elevated → critical` | 2 consecutive `critical` samples, or an `oom_kill` | hold window RESTARTS from the escalation (the machine is worse now) |
| `critical → elevated → normal` | 6 consecutive calm samples per step | `since` updated per step; at `normal` the hold window clears |
| any → `normal` at the hold expiry | clock bound reached and the current sample is calm | the reduction lifts immediately, streaks ignored |
| any → same or lower non-normal level at the hold expiry | clock bound reached while the current sample is STILL `elevated`/`critical` | the level moves straight to what the sample says (no calm streak is waited for) and the hold window RESTARTS - a governor must never force-lift into real pressure. This is the case that would otherwise read as "no-op or frozen"; the implementation's choice is deliberately "re-evaluate and re-arm" (`admission-governor.ts`, the `holdExpired` branch) |
| any → same level | a calm reading while reduced, or pressure while normal | streak counters advance; nothing observable changes |
| unreadable | any read failure | level unchanged, no streak advanced (fail-open, no false lift and no false pressure) |

### 4. Where the state lives

In the **shared workspace semaphore**, which already owns the workspace-wide counters
(`busy()`, `dispatchBusy()`) and the cached limits: `WorkspaceSemaphore.dispatchAdmissionCeiling()`
answers the effective ceiling, and `admissionState()` answers
`{ state, configured, effective, since }` for the readout. The governor object itself is pure
(input: pressure sample + clock; output: level + factor) and injected, so every rule above is
unit-tested without a cgroup.

### 5. Contract and UI (both additive)

```ts
admission: z.object({
  state: z.enum(['normal', 'elevated', 'critical']),
  configured: z.number().int().positive().optional(),   // the user's ceiling; absent = none set
  effective: z.number().int().positive().optional(),     // what the gate enforces now
  since: z.string().optional(),                          // ISO-8601, when this state began
}).optional()
```

carried on the **existing** `host` topic and `GET /api/v1/workspace/host-usage` payload (no new
route): the sampler reports the semaphore's snapshot. On Settings -> Resources the Machine card
gains one muted line - `Dispatch admission: elevated · 2 of 4` - and the existing
`Max running dispatched tasks` field stays exactly what it is: the ceiling.

**The key is ABSENT unless a positive ceiling is configured** (v1.1, from the review): no ceiling -
`null`, `0` or negative - means no `admission` object at all, so a workspace that never set one
keeps a byte-identical payload (keys, order and all) and the implementation's exact key-set test
keeps passing. When it IS present, `configured` and `effective` are both `.positive()` integers and
`effective <= configured`; `state` is the only required member.

## 💥 Edge Cases & Failure Scenarios

| Scenario | Behavior |
| --- | --- |
| No `dispatchMaxConcurrent` set | `normal`, `configured`/`effective` absent: nothing to reduce, default path unchanged. |
| `memory.max = max` (no limit) | The ratio row is skipped; PSI and events still decide. No limit is not "0 % used". |
| No PSI files (older kernel, hardened container) | Those rows are absent; ratio/events decide. |
| No cgroup files at all (non-Linux, no `/proc`) | `normal` - fail-open. |
| `oom_kill` observed | `critical` immediately, no two-sample wait. |
| Pressure clears | Six calm samples then lift; the hold never exceeds 10 min. |
| Ceiling of 1 | Factor applies but the floor is 1: a dispatch child is never starved to zero. |
| Ceiling set lower while reduced | The new `configured` is the base immediately; the effective value is recomputed from it (never higher than the new ceiling). |
| Configured ceiling cleared mid-reduction | `configured = null` ⇒ `normal`, no ceiling - the reduction is dropped with the ceiling, not held. |
| Sampler unreadable / probe throws | The governor's read fails open to `normal`; the admission path never depends on telemetry availability. |
| Two parents fan out at once | `dispatchBusy()` is workspace-wide (from #1034), so the reduced ceiling is shared, not per parent. |
| Restart | The level is in-memory only: a boot is `normal` until pressure says otherwise (a stale reduction must not survive a restart). |
| `dispatchMaxConcurrent` = `0` or negative (the other "no cap" spelling) | Treated exactly like `null`: no ceiling, no reduction, no `admission` key, and never `effective: 1` by arithmetic accident. |
| Quiet workspace - nothing dispatching, nothing reading | The reduction lifts at the hold's clock bound on the next look; the six-sample streak is never the only exit. |
| Ceiling lowered below the running count while reduced | The gate is per-candidate and reads the live count: existing children finish, new ones wait until the count is below the effective ceiling. Nothing is stopped. |

## 🔁 Compatibility

- **Default path**: no ceiling set ⇒ no reduction, no new keys beyond the optional `admission`
  object on a payload consumers already ignore additively. The `host` topic and the route keep
  their shapes.
- **#1034's contract**: `dispatchMaxConcurrent()` keeps answering the CONFIGURED value (its tests
  and the settings route stay true); the new `dispatchAdmissionCeiling()` is the effective one the
  admission gate reads. Splitting the two is what lets the UI say "2 of 4" honestly.
- **No preemption, unchanged**: the gate is per-candidate in `pump()`; a running child is never
  stopped, and ordinary runs are never gated by dispatch admission.
- **BC inventory**: one additive sentence on the existing §2 host-telemetry bullet; no new route,
  no new env var, no state file. The `admission` key is optional AND conditional (only with a
  positive ceiling), which is what keeps the no-ceiling payload byte-identical.

## ✅ Resolved assumptions (draft, for review verification)

| # | Question | Applied answer | Rationale |
| --- | --- | --- | --- |
| A1 | Does adaptive need a knob? | No new setting: the existing `dispatchMaxConcurrent` is the ceiling, and with it `null` or `<= 0` there is nothing to reduce. | Zero config: the default path must not change. A knob that turns a working default off is a bug, not a feature. |
| A2 | Base for the factor | The user's `configured`; the per-parent `DISPATCH_MAX_IN_FLIGHT` is untouched. | The 4 is an agent-facing contract (how many children a parent may run); lowering it changes the task protocol, which is out of scope. |
| A3 | Reduction shape | `ceil(configured * 1/2)` elevated, `ceil(configured * 1/4)` critical, floor 1. | A ceiling of 4 must mean 2 under pressure - not 3.5, and never 0. |
| A4 | Hysteresis | Enter at 2 samples, exit at 6, `oom_kill` immediate. | Entering late is safer than flapping; exiting slow is safer than flapping. |
| A5 | Max-hold | A CLOCK bound of 10 minutes from the reduction, evaluated on the next look; a calm streak of six samples may only lift EARLIER. | The failure mode "the cap never lifts" is structural, so the bound is structural - and it must not depend on samples a quiet workspace never takes. |
| A6 | Pressure source | Raw `memory.current/max`, `memory.events`, PSI - never the cache-excluded display value (F12). | The display value is a rendering artifact; control needs the raw counter. |
| A7 | Where the state lives | The shared workspace semaphore; the sampler only REPORTS it. | One writer, one reader, no telemetry-to-control dependency in the other direction. |
| A8 | Visibility | One readout line on Settings -> Resources, on the payload the page already reads. | The ceiling's owner is the person looking at that page; no new route, no new knob. |
| A9 | Restart | In-memory only, `normal` at boot. | A reduction is a reaction to a live signal; nothing about it is worth persisting. |
| A10 | Pressure scope | Leaf cgroup for usage and PSI; ancestors for the LIMITS. | The same rule `cgroup-probe.ts` pins - a sibling's PSI must not throttle this workspace, and a systemd scope's limit must still count. |
| A11 | Value deadband | The enter/exit streaks ARE the deadband at the 2 s cadence; no separate ratio deadband is added. | With a 2 s sampler, 2-in/6-out already means "4 s to react, 12 s to relax". Adding a deadband on top would only slow the same protection; it is the knob to revisit if the cadence ever changes. |

## 📋 Deferred (explicitly not in this spec)

- Notifications ("admission reduced because ..."), a history of reductions, and per-project
  governors: the state is visible, not announced.
- Dropping the `memory.events` rows (the review's simplicity suggestion): kept for now because
  `high` is the earliest signal of a throttling cgroup and `oom_kill` is the one immediate-critical
  case - and the cost is one cross-sample baseline inside the pressure reader. If a reviewer prefers
  fewer signals, removing the two event rows is a self-contained change (PSI + ratio still cover the
  stated failure modes).
- Adaptive ceilings for ORDINARY runs (`maxParallel`): the same measurement could inform them, but
  ordinary admission is the workspace's core scheduling promise and changes there deserve their
  own spec.
- Threshold auto-tuning and learned baselines: fixed, documented thresholds first.

## 📋 Phasing

- **Phase 1 - the governor (engine).** Pressure reader + pure state machine + semaphore ceiling +
  the admission gate reading it. Fully unit-tested, no UI.
- **Phase 2 - the readout.** Additive `admission` object on the host payload + the one line in the
  Machine card.

## 📋 Implementation Plan

> Evidence note (the review's last nit): the pin this spec consumes lives in
> `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, which is on PR #1041's branch and NOT on
> `main` yet - the same stacking this spec's delivery already declares. The file's own header still
> says "v2.2" in places while its content was folded up to v2.4; both are cosmetic and tracked by
> that PR.

1. `core/cgroup-pressure.ts`: read the raw signals (reusing `cgroup-probe.ts`'s path resolution
   helpers), injectable file reader, never throws.
2. `core/admission-governor.ts`: the pure state machine - thresholds, hysteresis, max-hold,
   fail-open - with a table-driven test for every row above.
3. Semaphore: `dispatchAdmissionCeiling()` + `admissionState()`; `dispatchMaxConcurrent()` keeps
   answering the configured value. Injected governor and clock for tests.
4. `workflows/run.ts`: the per-candidate gate reads the effective ceiling; tests for "ordinary runs
   unaffected", "one child never starved", "cleared ceiling drops the reduction".
5. Contract + sampler: the additive `admission` object; contract-parity and topic fixtures.
6. Machine card: the readout line plus `docs/reference.md` and the BC §2 sentence.
7. Demo: a script that induces memory pressure in the sandbox container and screenshots the
   readout moving `normal -> elevated -> normal`, with the effective ceiling changing.
