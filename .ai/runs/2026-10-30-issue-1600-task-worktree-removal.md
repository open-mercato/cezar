# Execution plan: task worktree removal (#1600)

Source doc: .ai/specs/2026-10-30-issue-1600-task-worktree-removal.md (design PR #1854)

## Goal
Free one settled task checkout from its desktop/mobile detail menus, retaining branch, task and transcript via existing lifecycle reclaim.

## Risks
Reclaim force-removes ignored files; explain this and block dirty/unavailable status. Status preflight is not atomic against external writes. Existing lifecycle recovery owns cleanup failures. No backend/API changes. Local Windows baseline has missing POSIX tools and symlink/load failures; report configured gate failures accurately and require exact published-head CI.

## Progress
PR: #1857

### Phase 1: action and safety
- [x] 1.1 Eligibility, dedicated confirmation and reclaim mutation with tests.
- [x] 1.2 Desktop/mobile menus; regression red/green and targeted verification.

### Phase 2: verification and publication
- [x] 2.1 Five-command gate and code review/autofix; publish for exact-head CI follow-up.
- [x] 2.2 Private disposable-project browser QA and branch/transcript proof; publish ready PR and release lock.

Phase 1 commit: aa35ade1. Targeted 264/264; red two menu tests fail without source, green2/2 restored. Typecheck/build/package33 pass. Full Vitest timed out300s with Windows symlink failures; node:test core45 passed,2 failed,1 skipped (missing mkdir and /bin/sh).


Final verification: 266/266 targeted tests, web typecheck, and final dialog10/10 pass. Browser desktop/mobile320x568: confirm/cancel, dirty/missing/in-place refusal, legacy hook-free reclaim, durable recovery/Retry, and unchanged unpushed branch + record/transcript after directory removal. Fixed clipped small-phone controls during review. Exact final-head CI outcome is posted on PR #1857 after publication; local full gate is NOT green (baseline failures above). No real task worktree/branch removed. Private artifacts remain ignored. Engine: om-auto-create-pr (steps: 4, --loop: no).

