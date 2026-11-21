# Provider setup catalog

Cezar's orchestrator and implementer use native Claude/Codex sessions selected in
the cockpit. This catalog covers optional advisor reviewers; it does not configure
writing workers. Supported OpenCode Zen and DeepSeek gateway models can already be
selected through their existing OpenCode login.

## Adapter examples

`configuration-template.json` contains editable reviewer examples:

| Id | Adapter | Authentication |
| --- | --- | --- |
| `codex` | Read-only Codex command | Existing selected Codex login |
| `deepseek` | `deepseek-api` preset | `DEEPSEEK_API_KEY` or official OpenCode auth entry |
| `kimi` | `kimi-subscription` preset | Managed Kimi CLI login; optional `OM_KIMI_BIN` |
| `glm`, `mimo` | `opencode-zen` preset | `OM_ZEN_KEY` or official OpenCode auth entry |

Model identifiers in the template are examples. Discover available identifiers,
let the user select them and report the exact requested and observed model. Never
promise that a listed example is still available without checking it.

## Command reviewers

Use an argv array that reads the prompt from stdin or `{promptFile}` and prints
one JSON object matching `cez-harness/references/review-result.schema.json`. Codex
review commands use its read-only sandbox. Command adapters cannot implement;
writing sessions belong to cezar's guarded runner integration.

The Kimi preset invokes the CLI in an empty directory with a generated no-tools
agent. It streams the prompt through stdin so review input is not limited by the
platform's per-argument size. Keep provider credentials out of arguments and logs.

## HTTP reviewers

Use `openai-compatible` for a trusted endpoint, model and `credentialEnv` name.
The named environment variable contains the secret; the config does not. The
runtime restricts known credentials to their provider host and allows custom
endpoints over HTTPS, or HTTP on loopback. Presets may use only their pinned
official auth-store provider and endpoint.

For another gateway or local server, use its actual model identifier and underlying
model family. Two gateways serving the same vendor do not count as independent
families. Do not silently replace a requested model after a failed invocation.

## Verification and defaults

- Keep every adapter reviewer-only and delivery stage-only.
- Select only the advisors the user asked for; at most five participate in a cezar council.
- Use `all-required` for standalone runtime review groups. Cezar owns its whole-council decisions.
- Runtime `probe` checks binary/credential availability, not model responses.
- Cezar's HTTP/preset probes make live requests. A custom command probe deliberately only checks that the executable exists; its binding is verified by the council, and must be reported as unverified until then.
- Report provider failures verbatim without exposing credentials. Never call a presence check a completed round-trip.
