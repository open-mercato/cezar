# Reviewer configuration

Store optional advisor definitions in `agentHarness.models` within
`.ai/agentic.config.json`. Cezar chooses writing roles from each submitted lineup;
configured workers, packet policies and named implementation profiles are unsupported.

Execution reads a trusted snapshot. Setup can edit the working-tree config, and
standalone runtime commands may accept a trusted `--user-config` overlay. Never
load executable settings from a model-modified task branch or store secrets here.

## Runtime shape

```json
{
  "agentHarness": {
    "version": 1,
    "delivery": { "mode": "stage-only" },
    "models": {},
    "profiles": {
      "multi": {
        "reviewers": [],
        "maxParallel": 5,
        "maxInputBytes": 180000,
        "reviewPolicy": { "mode": "all-required" }
      }
    }
  }
}
```

`models` maps identifiers to reviewer adapters. The setup template provides
examples; select only the bindings the user wants. Each model has exactly the
`reviewer` role. The runtime rejects worker commands and unused profile settings
(`workers`, `concurrency`, `packetPolicy`) instead of accepting inert configuration.

A runtime profile groups reviewers for one council. Cezar synthesizes
`cez-role-council` from the selected pending advisors and does not copy unrelated
models or profiles into that invocation. It does not resolve configured profiles
as task lineups. `maxParallel` bounds concurrent advisors; `maxInputBytes` bounds
parts of a large subject. Results union findings across parts.

## Review policy

- `advisory`: report available results, including missing reviewers.
- `quorum`: require `minimumSuccessful` completed reviewers and `minimumFamilies` distinct model families.
- `all-required`: require every selected reviewer, or the `requiredReviewers` subset. Missing required results produce no verdict and a nonzero exit.

Model families describe underlying vendors, not gateway names. Cezar separately
enforces the whole run's council quorum, including runner-backed reviewers, and
records explicit operator decisions when proceeding with reduced quorum.

## Retry policy

Standalone runtime calls can configure `retry`, with per-profile overrides:

```json
{
  "maxAttempts": 4,
  "backoffMs": 5000,
  "backoffMultiplier": 2,
  "timeoutEscalation": 1.5,
  "maxTimeoutMs": 2400000
}
```

Failed invocations retry within those bounds; missing bindings are skipped rather
than repeatedly invoked. Cezar sets the runtime to one attempt because the driver
owns retries, recovery and billing records. Never silently replace a failed model
or change council policy.

Credential-variable names and endpoints are checked together. Official auth-store
endpoints are pinned in the runtime; changing a preset endpoint requires changing
the runtime and setup template together. Credentials never belong in JSON.
