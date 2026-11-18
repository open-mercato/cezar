# Discord local chat provider

Status: implemented (2026-11-13). The adapter is the
public extension package `packages/chat-plugins/discord` (`2026-11-09-independent-chat-plugins.md`);
the host keeps only its identifiers and presentation (`packages/cezar/src/chat/providers/discord/`).
Extends `2026-11-04-chat-providers.md`.

Discord uses API v10 REST and Gateway JSON through the package's own `ws` and Undici 6
dependencies. No Discord SDK, public listener or additional environment setting. The existing `discord.v1` webhook remains notifications-only until the shared activation transaction attaches a bot to the same receiver. Bot errors never fall back to the webhook.

## Durable identity and credentials

Bot, actor and message IDs are decimal snowflakes retained as strings. Channel IDs are `discord:dm:<channel>` or `discord:guild:<guild>:<channel>`. Authoritative channel type 1 establishes a DM; type 0 with guild metadata establishes a guild text channel. Group DMs, threads, announcement, forum and voice channels are unsupported. Raw channel IDs are rejected. REST inspection checks the qualified identity before every send/edit/membership use; ingress validates channel and guild metadata before normalization. Classification survives cache loss, multiple bot sessions and persisted source/receipt reloads; the shared contract (`packages/contract/src/chat.ts`) constrains persisted Discord chat ids.

The sole secret field is `token`, encoded by shared ChatSecrets helpers. A fixed `https://discord.com/api/v10` destination never contains credentials and cannot identify the bot. Restart must authenticate saved credentials or use the shared authenticated durable bot identity. The identity display username is the stable bot snowflake, used for clickable profile links and mentions.

## Lifecycle and uncertainty

Dedicated-bot consent gates setup in `ChatInbound`. Adapter construction does no I/O. Core owns leases, grants, claims, budgets, encrypted storage and the durable inbox. Guards run before REST/socket effects; stop aborts the connection and awaits receive processing before lease release. Terminal Gateway failures abort queued work. No secret or raw platform error is logged.

Identify requests Guilds, Guild Messages, Direct Messages and Message Content intents (37377). Message Content must be enabled in the developer portal. Hello starts jittered heartbeats; missing ACK reconnects; opcodes 7/9 and resumable close codes reconnect after five seconds. READY stores a memory-only session/sequence/resume URL; RESUME uses the last received sequence, rejecting older dispatches independent of the inbox's 1,000-event ledger. Re-identification clears sequence; process restart never resumes an old Gateway session. Uncertain claimed work is not replayed. This can lose work around a disconnect or crash; it does not promise exactly-once delivery. Session-start quota exhaustion and sharding requirements fail closed; this implementation serves a small dedicated bot, not a sharded installation.

REST keeps cooldowns per rate-limit bucket and major parameter (channel, guild, webhook or interaction): `x-ratelimit-remaining: 0` with `x-ratelimit-reset-after`, or a 429's `retry_after`, holds only that bucket for that resource, and a cooldown recorded under the route before its `x-ratelimit-bucket` hash was learned still applies. Only a global 429 holds every route. The cooldown table is bounded at 512 entries and evicts expired entries first, then the one expiring soonest. Explicit 429 may retry under the core budget.

A Gateway event whose REST lookup is rate-limited is parked off the serial receive queue for `retry_after` and re-run, so later input keeps flowing and the 100-event pending cap never trips on a hold. Order is kept per chat (channel): while a chat has a parked event, its later events (messages, buttons, channel updates) park behind it in arrival order and run when it settles; other chats keep flowing, so only input from different chats can overtake a held event. Guild messages the core would ignore anyway (neither mentioning nor replying to the bot) are discarded instead of parked. Each event may be held for at most 60 seconds in total, counted from when it was first parked, and at most 100 messages and buttons are parked at once, followers included. Channel and thread update/delete events are exempt from both bounds and are not dropped while the connection runs (a stop discards parked lanes, and a restart resumes past them): they invalidate the channel cache on arrival, and the one queued per type per chat runs in order after the held event, so a channel removal still emits its membership suspension. The channel lookups for messages and buttons carry the connection's abort signal and REST's 10-second timeout, so stop aborts them; a hung lookup then drops only its event, but the receive queue is serial, so until it times out it stalls input from every chat, not just its own. Past either bound that one event is dropped: its sequence is already acknowledged, so a Gateway resume cannot replay it, and the connection is not reconnected for it. Drops are reported as one warning log line per minute with counts by bound and chat kind (guild or direct), never identifiers or content. The interaction ACK retries a 429 only while its 2.5-second deadline allows. When `/gateway/bot` omits `session_start_limit.reset_after`, an exhausted identify budget is refreshed after one minute. Ambiguous POST/PATCH network or server failures are blocked, preventing duplicate message delivery. GET failures are transient. Responses are bounded to 1 MiB. Credentials, transport errors and invalid responses expose only classified failure kinds.

## Inputs and outputs

Setup uses text `/start <code>` in a DM or `<@botId> /start <code>` in a guild text channel. The profile link fragment is local UI metadata, not a Discord deep-link command: the shared wizard displays a copyable command (`chat-discovery-command.tsx`). The only native application command is `/tasks`, registered when the bot connects; setup and every other command stay text. Unmentioned replies require the original bot's same-channel referenced message. Bot authors and cross-channel references are rejected.

Component interactions arrive through Gateway. An outbound type-6 deferred callback starts independently of the core receive queue with a 2.5-second timeout; the button is processed only after it settles, and while it is pending the button parks in its chat's lane like a held event, so a slow callback never stalls other chats; no inbound HTTP endpoint is needed. Leave Discord's Interactions Endpoint URL empty. The interaction token stays only in the callback's closure, never in normalized events or state. Shared one-time button claims authorize any task effect after the acknowledgement. Deferred acknowledgement does not imply successful task action; normal shared replies convey results.

REST messages suppress mentions and embeds, use at most 2,000 UTF-16 units, five rows of five buttons, 80-character labels and 100-character custom IDs. Rendering escapes markup and neutralizes mentions. Membership checks distinguish transient unknown from definite absence and evaluate guild owner, administrator, role and member overwrites for VIEW_CHANNEL. Guild unavailable events do not revoke or suspend grants; known channel/guild removal emits shared membership suspension events.

## Verification

Session and rendering run the shared conformance suite (`packages/cezar/src/chat/test-support/conformance.testkit.ts`) over simulated REST. The package's own `node:test` suites (`packages/chat-plugins/discord/test/`) use loopback WebSockets to exercise real JSON envelopes, identify, heartbeat, resume, deduplication, the interaction callback, removal, the terminal intent error and rotation; REST mocks disable the network entirely. Host tests assert no effects before consent, on a hosted cockpit, or after disposal. The simulated-Discord browser suites `packages/web/e2e/discord-*.e2e.ts` cover setup, activation, webhook-to-bot upgrade, groups, approvals and retries; they are run manually with `npm run test:e2e:runner` before a release (not part of CI).

Official protocol sources checked 2026-11-04:

- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/topics/rate-limits
- https://docs.discord.com/developers/topics/permissions
- https://docs.discord.com/developers/components/reference (legacy action-row/button messages, without IS_COMPONENTS_V2)
- https://docs.discord.com/developers/resources/message
