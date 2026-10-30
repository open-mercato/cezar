# Automation list ordering (#1819)

Source doc: .ai/specs/2026-10-30-issue-1819-automation-order.md (design PR #1835)
Status: in-progress
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Goal

Persist presentation-only Manual / Name / Next run ordering per project, with accessible drag and move controls. Preserve the alphabetical default and all scheduler/calendar behavior.

## Risks

- UI state is a protected open API/file bag: keep the change optional/additive and preserve unknown sibling fields.
- Capture project scope for asynchronous writes; serialize rapid changes and recover save errors.
- The unchanged Windows baseline passes typecheck/build; full npm test hit its 900s bound with unrelated platform/load failures, and node:test has missing POSIX `mkdir` and `/bin/sh`. Retain these results, run all configured commands on the implementation and check final-head CI; never call the local gate green when it fails.
- #1620's independent child owns BACKWARD_COMPATIBILITY.md for its additive note; add this issue's note only after coordinating its completion to avoid overlapping edits.

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
- [ ] 2.2 Review, validation, browser evidence and final PR state.
