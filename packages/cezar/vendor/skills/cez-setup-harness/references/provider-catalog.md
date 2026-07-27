# Provider setup catalog

This catalog is loaded by `cez-setup-harness` while detecting and binding
selectable workers and reviewers.

## Bundled cross-model jury

The setup skill ships these selectable bindings. Users may enable any subset or
add custom models without editing skill prose or runtime code.

| Id | Default binding | Authentication | Roles |
|---|---|---|---|
| `codex` | Codex CLI `gpt-5.6-sol` at `xhigh`, or a smoke-tested replacement | Existing Codex login | worker, reviewer |
| `deepseek` | `deepseek-v4-pro`, max reasoning | `DEEPSEEK_API_KEY` or OpenCode `deepseek` auth | reviewer |
| `kimi` | Kimi K3 managed model (`kimi-code/k3`), thinking enabled (K3 thinking runs at `max` effort — its only effort level today) | Managed Kimi subscription CLI | reviewer |
| `glm` | OpenCode Zen `glm-5.2`, max reasoning | `OM_ZEN_KEY` or OpenCode `opencode` auth | reviewer |
| `mimo` | OpenCode Zen `mimo-v2.5-free`, max reasoning | `OM_ZEN_KEY` or OpenCode `opencode` auth | reviewer |

Provider model ids may change. Treat these as versioned defaults: probe and
smoke-test them during setup, let the user override them, and record the exact
requested and observed model in every result.

## Adapter shapes

### Codex CLI

Probe with its version command. Bind the review command in read-only sandbox
mode and the worker command in workspace-write sandbox mode with network access
disabled. The version 1 worker binding must use the runtime-audited command
shape with ignored user config and rules, ephemeral state, no extra writable
directory, and `--cd {worktree}`. Pass `{model}` and `{promptFile}` as separate
arguments. It may serve as worker, reviewer, or both. If the installed version
cannot enforce those capabilities, keep it reviewer-only.

### Kimi CLI

Use the `kimi-subscription` preset. It locates `OM_KIMI_BIN`, the managed Kimi
installation, or `kimi` on `PATH`; invokes thinking mode in an empty directory;
and supplies a generated agent definition with no tools. Keep it reviewer-only.
The runtime delivers the prompt on standard input (print mode), so real review
packets are bounded only by `maxInputBytes` splitting, never by the platform
argv limit.
On K3, enabling thinking is maximum reasoning: `max` is the only effort level
the model exposes today, and the CLI has no separate effort control. When Kimi
ships `low`/`high` effort levels and a CLI knob for them, wire that knob into
the preset instead of recording a decorative config value.

### DeepSeek-compatible HTTP

Use the `deepseek-api` preset for the bundled model. It accepts the configured
credential environment variable first and the official OpenCode auth entry as
a local fallback. Custom DeepSeek-compatible endpoints use the generic
`openai-compatible` adapter. Keep both review-only.

### GLM-compatible HTTP

Use the `opencode-zen` preset with model `glm-5.2`. It accepts `OM_ZEN_KEY` or
the official OpenCode auth entry without exposing the key. Keep it review-only.

### MiMo-compatible HTTP

Use the `opencode-zen` preset with model `mimo-v2.5-free`. It shares the GLM
credential resolution and remains review-only.

## Bring your own reviewer

The bundled jury is a default, not a requirement. Any model can join the
council as a reviewer; the only fixed element is Claude as the host, because
the workflow starts in the Claude app and the mandatory fresh review is a
Claude artifact.

- **Any OpenAI-compatible endpoint** — bind through the generic
  `openai-compatible` adapter with `endpoint`, `model`, and a `credentialEnv`
  naming the environment variable that holds the key. This covers hosted
  gateways (OpenRouter, Groq, Together, Fireworks, Mistral, and similar) and
  local servers (Ollama, LM Studio, llama.cpp) alike.
- **Any locally installed CLI** — bind through the generic `command` adapter:
  an argv array that reads the prompt from stdin or `{promptFile}` and prints
  one JSON object matching `review-result.schema.json`.

Set `family` honestly per underlying model vendor — quorum independence counts
distinct families, so two gateways serving the same base model should share a
family. After adding custom reviewers, recalculate `minimumSuccessful` and
`minimumFamilies` from what is actually bound, and smoke-test each binding.
Custom models remain reviewer-only; workers require a runtime-audited sandbox
adapter.

Model identifiers and provider endpoints change independently of this skill.
Detect or ask for the current value instead of encoding it in skill prose.
Every worker binding must declare `workerSecurity` and match a
runtime-recognized provider or OS sandbox. Version 1 recognizes only
`codex-workspace-write-sandbox`; Kimi, GLM, MiMo, and other bindings remain
reviewer-only until an audited launcher is added. A prompt instruction or an
arbitrary `enforcedBy` string is not enforcement.

## Conservative defaults

- Host: Claude.
- Worker: Codex when its audited workspace-write command and chosen model pass smoke tests.
- Reviewers: every ready bundled advisor from a distinct family.
- `standard`: no external worker or reviewer.
- `optimized`: selected worker, advisory review policy.
- `multi`: every selected reviewer, all required to complete — the runtime
  retries failed invocations and a council missing any selected reviewer
  yields no verdict. The wrapper's fresh Claude `cez-code-review` result is
  mandatory and hash-bound but sits outside the provider policy. Every advisor
  receives the same full rubric and packet in a fresh invocation.
- `multi-optimized`: selected worker plus selected reviewers; the worker's family does not count as independent review.
- `high-assurance`: selected worker plus risk-scaled blind reviewers, fresh
  finding verification, a separate fixer context, path leases, explicit
  invocation budgets, and deterministic acceptance evidence. Default high and
  critical risk packets use two reviewers from two non-worker families.
- Maximum parallel reviewers: five.
- Timeout: ten minutes per invocation; the Codex binding ships with twenty,
  since `xhigh` reviews and worker packets on large diffs routinely exceed ten.
- Issue claim: hold while the staged branch awaits human review.

## Readiness table

Render this table after setup and doctor runs:

| Model | Adapter | Worker | Reviewer | Required | Probe | Notes |
|---|---|---:|---:|---:|---|---|
| `<id>` | `<adapter>` | yes/no | yes/no | yes/no | ✅ ready / 🟥 missing / 🟥 failed | `<reason>` |

The operational wrappers render the same probe data as a shorter per-run table
(model, binding, role, ✅/🟥 status) before invoking any model in a
non-`standard` profile.
