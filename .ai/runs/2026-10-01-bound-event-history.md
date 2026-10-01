# Bound event-history context retention

Goal: bound turn-boundary retention in `deriveRunContextEvents` for sessions without
sub-agent roots, while preserving active roots, newest children, latest plan, and the
existing settled-root carry-over behavior.

Scope: `packages/cezar/src/runs/event-history.ts`,
`packages/cezar/src/runs/event-history.test.ts`.

Non-goals: changing the HTTP contract, server behavior, web consumers, or root/child
episode selection semantics.

## Implementation Plan

### Phase 1: Fix and regression coverage

- [x] 1.1 Add an independent bounded boundary window and regression tests for long no-root and mixed-root histories — f14dd6da, 4d99d6b4
- [x] 1.2 Run focused history tests and inspect the diff — 15/15 passed; baseline red with 4,000 and 2,001 retained boundaries

### Phase 2: Validation and review

- [x] 2.1 Run the configured validation gate — typecheck, unit (36/36), build, and package (17/17) passed; full `npm test` had 9 unrelated environment-sensitive failures (8,466/8,475 passed)
- [x] 2.2 Obtain the authoritative PR review and address findings — independently verified; see Final verification below

## Risks

The boundary window may discard older turn markers, but context episode items and the
latest plan remain independently retained. Existing root-driven pruning and carry-over
tests guard the intentional fan-out behavior.

## Progress

PR: #1207

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix and regression coverage

- [x] 1.1 Add an independent bounded boundary window and regression tests for long no-root and mixed-root histories — f14dd6da
- [x] 1.2 Run focused history tests and inspect the diff — 15/15 passed; baseline red with 4,000 and 2,001 retained boundaries

### Phase 2: Validation and review

- [x] 2.1 Run the configured validation gate — typecheck, unit (36/36), build, and package (17/17) passed; full `npm test` had 9 unrelated environment-sensitive failures (8,466/8,475 passed)
- [x] 2.2 Obtain the authoritative independent PR review; self-review found no code findings, but GitHub disallows author approval — independently verified; see Final verification below

## Final verification

Independent reviewer approved code head `1f262b9ab94c1f21696dbcf714a89e04b3a7c115`: https://github.com/open-mercato/cezar/pull/1207#issuecomment-5922976168.

Final clean full npm test with task CEZ variables unset and TMPDIR=/tmp: 501 files / 8,475 tests passed, confirmed from worker tool output. Targeted former failures 232/232. Exact code-head CI also green.

This final documentation update supersedes earlier pending review/browser statements without changing implementation. No fix branch was merged; applicable QA/CI still gate merge.
