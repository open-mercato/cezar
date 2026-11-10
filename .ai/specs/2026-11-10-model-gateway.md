# Model gateway — one API key, many models, on OpenCode

Status: implemented (2026-11-10). Owner decision recorded below.

## Problem

A user with a key for a service that sells many models — OpenRouter, or the team's own
OpenAI-compatible API — wants to paste it once and code with those models. cezar is not a harness,
so the models must run on an agent CLI; OpenCode speaks to any OpenAI-compatible endpoint.

OpenCode's own login cannot carry this: `opencode auth login -p <id>` knows only its built-in
provider catalog (`Unknown provider "acme"`), and its "Other" path fails in 1.19.5. So cezar keeps
the key.

## Decision (owner, 2026-11-10)

cezar stores ONE gateway key and hands it to OpenCode's processes — runs, Continue, naming and
`opencode models` — and to nothing else. This is a deliberate exception to "an agent is never an
audience" (spec 2026-10-10-project-secrets-vault-options): it does not widen the user-secret
audiences; the gateway lives in its own managed record.

What an agent can do with it: anything in a process's environment is readable by that agent's own
tools, so a tool call could print the key. That is the same exposure OpenCode's own stored keys and
Claude Code's `ANTHROPIC_API_KEY` already have. Use a key with a spending limit.

## Shape

- **Storage.** `~/.cezar/model-gateway/gateway.vault`, `0600` in a `0700` dir, sealed with
  `SecretStore.sealManaged('model-gateway', …)` under the secrets data key (keychain, else file).
  The data-key recovery path counts it as ciphertext, like tracker connections.
- **Presets.** `openrouter` (OpenCode already knows it: the run gets `OPENROUTER_API_KEY`) and
  `custom` (any OpenAI-compatible base URL: the run gets `OPENCODE_CONFIG_CONTENT` declaring
  provider `<slug of name>` with `@ai-sdk/openai-compatible`, `baseURL`, `apiKey:
  "{env:CEZAR_MODEL_GATEWAY_KEY}"` and its models, plus that variable). The runner merges private
  MCP servers and read-only mode on top. A team's own API is one more preset row.
- **Checked on save.** OpenRouter: `GET /api/v1/key`. Custom: `GET {baseUrl}/models` with the key,
  which also supplies the model list when none is given. A refusal is a `400` with one sentence,
  and nothing is stored.
- **Status.** An installed OpenCode with a gateway reports `connected`; a missing one stays
  `not-installed`. Saving or removing refreshes provider status and drops OpenCode's model catalog.
- **Redaction.** The key is registered as a run secret for every OpenCode session.
- **API.** `GET/PUT/DELETE /api/v1/workspace/model-gateway` (BACKWARD_COMPATIBILITY.md §2). The
  key is write-only.
- **Cockpit.** Settings → Agents → Model gateway, and a "Use an API key" row on the first-run agent
  step that installs OpenCode after the key is saved when it is missing.

## Zero config

Nothing changes until a user saves a key: no gateway, no env, no request.
