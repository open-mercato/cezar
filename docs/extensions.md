# Extensions

Settings → Extensions installs trusted npm packages or built local folders globally. Choose
the project in that screen, review the exact artifact and requested access, then enable it.
The catalog labels artifacts shipped with the host **Shipped with Cezar**, registry packages
**Public extension**, and folder installs **Local extension**. A chat contribution links
(**Manage <provider> connection**) to that provider's single project configuration in
Settings → Integrations; the Extensions page manages software and Integrations manages
credentials, receivers and pairing. Installation alone never grants project access. Local
folders have Reload; npm updates resolve the original requested package/range again. Preview
and install use the same immutable snapshot.

Extension API `0.1` supports commands, declarative panels and forms/settings, informational task
events and external chat providers. Task proposals open the normal editable new-task form; they
never start a run. There is no tracker or runner extension API.

Each enabled extension/project pair has its own Node worker. This contains failures, **not
malicious code**: extensions run as your OS user and can access files and the network. Only
install code you trust. Official host APIs fix project identity, check declared permissions,
encrypt extension secrets and redact known secret values from logs and worker results/errors.

Disable fences host mutations, removes contributions and stops the worker. A worker that dies
after activation restarts with backoff (1 s, 2 s, 4 s); after three rapid crashes, or a failed
activation, it is shown as Failed — review and retry explicitly. Approved enabled workers restore when
the project opens after a cockpit restart. Updates stop affected workers, snapshot extension
data and owned secrets, and restore the previous version after failed activation. Additional
permissions/capabilities require project approval again. External platform effects cannot be
rolled back; activation must not perform migrations with external side effects.

Uninstall stops the extension in open projects and removes its global installation record.
Data is kept by default: each project that had approved the extension keeps that approval,
disabled, so the extension stays listed there as **Missing** with no actions until it is
reinstalled. The explicit delete-data choice removes extension-owned data/secrets and the
Missing entry from registered projects; a project whose chat selection or webhook receiver still
names the extension keeps its Missing entry, and the uninstall preview says which. Shared task
history and chat grants/receivers are retained. Reinstall requires approval again. Unrelated
extensions keep their approvals. If the removed artifact was selected for a Telegram integration,
that integration stays unavailable until an explicit source selection; uninstall does not
reactivate shipped code.

## Shipped Telegram adapter

Cezar ships the same public extension artifact that can be installed independently through
Extensions. The distribution stamps its manifest ID, independent version and artifact digest in
`dist/chat-plugins/catalog.json`; the provider directory contains its public package, manifest
and entrypoint. Startup verifies those bytes without contacting npm. Package checks verify
the catalog and shipped contents. An installed candidate does not replace a selected adapter until
its project selection is explicitly approved.

The ordinary extension host runs the adapter under the host-granted canonical provider ID
`telegram` and its `.v1` receiver format; a package name or manifest alone cannot claim them.
The ID is declared before chat state recovery. Boot chat and
HTTP extension management share one manager; the last owner drains it before a replacement can
start. Other providers use qualified IDs such as `extensionId/localId`.

Credentials, authorization, receive checkpoints,
deduplication and task effects are host-owned. Workers receive bot-bound handles and normalized
public operations. Long-lived receive sessions use bounded cancellation and drain outside ordinary
RPC timeouts. Telegram keeps native epochs and offsets.

`CEZ_EXTENSIONS=0` runs only verified shipped artifacts through the trusted in-process facade.
Installed selections stay unavailable, with their saved metadata intact. A hosted cockpit runs no
chat adapter. Missing, tampered, disabled or failed
selected code never silently falls back to another implementation. A source rollback restores code
and approval metadata, never vault or cursor state. Workers run as the Cezar user; they provide
failure containment, not a security sandbox.

Chat providers appear under Integrations after enablement and use the same credential,
discovery, test-send and person-approval flow as Telegram. Software approval does not approve a
person to control tasks. Slack and Discord incoming-webhook receivers (`slack.v1`, `discord.v1`)
from Cezar 0.19 and earlier keep working as webhook receivers. External providers use `extensionId/localId`, scoped
to one canonical project root.

Do not create a second provider settings screen. The Extensions link opens
`/p/<projectId>/settings/integrations?integration=<providerId>`, using the canonical ID for
Telegram and `extensionId/localId` for other providers; the Integrations gallery's
Chat category is the canonical destination.

Examples:

- [Project summary](../examples/extensions/project-summary): task snapshot, live updates and refresh.
- [Mattermost](../examples/extensions/mattermost): a reference fixture, a standalone provider using the public SDK.

The SDK is `@open-mercato/cezar-extension-sdk`, API line `0.1`. See
[authoring extensions](authoring-extensions.md). `npm run test:pack -w
@open-mercato/cezar-extension-sdk` builds both examples outside this workspace against the packed
SDK. The browser acceptance test is `packages/web/e2e/extensions.e2e.ts`.

HTTP installation operations live under `/api/v1/extensions`: list, `prepare-install`,
`commit-install`, `:extensionId/prepare-update`, `:extensionId/uninstall-impact` and DELETE
`:extensionId` (optional `removeData=true`). Project access lives under
`/api/v1/p/:projectId/extensions/access`; enable/disable, commands, forms and panels use that
project's `extensions/:extensionId` family, and `extensions/placements` lists contributions per
location. Enable requires the reviewed artifact's `integrity`. Project routes are also mounted
for the boot project without the `/p/:projectId` prefix.

Explicit chat source selection uses the project routes
`POST extensions/chat-selections/:provider/preview` and `POST extensions/chat-selections/:provider/select`,
where `provider` is `telegram`. Send `enabled` and a `target`:
`{"kind":"shipped"}` or `{"kind":"installed","extensionId":"…","localProviderId":"…","integrity":"sha512-…"}`.
The preview returns the current and candidate records, added permissions/capabilities, and a
`revision`. Include that revision with the same input in `select`; a stale preview is rejected.
Previewing does not start code or create an approval. Hosted cockpits refuse both operations.
With `CEZ_EXTENSIONS=0`, only an explicit selection of shipped code is permitted.

An explicitly selected installed chat artifact keeps its exact version independently of later
host or installation updates. Its selected local provider uses the canonical provider ID;
other contributed providers keep their qualified IDs. Disabling or uninstalling it does not
select shipped code. Missing selected bytes stay unavailable, with saved metadata retained.
A source change drains the old transport while keeping the canonical declaration. Failed
activation restores the prior code selection and approval without restoring old credentials,
cursors or chat journals. Use a fresh preview to select shipped code explicitly.

Direct tarball installation through the cockpit is unsupported: use a built folder with runtime
dependencies or an available npm package version.
