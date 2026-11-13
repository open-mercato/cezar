# Independent Telegram, Slack and Discord extensions

Status: implemented (2026-11-13). Code: `packages/chat-plugins/{telegram,slack,discord}`,
`packages/cezar/src/extensions/delivery-catalog.ts`, `chat-selection*.ts`, `project-runtime.ts`,
`manager.ts`, `host.ts`. Shared chat core: `2026-11-04-chat-providers.md`; the extension system
this builds on (worker host, install, approval, SDK versioning, trust model):
`2026-11-05-extension-system-design.md`.

## 1. Goal and boundaries

Telegram, Slack and Discord are three standalone extension packages running on the public SDK. The
same artifact can be installed from a folder or package and ships with cezar. Taking a package out
of the repository costs it no function and needs no import of private host modules.

Placements of panels and commands (`2026-11-07-extension-placements.md`) apply unchanged. Switching
implementation (shipped ↔ installed) keeps bots, pairings, permissions and receivers without a new
setup. Starting cezar never downloads packages from the registry.

Jira, Linear and webhooks are not extensions and work unchanged. How Settings → Extensions and
Settings → Integrations divide the work: `2026-11-03-integrations-gallery.md`. The relation to #1614
(integration providers), #1949 (communication channels) and Manager mode is in
`2026-11-05-extension-system-design.md` § Relation to other plans.

Out of scope, beyond what the extension system already excludes: package signatures, changes to
production secrets, delivery guarantees beyond what the platform gives. Trials on real accounts are
a separate activity.

## 2. Requirements

1. Three packages, each with an extension manifest, a build, its own dependencies, tests and a
   README; no imports of private cezar or the contract, and no paths into the monorepo.
2. A package installed outside the repository talks to cezar only through the public contract. The
   version shipped with cezar uses the same entry point and API.
3. Shipping with cezar is a host decision about the artifact's origin and trust, not a separate
   transport implementation or a private API.
4. Provider ids, state, bot leases, approvals, HTTP routes and UI paths mean the same regardless of
   the artifact's source. One bot has exactly one active receiving owner.
5. An extension has one management place in Settings → Extensions, and a connection one form in
   Settings → Integrations.

## 3. Division of responsibility

| Area | Adapter (extension) | Cezar host |
| --- | --- | --- |
| Platform protocol | HTTP, WebSocket, polling, reconnect, parsers, platform ACK | Limits and control of the adapter's lifetime |
| Events | Normalization to the public format, stable ids, ordering | Durable acceptance, deduplication, journal and checkpoint |
| Tasks | Passes the event on; renders the result | Pairing, person/chat grants, Confirm, project choice, execution |
| Credentials | Only authorized access for a specific bot/operation | Vault, secret scope, durable rotation, cross-process coordination |
| Process lifetime | Dispose, aborting I/O, reporting health | Restart/backoff, timeouts, fencing, one owner per bot, artifact leases |
| UI and installation | Declarative setup/presentation metadata | Extensions for packages, Integrations for project configuration |

The packages live in `packages/chat-plugins/<provider>` as separately buildable projects
(`@open-mercato/cezar-chat-<provider>`, extension ids `open-mercato.<provider>`). An extension's
logical identity is fixed and independent of where its artifact is installed. Code the adapters
share (`packages/chat-plugins/shared/`: pinned HTTP requests, adapter support) is copied into each
package (`shared/sync.mjs`), not imported from `packages/cezar`.

## 4. SDK contract

Schemas, signatures, limits and refusal cases: `packages/extension-sdk/src/chat.ts`.

### Receiving and durability

- One receive model: `receiveSession` for the declared `receiveModel` (`ordered` or `opaque`) —
  start, stop/abort, health and the host's confirmation of durable acceptance.
- The checkpoint belongs to the host. The adapter gets only its own cursor/epoch and an acceptance
  handle, never the `InboundStateStore`, grants or a path on disk.
- An event is durably accepted before the cursor moves; a failure between the two ends in a
  deduplicated replay. No result does not mean success; no timeout confirms data.
- Ignored, unsupported and no-effect events advance the checkpoint (Telegram may advance its offset
  without a synthetic user message). Epoch resets, invalid and out-of-order batches, partial
  confirmations and the queue limit are handled.
- The SDK accepts no raw platform updates: normalization happens in the package, and the host
  accepts semantic events.
- Slack and Discord have documented ACK/reconnect boundaries (`2026-11-04-slack-chat.md`,
  `2026-11-04-discord-chat.md`); there is no exactly-once guarantee and no durable replay from the
  platform.

