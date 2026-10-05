# Execution plan — dispatch cap partial reports

Goal: A dispatched autonomous child that exhausts cezar's existing 40 auto-continue cap must settle as an unfinished/non-success run and report `partial` to its parent, while a child that emits `CEZ:DONE` remains `done`.

Scope: `packages/cezar/src/runs/store.ts`, `packages/cezar/src/dispatch/engine.ts`, `packages/cezar/src/workflows/run.ts`, and focused dispatch/autonomous tests.

Non-goals: Implementing the unmerged `retry_limit` feature from PR #1186, changing missing-session continuation (#1193), or altering ordinary interactive/autonomous completion.

## Implementation plan

### Phase 1: Durable cap settlement

- [x] 1.1 Persist the auto-continue-cap cause, clear it only on accepted human continuation, and settle capped runs as failed/non-success. — 16d5a962
- [x] 1.2 Synthesize a partial dispatch report with the cap note, preserve resume context, and preserve ordinary completion. — 16d5a962

### Phase 2: Regression coverage

- [x] 2.1 Add isolated tests for cap report mapping, cancellation durability, live messages, and human continuation settlement. — 16d5a962
- [x] 2.2 Run targeted tests and the configured validation gate — final-head CI 37302641815 passed all jobs; CodeQL 37302641731 passed. Local typecheck/build were blocked by stale generated-contract/export drift and unrelated workspace/self-update errors, but clean CI verified the full gate. — 315195e0

## Risks

The marker must survive waiting and restart, but must not leak into a later human Continue. Existing `RunRecord` parsing is additive and optional for old state.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Durable cap settlement

- [x] 1.1 Persist the auto-continue-cap cause, clear it on a human continuation, and settle capped runs as failed/non-success. — 16d5a962
- [x] 1.2 Synthesize a partial dispatch report with the cap note and preserve ordinary completion. — 16d5a962

### Phase 2: Regression coverage

- [x] 2.1 Add isolated tests for cap report mapping and live cap settlement. — 16d5a962
- [x] 2.2 Run targeted tests and the configured validation gate — final-head CI 37302641815 passed all jobs; CodeQL 37302641731 passed. Local typecheck/build were blocked by stale generated-contract/export drift and unrelated workspace/self-update errors, but clean CI verified the full gate. — 315195e0

Validation evidence for the implementation commit:

Status: complete. Independent review approved at exact head `1178a161`; focused dispatch engine tests 20/20, parent cap suite 31/31, and remote CI/CodeQL/package checks pass.

- `npm exec vitest run packages/cezar/src/dispatch/engine.test.ts --config packages/cezar/vitest.config.ts` — 20 passed.
- `npm exec vitest run packages/cezar/src/workflows/autonomous-nudge.test.ts --config packages/cezar/vitest.config.ts` — 11 passed.
- `npm run typecheck:server` — local checkout blocked by generated-contract/export drift and unrelated self-update/dashboard errors; clean final-head CI typecheck passed.
- Final-head CI `37302641815` — passed: typecheck, unit, server/cockpit suites, build, packaged CLI E2E, release-package verification, and publish snapshot.
- Final-head CodeQL `37302641731` — passed: JavaScript/TypeScript and Actions analysis.
