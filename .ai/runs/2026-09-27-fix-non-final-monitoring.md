# Fix non-final workflow monitoring

Issue: #1076
Source doc: `.ai/specs/2026-07-24-monitoring-session-auto-wake.md`

## Goal

Ensure a `CEZ:MONITORING` turn on any agent step keeps unfinished workflow work
parked as monitoring instead of completing the step and advancing to downstream
checks. Preserve marker precedence, autonomous behavior, cancellation, durable
restart handling, bounded monitoring wake-ups, and the existing final-step path.

## Scope

- `packages/cezar/src/workflows/run.ts`: both first-session and continuation
  turn-end handlers, workflow park state, wake/recovery bookkeeping, and
  terminal cleanup.
- Dedicated regression coverage adjacent to the workflow tests, with focused
  cases for streaming and non-streaming handlers, autonomous and interactive
  runs, marker precedence, cancellation, wake liveness, restart recovery, and
  multi-step progression.
- No cancellation implementation changes from PR #1098; the final review must
  check interaction with that open branch separately.

## Root cause and design

`interactive` is true only for the last agent step. The first-session handler
currently computes `monitoring` with that flag, so a non-final marker is parsed
but discarded; `waiting` stays false, the autonomous nudge is skipped, the
one-shot intermediate-step close runs, and `execute` marks the step done before
running the next step. The continuation handler has the corresponding lifecycle
logic and must remain behaviorally aligned.

The fix should make a valid monitoring marker a workflow park for non-final
steps, with `CEZ:DONE`, `CEZ:ASK`, over-budget, cancellation, and backend
failure retaining their explicit precedence. The park must write the durable
signal consumed by `recover()`, enter the existing bounded monitoring accounting,
arm the existing bounded wake timer, and leave the run/step open until a wake,
user follow-up, explicit finish/cancel, or real session failure. Autonomous
monitoring must use the existing bounded wake/nudge policy rather than advancing
the workflow or spinning indefinitely.

## Non-goals

- Do not merge, copy, or edit PR #1098 cancellation work.
- Do not alter the parent orchestration plan or dispatch additional children.
- Do not change public run statuses, marker syntax, automation behavior, or the
  final-step monitoring semantics unless required to preserve parity.
- Do not add a new polling process, cron job, GitHub Action, or production change.

## Implementation plan

### Phase 1: Regression proof and lifecycle model

- [x] 1.1 Add the issue-1076 multi-step reproducer and prove it fails on the
  original source for both non-autonomous and autonomous runs.
- [x] 1.2 Trace and document the two turn-end paths, durable recovery signal,
  monitoring wake timer, and precedence/terminal transitions; use this to pin
  shared invariants without changing cancellation code.

### Phase 2: Minimal monitoring park fix

- [x] 2.1 Remove the accidental final-step-only gate from valid monitoring
  detection and include monitoring in the non-final workflow-park decision while
  preserving DONE/ASK/budget/dispatch precedence.
- [x] 2.2 Apply identical park, bounded wake, resume, and terminal cleanup
  behavior to both streaming/first-session and continuation handlers.
- [x] 2.3 Add durable restart recovery for a parked non-final monitoring step;
  prove a recovered run does not settle the unfinished step or skip downstream
  work.

### Phase 3: Regression matrix and validation

- [x] 3.1 Cover autonomous and non-autonomous monitoring, explicit DONE/ASK/
  budget precedence, cancellation, wake liveness/cap, user resume, and
  multi-step progression.
- [ ] 3.2 Re-run the original reproducer against the pre-fix source to retain
  red evidence, then run focused workflow tests and the configured full gate.
- [x] 3.3 Review the diff for interaction with PR #1098 cancellation changes,
  run local `om-code-review`/`om-auto-review-pr` where possible, and leave the
  PR draft if any required gate remains incomplete.

## Risks

- `run.ts` has two near-identical turn-end handlers; changing only one would
  create backend-specific regressions.
