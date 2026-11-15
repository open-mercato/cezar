# Fix issue-701 server-test lifecycle races

## Goal

Make the scoped real-process and Git fixture suites deterministic during teardown: every asynchronous writer is drained or made inert before its temporary directory is removed, without changing production lifecycle code.

## Scope

- `packages/cezar/src/git-worktree.test.ts`
- `packages/cezar/src/workflows/run-lease.test.ts`
- `packages/cezar/src/workflows/run-isolation.test.ts`
- `packages/cezar/src/autosave-conflict-guard.test.ts`
- `packages/cezar/src/workflows/autosave-gate.test.ts`
- A test-only RunStore cleanup helper under `packages/cezar/src/test-utils/`

## Non-goals

- No edits to production `run.ts` or `store.ts`.
- No edits to `auto-resume.test.ts` or `packages/web/src/routes/github/github.test.ts`.
- No blanket timeout increases or sleeps; existing bounded waits remain only where they represent legitimate process-drain deadlines.
- No claim that macOS-specific failures are fully reproduced on Linux.

## Implementation Plan

### Phase 1: Establish teardown guard

- [x] 1.1 Add a test-only RunStore registry/cleanup helper that flushes and blocks late scheduled saves. — 9a4d4f89
- [x] 1.2 Apply the helper and awaited manager/store cleanup to the scoped suites with temporary fixtures. — 9a4d4f89

### Phase 2: Verify lifecycle behavior

- [x] 2.1 Run focused repeated suites and prove the relevant teardown race is covered. — corrected subset 12/12; lease teardown asserts persisted runs.json
- [x] 2.2 Run the configured validation gate and record baseline limitations. — full-gate limitations recorded
- [x] 2.3 Complete review and publish the scoped PR evidence. — PR #1295

## Risks

The helper monkey-patches only the test process's `RunStore.open`; it must not alter production behavior or hide a run that failed to settle. Fixture removal stays after drain/flush, and failed drains leave the fixture for diagnosis.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Establish teardown guard

- [x] 1.1 Add a test-only RunStore registry/cleanup helper that flushes and blocks late scheduled saves. — 9a4d4f89
- [x] 1.2 Apply the helper and awaited manager/store cleanup to the scoped suites with temporary fixtures. — 9a4d4f89

### Phase 2: Verify lifecycle behavior

- [x] 2.1 Run focused repeated suites and prove the relevant teardown race is covered. — focused 64/64 x3
- [x] 2.2 Run the configured validation gate and record baseline limitations. — gate run 2026-10-06
- [x] 2.3 Complete review and publish the scoped PR evidence. — independent review remediation 5b89e4c4
