# Slack local chat provider

Status: implemented (2026-11-13). The adapter is the public extension package
`packages/chat-plugins/slack` (`2026-11-09-independent-chat-plugins.md`); the host keeps its
identifiers, presentation and token renewal (`packages/cezar/src/chat/providers/slack/`). Extends
`2026-11-04-chat-providers.md`.

## Wire and identity

Socket Mode opens with `apps.connections.open` using an app-level token; the bot token performs
`auth.test`, conversation inspection, membership, message send and update. There is no public
listener, no platform call during import and no fallback to the incoming webhook. Credentials are
the canonical opaque JSON record `{appToken, botToken}` in the project vault; URLs never contain
either value. Both tokens must belong to the same installed app.

Bot identity is `TTEAM:UBOT`. Authoritative `conversations.info` produces
`private:TTEAM:UBOT:DCHANNEL` or `group:TTEAM:UBOT:CHANNEL`; private channels and multiparty DMs
are groups. The readable kind and bot namespace survive source/receipt and receiver persistence
and restart. Privacy is never inferred from Slack's channel prefix. Incoming events must authorize
this bot; interactions must reference this bot's message. Cross-team, cross-bot and cross-chat
effects fail closed. Unknown membership stays unknown.

## Delivery semantics

Every Socket Mode envelope is acknowledged by envelope ID on arrival, before any API or core work,
because Slack retries after three seconds. When the adapter's receive queue (100 envelopes) is
full it leaves the envelope unacknowledged and reconnects, so Slack redelivers it. Redelivered
envelopes are processed: the first attempt may have been sent while the socket was down, and the
host's durable inbox claim on the event id keeps task effects exactly-once. A reconnect opens a
fresh authenticated socket; a ping/pong watchdog bounds quiet broken connections. Stop aborts API
work, closes the socket and drains queued work before the lease is released. Authentication and
blocked errors park the bot; transient and rate-limit errors back off.

Input can still be lost, by design: events older than the current connection (or than 15 minutes)
are ignored, an acknowledged event whose channel lookup keeps failing is dropped with a counted
warning, and Slack downtime or a crash after the acknowledgement loses that input. There is no
catch-up replay; users resend after checking the task state.

**Why ACK-first:** holding the acknowledgement behind core work would make Slack resend every slow
event, and the inbox's id claim already makes a resend harmless.

## Interaction and presentation

Commands are text in DMs, or a bot mention plus the command in channels; `cezar <command>` is
accepted as an alias for `/<command>` because Slack intercepts leading slashes. Native Slack slash
commands are not registered. Setup's discovery link carries `cezar_start`; the shared wizard shows
`slackDiscoveryCommand(link)` (`cezar start <code>`) for the user to send, because clicking a Slack
link does not send a message. An incoming `thread_ts` always refers to the original root receipt,
and an outbound `replyTo` in the same channel is sent as `thread_ts`.

Rendered text escapes `&`, `<` and `>` and neutralizes mentions. Limits: 4,000 rendered characters,
25 buttons, 75-character labels; section blocks split safely at 3,000. Shared send-budget rates are
one message per chat and ten per bot per second. Clearing controls sends `chat.update` with the
original text and section blocks; after a restart the text is read back from the bot's own
message (`conversations.history`, then `conversations.replies` for thread replies), and a message
it cannot read is left untouched. Read methods are form-encoded; only `chat.*` writes send JSON.

## Host integration

The host registers `slackServiceDescriptor` (`packages/cezar/src/chat/providers/slack/index.ts`):
format `slack.v1`, credential fields, `slackIds` for the persistence boundaries, limits and the
fixed destination `https://slack.com/api/chat.postMessage`. A URL never identifies the bot. The
host owns credential resolution and redaction, route mounting and contracts, attaching bot fields
transactionally to the SAME `slack.v1` receiver, and the send/receipt budget. The cockpit binds
`createSlackDescriptor({ api, setupApi, subscribe })` (`packages/web/src/lib/chat-providers/slack/`)
in the provider registry and renders the discovery command.

