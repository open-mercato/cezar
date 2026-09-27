# Fix Pi message item identities

Goal: ensure distinct assistant messages in one Pi turn produce distinct v2 item ids while preserving v1 and bounded adapter state.

Scope: `packages/cezar/src/core/pi-ui-mapper.ts`, its Pi tests, and the Pi lifecycle fixture.

Non-goals: changes to the shared protocol, server/workflow code, or other backends.

## Implementation Plan

### Phase 1: Reproduce and fix

- [x] 1.1 Confirm the reported collision and add a failing regression test — 11e7b8b2
- [x] 1.2 Add adapter-local per-message identity and bounded turn bookkeeping — 11e7b8b2
- [x] 1.3 Update Pi golden fixture and run targeted tests — 11e7b8b2, 37dd0416

### Phase 2: Validate and publish

- [x] 2.1 Run the configured validation gate — typecheck/build/unit/package green; sanitized full npm test is 7949/7950 with one base-reproduced web failure
- [ ] 2.2 Commit, push, open and review the PR

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — `<commit sha>` when a step lands.

### Phase 1: Reproduce and fix

- [x] 1.1 Confirm the reported collision and add a failing regression test — 11e7b8b2
- [x] 1.2 Add adapter-local per-message identity and bounded turn bookkeeping — 11e7b8b2
- [x] 1.3 Update Pi golden fixture and run targeted tests — 11e7b8b2

### Phase 2: Validate and publish

- [x] 2.1 Run the configured validation gate — typecheck/build/unit/package green; full npm test has 13 unrelated environment failures
- [ ] 2.2 Commit, push, open and review the PR
