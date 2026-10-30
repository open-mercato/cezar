# LLM provider connections

## Contract

An agent runner and an LLM provider are separate choices. Existing native agent
configuration remains the default, including subscription/OAuth accounts and
externally managed native configuration. Saving an API key never changes that
choice. New task and Continue offer an explicit provider connection and models
from that provider. The existing agent setup is labelled “Default”. The provider picker is hidden
when no usable connection exists for the chosen agent, unless the task already
references a connection (including one that was removed).

Connections have immutable UUIDs, names, API base URLs and wire protocols.
OpenRouter is a preset; custom endpoints implement OpenAI Chat Completions,
OpenAI Responses or Anthropic Messages and `/models`. Claude Code requires
Anthropic Messages, Codex requires Responses; OpenRouter supports their native
compatibility endpoints. Pi, OpenCode, Copilot and Junie support their native
custom-provider configuration. Cursor retains native authentication only.

## Ownership and security

Public connection metadata lives in the existing optional workspace config.
Keys use the existing encrypted SecretStore, workspace scope and `cezar`
audience; check steps do not receive them. The API accepts keys on create but
never returns them. The existing same-origin request guard protects writes,
including hosted mode, like the workspace-secret routes. Keys are resolved only
for the explicitly selected agent invocation, never added to process.env or
stored on task records. RunStore registers the selected key for transcript
redaction before launching. API errors do not echo upstream bodies.

Task records and steps persist the selected connection UUID, with no key.
Missing/deleted providers or unreadable keys fail closed. An explicit provider
change starts a fresh native session with Cezar's portable conversation context;
it cannot resume a session owned by another connection. Dispatch inherits a
connection only for the same runner. Naming uses the selected connection too.
API authentication failures do not invalidate unrelated native subscriptions.

Provider routing uses isolated native configuration under Cezar's private home,
with environment references instead of credential literals. No native login is
overwritten. Catalog GETs have a timeout, bounded streamed bodies, per-connection
caches and no redirects. URL credentials, query strings and fragments are
refused. Custom URLs are explicit user-directed requests, including local
inference servers. OpenRouter omits models known to lack tool calling.

## Terminal and deployment

`cez llm-providers` manages the same connections without a server. API keys are
accepted only on stdin. `exec` launches a native interactive CLI with the same
routing used by tasks. Terminal takeover commands contain connection references,
never keys. The schema and routing work identically in local and hosted Cezar;
OS terminal launching remains subject to the existing local-handoff gate.

There is no required migration or new environment switch. Old tasks remain
native. Deploy the normal Cezar release; no platform deployment files belong in
this repository. Downgrading ignores the new optional fields, so tasks using an
API connection must not be resumed on an older release. External agent wrappers
must honor or explicitly refuse the supplied routing: Cezar does not bypass
hosting/billing policies or invoke private `.real` binaries.

## Verification

Cover encrypted persistence and audience separation, selected-provider discovery,
protocol compatibility, native defaults, model-ID preservation, provider-bound
session continuation and safe terminal commands. Use fake keys and local test
endpoints; real provider inference requires separately supplied credentials.

API-bound tasks can only start immediately until deferred execution pins provider
ownership. Scheduling rejects them instead of dropping the selected connection.
