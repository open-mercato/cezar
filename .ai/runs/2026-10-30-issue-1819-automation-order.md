# Automation list ordering (#1819)

Source doc: .ai/specs/2026-10-30-issue-1819-automation-order.md (design PR #1835)
Status: complete
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Goal

Persist presentation-only Manual / Name / Next run ordering per project, with accessible drag and move controls. Preserve the alphabetical default and all scheduler/calendar behavior.

## Risks

- UI state is a protected open API/file bag: keep the change optional/additive and preserve unknown sibling fields.
- Capture project scope for asynchronous writes; serialize rapid changes and recover save errors.
- The unchanged Windows baseline passes typecheck/build; full npm test hit its 900s bound with unrelated platform/load failures, and node:test has missing POSIX `mkdir` and `/bin/sh`. Retain these results, run all configured commands on the implementation and check final-head CI; never call the local gate green when it fails.
- Parent owns shared compatibility documentation centrally; this issue's optional preference note is included.

## Implementation Plan

### Phase 1: Preference and ordering

1. Add the shared optional bounded preference schema and route validation, plus API validation tests.
2. Implement deterministic ordering/next-time rules, normalization and unit tests.

### Phase 2: Interaction and verification

3. Add project-safe serialized persistence, sorting, accessible drag/move controls and interaction tests.
4. Prove the regression, run validation, code review and real-browser QA; attach evidence and leave the PR ready/unassigned with the review label when complete.

## Progress

- [x] 1.1 Shared preference schema and API tests (API rejection regression red on original source, green fixed).
- [x] 1.2 Pure ordering rules and tests (7 focused ordering cases pass).
- [x] 2.1 Persisted sort and accessible placement controls with interaction tests (1db4e61c; 51 focused tests pass; original UI fails the new move test; follow-up loading/error recovery tests pass).
- [x] 2.2 Review, validation, browser evidence and final PR state (implementation PR #1836; owner review and QA approval remain required).

## Verification

- New API rejection and UI movement regressions fail on original source; 51 focused tests pass, followed by 19 controller/list tests after the two review fixes.
- Ordered local gate: typecheck PASS (185s); full Vitest FAIL/stopped after 688s of Windows baseline failures to release the shared suite slot; node:test 45 pass / 2 POSIX ENOENT failures / 1 skip; build PASS (16s); packaged CLI 33/33 PASS (63s). The local full gate is not green.
- Exact source commit 941d99fc passes every configured gate in CI run 41111059235: all three full Vitest shards and verify/typecheck/unit/build/package, plus Windows/macOS/Linux and CodeQL. Final plan-only commit repeats CI; no source changed.
- Real agent-browser 0.41/Chrome156 QA PASS, including pointer/keyboard drag, cancellation, movement, sort/persistence, empty/loading/error/retry, controlled GET/PUT403, project isolation, new/stale IDs, long titles, light/dark and 390px. Final rebuilt source cold-load/sort/move/reload and mobile recheck passed without browser errors.
- Evidence: https://github.com/open-mercato/cezar/pull/1836#issuecomment-6531247942 . Permission failures use private response injection; the 201-row bound and rapid-save serialization have component/controller evidence. No author QA sign-off granted.
- Automation route chunk: 75.44 → 80.60 kB (gzip 20.32 → 22.11 kB); existing dnd-kit reused, no dependency added.
