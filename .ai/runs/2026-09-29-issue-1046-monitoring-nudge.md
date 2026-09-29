# Fix issue #1046 Cause 1: preserve monitoring before autonomous nudges

## Goal

Ensure an autonomous turn that ends with `CEZ:MONITORING` parks as
`running`/`activity: monitoring` in both turn-end paths instead of consuming an
autonomous nudge. Preserve the existing budget brake, monitoring wake timer,
continue caps, and statuses; explain budget-brake parks in the cockpit.

## Scope

- `packages/cezar/src/workflows/run.ts`: gate the autonomous nudge on the
  already-computed monitoring decision in both `runContinuation` and
  `runAgentStep`.
- Monitoring workflow tests: replace the stale autonomous-monitoring expectation
  and add coverage for both turn-end sites, including the no-nudge evidence.
- `packages/web/src/lib/attention.ts` and task-thread header/dock: explain an
  existing over-budget waiting park with spent and ceiling values.

## Non-goals

- No store, contract, or Pi runner changes.
- No changes to over-budget auto-resume, monitoring wake/cap behavior, or the
  spend brake itself.

## Implementation Plan

### Phase 1: Minimal runtime fix

- [x] 1.1 Gate autonomous nudges behind `!monitoring` in both turn-end paths. — a7dc62fd
- [x] 1.2 Update focused regression coverage for first-session and continuation
      autonomous monitoring turns. — a7dc62fd

### Phase 2: Verification and handoff

- [x] 2.1 Prove the regression tests fail against the pre-fix implementation,
      then run targeted tests and the full configured validation gate. — focused suites, typecheck, unit, build, and package gate pass; full `npm test` has an unrelated projects API repo-shape failure.
- [ ] 2.2 Run the authoritative PR review/autofix pass and record the outcome.

### Phase 3: Cause 2 budget explanation

- [x] 3.1 Derive a budget-stop attention label from persisted dispatch facts without changing status or schema. — pending commit
- [x] 3.2 Render spent/ceiling explanation in the run header and paused dock, with UI regressions. — pending commit

Follow-up correction: `rePrompted` must retain precedence over the monitoring park in both handlers, because `handleDispatchTurn` may already have delivered an inbox prompt during a monitoring-marked turn. Regression `dispatch-engine.test.ts` fails pre-fix (`activity` is `monitoring`) and passes after the correction.

Reviewer follow-up: the regression now waits for the mock stdin file to contain the delivered inbox block before parsing it; the delivery note can precede that asynchronous file flush under suite load. The product invariant remains asserted, and the test still fails without the `rePrompted` precedence fix.

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

### Phase 3: Cause 2 budget explanation

- [x] 3.1 Derive a budget-stop attention label from persisted dispatch facts without changing status or schema. — pending commit
- [x] 3.2 Render spent/ceiling explanation in the run header and paused dock, with UI regressions. — pending commit
