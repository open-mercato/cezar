# Capability: agent-providers

Operators can choose and configure the provider methods each coding agent uses.

## Requirement: One auth method at a time

The system SHALL run a one-mode agent on exactly the method selected for it, and SHALL keep the other connected
methods signed in but unused.

### Scenario: Switching Claude to OpenRouter
- WHEN Claude has its subscription and an OpenRouter key connected, and the user selects OpenRouter
- THEN the next Claude run gets `ANTHROPIC_BASE_URL` and the OpenRouter key, and the subscription stays signed in

### Scenario: Removing the active method
- WHEN the user removes the key of Claude's active method
- THEN Claude shows "no credential" and no method is selected until the user picks one

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Detected logins count without setup

The system SHALL treat a vendor login that provider status already reports as connected, and a vendor key already
present in the host environment, as usable methods of that agent, without the user configuring anything.

### Scenario: Zero-config Claude
- WHEN Claude is signed in on the host and the user never opened Settings → Agents
- THEN Claude's subscription row shows as active, the composer offers Claude's models, and Start is enabled

### Scenario: Host key only
- WHEN pi has no login but `OPENROUTER_API_KEY` is set in the host environment
- THEN pi shows a read-only "OpenRouter · from host environment" row as connected, and runs behave as today

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Any combination of methods

The system SHALL let an any-mode agent use every connected method, and SHALL offer the union of their models,
each model tagged with the method that serves it.

### Scenario: pi with a subscription and OpenRouter
- WHEN pi has the Claude subscription and an OpenRouter key connected
- THEN pi's model list shows both groups, and a run on an OpenRouter model receives only the OpenRouter key

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Subscription runs never carry an API key

The system SHALL start a run whose method is a subscription with no cezar-held key and with that vendor's host
API-key and base-URL variables removed.

### Scenario: Host key present, subscription selected
- WHEN `ANTHROPIC_API_KEY` is set in the host environment and Claude's active method is its subscription
- THEN the Claude child process has no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL`

### Scenario: Nothing configured
- WHEN the user has never configured a method for an agent
- THEN that agent's child env is built exactly as before this change

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Keys are write-only and encrypted

The system SHALL store a typed key encrypted at rest and SHALL never return it over the API, only its last four
characters.

### Scenario: Reading a saved key
- WHEN the cockpit reads the agent-providers state after a key was saved
- THEN the response carries `keyHint: "…9662"` and no key value

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Models come from the endpoint

The system SHALL list an openrouter or custom method's models from `GET {base}/v1/models`. A method needs a
successful discovery before it can serve a model. If a later refresh fails, the last successful list stays
available and the catalog is marked stale.

### Scenario: A default model is no longer offered
- WHEN a refresh drops the model that is an agent's default
- THEN the composer preselects `auto` and the agent's row shows "no longer offered" next to the default

### Scenario: Custom endpoint unreachable
- WHEN a custom provider's first models request times out
- THEN the row shows the error and "Retry", the method offers no models, and runs cannot select it

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: A locked key store stops only the runs that need it

The system SHALL park a run whose method needs a cezar-held key when the key store cannot be read, and SHALL start
subscription runs normally.

### Scenario: Keychain locked
- WHEN the OS keychain is locked and a task starts on Claude via OpenRouter
- THEN the task parks with the keychain message, while a task on Claude's subscription starts

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Writes are local only

The system SHALL refuse every write to auth methods and keys when the cockpit is not local, and SHALL still
answer reads.

### Scenario: Paired phone adds a key
- WHEN a paired phone sends a key write
- THEN the server answers 409 and stores nothing

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Methods can be configured from a file or the CLI

The system SHALL accept a providers file at startup (`cezar serve --providers <file>`) and on demand
(`cezar providers apply <file>`), and single methods by parameters (`cezar providers set`). It SHALL save each
entry into the named agent's method in the agent-providers store, with the same validation as the API, and SHALL
never take a key value from the command line.

### Scenario: Startup with a providers file
- WHEN the user runs `cezar serve --providers providers.yaml` and the file sets Claude's `openrouter` method with
  `apiKeyEnv: OPENROUTER_API_KEY` and `active: openrouter`
- THEN Claude's OpenRouter method is stored with the key encrypted, it is Claude's active method, and Settings →
  Agents shows it marked "from providers file"

### Scenario: Inline JSON on npx
- WHEN the user runs `npx cezar-cli --providers '{"version":1,"agents":{"claude":{"active":"openrouter","methods":{"openrouter":{"apiKeyEnv":"OPENROUTER_API_KEY"}}}}}'`
- THEN the result is the same as passing that JSON as a file

### Scenario: Inline JSON carrying a key value
- WHEN the `--providers` value is inline JSON and an entry has `apiKey`
- THEN the apply is refused with "a key on the command line is visible in ps; use apiKeyEnv, apiKeyFile or --providers -"

### Scenario: One method by parameters
- WHEN the user runs `printf %s "$KEY" | cezar providers set codex custom --base-url https://llm.example.com --key-stdin --active`
- THEN Codex's custom method is stored with that base URL and key, it is Codex's active method, and its models are
  fetched before the command exits

### Scenario: Invalid file
- WHEN a providers file names a method the runner does not support, or a key source that resolves empty
- THEN nothing from that file is written, `cezar providers apply` exits non-zero naming the entry, and
  `cezar serve` logs the same error once and boots with the store unchanged

### Scenario: Re-applying the same file
- WHEN the same file is applied twice
- THEN the store ends in the same state, and methods the file does not name are left as they were

### Scenario: Key value on argv
- WHEN `cezar providers set` is given a key as a flag value
- THEN there is no such flag: the key comes only from `--key-stdin`, `--key-env <NAME>` or `--key-file <path>`

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md
