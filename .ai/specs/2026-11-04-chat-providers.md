# Chat providers: one core for two-way chat integrations

Status: implemented (2026-11-13). Builds on spec 2026-10-29 (Telegram) and spec 2026-11-03
(Integrations gallery). How a provider's adapter is
packaged, installed and run — public extension artifacts, the delivery catalog, the worker host —
is `2026-11-09-independent-chat-plugins.md`. Platform details: `2026-11-04-slack-chat.md`,
`2026-11-04-discord-chat.md`. Contributor guide: `docs/adding-chat-provider.md`.

## Intent

Telegram, Slack and Discord (and extension chat providers) share one provider-agnostic core, so a
new chat platform is an adapter plus its cockpit descriptor, not a copy of the Telegram module.

The pairing, permissions, confirmed previews, durable journal, source records and final-reply
routing are the hard part, and they live once in the core (`packages/cezar/src/chat/`). An adapter
only speaks its platform's wire protocol.

## Non-goals

- New task actions. Commands, permissions and previews are the ones spec 2026-10-29 defines.
- A provider-specific fork of pairing, grants or delivery.
- A public listener. Every transport is outbound (long polling, Socket Mode, Gateway).

## Invariants

These hold for every provider, enforced in the core rather than re-implemented per provider. This
is the one list; a provider spec adds only its platform-specific invariants.

- A chat command never becomes an unaudited shell or account-control channel.
- No success message is sent for an effect that was not durably claimed and authorized.
- A transient platform, vault, disk or provider failure never revokes a valid pairing.
- A disabled, damaged, orphaned or conflicted bot is always shown with its recovery action.
- Nothing contacts the platform before dedicated-bot consent and an explicit activation.
- An adapter never sees the run store, the vault or `ProjectContext`. It receives the credentials
  of its binding and emits normalized events.

## One integration per platform, two modes

Each platform is one integration with two modes: **notifications** and **task control**.

- A `slack.v1` or `discord.v1` receiver configured with an incoming-webhook URL (released in
  v0.17.0) is that platform's notifications-only setup. It keeps its format and stored shape.
- Task control needs the bot. Turning it on for an incoming-webhook receiver connects the bot,
  pairs it in that channel and adds the bot credentials and the discovered chat to the SAME
  receiver. From then on its notifications also go through the bot, so a reply to a notification
  can reach its task.
- A setup may also start with the bot and notifications only, as Telegram does.

A receiver without a bot keeps sending through its incoming-webhook URL; a receiver with a bot
sends through the provider under the shared send budget. Bot errors never fall back to the webhook.

**Compatibility with released versions:** 0.17.x–0.19.x read `endpoints.json` strictly. Bot fields
(`chatId`, `chatSecret`) are written only on a receiver that has a bot, so projects whose Slack and
Discord receivers stay webhook-only remain readable by those versions. A project with a
bot-connected or `telegram.v1` receiver cannot be read by them; `BACKWARD_COMPATIBILITY.md` records
this.

## Layers

| Layer | Owns | Where |
| --- | --- | --- |
| Core | inbound state, bot binding and ownership lease, pairing, grants and authorization, action previews and the journal, the conversation router and commands, source records, outcome observation and final replies, setup orchestration, the send-budget scheduler | `packages/cezar/src/chat/` (`state`, `bindings`, `ownership`, `recovery`, `pairing`, `authorization`, `actions`, `conversation`, `message-router`, `controls`, `task-target`, `runtime`, `setup`, `send-budget`, `service`, `host`) |
| Host descriptor | provider id, receiver format, credential fields, id schemas, limits, presentation (rendering, command syntax, discovery link) | `packages/cezar/src/chat/providers/<id>/` (`ChatServiceDescriptor` in `chat/provider.ts`) |
| Adapter | credential check and bot identity, receiving events, sending and editing messages, buttons, membership checks, error classification | `packages/chat-plugins/<id>/` on the public SDK (`ExtensionChatAdapter`, `packages/extension-sdk/src/chat.ts`) |
| Outbound delivery | queue, retries, history, privacy profiles, Pause/Resume for notifications | `packages/cezar/src/webhooks/` (a chat receiver stays a receiver there) |

## The adapter seam

Shapes are zod schemas, types inferred. An adapter implements:

```ts
interface ExtensionChatAdapter {
  identify(op?): Promise<ChatIdentity>              // stable bot id the ownership lease is keyed by
  inspect(chatId, op?): Promise<{ id; kind: 'private' | 'group'; eligible }>
  send(chatId, message: ChatMessage, op?): Promise<ChatReceipt>
  clearButtons(receipt, op?): Promise<void>
  acknowledge(eventId, text, op?): Promise<void>
  isMember(chatId, userId, op?): Promise<boolean | undefined>
  receiveSession(session: ChatReceiveSession): Promise<void>
  dispose?(): Promise<void>
}
```

Normalized events (`chatEventSchema`):

- **message**: chat (id, `private` or `group`), user, message id, time, text, whether the bot was
  addressed, and the receipt it replies to. Telegram's reply-to, Slack's `thread_ts` and Discord's
  message reference all map to that receipt.
- **button**: chat, user, message receipt, opaque callback data.
- **membership**: the bot was removed from a chat, or a group migrated to a new id.
- **start**: the discovery signal setup waits for (Telegram `/start`, a Slack or Discord
  `start` command with the setup code).

Errors are classified once, by the adapter, into `auth`, `conflict`, `rate_limited` (with
`retryAfterMs`), `gone`, `transient` and `blocked`. The core maps them to health states
(`credentials-unavailable`, `conflict`, `backoff`, `blocked`). No platform status code reaches the
core.

