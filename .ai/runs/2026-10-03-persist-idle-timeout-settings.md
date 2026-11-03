# Persist idle timeout settings

Issue: #1232
Goal: Make PUT /api/v1/workspace/config persist resources.idleTimeoutMinutes, including null as the supported disabled value, and cover the route-level regression.

## Scope

- `packages/cezar/src/server/server.ts`: add the missing resources merge assignment.
- `packages/cezar/src/server/workspace-api.test.ts`: add a dedicated route regression test covering persistence, response, reload, and live semaphore refresh.
- No schema, UI, workflow, attachment, or unrelated configuration changes.

## Implementation Plan

### Phase 1: Reproduce and plan

- [x] 1.1 Confirm issue, duplicate/claim state, and root cause from the route closure and issue repro.
- [x] 1.2 Create this execution plan from a clean origin/main fork.

### Phase 2: Fix and regression coverage

- [x] 2.1 Add the idle-timeout merge assignment and dedicated route regression test. — 338571f7
- [x] 2.2 Run targeted validation and prove the regression fails without the fix. — unfixed code: 1 failed, 53 passed; fixed code: 54 passed. `npm install --ignore-scripts` was required to refresh stale dependencies.

### Phase 3: Gate and review

- [x] 3.1 Run the configured full validation gate and resolve failures. — GitHub CI run 37085146700 passed all configured Unit/build/E2E/package checks; local parallel Vitest still exhibits unrelated isolation failures.
- [x] 3.2 Complete authoritative PR review, summarize evidence, and mark the PR ready. — internal review found no actionable findings; CI green; PR promoted to ready.

## Risks

The change is limited to one field in the existing atomic workspace-config merge closure. The test must preserve the semantic distinction between `undefined` (not supplied) and `null` (disable timeout).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Reproduce and plan

- [x] 1.1 Confirm issue, duplicate/claim state, and root cause from the route closure and issue repro.
- [x] 1.2 Create this execution plan from a clean origin/main fork.

### Phase 2: Fix and regression coverage

- [x] 2.1 Add the idle-timeout merge assignment and dedicated route regression test. — 338571f7
- [x] 2.2 Run targeted validation and prove the regression fails without the fix. — 338571f7 (unfixed 1 failed/53 passed; fixed 54 passed)

### Phase 3: Gate and review

- [x] 3.1 Run the configured full validation gate and resolve failures. — CI run 37085146700 passed.
- [x] 3.2 Complete authoritative PR review, summarize evidence, and mark the PR ready. — no actionable findings; ready promotion follows.
