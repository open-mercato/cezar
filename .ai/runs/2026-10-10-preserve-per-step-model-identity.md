# Preserve per-step model identity (#545)

## Goal

Persist each resolved runner/model identity on the corresponding `StepState`, so a multi-step run and a continuation that switches to auto retain historical attribution while keeping the run-level field backwards compatible.

## Scope

- Add an optional identity field to the contract and store `StepState` shape.
- Wire every initial, continuation, and spawned-step constructor/update path in `workflows/run.ts`.
- Add focused wiring and compatibility/parity tests.
- Remove the inherited issue-audit plan from this child PR; it belongs to the parent orchestration task.

## Non-goals

- No dashboard/UI changes, cost calculations, migrations, or new paid model calls.
- No changes to unrelated issue fixes or the parent branch.

## Implementation Plan

### Phase 1: Contract and persistence

- [ ] 1.1 Add the optional per-step model identity schema/type and store persistence.
- [ ] 1.2 Wire identity assignment across all run and continuation step construction paths.

### Phase 2: Regression proof

- [ ] 2.1 Add multi-step and continuation-to-auto regression coverage plus compatibility assertions.
- [ ] 2.2 Run targeted tests, full validation, review, and finalize the PR.

## Risks

The existing run-level `modelIdentity` is consumed by older readers, so it must remain unchanged and optional step data must parse old `runs.json` files.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Contract and persistence

- [ ] 1.1 Add the optional per-step model identity schema/type and store persistence.
- [ ] 1.2 Wire identity assignment across all run and continuation step construction paths.

### Phase 2: Regression proof

- [ ] 2.1 Add multi-step and continuation-to-auto regression coverage plus compatibility assertions.
- [ ] 2.2 Run targeted tests, full validation, review, and finalize the PR.
