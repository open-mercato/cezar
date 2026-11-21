---
name: cez-harness
description: Internal runtime for cezar's staged multi-model workflows: Git integrity, staging and structured review councils. Cezar owns orchestration and writing sessions. Never use this runtime to commit, push or publish.
---

# Cezar harness runtime

Use through cezar's phase driver or `cez-setup-harness`. Writing roles are selected
in the cockpit; this runtime accepts reviewer adapters only.

## Commands

Run `node scripts/harness.mjs <command> ...` from this directory. Execution uses
an explicit trusted config snapshot; setup alone may edit the working-tree config.

- `configure --config <path> --input <path>` validates an `agentHarness` object and merges it into the config, preserving other keys.
- `validate-config --config <path>` validates reviewer bindings and council profiles.
- `resolve-profile --config <path> --profile <name>` prints a runtime reviewer group, not a cezar run lineup.
- `probe --config <path> --profile <name>` checks reviewer binary/credential availability. This is not proof of a successful model round-trip.
- `review --config <path> --profile <name> --worktree <path> [--artifact <path> | --paths-file <path> | --diff-range <range>] --criteria-file <path> --output-dir <path> [--prompt-dir <path>]` invokes selected advisors against one subject and aggregates their results.
- `capture --worktree <path> --output <path>` records HEAD, the task branch ref and their reflogs.
- `verify --worktree <path> --start-state <path>` reports drift without staging.
- `stage --worktree <path> --start-state <path> --paths-file <path>` stages an allowlisted handoff after verifying Git integrity.

## Contracts

Read `references/configuration.md` and `references/adapter-contract.md` before
configuring models. Read `references/code-review-contract.md` for council inputs,
`references/reporting.md` for results and `references/stage-only-contract.md` for
the handoff. JSON artifacts are authoritative; do not reconstruct provenance from
model prose.

## Rules

- Require `delivery.mode: "stage-only"`. Never commit, push, publish or mutate tracker state.
- Pass configured commands as argument arrays, never through a shell.
- Use trusted snapshots for commands, endpoints and credential-variable names. Never trust task-branch replacements.
- Keep credentials out of configuration, prompts and artifacts.
- Run reviewers with publish credentials removed and reject worktree, index, ref or reflog changes.
- Give every advisor the same rubric, criteria and subject in a fresh invocation. Do not expose peers' output before reconciliation.
- Preserve minority findings. Derive verdicts from finding severity, not a model's approval label.
- Never treat a model's claim of passing tests as validation evidence.
- Leave agent sandboxing, session lifecycle, retry decisions and publication gates to the cezar conductor.