## Token renewal

Host side: `packages/cezar/src/chat/providers/slack/rotation.ts`; the adapter reaches it through the
closed `slack-oauth-v1` credential profile (`2026-11-09-independent-chat-plugins.md` §4).

Both long-lived app/bot credentials and rotating `xoxe.xapp-` / `xoxe.xoxb-` tokens are supported.
The wizard detects token prefixes, reveals only the matching refresh-token fields and the shared
Client ID/Client Secret, and discards hidden renewal values when switching back to long-lived
tokens. No new environment switch, migration, hosted capability or automatic installation.

- **When it renews.** Both credentials are checked before the first API call. Each rotating token is
  exchanged once on setup to establish a known expiration and verify renewal. Later requests and the
  active socket's 30-second watchdog renew within five minutes of expiry. Idle, disconnected
  integrations do no background network work; the next call checks expiry after a restart or
  sleep. Shutdown awaits an outstanding renewal. Ordinary tokens never invoke OAuth or create
  rotation state.
- **Where renewed tokens live.** The original credential envelope and consent fingerprints stay
  immutable. Renewed access/refresh pairs live in cezar-only encrypted project secrets keyed by a
  hash of the initial refresh token, kind and OAuth client credentials. This shares renewal across
  receivers and wires without invalidating grants or delivery revisions. A cross-process filesystem
  lock uses the existing PID-owner lease helper; lock names contain only hashes, under
  `cezarHomeDir()/slack-token-locks`. These are disposable state, not configuration. Use a dedicated
  Slack app per project.
- **Single-use refresh tokens.** Before exchanging one, write a `pending` marker to the encrypted
  store. After a successful exchange, persist the new pair even when the caller was cancelled, then
  recheck its authorization fence before making any ordinary Slack request. Read/write errors never
  expose provider response bodies or credentials. An explicit HTTP 429 restores the prior state for
  a bounded retry. An ambiguous network response, a crash, an invalid response or a failed save
  after the exchange leaves the `pending` state: that refresh token is not replayed, and the user is
  asked for fresh credentials. This is a deliberate recovery limit, not a claim of exactly-once
  delivery across Slack and the local vault.
- **Repair.** Repair connection opens the existing receiver's setup with its revision, keeping the
  receiver and notification settings; the operator confirms the chat and task-control permissions
  again. Routine renewal never re-pairs or changes grants. No token value appears in API responses,
  logs or check/agent environments; generic redaction covers app, rotating access and refresh token
  shapes.

## Verification and sources

The shared conformance suite (`packages/cezar/src/chat/test-support/conformance.testkit.ts`) runs through the real adapter against a simulated Slack
Web API. Further tests cover credential fences, errors, rendering, private/group restart identity,
normalization, ACK-before-work, redelivery and stop draining; a real loopback WebSocket test proves
ACK, redelivery deduplication, reconnect and stop. External network is blocked with the loopback
guard `packages/web/e2e/loopback-netguard.c` (LD_PRELOAD); no real workspace is contacted.
Token renewal is covered for long-lived tokens, both rotating kinds, mixed kinds, concurrent wires,
a real encrypted-store restart and audience, expiry, rate limits, an interrupted exchange, write
failures, cancellation fences, heartbeat renewal/shutdown, hidden-field exclusion and the repair
UI. Simulated browser e2e: `packages/web/e2e/slack-*.e2e.ts` (setup, restart and a task flow,
among others), run manually with `npm run test:e2e:runner` before a release (not part
of CI).

Official protocol sources (checked 2026-11-04):
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://docs.slack.dev/apis/events-api/
- https://docs.slack.dev/reference/methods/conversations.info/
- https://docs.slack.dev/reference/objects/conversation-object/
- https://docs.slack.dev/reference/methods/chat.postMessage/
- https://docs.slack.dev/reference/methods/chat.update/
- https://docs.slack.dev/authentication/using-token-rotation/
- https://docs.slack.dev/authentication/tokens/
