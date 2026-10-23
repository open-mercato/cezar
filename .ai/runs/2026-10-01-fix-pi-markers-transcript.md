# Fix Pi markers and duplicate transcript

Goal: fix Pi content-part marker fragmentation for issues #902/#903 while preserving v2 live streaming and v1 whole-message transcript semantics.

Scope: `packages/cezar/src/core/pi-runner.ts`, its focused protocol tests, and the existing shared Pi text coalescer. Non-goals: other backends, workflow marker parsing, or UI code.

## Implementation Plan

### Phase 1: Reproduce and fix Pi snapshot assembly

- [x] 1.1 Add regression coverage for content-part marker boundaries and tool-interleaved text while retaining v2 deltas — 54abec39, 9d898c61
- [x] 1.2 Concatenate Pi assistant text parts for v1 snapshots without changing tool/result or v2 mapping behavior — 54abec39

### Phase 2: Validate and review

- [x] 2.1 Prove the regression is red without the fix, run the configured validation gate, and complete PR review — independently verified; see Final verification below

## Risks

- Adjacent concatenation must be limited to Pi assistant snapshots; tool output and other backends retain their existing separators.

## Progress

PR: #1208

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and fix Pi snapshot assembly

- [x] 1.1 Add regression coverage for content-part marker boundaries and tool-interleaved text while retaining v2 deltas — 54abec39, 9d898c61
- [x] 1.2 Concatenate Pi assistant text parts for v1 snapshots without changing tool/result or v2 mapping behavior — 54abec39

### Phase 2: Validate and review

- [x] 2.1 Prove the regression is red without the fix, run the configured validation gate, and complete PR review — independently verified; see Final verification below

## Final verification

Independent reviewer approved code head `5341303d879233889198adb70278a306ba7ffae8`: https://github.com/open-mercato/cezar/pull/1208#issuecomment-5922976327.

Genuine red/green regression proof recorded; focused Pi tests and typecheck/unit/build/package checks passed. Exact code-head CI is green. Earlier local full-suite failures are historical, not claimed as a passing run.

This final documentation update supersedes earlier pending review/browser statements without changing implementation. No fix branch was merged; applicable QA/CI still gate merge.
