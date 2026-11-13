# Adding a local chat provider

Implement providers as public SDK extensions. Telegram, Slack and Discord live in
`packages/chat-plugins/{telegram,slack,discord}`; Cezar ships the same independently built
artifacts that can be installed separately. The host's native descriptors for those three
(`packages/cezar/src/chat/bundled.ts`) fix their canonical IDs, formats and presentation; they
are not the implementation template for a new transport.

## Read first

Read [authoring extensions](authoring-extensions.md), [extensions](extensions.md), and AGENTS.md.
The independent chat plugins spec (`.ai/specs/2026-11-09-independent-chat-plugins.md`) records the
delivery and selection design. Use the public packages and the
[Mattermost example](../examples/extensions/mattermost) as references.

## Boundary and lifecycle

Declare `contributes.chatProviders` and register an `ExtensionChatAdapter` through
`context.chat.register`. Implement identify, inspect, send, clearButtons, acknowledge,
isMember and the declared receive model using the public `@open-mercato/cezar-extension-sdk`.
Keep platform HTTP/socket parsing, reconnect and error classification in the package;
declare its runtime dependencies and host feature requirements.

The host owns consent, pairing, grants, Confirm, durable acceptance, deduplication, checkpoints,
bot leases, credentials and task effects. Never give an adapter a run store, project context,
vault path, command executor or agent environment. Slack rotation uses the public host credential
profile: refresh tokens and client secrets stay in the host. Software approval does not grant a
person permission to control tasks.

Honor operation cancellation and activity checks immediately before external effects; dispose
must stop receives and settle outstanding work before ownership passes to a successor. Every
adapter receives through `receiveSession` for its declared `receiveModel`, which supports
long-lived connections. Preserve stable event IDs and advance checkpoints only after durable host acceptance. Telegram uses native
ordered offsets/epochs, including eventless checkpoints. Slack and Discord socket claims are not
durable upstream replay guarantees; do not promise exactly-once delivery.

Keep IDs opaque strings and timestamps in milliseconds. Respect platform text/button limits,
escape markup, suppress unintended mentions and classify errors without leaking tokens.
Bot-connected replies and notifications use the shared host budget and receipt tracking.
Never fall back to a webhook send after a bot send fails: it would have no trustworthy bot receipt.

## Identity, state and selection

External providers normally use `extensionId/localId` and `extensionId/localId.v1`.
The canonical IDs `telegram`, `slack`, `discord` and their `.v1` formats are host-controlled:
a package name or manifest alone cannot claim them. Verified delivery metadata or an explicitly
approved project selection binds a public implementation to a canonical ID before chat storage
recovery. Boot chat and HTTP extension management share one manager.

Receiver IDs, pairings, grants, journals, vault records and bot leases belong to the canonical
provider, not to the selected artifact. Bot leases live under
`~/.cezar/chat/<provider>/[dry-run/]bots/<botId>/` and project journals under
`.ai/cezar/webhooks/chat/<provider>/`; changing the selected artifact neither moves these records
nor requires re-pairing. Keep **Enable task control for <name>** attaching a bot to an existing
receiver, and keep webhook-only receivers (`slack.v1`/`discord.v1` receivers from Cezar 0.19 and
earlier among them) working; do not introduce a second receiver or configuration form.

Install a candidate in Extensions, then preview and explicitly approve its project selection.
Installed selections pin the exact artifact across host and installation updates. Disable or
uninstall never silently selects shipped code. Returning to the shipped artifact is a separate,
explicit selection. Failed activation rollback restores code and approval metadata, never old
vault contents, rotation state, cursors or journals.

## Delivery and operating modes

`scripts/build-chat-plugins.mjs` builds the SDK and standalone packages, then
`packages/cezar/scripts/build-chat-delivery.mjs` copies the public artifacts into
`packages/cezar/dist/chat-plugins/<provider>/` and stamps `catalog.json`. The delivery loader
verifies artifact integrity and manifest/package identity before granting canonical IDs.
Adapter versions are independent of the host release. A distribution pins its shipped versions
and digests; shipped copies update with the host, not separately through Extensions. An explicitly
selected installed artifact stays pinned independently.

