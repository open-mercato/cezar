# Implement durable monitoring sessions and periodic wake-up

Source doc: `.ai/specs/2026-07-24-long-running-waiting-sessions.md`
Related source doc: `.ai/specs/2026-07-24-monitoring-session-auto-wake.md`
Spec PR: #655
Issue: #654

## Goal

Keep `CEZ:MONITORING` sessions alive safely, bound their extra workspace capacity, and optionally wake them on a configured cadence across every backend.

## Scope

- Workspace config/API/UI fields for monitoring capacity and nullable wake cadence.
- RunManager lifecycle bookkeeping, capped scheduler accounting, and automatic wake timers.
- Unit, API, component, and browser regression coverage plus documentation.

## Non-goals

- Replacing backend session recovery or resurrecting dead vendor processes after restart.
- Vendor-specific Claude `/loop` or Codex desktop automation integration.
- New public run statuses, markers, or notification behavior.

## Risks

- Scheduler accounting spans projects and intentionally permits immediate resume overshoot.
- Timed wake-ups create model turns; parked mode must remain the default and the 40-wake cap must be reliable.
- Workspace config is a protected additive contract and must retain per-key salvage/passthrough behavior.

## Implementation Plan

### Phase 1: Configuration and scheduler accounting

- Extend workspace resource schemas, API contracts, types, and semaphore snapshots.
- Separate durable monitoring accounting from ordinary time-bounded waiting.
- Add cross-project, overflow, dynamic refresh, recovery, and timeout regression tests.

### Phase 2: Periodic backend-neutral wake-up

- Add nullable interval configuration and an internal synthetic follow-up delivery path.
- Schedule/cancel unref'd timers around monitoring turn boundaries with a 40-wake epoch cap.
- Prove identical behavior through runner-neutral fake sessions and lifecycle tests.

### Phase 3: Settings UI and docs

- Add monitoring capacity and park/interval controls to Global Settings → Resources.
- Add unit and browser persistence coverage with accessible copy and cost warnings.
- Update the monitoring lifecycle design history and compatibility documentation.

### Phase 4: Verification and delivery

- Run the complete configured validation gate and package checks.
- Run code review/autofix and browser QA, then publish the ready implementation PR.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Configuration and scheduler accounting

- [x] 1.1 Extend workspace resource contracts — 760a986
- [x] 1.2 Bound durable monitoring exemptions — 760a986
- [x] 1.3 Cover scheduler and lifecycle regressions — 760a986

### Phase 2: Periodic backend-neutral wake-up

- [x] 2.1 Extract synthetic follow-up delivery — 760a986
- [x] 2.2 Implement monitoring wake timer and safety epoch — 760a986
- [x] 2.3 Prove cross-backend and timer behavior — 760a986

### Phase 3: Settings UI and docs

- [x] 3.1 Add Resources controls — 413495d
- [x] 3.2 Add component and browser coverage — 413495d
- [x] 3.3 Document lifecycle and cost semantics — 413495d
- [x] 3.4 Sync persisted wake deadline and exact session UI with the reviewed spec — 7d0ea3f
- [x] 3.5 Display and de-duplicate the 40/40 automatic-check cap — 9075d1f
- [x] 3.6 Add browser persistence coverage and screenshot evidence — b85dba0

### Phase 4: Verification and delivery

- [x] 4.1 Pass the full validation gate — 7d0ea3f
- [x] 4.2 Complete review autofix and UI QA — 3405922
