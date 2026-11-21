# Stage-only handoff contract

This contract is loaded by both wrapper skills before creating their worktree.

1. Work in an isolated worktree and run `capture` before any edits. Keep the
   resulting starting commit, complete ref snapshot, and reflog snapshot under
   the ignored run-artifact directory.
2. Do not create intermediate commits. Store progress in run artifacts instead.
3. Do not invoke publication-oriented skills, remote writes, or the tracker
   `create-pr` operation.
4. Build an allowlist containing every intended product, test, spec, and process
   file. Keep raw model output and generated review artifacts under a configured
   ignored artifact directory, not in the allowlist.
5. Run the full configured validation gate and the required review passes. Bind
   each wrapper-level council to one exact subject, and require both the fresh
   Claude `cez-code-review` pass and the advisor council before accepting the
   final review.
6. Invoke the runtime `stage` command with the worktree, original start-state
   artifact, and allowlist.
7. Require all of these checks to pass:
   - current `HEAD`, refs, and reflogs equal the captured starting state;
   - the staged diff is non-empty;
   - every staged path came from the allowlist;
   - no non-ignored unstaged or untracked files remain.
   Whitespace findings are reported as warnings, but completeness is an
   integrity invariant: a ready staged handoff must contain the whole
   reviewed change.
8. Report the absolute worktree path, branch, staged paths, validation evidence,
   suggested commit message, prepared pull-request body, and issue-claim state.

Command reviewers run with credential-like environment variables stripped and
Git protocols and credential helpers disabled. If any assertion fails, stop
with a blocked result. Never repair an unexpected commit by
rewriting history automatically.
