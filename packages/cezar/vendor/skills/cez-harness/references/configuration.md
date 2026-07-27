# Harness configuration

This contract is loaded by every wrapper before resolving workers or reviewers.

## Location and precedence

Store non-secret team policy under the optional `agentHarness` object in
`.ai/agentic.config.json`. Existing pipeline configuration remains valid when
the object is absent. Resolve configuration in this order:

1. the repository configuration from the trusted base revision;
2. an optional user-local overlay passed with `--user-config`;
3. explicit invocation choices such as `--profile` or `--model`.

The user-local overlay may bind provider commands, endpoints, model identifiers,
timeouts, and credential environment-variable names. It must not change the
delivery mode. Never load executable provider settings from the task branch.

## Required shape

```json
{
  "agentHarness": {
    "version": 1,
    "host": "claude",
    "delivery": {
      "mode": "stage-only",
      "issueClaim": "hold"
    },
    "models": {},
    "profiles": {
      "standard": {
        "workers": [],
        "reviewers": [],
        "reviewPolicy": { "mode": "advisory" }
      }
    }
  }
}
```

`host` is optional and, in version 1, must be `claude` when present — the fresh
host review is always a Claude artifact. `models` maps stable local identifiers
to adapter definitions. The shipped
template contains the selectable `codex`, `deepseek`, `kimi`, `glm`, and `mimo`
jury; repositories may keep any subset and add custom ids. `profiles` maps
profile names to `workers`, `reviewers`, `maxParallel`, `maxInputBytes`, and
`reviewPolicy`. A profile may also declare `concurrency` and a `packetPolicy`.
The runtime repeats criteria and splits oversized review input
into bounded parts, then unions findings by fingerprint. The
official DeepSeek and OpenCode Zen auth-store endpoints are pinned inside the
runtime; a changed endpoint requires updating both the runtime pin and the
setup template together.

Review policy modes:

- `advisory` — report every result and continue even when reviewers skip.
- `quorum` — require `minimumSuccessful` completed reviewers and
  `minimumFamilies` distinct model families (legacy; kept for existing
  configs, no longer the shipped default for `multi*` profiles).
- `all-required` — require every id in `requiredReviewers` to complete. This
  is the shipped default for `multi`, `multi-optimized`, and `high-assurance`:
  the user selected those reviewers to hear from all of them, so a council
  missing any of them produces no verdict.

Reviewer retries (`retry`, top-level with per-profile override):

```json
"retry": {
  "maxAttempts": 4,
  "backoffMs": 5000,
  "backoffMultiplier": 2,
  "timeoutEscalation": 1.5,
  "maxTimeoutMs": 2400000
}
```

Every failed reviewer invocation — timeout, provider 5xx/network error,
ref-mutation rejection, or invalid/unparseable JSON — is retried automatically
up to `maxAttempts`, with exponential backoff between attempts and the
per-attempt timeout escalated by `timeoutEscalation` (capped at
`maxTimeoutMs`). A `skipped` status (missing binary or credential) is
structural and is not retried; under `all-required` it still fails the
council. When any required reviewer is still not `completed` after its
retries, the run emits **no verdict** (`verdict: null`), reports each broken
reviewer with its attempt count, and exits non-zero. The wrapper must then
re-run the review command, repair the binding via `cez-setup-harness`, or
stop for the user's explicit decision — a partial council is never a usable
result.

The runtime invokes every reviewer listed by the selected profile. The
staged wrapper starts a genuinely fresh Claude context running
`cez-code-review` and the bound provider council concurrently. The runtime gives
every configured advisor the same complete `cez-code-review` rubric, resolved
packet, and subject, waits for Claude's hash-matched artifact, and emits no final
result when that artifact is invalid. With the bundled
five-model jury, `multi` therefore means fresh Claude plus Codex, DeepSeek,
Kimi, GLM, and MiMo in one result matrix — all five must complete. Claude is
mandatory and separate from the provider policy.

The runtime validates references between profiles and models. A model can be a
worker only when it declares the `worker` role, uses a command adapter, and
provides a `workerSecurity` contract whose runtime-recognized adapter-enforced
network, remote-write, and ref-write capabilities are all disabled. Version 1
accepts only the audited `codex-workspace-write-sandbox` command shape. Worker processes
also receive a credential-scrubbed environment with Git protocols and
credential helpers disabled; the runtime rejects any ref or reflog change.

## Profile semantics

- `standard` — the host implements, then a new Claude context performs
  `cez-code-review` without inheriting the implementation transcript.
- `optimized` — configured workers receive bounded implementation packets.
- `multi` — fresh Claude and every configured reviewer independently apply
  `cez-code-review` to the root-cause/spec artifact and final diff.
- `multi-optimized` — combine both axes; a reviewer from the worker's model
  family is a self-check rather than an independent family.
- `high-assurance` — run manifest-defined packets with path leases, blind
  risk-scaled reviews, fresh finding verification, a separate fixer context,
  bounded retry and input budgets, and a deterministic evidence gate. Low and
  medium risk require one independent reviewer by default; high and critical
  risk require two reviewers from two independent model families.

Profiles describe roles, not vendors. Users may bind any supported model to any
role that its adapter can safely perform.

`packetPolicy` is opt-in. Existing profiles and existing repository configs keep
their prior behavior when it is absent. `concurrency.reviewers` bounds parallel
reviewer invocations (workers, fixers, and heavy validation are always serial in
version 1); it does not authorize writes to overlapping paths. `budgets` limit
worker, reviewer, and fixer invocations plus total review input bytes so retry
loops terminate predictably.

Version 1 serializes packet workers, fixers, and heavy validation in one
integration worktree while parallelizing blind reviewers. This avoids
misattributing concurrent filesystem writes. Path leases are repository-global
and make later isolated-worktree worker parallelism an additive extension.
