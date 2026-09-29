# Task PR reference list — #779

Goal: preserve every authoritative PR association on a run and expose the ordered list to the
cockpit while keeping old scalar fields readable.

Scope: `packages/cezar/src/runs`, `packages/contract/src/runs.ts`, and the web task-reference
selector/tests, run-index API projection, and existing PR-status cache hydration. Non-goals: issue references or a new polling mechanism.

## Final verification

Independent review task `690e9ba5` approved `fbe5ad5ed090974028088359b0ef40090a0a69ab` with no actionable findings.

Full clean gate passed: 496 files / 8404 tests, typecheck, unit 36/36, build/check-pack, package 17/17. Real-browser multi-reference QA confirmed draft #1151 before closed-unmerged #1152 with both hrefs retained. [Screenshot](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1151/pr-1151/tasks-multiref-authoritative.png). Mobile viewport was not exercised.

GitHub author self-approval is unavailable. QA sign-off remains a merge gate; ready status does not waive it.

## Progress

PR: #1151

### Phase 1: persistence and selector

- [x] 1.1 Add additive `prRefs` schema and store projection — d001db66
- [x] 1.2 Record marker/created/legacy associations and regression tests — d001db66
- [x] 1.3 Expose ordered references to web consumers and add selector tests — d001db66
- [x] 1.4 Run targeted validation and publish PR — fbe5ad5e
