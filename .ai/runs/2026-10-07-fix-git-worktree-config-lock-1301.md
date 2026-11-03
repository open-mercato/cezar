# Fix parallel worktree creation config-lock failures

## Goal

Prevent concurrent task worktree creation from failing on a transient shared `.git/config.lock` when Git attempts unnecessary upstream tracking writes.

## Scope

- `packages/cezar/src/git-worktree.ts`: create new task branches without upstream tracking metadata.
- `packages/cezar/src/git-worktree.test.ts`: real-git regression coverage for the locked-config scenario and preserved normal worktree behavior.

## Non-goals

- Changing base-ref resolution, worktree recovery, branch naming, or lifecycle cleanup.
- Adding a retry loop around Git failures or changing repository-wide Git configuration.

## Implementation Plan

### Phase 1: Fix and regression coverage

- [x] 1.1 Add `--no-track` to fresh worktree creation and document why. — a343a6c4
- [x] 1.2 Add a deterministic regression test that holds `.git/config.lock`, proves fresh creation still succeeds, and verifies no upstream metadata is required. — a343a6c4

### Phase 2: Verification and delivery

- [x] 2.1 Run targeted tests and prove the regression is red against the parent implementation and green with the fix. — a343a6c4
- [x] 2.2 Run the configured validation gate, review the PR, and report the verified branch and PR. — fb883440

## Risks

Git's default branch tracking is intentionally suppressed for cezar-created task branches. This is safe only if no lifecycle path relies on `branch.*.remote` or `branch.*.merge`; targeted repository search and the regression test must confirm that assumption.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Fix and regression coverage

- [ ] 1.1 Add `--no-track` to fresh worktree creation and document why.
- [ ] 1.2 Add a deterministic regression test that holds `.git/config.lock`, proves fresh creation still succeeds, and verifies no upstream metadata is required.

### Phase 2: Verification and delivery

- [ ] 2.1 Run targeted tests and prove the regression is red against the parent implementation and green with the fix.
- [ ] 2.2 Run the configured validation gate, review the PR, and report the verified branch and PR.
