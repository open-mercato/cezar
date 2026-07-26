# Restore interrupted tasks within project resource limits

## Goal

Ensure tasks restored after a Cezar restart re-enter execution through the workspace and per-project concurrency gates, so a project configured for one parallel task cannot resume several interrupted tasks at once.

## Scope

- Update `RunManager` restart recovery and queue bookkeeping in `src/workflows/run.ts`.
- Add regression coverage for multiple interrupted tasks recovered under a per-project limit.
- Preserve the intentional immediate-resume exemption for an explicit user message sent to a live waiting session.

## Non-goals

- Do not change workspace or per-project resource configuration schemas.
- Do not change ordinary queued-run ordering or interactive Continue behavior.
- Do not alter the UI; the existing queued/running states will reflect the corrected scheduler decision.

## Implementation Plan

### Phase 1: Route recovery through capacity gates

1. Add a queued continuation representation that the existing scheduler can admit under both workspace and per-project limits.
2. Use the queued continuation path for interrupted `running` records restored by `recover()`, while retaining immediate interactive continuation.

### Phase 2: Lock in restart behavior

1. Add a regression test proving recovery starts only one interrupted task when the project cap is one and leaves the remainder queued.
2. Run targeted workflow tests and the complete configured validation gate.

## Risks

- Continuation setup and failure handling currently assume immediate launch; the queued path must preserve existing status, error, cancellation, and session-affinity behavior.
- A queued recovery must remain discoverable and cancellable without changing persisted schema, so the new bookkeeping stays process-local like ordinary queued jobs.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #693

### Phase 1: Route recovery through capacity gates

- [x] 1.1 Add a queued continuation representation that the existing scheduler can admit under both workspace and per-project limits. — e032ad0f
- [x] 1.2 Use the queued continuation path for interrupted `running` records restored by `recover()`, while retaining immediate interactive continuation. — e032ad0f

### Phase 2: Lock in restart behavior

- [x] 2.1 Add a regression test proving recovery starts only one interrupted task when the project cap is one and leaves the remainder queued. — 2641fa20
- [x] 2.2 Run targeted workflow tests and the complete configured validation gate. — 5cace4fd
- [x] Post-review fix: reconstruct a queued continuation after a repeated restart and cover the idempotent recovery path. — 99eb0f09
