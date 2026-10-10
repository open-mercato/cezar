# Fix mobile step-rail touch target

Engine: om-auto-create-pr (steps: 6, --loop: no)

## Goal

Give the workflow step-rail disclosure trigger an effective 44px touch target on phone layouts while preserving the compact run-header height and avoiding overlap with neighboring controls.

## Scope

- `packages/web/src/routes/task-thread/step-rail.tsx`
- `packages/web/src/routes/task-thread/step-rail.test.tsx`

## Non-goals

- Do not change the run header layout, tabs, action controls, or desktop sizing beyond what is required for the trigger hit area.
- Do not add a new configuration option or broaden the step-rail behavior.

## Implementation Plan

### Phase 1: Baseline and implementation

- [ ] 1.1 Reproduce the undersized mobile trigger and record the existing class/test behavior.
- [ ] 1.2 Implement a compact visual trigger with a non-layout-expanding 44px hit area.
- [ ] 1.3 Add a dedicated component regression test for the mobile effective target and header-safe structure.

### Phase 2: Verification and handoff

- [ ] 2.1 Run targeted web step-rail tests and inspect the diff.
- [x] 2.2 Run the configured repository validation gate and fix any failures. — aac274cc
- [ ] 2.3 Complete authoritative PR review, summarize evidence, and mark the PR ready.

## Risks

An absolutely positioned hit-area overlay could intercept adjacent controls if its containing block or inset is wrong; tests should pin the trigger structure and the visual row must remain compact.

## Progress

PR: #1244

> Convention: `- [x]` pending, `- [x]` done. Append — `<commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Baseline and implementation

- [x] 1.1 Reproduce the undersized mobile trigger and record the existing class/test behavior. — dfc39834
- [x] 1.2 Implement a compact visual trigger with a non-layout-expanding 44px hit area. — dfc39834
- [x] 1.3 Add a dedicated component regression test for the mobile effective target and header-safe structure. — dfc39834

### Phase 2: Verification and handoff

- [x] 2.1 Run targeted web step-rail tests and inspect the diff. — dfc39834
- [x] 2.2 Run the configured repository validation gate and fix any failures.
- [x] 2.3 Complete authoritative PR review, summarize evidence, and mark the PR ready.


Independent review c51d3a41 approved source at ac542a38. Parent reproduced focused tests. Hosted full CI passed; local full Vitest environmental failures remain documented on the PR and were not changed out of scope. Final artifact update completes tracking and readiness only.
