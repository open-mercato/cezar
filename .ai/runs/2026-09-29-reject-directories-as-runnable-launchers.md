# Reject directories as runnable launchers

Goal: Fix #1066 so `resolveOnPath` only resolves executable regular files, while preserving executable symlinks, platform-specific `.com`/`.exe` probing, and Windows shell exclusions.

Scope: `packages/cezar/src/server/open-in-app.ts`, its focused tests, and the shared executable-file helper in `packages/cezar/src/core/claude-bin.ts` plus helper tests.

Non-goals: No changes to API contracts, launcher behavior outside these probes, tracker integrations, or unrelated cleanup.

## Implementation Plan

### Phase 1: Regression and shared guard

- [x] 1.1 Add a hermetic regression test covering PATH directories, real executable files, symlinks, and Windows suffix behavior. — 25f22d5f
- [x] 1.2 Reuse the existing regular-file executable helper from Claude resolution in `resolveOnPath`. — 25f22d5f

### Phase 2: Validation and delivery

- [x] 2.1 Run the focused regression red before the fix and green after it, then run the configured validation gate. — 7611ff78
- [x] 2.2 Commit, push, open and finalize the issue PR with review evidence. — 3d5fc89f

Risks: Filesystem probes must continue to follow executable symlinks and must not broaden the set of directly spawned Windows suffixes. The configured package dependency tree will be installed locally with `npm ci` if needed.

## Final verification

Independent review task `690e9ba5` approved `3d5fc89f28a87a29fd04143f96b8f75a0190a095` with no actionable findings.

Regression red before fix, focused 62/62 after fix; parent independently passed 51 tests and reviewer 26 launcher tests. Typecheck, unit 36/36, build/check-pack, package 17/17 passed. Full local suite encountered unrelated environment/concurrency failures. CI passed after a rerun of the known #1117 automation-lock race.

GitHub author self-approval is unavailable. QA sign-off remains a merge gate; ready status does not waive it.

## Progress

PR: #1153

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Regression and shared guard

- [x] 1.1 Add a hermetic regression test covering PATH directories, real executable files, symlinks, and Windows suffix behavior. — 25f22d5f
- [x] 1.2 Reuse the existing regular-file executable helper from Claude resolution in `resolveOnPath`. — 25f22d5f

### Phase 2: Validation and delivery

- [x] 2.1 Run the focused regression red before the fix and green after it, then run the configured validation gate. — 7611ff78
- [x] 2.2 Commit, push, open and finalize the issue PR with review evidence. — 3d5fc89f
