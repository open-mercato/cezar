# Extensions and chat in hosted mode

Status: implemented (2026-11-13). Acceptance criteria 8 (the hosted variant in the e2e runner) and
10 (the end-to-end scenario) have no automated test — see "Limits". Builds on
`2026-11-05-extension-system-design.md` and `2026-11-09-independent-chat-plugins.md`.

## Goal

Cezar running on a server (`CEZ_REMOTE=1` or a bind to a non-loopback address) can install, enable
and run extensions and chat bots the same way as a local cockpit: from the panel, through the same
screens and wizards. Bots and workers run continuously, also with the browser closed, and come back
after a server restart.

The server operator turns this on explicitly with one flag. Without it, a hosted cockpit refuses
extensions and chat.

## Trust model

With the agent's default, unrestricted Bash access, a cockpit user can already run code as cezar's
system user, so a separate administration (e.g. through a CLI) would not be a boundary that
protects against them. We do not assume, however, that every deployment gives agents that access.

Therefore: **whoever can reach a hosted panel with the flag on can install and enable extensions,
configure bots and grant people task control through chat.** The machine's operator makes that
decision by setting the flag. Every panel user is then a trusted extension administrator of that
instance, including its shared inventory. This model is not for sharing an instance between people
of different trust levels. Authentication at the proxy controls entry but introduces no roles
inside cezar.

The flag is not on by default because "panel = shell" does not always hold: the operator may
restrict agent tools (`allowedTools`, `bashAllowlist`), and an extension runs persistently, outside
task history. `CEZ_TERMINAL=1` and `CEZ_REMOTE_AGENT_ACCOUNTS=1` follow the same pattern.

Unchanged: hosted mode requires an authenticated reverse proxy or tunnel; a separate worker isolates
failures, not malicious code; per-project approval limits the host API, not access to files and the
network.

## The flag

`CEZ_REMOTE_EXTENSIONS=1` — in hosted mode, allows extensions and chat in their full local scope. In
local mode it changes nothing. It is read from `process.env` on every check; a running process's env
does not change, so a new value takes effect after a restart.

After a restart without the flag, a hosted cockpit starts no extension worker and no chat adapter,
not even through the in-process fallback; the API refuses management and invocations. A normal
server shutdown cleans up its workers and connections. Turning the flag off does not cancel tasks a
bot created earlier.

Installs, configuration, secrets, approvals and people's permissions stay stored. After turning the
flag back on and restarting, only previously enabled, still validly approved artifacts and active
connections come back. A changed artifact or widened permissions need the usual new approval; the
flag does not bypass integrity verification.

The other flags work the same and are not replaced by it:

| Flag | Meaning in hosted mode with `CEZ_REMOTE_EXTENSIONS=1` |
| --- | --- |
| `CEZ_EXTENSIONS=0` | Turns installed extensions off as locally; shipped adapters run through the in-process fallback as locally. |
| `CEZ_WEBHOOKS=1` | Required for notifications and bots. |
| `CEZ_CHAT_INBOUND=1` | Required for task control from chat. |

The flag widens exposure, so it is opt-in (AGENTS.md § Zero config) and documented in `.env.example`
and in the env table of `docs/reference.md`.

## Design

### 1. One gate instead of `mode`

`extensionsRuntimeAllowed(env, localHandoff)` in `server/capabilities.ts`: always yes locally, in
hosted mode only with `CEZ_REMOTE_EXTENSIONS=1`. It is read by `extensionsOffReason`, the extension
routes' `discloseInventory`, and `chatUnavailableReason` / `chatNotificationsUnavailableReason`
(`chat/availability.ts`). `ChatHost`, `ChatInbound`, `WebhookService`, `ExtensionManager` and the
chat management owner (`extensions/project-runtime.ts`) receive it as a dependency
(`runtimeAllowed`) rather than reading env in each module. Every construction path (boot, lazy
project open, continuation, restart) passes it at the same place — AGENTS.md § "Find every
construction site".

`mode: 'local' | 'hosted'` still describes the real mode and drives what must stay hosted: cockpit
links in notifications (`webhooks/payload.ts`, the provider renderers, `webhooks/links.ts`) and the
webhook address policy (`webhooks/destination.ts`: https and a public address in hosted mode). In a
delivery request, `policy.mode` is only the address policy (together with the receiver's stored
activation mode), and chat availability travels in a separate field from the gate.

**Why a gate rather than removing the `mode` conditions:** the same `mode` carries the address and
link policy, which must stay hosted in hosted mode; only the runtime's availability depends on the
flag.

Without the flag, a hosted cockpit's refusals have fixed codes and messages, including 409 on
install and management (the message names `CEZ_REMOTE_EXTENSIONS=1`).

### 2. Background work without a browser

- Bots come back without a project context. `WebhookCoordinator.start()` runs `discover()` at boot
  and every 15 s. For each registered, available project with a `.ai/cezar/webhooks/endpoints.json`
  file it opens a `WebhookService`, which holds the project's `ExtensionManager`, declares the
  shipped adapters and calls `startChat()`. `CEZ_SINGLE_PROJECT=1` limits this to the boot project.
  An unavailable project directory (`status === 'missing'`) is skipped.
- Each project opens and starts chat on its own chain: one project's stuck open does not hold the
  others. This applies in local mode too.
- A chat command builds the project context itself (`contexts.context(project.id)`);
  `ProjectContexts` shares an in-flight build, so a concurrent user request does not create a
  second context.
- Extensions without chat and task recovery start with the project context (`onBeforeRecover`).

