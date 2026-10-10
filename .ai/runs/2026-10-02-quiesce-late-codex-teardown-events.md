# Quiesce late Codex teardown events

Issue: #1105

## Goal

Prevent a Codex follow-up rejection after cezar teardown from escaping its discarded floating promise, while preserving normal cancellation lifecycle events and synchronous event-delivery failures during a live session.

## Scope

- `packages/cezar/src/core/codex-app-server-runner.ts`: close follow-up failure delivery at teardown; retain normal cancellation `done` events.
- `packages/cezar/src/core/codex-app-server-runner.test.ts`: deterministic regression coverage for a rejected follow-up after teardown and the live callback-error boundary.
- `packages/cezar/src/workflows/run.test.ts`: await the active session result before removing the #955 temp fixture.

Non-goals: `run.ts`, `mock-claude.mjs`, CI reporter changes, broad RunStore error handling, or changes to the sibling #1221 work.

## Implementation Plan

### Phase 1: Reproduce and fix

- [x] 1.1 Add a deterministic regression proving teardown does not deliver late Codex events into a removed store. — f2baa15d
- [x] 1.2 Gate Codex event delivery at teardown without swallowing live callback failures. — f2baa15d

### Phase 2: Verify and ship

- [x] 2.1 Run targeted and full configured validation, inspect the final diff, and open the PR for #1105. — 64ef54fc

## Risks

Suppressing only the self-inflicted follow-up failure event is intentional: the owning run is already cancelling and its storage may be gone. Normal `done` delivery remains unchanged, and active-store corruption remains a thrown error while live or as the explicitly asserted cancellation result.

## Progress

PR: #1230

> Convention: `- [x]` pending, `- [x]` done. Append — `<commit sha>` when a step lands.

### Phase 1: Reproduce and fix

- [x] 1.1 Add a deterministic regression proving teardown does not deliver late Codex events into a removed store. — f2baa15d
- [x] 1.2 Gate Codex event delivery at teardown without swallowing live callback failures. — f2baa15d

### Phase 2: Verify and ship

- [x] 2.1 Run targeted and full configured validation, inspect the final diff, and open the PR for #1105. — 64ef54fc

## Final verification

All configured commands passed. Clean full `npm test -- --maxWorkers=2`: 507 files / 8587 tests passed. Test subprocesses removed inherited `CEZ_*` values and used `/tmp`; earlier environment/timing failures are superseded by this green run. Independent final review found no code defects on this implementation. Evidence: https://github.com/open-mercato/cezar/pull/1230#issuecomment-5944225257.
