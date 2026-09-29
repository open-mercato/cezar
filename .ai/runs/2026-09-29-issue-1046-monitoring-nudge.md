# Fix issue #1046 Cause 1: preserve monitoring before autonomous nudges

## Goal

Ensure an autonomous turn that ends with `CEZ:MONITORING` parks as
`running`/`activity: monitoring` in both turn-end paths instead of consuming an
autonomous nudge. Preserve the existing budget brake, monitoring wake timer,
continue caps, and statuses; leave Cause 2 untouched.

## Scope

- `packages/cezar/src/workflows/run.ts`: gate the autonomous nudge on the
  already-computed monitoring decision in both `runContinuation` and
  `runAgentStep`.
- Monitoring workflow tests: replace the stale autonomous-monitoring expectation
  and add coverage for both turn-end sites, including the no-nudge evidence.

## Non-goals

- No attention/UI, store, contract, or Pi runner changes.
- No changes to budget attention semantics or monitoring wake/cap behavior.

## Implementation Plan

### Phase 1: Minimal runtime fix

- [x] 1.1 Gate autonomous nudges behind `!monitoring` in both turn-end paths. — a7dc62fd
- [x] 1.2 Update focused regression coverage for first-session and continuation
      autonomous monitoring turns. — a7dc62fd

### Phase 2: Verification and handoff

- [x] 2.1 Prove the regression tests fail against the pre-fix implementation,
      then run targeted tests and the full configured validation gate. — focused suites, typecheck, unit, build, and package gate pass; full `npm test` has an unrelated projects API repo-shape failure.
- [ ] 2.2 Run the authoritative PR review/autofix pass and record the outcome.

Follow-up correction: `rePrompted` must retain precedence over the monitoring park in both handlers, because `handleDispatchTurn` may already have delivered an inbox prompt during a monitoring-marked turn. Regression `dispatch-engine.test.ts` fails pre-fix (`activity` is `monitoring`) and passes after the correction.

## Risks

The two near-identical turn-end handlers can drift. Tests must exercise both.
The change is intentionally limited to the nudge precedence; existing timer,
cap, dispatch, and budget behavior must remain unchanged.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Minimal runtime fix

- [x] 1.1 Gate autonomous nudges behind `!monitoring` in both turn-end paths. — a7dc62fd
- [x] 1.2 Update focused regression coverage for first-session and continuation autonomous monitoring turns. — a7dc62fd

### Phase 2: Verification and handoff

- [x] 2.1 Prove the regression tests fail against the pre-fix implementation, then run targeted tests and the full configured validation gate. — focused suites, typecheck, unit, build, and package gate pass; full `npm test` has an unrelated projects API repo-shape failure.
- [ ] 2.2 Run the authoritative PR review/autofix pass and record the outcome.
