# Issue #1599 Tasks quick and selected-row actions

Source doc: .ai/specs/2026-10-30-issue-1599-tasks-actions.md (design-only PR #1842)

## Goal

Manage a specific subset of task history from the per-project Tasks list without opening each thread.

## Scope

Only tasks-overview.tsx and uniquely named action/selection helpers/tests. Preserve current APIs, eligibility, header actions, virtualization, memoization and mobile navigation. No All Tasks changes, destructive actions, shared configuration/docs or contracts.

## Implementation Plan

Phase 1: add bounded existing-API action execution and accessible desktop/mobile selection, row controls and selected-row toolbar.
Phase 2: interaction/red-green regression tests, full configured validation, review/autofix, browser QA and publish evidence.

## Risks

Mixed eligibility, partial failure, hidden selected rows and project navigation during a batch. Existing Windows baseline failures may prevent a local green full gate; record exact results and supported-platform CI separately. Private test environment avoids sibling collisions.

## Progress

PR: #1843

Implementation: c88c207f. Source-scoped actions/selection, tests and review fixes complete. Browser QA PASS with screenshots published separately on qa-evidence-issue-1599; no QA-approval label granted. Full commands executed: typecheck PASS; npm test TIMEOUT600s with broad Windows failures; node:test45pass/2fail/1skip (baseline POSIX mkdir and /bin/sh missing); build/check:pack PASS; package33/33 PASS. Targeted105/105 PASS after full-suite load ended. Key subset test FAILS against old route and PASSES restored.

Supported-platform CI on the final documentation head is reported in the PR's review/CI-result comments. Local full gate is not claimed green. Review pickup stays unassigned with review and needs-qa. Full QA report: https://github.com/open-mercato/cezar/blob/qa-evidence-issue-1599/issue-1599/report.md


### Phase 1: scoped actions

- [x] 1.1 Add canonical eligibility and bounded execution helpers.
- [x] 1.2 Wire row/selected actions and accessible responsive selection.

### Phase 2: verification

- [x] 2.1 Add interaction tests and demonstrate red/green regression.
- [x] 2.2 Run gate, review/autofix, browser QA and publish evidence.
