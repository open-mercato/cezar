# Bound `cez-code-review` council contract

Load this contract before invoking an advisor council.

## Bind one exact subject

Run the runtime `review` command against exactly one subject: `--artifact` for a
diagnosis or spec file, `--paths-file` for an allowlisted worktree diff,
`--diff-range` for an explicit Git range, or nothing for the whole worktree diff.
Pass the requirements, rules, and any validation evidence the reviewers should
audit with `--criteria-file`. The runtime binds the subject SHA-256 and the
installed `cez-code-review` rubric hash into the result's `reviewContract`; a
reviewed-subject change means a new council.

## Keep contexts fresh

Cezar launches runner-backed reviewers separately and combines their results with
this runtime's advisors. Each reviewer receives the same bound subject and criteria,
never the implementation conversation or peers' outputs. The runtime does not
launch an additional host review or require a particular orchestrator model.

## Run every configured advisor

The runtime invokes every reviewer id in the selected profile in parallel up to
the profile limit. Each invocation is a new process or API request with
no implementation transcript and receives the same complete `cez-code-review`
rubric, criteria, and subject. Oversized subjects may use multiple fresh parts
per advisor; the runtime unions their findings without exposing one advisor's
result to another. `--output-dir` receives `review-result.json` and
`review-summary.md`; `--prompt-dir` records each advisor's exact prompt.

The provider policy applies to the profile's configured reviewers (under the
shipped `all-required` default, every configured reviewer must complete). The
runtime retries each failed invocation per the configured `retry` block
(backoff + timeout escalation). Reconcile only after every invocation reaches
a terminal state. Preserve unique findings, validate them against
repository/runtime evidence, and rerun the entire council after any
reviewed-subject change.

**Blocked council.** When the runtime exits non-zero with `verdict: null`
because a required reviewer did not complete after its retries, the council
produced NO result: do not reconcile, do not proceed to stage, and never
downgrade to a smaller council silently. Re-run `review` against the same subject
and criteria; if the same reviewer keeps failing, repair its binding via
`cez-setup-harness` or stop and surface the failure to the user for an explicit
decision.
