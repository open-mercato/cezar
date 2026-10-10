# Fix autosave check-step artifacts

## Goal

Ensure workflow check commands cannot be folded into the run's autosave commit, while preserving all agent-authored work and recovery behavior.

## Scope

- `packages/cezar/src/git-worktree.ts`: add a narrowly scoped worktree cleanup helper for post-check mutations.
- `packages/cezar/src/workflows/run.ts`: checkpoint agent work before checks and discard check-created worktree mutations before final settlement.
- Associated autosave/workflow regression tests only.

## Non-goals

- No startup, automation, CLI, API, or periodic-autosave changes.
- No changes to the existing conflict guard or pre-PR autosave contract.

## Implementation Plan

### Phase 1: Plan and reproduction

- [x] 1.1 Confirm issue/PR state, current main, call sites, and root cause.
- [x] 1.2 Add a regression test that demonstrates a command-step artifact is not present in autosave history. — 90962f8e

### Phase 2: Fix

- [x] 2.1 Checkpoint successful agent work before entering command steps. — 90962f8e
- [x] 2.2 Remove only post-check worktree mutations before final autosave/settlement. — 90962f8e

### Phase 3: Validation and review

- [x] 3.1 Run targeted tests, prove the regression test fails against the pre-fix code, then passes with the fix. — 90962f8e
- [ ] 3.2 Run the configured validation gate and authoritative PR review.

## Evidence

- Red-before-fix: the new targeted regression failed because `run finalize` autosave contained `debug_test.txt`.
- Green-after-fix: focused workflow/autosave tests passed (144 tests), with both tracked and untracked check artifacts removed and agent `notes.md` preserved.
- Passed: `npm run typecheck`, `npm run test:unit`, `npm run build`, `npm run test:package`.
- Full `npm test` with `TMPDIR=/tmp TMP=/tmp` and task-session variables unset passed 8290/8291; the sole unrelated automation-gate failure passes when run sequentially (22/22). GitHub rejects self-approval, so review evidence was posted as a PR comment and the PR remains draft.

## Risks

The cleanup must preserve agent-authored files and avoid broad deletion outside the isolated task worktree. It will therefore run only after an agent autosave checkpoint and use Git's worktree-local reset/clean semantics.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Plan and reproduction

- [x] 1.1 Confirm issue/PR state, current main, call sites, and root cause.
- [x] 1.2 Add a regression test that demonstrates a command-step artifact is not present in autosave history. — 90962f8e

### Phase 2: Fix

- [x] 2.1 Checkpoint successful agent work before entering command steps. — 90962f8e
- [x] 2.2 Remove only post-check worktree mutations before final autosave/settlement. — 90962f8e

### Phase 3: Validation and review

- [x] 3.1 Run targeted tests, prove the regression test fails against the pre-fix code, then passes with the fix. — 90962f8e
- [ ] 3.2 Run the configured validation gate and authoritative PR review.
