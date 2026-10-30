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
- [ ] 2.1 Five-command gate, code review/autofix and exact-head CI.
- [ ] 2.2 Private disposable-project browser QA, branch/transcript proof, ready PR and lock release.

Phase 1 commit: aa35ade1. Targeted 264/264; red two menu tests fail without source, green2/2 restored. Typecheck/build/package33 pass. Full Vitest timed out300s with Windows symlink failures; node:test core63/65 (missing mkdir and /bin/sh).