- A durable park without a recovery signal can be falsely settled after restart.
- Waking without bounded accounting can leak slots or spin autonomous runs.
- Cancellation owns terminal state; monitoring cleanup must not revive or
  overwrite a cancellation transition.

## Progress

PR: #1102

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Regression proof and lifecycle model

- [x] 1.1 Add the issue-1076 multi-step reproducer and prove it fails on the original source for both non-autonomous and autonomous runs.
- [x] 1.2 Trace and document the two turn-end paths, durable recovery signal, monitoring wake timer, and precedence/terminal transitions; use this to pin shared invariants without changing cancellation code.

### Phase 2: Minimal monitoring park fix

- [x] 2.1 Remove the accidental final-step-only gate from valid monitoring detection and include monitoring in the non-final workflow-park decision while preserving DONE/ASK/budget/dispatch precedence.
- [x] 2.2 Apply identical park, bounded wake, resume, and terminal cleanup behavior to both streaming/first-session and continuation handlers.
- [x] 2.3 Add durable restart recovery for a parked non-final monitoring step; prove a recovered run does not settle the unfinished step or skip downstream work.

### Phase 3: Regression matrix and validation

- [x] 3.1 Cover autonomous and non-autonomous monitoring, explicit DONE/ASK/budget precedence, cancellation, wake liveness/cap, user resume, and multi-step progression.
- [x] 3.2 Re-run the original reproducer against the pre-fix source to retain red evidence, then run focused workflow tests and the configured full gate. — dependency validation 2026-09-27; all configured commands pass
- [x] 3.3 Review the diff for interaction with PR #1098 cancellation changes, run local `om-code-review`/`om-auto-review-pr` where possible, and leave the PR draft if any required gate remains incomplete.

## Validation evidence

- Baseline red: the issue reproducer failed 2/2 on the original source (both non-autonomous and autonomous), with the non-final step advancing to downstream work.
- Focused green: `npx vitest run packages/cezar/src/workflows/non-final-monitoring.test.ts` — 4/4; `npx vitest run packages/cezar/src/workflows/run.test.ts` — 134/134. The dedicated suite covers first-session non-final parking, autonomous nudge-before-advance, bounded wake/cancellation, and persisted restart recovery with downstream step still pending.
- Existing transition coverage reused: `run.ts`'s shared `askPark` branch guards session-close/failure settlement; `finish()` explicitly handles a mid-workflow park; `dropActive()` clears monitoring state/timers on cancellation and terminal paths; `runContinuation` has the parallel monitoring turn-end handler. Existing `run.test.ts` covers DONE/ASK/budget precedence and continuation monitoring.
- `npm run typecheck` — pass; `npm run test:unit` — 36/36; `npm run build` — pass; `npm run test:package` — 16/16.
- `npm test` — 7,947 passed, one known unrelated baseline failure at `packages/web/src/routes/cross-project-task-navigation.test.tsx:222` (`getByRole('button', { name: 'other-repo' })`), tracked by #1096/#1097; no workflow failure.
- Local review: no actionable findings; PR remains draft because the configured full gate is not entirely green and GitHub self-approval is unavailable.

### Dependency validation evidence (2026-09-27)

- Reused reviewed sidebar test commit `e882054b6300542f36583286e2e1804fcafd0598` unchanged; targeted `packages/web/src/routes/cross-project-task-navigation.test.tsx`: 1 file, 3 tests passed (`/tmp/pr1102-targeted.log`).
- Sanitized sequential gate (`CEZ_*` unset, `TMPDIR=/tmp`): `npm run typecheck` PASS; `npm test` PASS (7949/7949); `npm run test:unit` PASS (36/36); `npm run build` PASS; `npm run test:package` PASS (16/16). Full log: `/tmp/pr1102-full-gate.log`.

Final independent review: [approved](https://github.com/open-mercato/cezar/pull/1102#issuecomment-5852039141). Reviewed source head: `0a34d9e1`.
