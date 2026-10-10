# Bound repeated handoff heartbeats

## Goal

Implement issue #1215 by coalescing adjacent eligible same-note engine heartbeats in the handoff Progress log, retaining the newest timestamp and summed occurrence count, then retaining at most 100 eligible entries while preserving all non-engine content and existing best-effort behavior.

## Scope

- `packages/cezar/src/handoff.ts`
- `packages/cezar/src/handoff.test.ts`
- This execution plan

## Non-goals

- No changes to call sites, file format outside the documented `(×N)` suffix, dependencies, configuration, or unrelated handoff behavior.
- No changes to the repository base branch.

## Implementation Plan

### Phase 1: Implement and verify bounded handoff journals

- [x] 1.1 Add regression tests that reproduce unbounded growth and pin coalescing, count accumulation, eligibility, boundaries, header-less behavior, and silent failures. — 4e33f4c9
- [x] 1.2 Implement eligible heartbeat parsing, adjacent same-note coalescing, and the exported 100-entry cap in the existing read-modify-write path. — 4e33f4c9
- [x] 1.3 Run targeted tests, inspect the scoped diff, and run the configured validation gate. — e686b4dc; targeted 13/13, typecheck, unit 42/42, build, and package 17/17 pass; bounded clean full test: 8,921 passed, 3 skipped
- [x] 1.4 Review the final diff locally and publish the tested branch as a PR. — e686b4dc; ready PR #1332

## Risks

- Eligibility is necessarily a timestamp-plus-engine-prefix compatibility heuristic; tests must ensure agent-authored timestamped lines and section boundaries remain intact.

## Progress

PR: #1332

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Implement and verify bounded handoff journals

- [x] 1.1 Add regression tests that reproduce unbounded growth and pin coalescing, count accumulation, eligibility, boundaries, header-less behavior, and silent failures. — 4e33f4c9
- [x] 1.2 Implement eligible heartbeat parsing, adjacent same-note coalescing, and the exported 100-entry cap in the existing read-modify-write path. — 4e33f4c9
- [x] 1.3 Run targeted tests, inspect the scoped diff, and run the configured validation gate. — e686b4dc; targeted 13/13, typecheck, unit 42/42, build, and package 17/17 pass; bounded clean full test: 8,921 passed, 3 skipped
- [x] 1.4 Review the final diff locally and publish the tested branch as a PR. — e686b4dc; ready PR #1332

## Final orchestration verification

All configured gates pass with isolated worktree dependencies and the bounded clean-temp full suite. Independent source review approved; final documentation-only orchestration update removes stale completion notes. No implementation merged.
