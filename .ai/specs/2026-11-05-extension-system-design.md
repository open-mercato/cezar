# Extension system

Status: implemented (2026-11-13). Scope: install from npm and from a local folder, per-project
approval, commands, panels, forms/settings, task events and chat adapters; the public SDK
`@open-mercato/cezar-extension-sdk` ships in the release set. Placements outside Settings →
Extensions: `2026-11-07-extension-placements.md`. Telegram as an ordinary extension:
`2026-11-09-independent-chat-plugins.md`. A hosted cockpit refuses to install or run extensions.
User guide: `docs/site/content/docs/03-features/settings-and-projects/extensions.mdx`; author guide:
`docs/authoring-extensions.md`.

## Goal and boundaries

An author creates a separate project, uses the public SDK, adds a manifest and publishes a
package. The user installs it into cezar without rebuilding the app. Our own team ships features
this way too. The first authors are our team; no marketplace is needed.

"Universal" means one shared mechanism for installation, lifecycle, permissions, data and
versioning, plus a few explicit extension points. It does not mean the right to replace arbitrary
cezar code. A new KIND of extension needs a host API change; a new provider of a supported kind
does not.

The system offers user commands/actions, declarative panels and settings, task events and chat
adapters. Trackers and agent backends have no public API; one will exist only once they move onto
a shared interface with conformance tests.

Out of scope: a marketplace, payments, automatic updates, arbitrary React/HTML in the main app,
extensions that modify the core, safely running untrusted code.

## Relation to other plans

- **#1614 — integration providers (issues and PRs).** Trackers and forges (GitHub, GitLab, Azure
  DevOps, Jira, Linear) belong to that plan; the extension system gives them no public API. The
  Settings → Integrations gallery is the frame provider tiles plug into, #1614's included. Worker
  processes with per-project approval are one possible answer to #1614's open question about
  external provider packages; choosing the trust model is the owner's call.
- **#1949 — Send/Receive/Duplex channels.** Chat adapters are a Duplex channel for chat. They
  respect that plan's boundaries: a channel belongs to a project, receiving needs no public
  address, inbound content is data rather than an instruction, and credentials never reach agents.
  They give agents no tool for sending messages — that stays in #1949.
- **Manager mode (`2026-10-31-managers.md`).** A manager watches tasks from the cockpit; chat
  controls them from a messenger. Both use the same server paths for creating tasks and delivering
  replies (`server/run-messages.ts`) and share no state. Manager and chat notifications are
  switched off independently.

## Architecture

Options considered: a dynamic import into the server is simple but couples failures and
dependencies; a separate process with an explicit protocol gives lifecycle control; a full
sandbox is a separate, much larger project. We chose one Node process per active
extension–project pair and validated RPC over line-framed stdio (`extensions/worker-process.ts`,
`extensions/protocol.ts`). Commands, panel data and host calls go through that protocol. The
process gets no `RunManager`, secret store or Hono context.

**This is failure isolation, not a security sandbox.** Node code running as the user can reach
files and the network on its own. We install only code the user trusts; permissions limit cezar's
official API, not what the operating system allows. The UI says so plainly. We promise no safety
against a malicious author.

The SDK's base set: `defineExtension`, `ExtensionContext`, `Disposable`, registration of commands,
panels and forms, a per-project data store, a redacting logger, event subscriptions and controlled
task operations. The `chat` module has its own interface (`ExtensionChatAdapter`) and conformance
suite.

The SDK is the publishable package `@open-mercato/cezar-extension-sdk`, API `0.1`. The host accepts
only the explicitly supported `0.1` line; we do not pretend all of 0.x is stable. Inside `0.1` only
additive changes are allowed (BACKWARD_COMPATIBILITY.md §6b); stabilization is 1.0. An unknown
required capability refuses activation; it is never silently skipped.

## Manifest and contract

A `cezar-extension.json` file in the package, for example:

```json
{
  "id": "open-mercato.project-summary",
  "name": "Project summary",
  "version": "0.1.0",
  "apiVersion": "0.1",
  "entry": "dist/index.js",
  "capabilities": ["commands", "panels", "taskEvents"],
  "permissions": ["project.read"],
  "contributes": {
    "commands": [{ "id": "refresh", "label": "Refresh summary" }],
    "panels": [{ "id": "summary", "title": "Project summary" }]
  }
}
```

The permissions are `project.read` and `task.create`. The manifest and messages have single Zod
schemas with inferred types (`packages/extension-sdk/src/schemas.ts`). The SDK owns the shared
schemas; the HTTP contract re-exports them (the `./source` export) rather than duplicating them.
IPC frames live in `packages/cezar/src/extensions/protocol.ts`, never in the SDK or the HTTP
contract. The SDK is published in the release set before the contract, so installing cezar does
not depend on publication order.