| Mode | Chat implementation |
| --- | --- |
| Local, extensions on (default) | Verified shipped public artifacts, or explicitly selected installed artifacts, through the ordinary extension worker host. Configured bots need no npm download or new installation. |
| Local, `CEZ_EXTENSIONS=0` | Only verified shipped public artifacts through the trusted in-process SDK facade; no child worker. Installed selections stay unavailable with saved metadata retained. |
| Hosted, `CEZ_REMOTE_EXTENSIONS=1` | Same as local with extensions on: shipped or selected installed artifacts through the extension worker host. Everyone the reverse proxy admits can install, enable and select chat sources. |
| Hosted (default) | No chat adapter. Extension inventory is hidden; install/enable/disable/invoke and chat selection are refused. |
| Dry-run / explicitly injected test transports | Deterministic mock/test seams, not live-platform evidence. |

Chat remains opt-in: `CEZ_WEBHOOKS=1` enables receivers/setup and `CEZ_CHAT_INBOUND=1` enables
task control. Missing, tampered, disabled or failed selected artifacts never silently fall back
to another implementation. The facade accepts only verified shipped artifacts,
not arbitrary installed code. Workers contain failures but are not a security sandbox: they run
as the Cezar user with that user's filesystem and network access.

## File map and configuration

| File or folder | Responsibility |
| --- | --- |
| `packages/chat-plugins/<provider>/` | Standalone package, manifest, public SDK adapter, platform tests and pack smoke. |
| `packages/extension-sdk/src/` | Public schemas/context and adapter types; keep additions compatible with API `0.1`. |
| `packages/cezar/src/extensions/delivery-catalog.ts` | Verify host-delivered artifacts and canonical identity. |
| `packages/cezar/src/extensions/manager.ts`, `project-runtime.ts` | Project selection, approval, activation and runtime ownership. |
| `packages/cezar/src/extensions/trusted-chat-worker.ts` | Verified shipped-only in-process facade. |
| `packages/cezar/src/chat/host.ts`, `registry.ts` | Canonical declarations, bridge composition and core lifecycle. |
| `packages/cezar/test/e2e/package-chat-runtime.test.ts` | Packed host/SDK/plugin tests against simulated platforms. |

A normal external provider needs no new HTTP family or private host transport. Use existing
extension chat routes and declarative setup metadata. Extensions manages software; project
Integrations manages credentials, discovery, receivers, pairing and person approval. Keep one
canonical provider form, including for a selected public replacement. Changes to the chat
routes must keep contract schemas, chained builders and validation middleware; see AGENTS.md.

## Verification and limits

Run adapter tests and `npm run test:pack` in each changed package. For host integration use bounded
typecheck, build/pack and relevant simulated runtime tests, plus the docs checker. Do not use live
credentials or platforms. A regression test must fail without its fix.

Direct cockpit tarball installation is unsupported. Install a built local folder with runtime
dependencies or an available npm package version.

### Explicit adapter disable

Ordinary worker retirement is separate from an explicit adapter selection change. Restart,
crash recovery and replacement keep consent. Explicit disable drains receive work, turns task
control off on the provider's inbound receivers (`enabled: false`) and pauses bot-attached
notification receivers. Grants, native cursor/epoch, vault records and bot ownership are kept.

The restoration record is stored beside the inbound state, not in it. Explicit enable restores
only the configuration generations and paused receiver revisions written by that disable. A
later edit, a pause that already existed or a webhook-only receiver is not overwritten. If the
process stops after a notification pause but before its restoration revision is recorded, the
receiver stays paused and needs an explicit Resume. A failed or missing extension selection
never selects another transport as fallback.
