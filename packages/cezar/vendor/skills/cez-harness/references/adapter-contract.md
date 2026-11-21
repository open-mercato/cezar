# Model adapter contract

Load this contract before configuring or invoking reviewer adapters.

## Command adapter

Use a command adapter for a locally installed CLI. Define commands as arrays,
never shell strings:

A custom command adapter is reviewer-only. This example passes `validate-config`
as written:

```json
{
  "adapter": "command",
  "family": "example-family",
  "model": "example-model",
  "roles": ["reviewer"],
  "timeoutMs": 600000,
  "commands": {
    "probe": ["example-cli", "--version"],
    "review": ["example-cli", "review", "--model", "{model}", "{promptFile}"]
  }
}
```

Supported placeholders are `{model}`, `{reasoningEffort}`, `{promptFile}`,
`{schemaFile}`, `{worktree}`, and `{metadataFile}`. The runtime expands each
placeholder as one argument and launches the executable without a shell. It
also supplies the prompt on standard input.

A reviewer command must be read-only in the worktree; the runtime enforces this
by running reviewer commands with a credential-stripped environment, Git
protocols and credential helpers disabled, and by snapshotting the worktree,
index, refs, and reflogs around each invocation, failing the reviewer when any
of them changes. Writing sessions belong to cezar's guarded runner integration.

## Observed invocation metadata

A command adapter should write this trusted adapter metadata to
`{metadataFile}` or `OM_HARNESS_METADATA_FILE`:

```json
{
  "actualModel": "provider-observed-model",
  "provider": "provider-name",
  "fallbackReason": null
}
```

This file is separate from model-authored review JSON. When the adapter cannot
report observed metadata, the runtime leaves `actualModel` empty and marks
provenance unverified; it never copies the requested model into that field.

## OpenAI-compatible adapter

Use this adapter for review-only HTTP models:

```json
{
  "adapter": "openai-compatible",
  "family": "example-family",
  "model": "example-model",
  "roles": ["reviewer"],
  "endpoint": "https://provider.example/v1/chat/completions",
  "credentialEnv": "EXAMPLE_API_KEY",
  "timeoutMs": 600000
}
```

The endpoint and credential-variable name must come from trusted configuration.
The secret itself comes only from the named environment variable. All runtime adapters are reviewer-only.

## Built-in preset adapter

Use `adapter: "preset"` for the maintained jury bindings:

- `deepseek-api` — OpenAI-compatible DeepSeek review with environment or
  official OpenCode auth-store credentials;
- `kimi-subscription` — managed Kimi CLI review in an empty directory with a
  generated no-tools agent;
- `opencode-zen` — GLM or MiMo review through the OpenCode Zen chat endpoint,
  using environment or official OpenCode auth-store credentials.

Preset adapters are review-only and contain no publication or workspace tools.
Generic `command` and `openai-compatible` adapters remain the extension points
for models outside the bundled jury.

## Reviewer output

Return one JSON object matching `review-result.schema.json`. The runtime accepts
surrounding CLI noise only when it can unambiguously extract one valid object.
Malformed or empty output becomes an explicit failed reviewer status; it never
silently becomes a pass.

Every reviewer invocation is fresh and tool-free: it receives the installed
`cez-code-review` skill, full built-in checklist, structured output contract,
the council criteria, and its assigned subject part. It never receives
the conductor or worker transcript, implementer rationale, proposed fixes, or
another reviewer's output. The runtime records `freshContext: true` and the
`cez-code-review` rubric and subject hashes on each result.

## Availability and fallback

Probe before the run. Record selected, completed, skipped, failed, and timed-out
states separately, plus the attempt count when retries ran. Failed, timed-out,
and invalid-output invocations are retried per the configured `retry` block;
`skipped` (missing binary or credential) is structural and is not. Optional
missing reviewers do not fail an advisory profile; under `all-required` every
configured reviewer must complete. Never substitute another model silently.
When an invocation uses a fallback, record both requested and observed model
identifiers and the reason.