### Credentials and Slack rotation

- `ChatBotServices.credentials.accessToken(slot, operation)` returns the current access token of
  the bound credential profile. The handle cannot name another project or vault key.
- The refresh token and client secret never reach the adapter. Rotation keeps the cross-process
  lock, the `pending` write before a single-use token is used, the `ready` write after the response
  and the refusal on an uncertain result (`2026-11-04-slack-chat.md` § Token renewal).
- The exchange profile is closed and host-owned (`slack-oauth-v1`), available through the public
  interface to any extension the user approved for it — with no condition on a specific
  `extensionId`. Destination, fields, redaction and response limits are fixed; there is no general
  HTTP proxy with vault access.
- **Why not plain `secrets.get/set`:** it would change secret exposure and lose the protection of
  single-use refresh tokens.

### Discord native commands and presentation

- `ChatInteractionContext.taskChoices(query)` is a narrow task-options service for the active
  interaction; the core authorizes the person, chat and project. The context is short-lived, bound
  to one event and cannot change the actor/project, bypass grants or start work. Limits on result
  count, length, time and rate apply on the host. Neither a broad `tasks.list()` nor `project.read`
  for adapters replaces it.
- Discord keeps the ACK/defer deadline and the interaction token's lifetime; executing the command
  comes back to the core as an event, with the same confirmations.
