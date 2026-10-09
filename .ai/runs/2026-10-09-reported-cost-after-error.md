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

PR: #1346

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Preserve accounting

- [x] 1.1 Add regression tests and retain costs after errors in both execution paths. — d10d121
- [ ] 1.2 Run validation and authoritative review.

## Validation evidence

- Regression proven red before the fix: four failing positive/zero cases; absent-cost guards passed.
- Typecheck and full build/check:pack pass.
- Full vitest: 9027 passed, 3 skipped (531 files passed, 1 skipped).
- Core node:test: 42 passed; packaged CLI: 17 passed.
- Linux test PATH excludes the optional host wslpath executable, matching the existing WSL fallback tests’ assumption. On the native WSL PATH those two unrelated assertions fail; an initial parallel diff test timeout passed in isolation and the final full run.
- Tests run without inherited CEZ/provider variables, with Git 2.55.0 and Node 24.13.1.
