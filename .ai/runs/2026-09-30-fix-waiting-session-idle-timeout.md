# Fix waiting-session idle timeout

Goal: make the plain waiting-session idle timeout configurable without changing its 15-minute default, while retaining durable monitoring behavior and all terminal safeguards.

Scope: workflow idle timer; workspace resource schema/semaphore and API contract; Global Settings → Resources; focused regression/config/UI tests. Non-goals: task-thread UI, transcript markdown, installer modules, monitoring classification, wall-clock provider timeout, and changing timeout expiry semantics.

## Implementation Plan

### Phase 1: Configuration and lifecycle

- [x] 1.1 Add optional `idleTimeoutMinutes` resource defaults, bounds, API contract, and semaphore cache/getter. — ccc8939e
- [x] 1.2 Replace the workflow constant use with the cached setting and preserve timer expiry behavior; test new-run and continuation park paths. — ccc8939e

### Phase 2: Operator surface and verification

- [x] 2.1 Add the timeout control and explanatory copy to Global Settings → Resources with focused UI tests. — ccc8939e
- [x] 2.2 Run focused regression/config/API/UI tests and prove the regression test is red against the pre-fix implementation. — ccc8939e
- [x] 2.3 Run the full configured validation gate, review diff, and document compatibility/evidence. — ccc8939e

## Evidence

- PR #1176: https://github.com/open-mercato/cezar/pull/1176
- Head: `825ba463744c2d80db87b1d5d339e9080a157514` (implementation correction; final evidence commit follows)
- Focused regression proof: `npm run test -w @open-mercato/cezar -- src/workflows/run.test.ts -t '#992'` (5 passed), `npm run test -w @open-mercato/cezar-web -- src/api/client.test.ts src/routes/settings/resources-section.test.tsx` (100 passed), and `npm run typecheck` (pass). The custom-positive test was red at 15 minutes against the old hard-coded timer and green at the configured 30-minute delay.
- Browser QA passed on Resources: 30 persisted through blur and reload; explicit 0 saved as disabled; 15 restored and persisted through reload. Inline screenshots are attached to PR #1176 from dedicated branch `qa-evidence-pr-1176`.
- Full configured validation was run; the remaining failures are environment-sensitive task-context tests documented in the PR, with the focused suite passing under the controlled test environment.

## Risks

- A missing or invalid setting must keep the 15-minute safeguard.
- Monitoring parks must remain exempt from this timer and continue using their existing wake policy.

Source doc: `.ai/specs/2026-07-24-long-running-waiting-sessions.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Configuration and lifecycle

- [x] 1.1 Add optional `idleTimeoutMinutes` resource defaults, bounds, API contract, and semaphore cache/getter. — ccc8939e
- [x] 1.2 Replace the workflow constant use with the cached setting and preserve timer expiry behavior; test new-run and continuation park paths. — ccc8939e

### Phase 2: Operator surface and verification

- [x] 2.1 Add the timeout control and explanatory copy to Global Settings → Resources with focused UI tests. — ccc8939e
- [x] 2.2 Run focused regression/config/API/UI tests and prove the regression test is red against the pre-fix implementation. — ccc8939e
- [x] 2.3 Run the full configured validation gate, review diff, and document compatibility/evidence. — ccc8939e

### Correction and QA follow-up

- [x] 3.1 Preserve explicit `null` in client resource normalization and add absent/null/0/positive regression coverage. — ee6a3679
- [x] 3.2 Prove a configured positive timeout through the parked lifecycle (red against hard-coded 15 minutes, green at configured 30 minutes). — 825ba463
- [x] 3.3 Capture Resources persistence/disabled browser evidence and attach screenshots inline to PR #1176. — 2026-09-30 QA