Contribution ids are qualified by the extension id. Registration must match the manifest. Core ids
and other extensions' ids cannot be overridden. A form schema is a bounded field description, not
executable validator code. Panels: text, statuses, tables and buttons rendered by existing
components. No arbitrary HTML or scripts.

## User flow

1. Settings → Extensions → Install extension → Package / Local folder.
2. Package: a name with an optional version; folder: a directory with a manifest and already built
   JS. No config file has to be edited.
3. Preview: name, exact version, source, declared capabilities, data access and a note that
   trusted code runs locally. Installing does not run the extension's code.
4. Enable for project: choose the project and approve the access it needs. Then an optional
   connection form, e.g. for a chat platform. Installing a package does not replace consent to
   connect to the platform.
5. The list shows the version, projects, state, an error with a repair action, and Disable /
   Update / Uninstall. A folder install has Reload. New projects do not enable extensions
   automatically.

Settings → Integrations stays the place to connect services; Settings → Extensions manages
software. A chat extension contributes a tile to Integrations. The connection wizard is not
duplicated in Extensions.

## Installation, data, lifecycle

- A package version resolves to one concrete artifact; its integrity and dependency tree are
  recorded (dependencies must have pinned integrity). Installation stages outside the repository,
  without lifecycle scripts and without shell interpolation of arguments. Sources: npm registry
  packages and local folders; not arbitrary Git/URL/tarball sources named by the user. Paths and
  symlinks escaping the package directory are rejected. Dependencies that need install scripts are
  rejected with a readable error.
- Installs are global and immutable: `cezarHomeDir()/extensions/artifacts/<id>/<version>/<digest>/`;
  atomic writes, a cross-process lock. Approval is per project and bound to the exact artifact;
  project state is isolated by `projectId` and `extensionId`. A damaged entry disables only that
  extension. No extensions = no processes, no downloads and no change to core behaviour.
- States: installed/disabled → starting → running; an error → failed. A failed activation stays
  visibly `failed`. A process death after activation restarts with bounded backoff
  (`RestartBudget`: by default three quick crashes, backoff from 1 s, doubling), then `failed`; no
  endless loop. Disable blocks new calls, invalidates the permission generation, aborts pending
  operations, cleans up registrations and, after a deadline, ends the process. Limits: start 10 s,
  stop 5 s, RPC request 30 s, frame 1 MiB, 100 pending calls, data store ≤1000 keys and 4 MiB.
- Update: staging and validation → stop the old version → activate the new one. A failure restores
  the code and a snapshot of the extension's state. External effects cannot be undone: data
  migrations are local, with no platform calls. A consent-relevant change (permissions,
  capabilities, source) needs consent again.
- Uninstall keeps configuration and data for a reinstall by default; a separate, explicit option
  deletes the extension's data and secrets and the project approval row (otherwise shown as
  Missing), unless a chat selection or a webhook receiver still points at the extension — then the
  row stays and the uninstall preview says why. It never deletes task history or shared records. A
  disabled provider stays recognizable in historical data.
- Features shipped with cezar work without installing anything. Shipped chat adapters keep their
  provider ids and receiver state, with no re-pairing.

## Access and events

The host derives the project and the caller from the worker session; it never trusts a `projectId`
in a payload. Task-mutating operations go through the confirmation, limit and permission rules. A
command may propose a task (`tasks.propose`, permission `task.create`) in the existing form; it
gets no unchecked `startRun`.

Secrets are available only in the given extension's and project's namespace, through the project's
encrypted vault, never through an API to the frontend or the agents' environment; host-call results
have secrets redacted. The process gets a minimal runtime environment and inherits no host tokens.
This limits accidental leaks; it is not a sandbox.

Panel events are informational updates without durable delivery; after a restart a panel reads a
snapshot. Automatic task starts must never depend on them. When the bounded queue overflows the host
sends `resyncRequired`. Chat integrations keep a durable journal and the rules against repeating
uncertain effects. Every subscription has an owner and a dispose; the cockpit uses the shared
WebSocket.

## Success criterion

An external project with only the public SDK builds a working extension with no imports from inside
the repo. We install and disable it through the UI without restarting cezar. Two different uses: a
project summary panel with an action (`examples/extensions/project-summary`) and a chat platform
(`examples/extensions/mattermost`). A failure, update or removal of one extension breaks neither
basic work nor another extension.
