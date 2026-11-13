# Authoring an extension

Create a separate ESM package with `@open-mercato/cezar-extension-sdk` as its only Cezar
dependency. Build before installing a local folder; a plain `npm install` is fine, the
`node_modules/.bin` command links it creates are left out of the installed copy (any other
symbolic link is refused). Never import Cezar's private contract,
API client, server or React components. The SDK tarball includes its own runtime and types.

Add `cezar-extension.json` with `id`, `name`, exact `version`, `apiVersion: "0.1"`, `entry`,
`capabilities`, `permissions` and `contributes`. See the two [examples](../examples/extensions).
`capabilities` is required; list what the extension contributes and use `[]` if it contributes
nothing. Unknown capabilities and permissions fail validation. Supported capabilities are
`commands`, `panels`, `taskEvents`, `forms`, `settings`, and `chatProviders`. Capabilities are
declarations shown on the consent card; `permissions` are the boundary the host enforces.

Export `defineExtension({ activate(context) { … } })`. Return a disposable which releases
subscriptions and resources. Register only declared contribution IDs:

```ts
context.commands.register('refresh', async () => ({ message: 'Refreshed' }))
context.panels.register('summary', async () => ({
  id: 'summary', title: 'Summary',
  blocks: [{ type: 'text', text: 'Plain text only' }],
  actions: [{ id: 'refresh', label: 'Refresh' }],
}))
```

The permissions are `project.read` and `task.create`; each gates a host API below.
`tasks.list()` needs `project.read` and returns the 500 newest
tasks. `tasks.propose({title,prompt,
workflow?})` needs `task.create`; its receipt always has `accepted: false`. Proposals returned
by a command are offered as links to the normal new-task confirmation form. No direct launch
API is available. Task events are informational, bounded and may emit `resyncRequired`; reload
the snapshot after that signal. They are not an automation delivery queue.

`storage.get/set` accept JSON keys/values in this extension/project namespace, at most 1000
keys and 4 MiB in total; a `set` past either limit rejects and keeps the stored values.
Stdout carries the host's IPC, so `console.*` and anything your code or a dependency writes to
`process.stdout` goes to stderr instead. The host prints the end of stderr if the worker crashes.
`secrets.get/set` use Cezar's encrypted project secret store. Do not put secrets in storage, output,
exception messages or environment variables. Known values are redacted, but the host cannot
recognize arbitrary encodings of a secret. `logger.info/error` are redacted too.

Declare forms under `contributes.forms`, with `id`, `title`, `commandId` and `fields`.
Fields have a `key`, `label`, `type` (`text`, `password`, `number`, `boolean`, `select`),
optional `required`, and `options` for selects. Register an optional dynamic provider with
`context.forms.register`; it may return saved `values`. Password defaults are withheld.
Submission validates the manifest's fields before invoking the declared command; save settings
through storage/secrets from that handler. No executable validator, HTML or React crosses IPC.