There is no startup queue and no cancellation of a context build: `ProjectContexts.build()` takes no
signal, and a single worker's activation is already bounded (10 s).

### 3. Installing from a local folder

In hosted mode the path names a directory on the server. A folder install is allowed only inside
the browse root of "Add project" (`~/` by default, the stored workspace value or `CEZ_BROWSE_ROOT`)
— `hostedSourcePolicy` in `server/extensions.ts`.

The check resolves the real path (`realpath`) of the root and the source and tests containment by
path segment, not by text prefix: `/srv/plugins-other` is not inside `/srv/plugins`. A symlink out
of the root, or a missing or inaccessible root/path, means refusal. The check applies in the
preview, install and update APIs, before the package is read, regardless of the UI picker. Copying
does not follow inner symlinks out of the root. A rejected source runs no code and no install.

A hosted inventory reveals no absolute paths outside that directory (`trimHostedExtensionSource`).

### 4. Refreshing in a hosted cockpit

A hosted cockpit opens no WebSocket. Extension and chat configuration changes arrive over the
workspace SSE (`/api/v1/workspace/events`) as `extension-inventory-changed` and
`chat-configuration-changed` events with the payload `{ changed: true }`
(`hostedConfigurationChangedEventSchema` in `packages/contract/src/events.ts`). The server coalesces
events of one type into one every 250 ms. The client invalidates the extension queries
(`['extensions']`) or every project's chat configuration; a run change invalidates nothing here.
After every SSE reconnect the usual refetch applies, so a change made during a disconnect is visible
without replay. The events carry no secrets and no project ids. `useExtensionSubscription` and
`lib/chat-providers/*` pick the channel by mode: WS locally, SSE in hosted mode.

### 5. Capabilities and UI

`capabilities.extensions` in hosted mode with the flag is `true`; without it `false` with
`extensionsUnavailableReason: 'hosted'`, and the UI points at the flag ("Set
`CEZ_REMOTE_EXTENSIONS=1` on the server and restart cezar"). Settings → Extensions and Settings →
Integrations work as locally; there are no separate hosted views. Chat and extension responses carry
no secrets, and the chat wizards' warnings when granting task control are the same as locally.

## Out of scope

RBAC and roles in the panel; separate administration through a CLI or private IPC; a sandbox for
untrusted code; a separate "hosted" approval beside the per-project one; SDK or extension ABI
changes (§6b); changes to custom webhooks and their address policy; Windows support beyond what
works locally.

## Limits

- An extension without chat in a project nobody opened after a restart does not run until the first
  HTTP request or chat command for that project. Its panels, commands and task events need the
  context anyway; only its own background work is lost. Local mode behaves the same.
- SSE events carry no project (their sources, `ExtensionManager.subscribe` and
  `WebhookCoordinator.onChatChange`, do not pass it), so a cockpit with many projects refetches more
  than needed.
- The e2e runner has no hosted variant (`extensions` and one chat provider with `CEZ_REMOTE=1` and
  `CEZ_REMOTE_EXTENSIONS=1`), which criterion 8 requires.
- The criterion 10 scenario has no automated end-to-end test.

## Acceptance criteria

1. **Default.** Local mode is unchanged. Hosted without the flag: 409, zero workers, zero bots, zero
   requests to npm and chat platforms — route, capabilities and runtime tests.
2. **Hosted with the flag = local.** Install from npm, approval, enable, panels, palette, task view,
   forms, uninstall (keep/remove data, "Missing") work over HTTP as locally.
3. **Chat in hosted mode.** The Telegram, Slack and Discord wizards configure a bot from scratch;
   pairing, grants and task control work against local provider fixtures; `CEZ_WEBHOOKS` and
   `CEZ_CHAT_INBOUND` keep their meaning. Cockpit links and the webhook address policy follow hosted
   mode.
4. **Restart without a browser.** After a restart bots come back without an HTTP request, also for a
   project other than the boot one. An unavailable directory, a worker error or one project's stuck
   open does not hold the other projects' bots or HTTP. A chat command and a concurrent user request
   produce one context and one bot.
5. **Folder.** A folder install outside the browse root (also through a symlink) is rejected. Tests
   cover a valid folder, a similar prefix, a source symlink and one inside the package leaving the
   root, an inaccessible root, an update from the stored source and a direct API request.
6. **SSE.** A hosted cockpit updates extensions and chat state without a WebSocket; a run change does
   not invalidate extension queries; a change during a dropped connection is visible after
   reconnect.
7. **Behaviour matrix.** Route, capabilities and runtime tests cover local, hosted without the flag,
   hosted with the flag, and combinations of `CEZ_EXTENSIONS`, `CEZ_WEBHOOKS` and
   `CEZ_CHAT_INBOUND`, the shipped fallback and the chat management owner. We test effects, not the
   number of `mode` occurrences.
8. Every boundary test has a negative control. Gates: typecheck, `npm test`, `test:unit`, the build
   with `check:pack`, `test:package`, `docs:check`, and — manually before a release —
   `test:e2e:runner` with a hosted variant for `extensions` and one chat provider (the variant does
   not exist yet).
9. **Turning off and on again.** A restart without the flag blocks the runtime and invocations while
   keeping data and approvals. A restart with the flag restores validly approved integrations, does
   not bypass an integrity change and does not enable previously disabled entries.
10. **End-to-end scenario.** A bot set up in the hosted panel for a project other than the boot one;
    the browser closed, the server restarted, no request opening the project; a command from an
    approved person through the chat fixture creates the task exactly once; the panel shows the
    current bot and task state. No real token and no external chat platform.
