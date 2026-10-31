# Fix queued-task screenshot attachments

## Goal

Fix issue #926 so pasting a screenshot into a queued task's follow-up composer uploads and submits successfully instead of showing `Load failed`.

## Scope

- Trace the queued-task attachment upload and message submission path in the cockpit and server.
- Add the smallest fix needed for queued messages with attachments.
- Add focused regression coverage for the failing queued attachment path and preserve existing text-only behavior.

## Non-goals

- Workspace idle-timeout settings or closure behavior.
- Workflow idle settlement, test cleanup helpers, or step-rail UI.
- Broad attachment refactors, unrelated server routes, or changes to the initial new-task composer.

## Implementation Plan

### Phase 1: Reproduce and isolate

- [x] 1.1 Trace queued composer upload/message calls and identify the request/response mismatch causing `Load failed` — current `main` already contains the queued attachment persistence/dequeue fix; duplicate PR #1209 reached the same conclusion.
- [x] 1.2 Add a focused regression test that fails against the current implementation — exact queued screenshot coverage added; it guards the already-landed behavior.

### Phase 2: Fix and verify

- [x] 2.1 Implement the minimal queued attachment fix within the allowed attachment/message scope — no source change is warranted because the fix is already on `main`; added coverage instead.
- [x] 2.2 Run focused tests, then the configured full validation gate; review the final diff for scope creep. — focused 50 passed; typecheck/unit/build/package passed; full npm test 503 files passed, 15 unrelated failures

## Risks

- Queued and live message paths share attachment contracts; the fix must not alter live-session uploads or text-only queueing.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #1246

### Phase 1: Reproduce and isolate

- [x] 1.1 Trace queued composer upload/message calls and identify the request/response mismatch causing `Load failed`. — 281cb497
- [x] 1.2 Add a focused regression test that fails against the current implementation. — 281cb497

### Phase 2: Fix and verify

- [x] 2.1 Implement the minimal queued attachment fix within the allowed attachment/message scope. — 281cb497
- [x] 2.2 Run focused tests, then the configured full validation gate; review the final diff for scope creep.

## Final outcome

This is regression coverage, not a new production fix: current main already satisfies the reported queued screenshot path. The step 1.2 test is a guard test and is not claimed to fail on current main. Independent reviewer c51d3a41 accepted source at f5fa168b; parent independently passed all 50 focused tests. Hosted Unit/build/E2E/package CI passed. Local full Vitest failures remain disclosed on the PR.