Commands stay text: the core parses `/status 1a2b` from message text. A platform with native
commands translates them into the same text form (Discord's `/tasks` is the one native command).

## Group routing

In a group, a message reaches a task when it is either:

- a **reply to a bot message** (Telegram reply-to, a Slack thread reply, a Discord message
  reference to a bot message) — no mention is needed, because the platform ties the reply to the
  message and the message to its task;
- or an **addressed command**: `/command@bot` in Telegram, a mention of the bot in Slack and
  Discord.

Any other group message is ignored. Grants, freshness and confirmed previews apply unchanged, and
new tasks start only from a private chat.

## Stored state and records

- **Run record:** `chatSource`, with a `provider` field and string ids validated by that provider's
  id schema. The public projection (`public-run.ts`) hides chat, user and bot ids.
- **Inbound state:** `.ai/cezar/webhooks/chat/<provider>/<botId>.json`; the cross-process
  ownership lease and binding live under `~/.cezar/chat/<provider>/bots/<botId>/`.
- **Receivers:** bot-connected receivers of every provider carry `chatId` and `chatSecret` (a
  vault reference).

## HTTP API

One chained route-family builder (`createChatRoutes`) mounted once per provider at
`/api/v1/<provider>/…` and its project alias (`telegram`, `slack`, `discord`), plus
`/api/v1/extensions/:extensionId/chat/:providerId/…` for extension providers. The contract
defines each shape once with the provider as a parameter (`chatSchemas(...)` in `chat.ts`).
`contract-parity` and `route-parity` run per provider.

## Cockpit

- The wizard keeps its steps: check credentials, discover the chat, choose people and permissions,
  activate. A provider descriptor supplies the label, icon, credential fields, the discovery hint
  and its help links (`packages/web/src/lib/chat-providers/`).
- Each descriptor contributes its Integrations tile. Slack and Discord tiles list webhook-only and
  bot-connected receivers together and offer **Enable task control** on a webhook-only one.

### Slack and Discord setup

One capability-led **Connect** entry per platform, minimal permissions for notification-only
destinations, optional task control, inline copy actions and actionable provider preparation.
Telegram keeps its own setup flow (`2026-10-29-telegram-setup-and-replies.md`).

- One vocabulary: the optional capability is called **task control** everywhere (choice, wizard,
  panel). Connect offers **Notifications only** or **Notifications and task control**; once a bot
  exists the same dialog is titled **Add a chat**.
- **Notifications only** uses a channel webhook without message-reading permissions, or the
  existing bot when one is already connected. **Notifications and task control** runs the bot
  wizard with conversation enabled, without granting the optional start/cancel/continue
  permissions automatically.
- The token step shows the provider preparation box once (hidden when adding a chat to a connected
  bot). The connect step is a numbered list (Discord: invitation first), shows Slack's command
  once (identical in a private chat and a channel), and collapses to the sender line once the
  setup command arrived.
- The webhook-only receiver list is shown only when such receivers (or their deleted history, a
  receiver link, or the webhooks-off explanation) exist; the change notice renders in the panel
  header for every provider. Slack/Discord panels with webhook-only receivers and no bot read the
  same delivery status as their gallery tile.
- Notification-only setup saves an inactive receiver, automatically sends a test, shows the
  delivery result through the existing project event invalidations, and requires explicit
  activation after a successful delivery. A changed delivery revision and an unknown, failed or
  pending result cannot activate. Closing keeps the inactive receiver; retry tests the same
  receiver rather than recreating it.
- Webhook-only rows offer **Enable task control** in place. The upgrade passes the same receiver
  id/revision to the transactional bot attachment and test path, so a bot chat never gets a second
  webhook row.
- The Slack creation link prefills the app manifest (`manifest_json`); copying it remains a
  fallback. The manifest declares Socket Mode, writable Messages, interactivity, scopes and the
  supported events. Tokens still require the operator's workspace authorization. Discord
  instructions explain intents, invitation permissions, a shared server and DM delivery. No
  third-party application setting is changed silently.
- Copy uses the shared clipboard helper with success feedback and a visible manual fallback. No
  credential is copied out of the vault or printed.
- Setup verifies incoming discovery and outgoing test separately. Bounded setup expiry, ownership,
  group consent/comparison, revision fences and test-before-activation all apply. No new API,
  state format or environment flag.

Platform sources: https://docs.slack.dev/reference/app-manifest/,
https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests (`manifest_json`),
https://docs.discord.com/developers/events/gateway

## Platforms

Every transport needs no public URL, so cezar stays local and zero-config. No platform SDK is used.

| Platform | Receive | Credentials | Notes |
| --- | --- | --- | --- |
| Telegram | `getUpdates` long polling | bot token | |
| Slack | Socket Mode WebSocket | app-level token (`xapp-…`) and bot token (`xoxb-…`), optionally rotating | each envelope is acknowledged on arrival; replies use threads |
| Discord | Gateway WebSocket | bot token | heartbeat and resume; reading group text needs the Message Content intent |

## Verification

A conformance suite in the core (`chat/test-support/conformance.testkit.ts`) runs every provider
against a simulated platform: pairing, Confirm with a durable claim and a final reply in the same
chat, a question answered with a button, a group thread reply without a mention, a rate limit, a
credential rotation, task autocomplete for a group member, removal from a group. A provider is done
when it passes that suite unchanged.

Focused UI tests cover the Slack and Discord setup: intent, manifest/clipboard,
create/test/activate gating, failure/retry, navigation and revision changes. The simulated-platform
browser suites (`packages/web/e2e/slack-*.e2e.ts`, `discord-*.e2e.ts`) cover a webhook-only
receiver upgraded to task control (upgrade identity and persisted grants); they are run manually
with `npm run test:e2e:runner` before a release (not part of CI). Automated checks never use real
Slack/Discord credentials.
