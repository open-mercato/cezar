# High-assurance packet contract

Load this contract only for a profile whose `packetPolicy.mode` is
`adversarial`.

## Manifest

Create one JSON manifest matching `packet-manifest.schema.json` per bounded,
file-disjoint implementation unit. Put the objective, exact relative paths,
invariants, acceptance criteria, dependencies, and non-goals in the manifest.
Keep implementation rationale and prior model output out of it.

## Lifecycle

Run `packet-run` with the trusted harness configuration, manifest, worktree,
and ignored run-artifact directory. The runtime:

1. verifies that dependencies are gated and atomically leases every allowed
   path;
2. rejects an allowed path that already has uncommitted changes;
3. invokes one sandboxed worker and rejects changes outside the lease;
4. selects independent reviewer families according to the packet risk;
5. gives reviewers only the manifest contract and packet diff, with a distinct
   configured review lens and no implementer transcript;
6. verifies candidate findings in a fresh reviewer invocation;
7. sends verified findings to a fresh fixer invocation and repeats review up to
   `maxFixCycles`;
8. stops at `awaiting_validation`, or at `blocked` when review policy,
   isolation, or the fixer loop fails.

The JSON ledger under `<runDir>/packets/<id>/packet-result.json` is
authoritative. Do not edit it by hand.

## Deterministic gate

Run repository acceptance commands outside the model-authored packet loop.
Write their results to JSON matching `packet-gate.schema.json`. Cover every
manifest acceptance criterion, include the ledger's current diff hash, and run
`packet-gate`. The runtime re-hashes the packet diff before accepting evidence.
Only a `gated` packet may be treated as integrated.

`packet-gate` does not execute commands from the evidence file. The host owns
their safe execution from trusted repository configuration and records the
result afterward.

## Leases and recovery

Keep leases while a packet is running, awaiting validation, or blocked. A
successful gate releases them. Use `packet-status` to inspect the ledger. Use
`packet-release --reason <text>` only after deliberately abandoning or taking
manual ownership of a non-gated packet; it records `aborted` before releasing
paths.

The lease registry lives under the repository's Git common directory, so
separate harness run directories and linked worktrees still coordinate path
ownership. A stale registry mutex may be reclaimed after one minute; packet
leases themselves are never expired automatically.

Version 1 runs one implementation or fixer packet at a time in an integration
worktree. Reviewer invocations may run concurrently. Do not increase worker,
fixer, or heavy-validation concurrency until packet execution uses isolated
worktrees with an explicit integration gate.

## Stopping rules

Stop rather than weaken policy when independent families are unavailable, a
worker edits outside its allowed paths, a dependency is not gated, a verifier
fails, blocking findings survive the configured fixer cycles, acceptance
evidence does not cover every criterion, or the diff changes after review.
