# Execution plan — strip bidi controls from attachment filenames

**Issue:** #988
**Branch:** `cez/3f92bd8e`
**Goal:** Remove bidi/format display-control characters from sanitized attachment filenames while preserving ordinary Unicode names and existing media-type extension pinning.

## Scope

- Update `sanitizeAttachmentName` in `packages/contract/src/runs.ts`.
- Extend the focused sanitizer tests in `packages/cezar/src/workflows/pasted-attachments.test.ts`.
- Preserve all existing path, Windows-name, Unicode, length, and extension-pinning behavior.

## Non-goals

- No resource schemas, workflow, settings, installer, transcript UI, or unrelated attachment behavior.

## Implementation Plan

### Phase 1: Regression and fix

- [x] 1.1 Add a regression test covering U+202E and the full required bidi/format ranges; prove it fails before the fix. — 9b38afa8
- [x] 1.2 Extend the sanitizer character class minimally and prove the focused tests pass. — a867c19a

### Phase 2: Validation and handoff

- [x] 2.1 Run the complete configured validation gate, document any baseline/unrelated failures, and complete the PR review handoff. — 3ad30c74

Gate evidence: `npm run typecheck` and `npm run build` fail on pre-existing workspace dependency/contract drift (including Zod v3/v4 resolution and stale `/tmp/cezar-review-1098-final-...` paths); `npm test` reports 312 failed files and an unrelated repository-root discovery failure; `npm run test:unit` has 3 unrelated failing suites; `npm run test:package` has 2 artifact assertions. `git diff --check` and direct source-level sanitizer checks pass. The focused Vitest suite cannot collect because of the same `z.looseObject is not a function` dependency mismatch.

## Risks

The sanitizer is a shared contract helper, so an overbroad Unicode range could damage legitimate filenames. The change will use only the explicitly required display-control ranges and tests will pin ordinary Unicode preservation and extension pinning.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Regression and fix

- [ ] 1.1 Add a regression test covering U+202E and the full required bidi/format ranges; prove it fails before the fix.
- [ ] 1.2 Extend the sanitizer character class minimally and prove the focused tests pass.

### Phase 2: Validation and handoff

- [ ] 2.1 Run the complete configured validation gate, document any baseline/unrelated failures, and complete the PR review handoff.
