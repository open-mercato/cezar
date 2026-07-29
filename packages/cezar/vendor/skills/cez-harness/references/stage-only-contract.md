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
   each wrapper-level council to an exact-subject `cez-code-review` packet, start
   fresh Claude and every configured advisor concurrently, and require the
   matching Claude artifact before accepting the final council result. For
   `high-assurance`, require every packet ledger to reach `gated`; a packet in
   `awaiting_validation`, `blocked`, or `aborted` cannot enter the handoff.
6. Invoke the runtime `stage` command with the worktree, original start-state
   artifact, and allowlist.
7. Require all of these checks to pass:
   - current `HEAD`, refs, and reflogs equal the captured starting state;
   - the staged diff is non-empty;
   - every staged path came from the allowlist.
   Whitespace findings in the staged diff and non-ignored unstaged or
   untracked leftovers are reported as WARNINGS on the stage result, never as
   refusals: the staged handoff feeds a human gate, and that gate judges
   cosmetic and completeness questions better than a fatal last-step check
   that hands it nothing.
8. Report the absolute worktree path, branch, staged paths, validation evidence,
   suggested commit message, prepared pull-request body, and issue-claim state.

Worker adapters must also enforce disabled network, remote writes, and ref
writes. The runtime strips credential-like environment variables and disables
Git protocols and credential helpers for worker processes. If any assertion
fails, stop with a blocked result. Never repair an unexpected commit by
rewriting history automatically.