- Setup metadata, pairing links, command prefixes, button and text limits and message formatting are
  declarative (the manifest's `chatProviders`, the host descriptor). Rendering happens on the
  host/adapter side over bounded data the core approved; no extension code reaches React.

### Compatibility

- The manifest is parsed strictly: an older host may reject a manifest with a new field
  (BACKWARD_COMPATIBILITY.md §6b).
- The SDK is Node-free; adapters use Node and declare their own dependencies.
- Every operation (receive, secrets, ACK/defer, native commands, send) inherits
  `ExtensionChatOperationContext`: a validity check before the effect, abort, generation, timeout,
  limits and redaction.
- Adapter HTTP clients keep fixed hosts, DNS/address validation, the redirect policy, response
  limits, proxy and custom CA support (`shared/pinned-request.ts`).

## 5. Installation, trust and modes

One artifact resolver and one ordinary worker host. Cezar's delivery catalog
(`dist/chat-plugins/catalog.json`, built by `packages/cezar/scripts/build-chat-delivery.mjs`) maps
the `telegram`/`slack`/`discord` provider to a concrete manifest, version and digest; the host
verifies integrity before activation. Only this catalog grants a historical provider alias: a
package name grants no right to the alias or to an existing bot's secrets.

- A locally configured bot uses the verified artifact shipped with cezar, with no npm download. An
  external install goes through the standard preview and approval.
- Approval of the shipped integration does not authorize running any package with the same name.
  A change of source, digest or permissions requires a review and confirmation of the
  implementation choice (`/extensions/chat-selections/:provider/{preview,select}`).
- An explicitly selected installed version stays pinned; a cezar update does not overwrite it. The
  default artifact is pinned to the cezar release.
- Disable never starts a fallback that bypasses the user's decision. A missing or disabled selected
  installed version leaves the integration off until the source is chosen explicitly; it never
  activates the shipped version in the background. The dialog offers an explicit "Return to version
  shipped with Cezar" action that keeps pairings. Disconnect/reset are separate operations.
- `CEZ_EXTENSIONS=0`: installed extensions do not run, and the verified artifact shipped with cezar
  runs through the trusted in-process facade (`trusted-chat-worker.ts`) — the same package
  implementation and the same public services. A selected installed version then has no fallback.
  Notifications still need `CEZ_WEBHOOKS=1`, task control also `CEZ_CHAT_INBOUND=1`; without the
  flags there is no traffic.
- A hosted cockpit offers no chat. A dry run gets a blocked transport.
- When ownership changes, the old owner is stopped and ended before the next one starts; restart
  and fallback have time limits. Startup works with a read-only home, missing/damaged artifacts and
  redaction of incomplete diagnostics.

The navigation between Settings → Extensions and Settings → Integrations, the gallery's categories
and filter, and the legacy settings addresses are specified in `2026-11-03-integrations-gallery.md`.

### Mattermost

An example of an independent public-SDK package (`examples/extensions/mattermost`). It is installed
in Settings → Extensions, and its bot, channels, pairings and grants are configured through the same
Integrations flow as the other chat providers. It sends messages, polls channels through an
`ordered` session (one page per checkpoint), and passes commands and text confirmations to the
core, with a durable cursor, chronological handling, cancellation and documented polling limits. It
declares no panels and no commands with a `location`.

### Versioning and delivery

Adapter packages have their own semver versions; the manifest version equals the `package.json`
one. They are published in the release set after the SDK (`scripts/release.mts`,
`docs/publishing.md`); a host release neither bumps their versions nor overwrites a published
artifact. The cezar bundle points at the exact tested versions and digests:
`scripts/build-chat-plugins.mjs` builds the packages, and the host build stamps them into
`dist/chat-plugins` with their dependencies, without rewriting code for a private API. The digest is
computed after every build step. An offline install needs no hoisted host dependencies.

## 6. State on disk

Identities a change of artifact source does not re-key:

| Resource | Identity / path |
| --- | --- |
| Bot state | `.ai/cezar/webhooks/chat/<provider>/<bot>.json`; dry run separately; non-numeric bots get an encoded file name |
| Cross-process ownership | `~/.cezar/chat/<provider>/bots/<botId>/{owner.lock,binding.json}` via `cezarHomeDir()` |
| Receivers | `.ai/cezar/webhooks/endpoints.json`, receiver id, `.v1` format, revision and delivery test |
| Secrets | Project vault, audience `cezar`, `WEBHOOK_CHAT_*` references; never in extension settings |
| Slack rotation | `SLACK_ROTATION_*` in the vault and `~/.cezar/slack-token-locks/`, `pending`/`ready` state |
| Implementation choice | `.ai/cezar/extensions/chat-selections/<provider>.json`; artifact leases in `~/.cezar/extensions/leases/` |
| Task history | `chatSource`, conversation contexts and correlations use provider ids |

Webhook-only Slack/Discord receivers (released in v0.17.0) stay such receivers. Installing a package
does not turn them into bots; upgrading to a bot needs a delivery test and keeps the receiver id.

Switching a bot's implementation: under the current lease, read the state and check the artifact's
and SDK capabilities' compatibility; pause new operations, cancel pending ones, stop receiving and
flush the journal (never two receivers in parallel); start the new owner with the same lease key
and resume from the host checkpoint. A failed activation ends the new owner; confirmed messages do
not run again.

An artifact rollback does not roll back the outside world: it does not restore a spent refresh
token, checkpoints or executed tasks. Older package code must handle the current state, or the
integration stops with repair instructions.

## 7. Tests and proof of independence

1. **Statically:** packages import neither private cezar, the contract, the api-client nor paths
   outside the package; the published tarball has no workspace/file dependencies.
2. **Outside the repo:** each package's `pack-smoke.mjs` packs the SDK and the adapter, installs
   them in a clean consumer and runs a real worker; `npm run test:package` checks packed cezar with
   the adapters against local platform simulators.
3. **Conformance:** the shared suite `chat/test-support/conformance.testkit.ts` through the real
   adapter; `npm run test:chat-plugins` builds and tests each package (`node:test`).
4. **Failure and state:** kill before/after accept/checkpoint, a partial batch, a missing/late ACK,
   IPC timeout, a blocked worker, a partial secret in stderr, disable/revoke during I/O, concurrent
   install/update/uninstall, artifact leases, read-only/corrupt home, token rotation.
5. **Authorization:** a foreign person/chat/project, a copied callback, reuse/expiry, missing
   permissions. Platform data is untrusted.
6. **UI/e2e:** the simulated browser suites `packages/web/e2e/{telegram,slack,discord}-*`,
   `extensions` and `integrations-section` (install, setup, restart, command, refusal, update,
   implementation choice, disable, uninstall, navigation between Extensions and Integrations, old
   links). Run manually with `npm run test:e2e:runner` before a release, not in CI.

Tests use an isolated `CEZ_HOME`, synthetic secrets, a time limit and an external-network block.

## 8. Risks and limits

The main risks: growing the SDK around one platform's details, exposing refresh secrets, losing an
update when the cursor changes, changing the dedupe/lease namespace, Discord's deadline, implicit
activation after disable, a rollback that undoes a spent secret; in the UI, confusing a global
install with a project connection and hiding a connection that needs repair. The shared contract
and the tests above contain them.

Rule: a change that needs a private import, a weaker grant, moving the checkpoint before accept,
handing a refresh token to the worker or breaking a working `CEZ_EXTENSIONS=0` scenario is a signal
to fix the contract, not an exception for an "official" extension.
