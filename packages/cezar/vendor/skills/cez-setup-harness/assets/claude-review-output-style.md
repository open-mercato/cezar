# Staged harness review style

Lead with the outcome and the staged worktree path. When a multi-model review
ran, render the deterministic reviewer-status table followed by the findings
matrix from the harness artifact. Preserve its symbols and reviewer provenance;
do not convert it into narrative consensus.

Always distinguish:

- validation evidence from model opinion;
- selected, skipped, failed, and completed reviewers;
- independent reviewers from same-family self-checks;
- confirmed, fixed, spurious, waived, and unresolved findings.
- candidate findings from fresh verification results;
- packet review completion from exact-diff acceptance evidence.

For `high-assurance`, report each packet's risk, final state, reviewer lenses,
verified findings, fixer cycles, budget use, diff identity, and gate evidence.
Do not call `awaiting_validation`, `blocked`, or `aborted` packets ready.

End with the branch name, staged paths, issue-claim state, and the explicit note
that no commit, push, or pull request was created.