For chat, declare `contributes.chatProviders` (see Mattermost) and register a factory with
`context.chat.register(id, credentials => adapter)`. The adapter implements identify, inspect,
send, clearButtons, acknowledge, isMember, receiveSession and optional dispose. Credential fields are
secret by default; mark a public server URL `secret: false`. The provider's required HTTPS
`discoveryUrl` is the cockpit's setup help link, and the base of the pairing link when
`identify()` returns none. Identity may return its own HTTPS `discoveryUrl` (for example the
bot's page on a self-hosted server), which wins. The host adds the one-time pairing code.

An extension cannot claim the canonical Telegram, Slack or Discord IDs on its own:
`telegram`, `slack`, `discord`, `telegram.v1`, `slack.v1` and `discord.v1` are reserved. Use a qualified provider ID such as
`mattermost/chat` for an external provider. Cezar ships the same public SDK artifacts as the
standalone Telegram, Slack and Discord packages. Verified delivery metadata grants the canonical IDs;
a compatible installed replacement needs explicit project selection and approval. Installing a
package alone cannot take over a configured bot. Selected installed artifacts pin an exact version
independently of host updates; disable/uninstall never falls back to shipped code. Shipped versions
update with Cezar. Local `CEZ_EXTENSIONS=0` permits only verified shipped artifacts through the
trusted in-process facade; hosted mode runs no chat adapter unless
`CEZ_REMOTE_EXTENSIONS=1`. See [extensions](extensions.md).

Direct cockpit tarball installation is unsupported; use a built folder with runtime dependencies
or an available npm package version.

With `receiveModel: "ordered"`, read `session.checkpoint()` and accept deliveries in ascending
`sequence` order from its `nextSequence`; `sequence` is a nonnegative safe integer, and event IDs
must remain stable. A platform timestamp is not necessarily a sufficient cursor: if many events
share it, returning the same first page forever prevents progress. Use durable pagination and,
where necessary, synthetic increasing sequences (the Mattermost example does both). The host
advances the checkpoint only after `ChatInbound` durably accepts each delivery; core event-ID
claims prevent duplicate effects on replay. Event timestamps are Unix **milliseconds**. Abort
outstanding network requests in dispose. Do not implement task authorization or
launching in the adapter: pairing, grants, deduplication and task confirmation belong to Cezar.

Chat adapter methods also accept an optional final `ExtensionChatOperationContext`
(`dispose` is unchanged). After asynchronous preparation, await
`operation?.assertActive()` immediately before each external effect, then call
`operation?.signal.throwIfAborted()`. Forward the signal's abort event to the
`AbortController` used for your HTTP request, and remove the listener in `finally`.
The SDK exposes a structural signal type so authors do not need Node or DOM types.

This is cooperative cancellation: an adapter that ignores the context cannot stop its
pending sends after revocation. A request already sent to a remote service cannot be
undone by aborting locally; its result may be uncertain. This context is neither a sandbox
nor permission for unsolicited requests.

RPC limits: activation 10 seconds, shutdown 5 seconds, ordinary calls 30 seconds, frames 1 MiB,
100 pending calls. A worker receives minimal environment and cannot select its host project.
Every request is generation-fenced. `ExtensionChatError` carries a bounded transport failure
when authentication, rate limiting or provider availability needs specific handling.

Registry installs are resolved by cezar itself, not by `npm install`: npm only supplies your
`registry` and `@scope:registry` settings, and a scoped package is fetched only from its scope's
registry. Proxies, auth tokens and git/URL/file dependencies are not supported, so private
registries that need a token are unavailable. Dependencies requiring install scripts and
symlinked artifacts are rejected. Packages flagged `hasInstallScript` (including a `binding.gyp`-only
native build) are refused, and so is any scope whose registry URL embeds credentials — use a URL
without them; that scope is never fetched from the default registry. Updates are explicit. Keep activation idempotent,
and limit migrations to local extension-owned state so rollback can restore it.

Task proposals must be awaited inside a command invocation. Each invocation returns only its own proposals; a failed command discards them. Calls from activation, task events, chat callbacks or work continuing after the command returns are rejected. The user still reviews the normal new-task form before launching anything.

## Where contributions appear

By default every panel and command renders in Settings → Extensions. An optional `location`
on a declared panel or command moves it to where the user works:

```json
"contributes": {
  "panels":   [{ "id": "summary", "title": "Project summary", "location": "sidebar" },
               { "id": "task-notes", "title": "Notes", "location": "task" }],
  "commands": [{ "id": "refresh", "label": "Refresh summary", "location": "palette" },
               { "id": "summarize", "label": "Summarize this task", "location": "task" }]
}
```

- Panel locations: `settings` (default), `sidebar` (a collapsible section under the sidebar
  project's areas, above Current tasks) and `task` (a card in the task workspace's **Extensions** view). Command locations:
  `settings` (default), `palette` (the command palette, shown as "<Extension name>: <label>")
  and `task` (a button in that same view). A panel's action buttons have no `location`; they
  run the declared command where the panel is.
- Limits per extension: 3 `sidebar` panels, 5 `task` panels, 20 `palette` commands.
- A `task`-located panel provider receives `{ runId }` and a `task`-located command receives it
  as `input.runId`; both are asserted by the host for the task the user is looking at. Load the
  task with `context.tasks.get(runId)` (needs `project.read`; returns `null` when the run is not
  in this project — it is the same shape as one `tasks.list()` item). Sidebar, palette and
  Settings calls pass no task.
- Panels are pulled, never pushed: the cockpit calls your provider when it shows the panel,
  after one of its actions runs, and when the extension's state changes. A `task` panel is also
  re-read when that task's status or step changes, and a `sidebar` panel when any task in the
  project starts or changes status (both about a second after the change settles). A worker
  cannot ask for a refresh, so render what is true at call time.
- Everything else is the same declarative renderer, the same permissions and the same
  worker. Nothing here grants new trust, and a hosted cockpit shows none of these surfaces
  unless it was started with `CEZ_REMOTE_EXTENSIONS=1`.
- Chat providers have no `location`; they appear under Settings → Integrations only.

The [project-summary example](../examples/extensions/project-summary) uses every placement
(its `test/` drives each one through a fake host), and the snippets above are checked against
the SDK types by that example's build.

## Versioning

`apiVersion` is the compatibility contract between an extension and the host, separate from
the npm versions of the SDK or your package. The SDK exports the accepted list as
`EXTENSION_API_VERSIONS` and the current value as `EXTENSION_API_VERSION`; today both are
`0.1`.

- The API stays at `0.1` until 1.0. Changes inside `0.1` are additive: new optional manifest
  fields, new capabilities or context methods. Existing manifests and adapters keep working.
- A breaking change gets a new `apiVersion`. A host lists every version it still runs, so a
  release can accept both the old and the new value for a transition period.
- The SDK package is released in lockstep with cezar, so its npm version follows cezar's.
  Depend on it with `>=0.1.0 <1.0.0` (as the examples do); the `apiVersion` you declare,
  not the SDK version, decides whether a host accepts your extension.
- A host that does not support a manifest's `apiVersion` rejects the install with a
  validation error. A stored record with an unsupported `apiVersion` (for example after
  downgrading cezar) is unreadable: it is shown as Failed, never started, and kept in the
  registry until a reinstall replaces it. Reinstall the extension from its source after
  upgrading again; its storage and secrets are kept unless you uninstalled with data removal.
- Uninstalling and keeping data leaves the extension listed as **Missing**, without actions, in
  every project that had approved it; uninstalling with data removal also drops that entry unless
  a chat selection or webhook receiver still names the extension. Reinstalling brings it back
  disabled, pending approval.

### Long-lived chat receivers

Every chat declaration selects `receiveModel: "ordered"` or `"opaque"`, and the host calls
`receiveSession(session)`. The session survives the ordinary 30-second RPC deadline.
Stop aborts it and waits for drain; an unresponsive worker is terminated before
replacement. Each individual host service request remains bounded.

Ordered deliveries use the host's epoch and next sequence. An omitted event is a
checkpointable no-op. Acceptance resolves after journal persistence; a rejected
or uncertain response must never be treated as an acknowledgement. Telegram uses
its native update offset and a six-day idle reset. Opaque deliveries use the core
inbox's bounded received claims; this does not promise replay of lost socket frames
or exactly-once effects. Explicit command classification, pairing eligibility,
chat titles and membership destinations are carried by the session mapper.

With the optional `slack-oauth-v1` credential profile the factory receives an empty credential
record and scoped `services.credentials.accessToken(slot, operation)`. Refresh
tokens and client secrets stay in the host vault; no caller-supplied URL or vault
key is accepted. Adding the profile requires renewed project approval.

Receive sessions can open short-lived, single-query interaction handles for native task
choices. The host applies the same person, chat and project authorization as for messages and
checks it again after asynchronous work. Choices are limited to 25, queries to
128 characters, and lookup to one second. Transport plugins assert platform actor
identity; these handles are not a sandbox against malicious approved code.

A declaration can supply an HTTPS `pairingLink` template with `{username}` and
`{code}` placeholders. The host URL-encodes both values.
