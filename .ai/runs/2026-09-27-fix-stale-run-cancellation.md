# Fix stale run cancellation (#1087)

Goal: make cancellation terminal and slot-releasing even when startup or continuation never opens an agent session, without changing monitoring behavior.

Scope: `packages/cezar/src/workflows/run.ts` cancellation/ownership helpers and focused workflow tests.

Non-goals: monitoring wake/park behavior, recovery policy for non-cancelled runs, unrelated API/UI changes.

## Implementation Plan

### Phase 1: Reproduce and define ownership

- [ ] 1.1 Add a regression test for cancelling an active pre-session run and prove it fails before the fix.
- [ ] 1.2 Add state-ownership guards for asynchronous cleanup.

### Phase 2: Implement durable cancellation

- [ ] 2.1 Persist terminal cancellation, settle running steps, release the active slot, and prevent late startup work from reviving the run.
- [ ] 2.2 Run targeted cancellation tests and the configured validation gate.

## Risks

Cancellation is intentionally terminal before provider cooperation; late session teardown must not remove a newer owner or overwrite a later run state.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and define ownership

- [ ] 1.1 Add a regression test for cancelling an active pre-session run and prove it fails before the fix.
- [ ] 1.2 Add state-ownership guards for asynchronous cleanup.

### Phase 2: Implement durable cancellation

- [ ] 2.1 Persist terminal cancellation, settle running steps, release the active slot, and prevent late startup work from reviving the run.
- [ ] 2.2 Run targeted cancellation tests and the configured validation gate.
