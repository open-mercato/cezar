# Preserve reported costs after runner errors

## Goal
Count provider-reported costs even when the same invocation has already emitted an error.

## Scope
Both initial execution and Continue event handlers in `workflows/run.ts`. Keep failures authoritative while persisting accounting events delivered after them. No UI, pricing estimates, runner protocols, cancellation policy, or automatic historical migration changes.

## Implementation plan
1. Add real-runner regression coverage for error then cost, including Continue and explicit zero.
2. Process cost before the session-error short circuit in both handlers.
3. Run the repository validation gate and review the patch.

## Risks
Do not re-enable success transitions after failure; do not record costs from cancelled or replaced invocations. Historical missing costs require a separate offline repair from recorded events. Installed local releases must not be changed in place.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Preserve accounting

- [ ] 1.1 Add regression tests and retain costs after errors in both execution paths.
- [ ] 1.2 Run validation and authoritative review.
