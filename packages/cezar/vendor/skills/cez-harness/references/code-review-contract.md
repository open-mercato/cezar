# Bound `cez-code-review` council contract

Load this contract before every wrapper-level diagnosis, specification, or
implementation council.

## Prepare one immutable packet

Run `prepare-review` against the exact artifact or allowlisted worktree diff.
Set `--kind` to `diagnosis`, `spec`, or `implementation`; pass the requirements
with `--criteria-file`, and list any nested agent instructions or architecture
rules with `--context-paths-file`. The runtime automatically captures existing
root agent instructions, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md`, the
configured review checklist, and the repo-local `cez-code-review` extension.

For an implementation packet, pass version 1 validation evidence containing
the real status, exit code, and observed output summary for every configured
command:

```json
{
  "version": 1,
  "status": "passed",
  "reason": null,
  "checks": [
    {
      "command": ["<executable>", "<argument>"],
      "status": "passed",
      "exitCode": 0,
      "evidence": "Observed summary with the artifact path when applicable."
    }
  ]
}
```

Specification and diagnosis packets record validation as not applicable. The
generated packet binds its subject SHA-256 to the installed `cez-code-review`
skill, full checklist, output contract, repository rules, criteria, and host
validation evidence. Do not hand-edit it.

## Run Claude with genuinely fresh context

Create a new Claude reviewer context through the host's fresh-agent mechanism.
Do not fork or copy the conductor's implementation conversation, worker
transcripts, rationale, previous findings, or proposed fixes. Give the reviewer
only:

- the isolated worktree and exact review subject;
- the immutable packet and its SHA-256;
- the installed `cez-code-review` skill;
- `fresh-review-result.schema.json` and `review-result.schema.json`;
- an output path under the ignored review-artifact directory.

Tell that reviewer to execute `cez-code-review` in full, including its own
configured validation gate when the subject is an implementation, and serialize
that per-command gate evidence plus the result without markdown. It must attest `freshContext: true` and
`implementationContextInherited: false`, copy every contract hash from the
packet/preparation result, and report observed model provenance when available.
Write to a temporary sibling path and rename it to the declared host-review path
only after the JSON is complete, so the runtime never observes a partial file.
If the host cannot create a fresh Claude context, stop; never substitute the
conductor's current context or another model.

## Run every configured advisor

Predeclare the final host-review path. Launch the new Claude context and the
runtime `review` command concurrently, passing both `--review-packet` and
`--host-review`; do not wait for Claude before starting the runtime. The runtime
immediately starts every configured advisor and waits up to
`--host-review-timeout-ms` (ten minutes by default) for Claude's atomically
completed artifact. It rejects a stale subject, changed rubric, non-Claude host,
inherited-context attestation, or mismatched hash instead of producing a final
council result.

The runtime invokes every reviewer id in the selected profile in parallel up to
the profile limit while Claude works independently. Each invocation is a new process or API request with
no implementation transcript and receives the same complete `cez-code-review`
rubric, packet, and subject. Oversized subjects may use multiple fresh parts per
advisor; the runtime unions their findings without exposing one advisor's
result to another.

The fresh Claude result appears in the same reviewer table and findings matrix
as the configured advisors. Claude is mandatory but does not satisfy the
provider policy, which applies to the profile's configured reviewers (under
the shipped `all-required` default, every configured reviewer must complete).
The runtime retries each failed invocation per the configured `retry` block
(backoff + timeout escalation). Reconcile only after every invocation reaches
a terminal state. Preserve unique findings, validate them against
repository/runtime evidence, and rerun the entire packet after any
reviewed-subject change.

**Blocked council.** When the runtime exits non-zero with `verdict: null`
because a required reviewer did not complete after its retries, the council
produced NO result: do not reconcile, do not proceed to stage, and never
downgrade to a smaller council silently. Re-run the `review` command (the run
is deterministic over the same packet, so a repeat is cheap and safe); if the
same reviewer keeps failing, repair its binding via `cez-setup-harness`
or stop and surface the failure to the user for an explicit decision.
